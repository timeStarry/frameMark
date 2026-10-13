package config_test

import (
	"strings"
	"testing"

	"github.com/timeStarry/frameMark/internal/config"
)

func TestLoad_RequiresOriginHTTPS(t *testing.T) {
	_, err := config.Load([]string{
		"MARKR_ORIGIN=http://example.com",
		"MARKR_DATA_DIR=/tmp/x",
	})
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("expected https enforcement, got %v", err)
	}
}

func TestLoad_DevAllowsLocalhostHTTP(t *testing.T) {
	cfg, err := config.Load([]string{
		"MARKR_ORIGIN=http://127.0.0.1:18150",
		"MARKR_DATA_DIR=/tmp/x",
		"MARKR_DEV=1",
	})
	if err != nil {
		t.Fatalf("dev origin should be accepted: %v", err)
	}
	if cfg.Origin != "http://127.0.0.1:18150" || !cfg.Dev {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
}

func TestLoad_WorkersInvalid(t *testing.T) {
	_, err := config.Load([]string{
		"MARKR_ORIGIN=https://example.com",
		"MARKR_DATA_DIR=/tmp/x",
		"MARKR_WORKERS=abc",
	})
	if err == nil {
		t.Fatalf("expected error for invalid MARKR_WORKERS, got nil")
	}
}

func TestLoad_DataDirRequired(t *testing.T) {
	_, err := config.Load([]string{
		"MARKR_ORIGIN=https://example.com",
	})
	if err == nil || !strings.Contains(err.Error(), "MARKR_DATA_DIR") {
		t.Fatalf("expected error about MARKR_DATA_DIR, got %v", err)
	}
}
