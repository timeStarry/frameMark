package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/timeStarry/frameMark/internal/api"
	"github.com/timeStarry/frameMark/internal/cdn"
	"github.com/timeStarry/frameMark/internal/clock"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/identity"
	"github.com/timeStarry/frameMark/internal/jobs"
	"github.com/timeStarry/frameMark/internal/mail"
	"github.com/timeStarry/frameMark/internal/storage"
	"github.com/timeStarry/frameMark/internal/worker"
)

const dbFile = "markr.db"

func run(ctx context.Context, args []string, environ []string, logs io.Writer) error {
	log := slog.New(slog.NewTextHandler(logs, nil))
	if len(args) == 0 {
		return errors.New("usage: markr migrate | markr serve --role=api|worker|all")
	}
	cfg, err := config.Load(environ)
	if err != nil {
		return err
	}
	switch args[0] {
	case "migrate":
		return cmdMigrate(cfg)
	case "serve":
		role, err := parseRole(args[1:])
		if err != nil {
			return err
		}
		return cmdServe(ctx, cfg, role, log)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func parseRole(args []string) (string, error) {
	role := "all"
	for _, a := range args {
		if strings.HasPrefix(a, "--role=") {
			role = strings.TrimPrefix(a, "--role=")
			continue
		}
		return "", fmt.Errorf("unknown flag %q", a)
	}
	switch role {
	case "api", "worker", "all":
		return role, nil
	}
	return "", fmt.Errorf("unknown role %q", role)
}

func cmdMigrate(cfg config.Config) error {
	d, err := openDB(cfg)
	if err != nil {
		return err
	}
	d.Close()
	return nil
}

func openDB(cfg config.Config) (*sql.DB, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	d, err := db.Open(filepath.Join(cfg.DataDir, dbFile))
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(d); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
}

func cmdServe(ctx context.Context, cfg config.Config, role string, log *slog.Logger) error {
	log.Info("markr starting", "config", cfg.Redacted(), "role", role)

	d, err := openDB(cfg)
	if err != nil {
		return err
	}
	defer d.Close()

	store, err := storage.New(ctx, storage.Options{
		Endpoint:  cfg.S3Endpoint,
		Region:    defaultStr(cfg.S3Region, "us-east-1"),
		AccessKey: cfg.S3AccessKey,
		SecretKey: cfg.S3SecretKey,
		PathStyle: cfg.S3PathStyle,
	})
	if err != nil {
		return err
	}

	var replica worker.Storage
	if cfg.ReplicaBucket != "" {
		if cfg.ReplicaEndpoint == "" || cfg.ReplicaEndpoint == cfg.S3Endpoint {
			replica = store
		} else {
			rc, err := storage.New(ctx, storage.Options{
				Endpoint:  cfg.ReplicaEndpoint,
				Region:    defaultStr(cfg.ReplicaRegion, "us-east-1"),
				AccessKey: cfg.ReplicaAccessKey,
				SecretKey: cfg.ReplicaSecretKey,
				PathStyle: true,
			})
			if err != nil {
				return err
			}
			replica = rc
		}
	}

	purger, err := cdn.New(cdn.Options{
		SecretID: cfg.EOSecretID, SecretKey: cfg.EOSecretKey, ZoneID: cfg.EOZoneID, Base: cfg.CDNBase,
	}, func(format string, args ...any) { log.Warn(fmt.Sprintf(format, args...)) })
	if err != nil {
		return err
	}

	var mailer identity.Mailer
	if cfg.SMTPConfigFile != "" {
		s, err := mail.LoadSMTP(cfg.SMTPConfigFile)
		if err != nil {
			return err
		}
		mailer = mail.NewSMTP(s)
	}

	id, err := identity.New(d, identity.Deps{
		Origin: cfg.Origin, Dev: cfg.Dev, Enabled: cfg.IdentityOn, RegistrationOpen: cfg.RegOpen, Mailer: mailer,
	})
	if err != nil {
		return err
	}

	q := jobs.New(d, clock.Now)

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var wg sync.WaitGroup
	errc := make(chan error, 2)

	if role == "worker" || role == "all" {
		w := worker.New(worker.Deps{
			DB: d, Jobs: q, Storage: store, Replica: replica, CDN: purger, Cfg: cfg, Log: log,
		})
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := w.Run(ctx); err != nil {
				errc <- err
			}
		}()
	}

	var srv *http.Server
	if role == "api" || role == "all" {
		h := api.New(api.Deps{DB: d, Identity: id, Storage: store, Jobs: q, Cfg: cfg})
		srv = &http.Server{
			Addr:              cfg.Listen,
			Handler:           h,
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      60 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errc <- err
			}
		}()
	}

	select {
	case <-ctx.Done():
	case err := <-errc:
		stop()
		if err != nil {
			log.Error("serve", "err", err)
		}
	}

	if srv != nil {
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		if err := srv.Shutdown(sctx); err != nil {
			log.Error("http shutdown", "err", err)
		}
		cancel()
	}
	// Worker Run honours ctx and finishes in-flight handlers (and their
	// DB writes) before returning. Wait for both goroutines.
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Minute):
		log.Error("shutdown timed out")
	}

	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return id.Close(cctx)
}

func defaultStr(v, d string) string {
	if v == "" {
		return d
	}
	return v
}
