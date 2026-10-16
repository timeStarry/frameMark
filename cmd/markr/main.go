package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/timeStarry/frameMark/internal/config"
)

func main() {
	if err := dispatch(context.Background(), os.Args[1:], os.Environ(), os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

// dispatch routes seed-demo (whose JSON report goes to out) and hands every
// other command to run.
func dispatch(ctx context.Context, args, environ []string, out, logs io.Writer) error {
	if len(args) > 0 && args[0] == "seed-demo" {
		cfg, err := config.Load(environ)
		if err != nil {
			return err
		}
		// Ctrl-C cancels before the tx commits; already-put originals are
		// still deleted (seed uses a detached cleanup context).
		ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		return cmdSeedDemo(ctx, cfg, args[1:], out)
	}
	return run(ctx, args, environ, logs)
}
