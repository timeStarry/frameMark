package main

import (
	"fmt"
	"os"

	"github.com/timeStarry/frameMark/internal/config"
)

func main() {
	cfg, err := config.Load(os.Environ())
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("markr starting: %v\n", cfg.Redacted())
}
