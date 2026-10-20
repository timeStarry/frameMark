package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/timeStarry/frameMark/internal/clock"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/seed"
	"github.com/timeStarry/frameMark/internal/storage"
)

const seedUsage = "usage: markr seed-demo --manifest FILE --images DIR [--apply]"

type seedArgs struct {
	manifest, images string
	apply            bool
}

func parseSeedArgs(args []string) (seedArgs, error) {
	var a seedArgs
	fs := flag.NewFlagSet("seed-demo", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&a.manifest, "manifest", "", "")
	fs.StringVar(&a.images, "images", "", "")
	fs.BoolVar(&a.apply, "apply", false, "")
	if err := fs.Parse(args); err != nil {
		return a, fmt.Errorf("%v; %s", err, seedUsage)
	}
	if fs.NArg() != 0 || a.manifest == "" || a.images == "" {
		return a, errors.New(seedUsage)
	}
	return a, nil
}

// cmdSeedDemo runs the demo seed and prints its JSON report to out. It opens
// the existing database without migrating it (run `markr migrate` or
// `markr serve` first), and only connects storage for --apply, so a dry run
// writes nothing anywhere.
func cmdSeedDemo(ctx context.Context, cfg config.Config, args []string, out io.Writer) error {
	a, err := parseSeedArgs(args)
	if err != nil {
		return err
	}
	if a.apply && cfg.BucketOriginals == "" {
		return errors.New("seed-demo --apply: MARKR_BUCKET_ORIGINALS is required")
	}
	path := filepath.Join(cfg.DataDir, dbFile)
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("database %s: %w (run markr migrate first)", path, err)
	}
	d, err := db.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()

	var store seed.Storage = refuseStorage{}
	if a.apply {
		s, err := storage.New(ctx, storage.Options{
			Endpoint:  cfg.S3Endpoint,
			Region:    defaultStr(cfg.S3Region, "us-east-1"),
			AccessKey: cfg.S3AccessKey,
			SecretKey: cfg.S3SecretKey,
			PathStyle: cfg.S3PathStyle,
		})
		if err != nil {
			return err
		}
		store = s
	}

	r, runErr := seed.Run(ctx, seed.Deps{DB: d, Storage: store, Cfg: cfg, Now: clock.Now}, a.manifest, a.images, a.apply)
	if r != nil {
		b, err := json.MarshalIndent(r, "", "  ")
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(out, "%s\n", b); err != nil {
			return err
		}
	}
	return runErr
}

// refuseStorage backs a dry run: seed.Run never touches storage then, and
// this makes sure of it.
type refuseStorage struct{}

func (refuseStorage) Put(context.Context, string, string, []byte, string, string) error {
	return errors.New("seed-demo: storage write in dry run")
}

func (refuseStorage) Delete(context.Context, string, string) error {
	return errors.New("seed-demo: storage delete in dry run")
}
