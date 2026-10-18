package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
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
	"github.com/timeStarry/frameMark/internal/media"
	"github.com/timeStarry/frameMark/internal/storage"
	"github.com/timeStarry/frameMark/internal/webui"
	"github.com/timeStarry/frameMark/internal/worker"
)

const dbFile = "markr.db"

// mediaSelfCheck is media.SelfCheck; tests replace it.
var mediaSelfCheck = media.SelfCheck

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

	// Spec §10: the worker refuses to start when libvips cannot write
	// every derived format (AVIF needs heifsave).
	if role == "worker" || role == "all" {
		if err := mediaSelfCheck(); err != nil {
			return err
		}
	}

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
				PathStyle: cfg.ReplicaPathStyle,
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

	mailer, err := pickMailer(cfg, role, func(format string, args ...any) { log.Warn(fmt.Sprintf(format, args...)) })
	if err != nil {
		return err
	}

	var id *identity.Service
	if role == "api" || role == "all" {
		id, err = identity.New(d, identity.Deps{
			Origin: cfg.Origin, Dev: cfg.Dev, Enabled: cfg.IdentityOn, RegistrationOpen: cfg.RegOpen, Mailer: mailer,
		})
		if err != nil {
			return err
		}
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
		hosts := s3Hosts(cfg)
		h := rootHandler(
			api.New(api.Deps{DB: d, Identity: id, Storage: store, Jobs: q, Cfg: cfg}),
			webui.Handler(webui.Options{CDNBase: cfg.CDNBase, ImgHosts: hosts, ConnectHosts: hosts}),
		)
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

	// runErr is the listener or worker failure that ended serve; it is
	// returned (joined with any close error) so the process exits non-zero.
	var runErr error
	select {
	case <-ctx.Done():
		// Unregister the signals: a second Ctrl-C now exits at once with
		// Go's default behaviour instead of waiting for in-flight work.
		stop()
		log.Info("shutting down; press Ctrl-C again to force")
	case err := <-errc:
		stop()
		if err != nil {
			log.Error("serve", "err", err)
			runErr = err
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
	wg.Wait()

	if id != nil {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		return errors.Join(runErr, id.Close(cctx))
	}
	return runErr
}

// rootHandler sends /api/ and /m/ to the API (so their 404s stay JSON) and
// everything else to the embedded frontend.
func rootHandler(apiH, web http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/m/") {
			apiH.ServeHTTP(w, r)
			return
		}
		web.ServeHTTP(w, r)
	})
}

// pickMailer returns the verification mailer for role: SMTP when a config
// file is set, else a log mailer in dev mode, else nil (register is 503).
// The worker role never sends mail.
func pickMailer(cfg config.Config, role string, logf func(format string, args ...any)) (identity.Mailer, error) {
	if role != "api" && role != "all" {
		return nil, nil
	}
	if cfg.SMTPConfigFile != "" {
		s, err := mail.LoadSMTP(cfg.SMTPConfigFile)
		if err != nil {
			return nil, err
		}
		return mail.NewSMTP(s), nil
	}
	if cfg.Dev {
		return mail.LogSender{Log: logf}, nil
	}
	return nil, nil
}

// s3Hosts returns the origins presigned S3 URLs can point at, for the CSP
// img-src (presigned GETs) and connect-src (direct presigned PUT uploads).
// Path-style URLs use the endpoint origin; virtual-host style puts the
// bucket in a subdomain, so each bucket's origin is listed too.
func s3Hosts(cfg config.Config) []string {
	u, err := url.Parse(cfg.S3Endpoint)
	if cfg.S3Endpoint == "" || err != nil || u.Scheme == "" || u.Host == "" {
		return nil
	}
	hosts := []string{u.Scheme + "://" + u.Host}
	// Virtual-host addressing cannot apply to an IP host.
	if !cfg.S3PathStyle && net.ParseIP(u.Hostname()) == nil {
		for _, b := range []string{cfg.BucketOriginals, cfg.BucketDerived} {
			if b != "" {
				hosts = append(hosts, u.Scheme+"://"+b+"."+u.Host)
			}
		}
	}
	return hosts
}

func defaultStr(v, d string) string {
	if v == "" {
		return d
	}
	return v
}
