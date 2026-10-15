package config_test

import (
	"strings"
	"testing"

	"github.com/timeStarry/frameMark/internal/config"
)

func TestLoad_OriginValidation(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		dev     bool
		wantErr bool
		want    string // canonical form, or "" to skip check
	}{
		// Valid origins
		{"https normal", "https://example.com", false, false, "https://example.com"},
		{"https with port", "https://example.com:8443", false, false, "https://example.com:8443"},
		{"https canonical", "HTTPS://Example.com", false, false, "https://example.com"},
		{"http dev localhost", "http://localhost:18150", true, false, "http://localhost:18150"},
		{"http dev 127.0.0.1", "http://127.0.0.1:18150", true, false, "http://127.0.0.1:18150"},
		{"https default port dropped", "https://example.com:443", false, false, "https://example.com"},
		{"http dev default port dropped", "http://localhost:80", true, false, "http://localhost"},
		{"empty port rejected", "https://example.com:", false, true, ""},

		// Rejected: trailing slash
		{"trailing slash", "https://example.com/", false, true, ""},
		// Rejected: path
		{"path", "https://example.com/path", false, true, ""},
		// Rejected: query
		{"query", "https://example.com?q=1", false, true, ""},
		// Rejected: fragment
		{"fragment", "https://example.com#f", false, true, ""},
		// Rejected: userinfo
		{"userinfo", "https://user:pass@example.com", false, true, ""},
		// Rejected: empty hostname
		{"empty hostname", "https://:443", false, true, ""},
		// Rejected: non-http in dev
		{"ftp dev", "ftp://localhost", true, true, ""},
		// Rejected: http non-dev
		{"http non-dev", "http://localhost", false, true, ""},
		// Rejected: non-localhost http in dev
		{"http dev non-localhost", "http://localhost.evil.com", true, true, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := []string{
				"MARKR_ORIGIN=" + tt.origin,
				"MARKR_DATA_DIR=/tmp/x",
			}
			if tt.dev {
				env = append(env, "MARKR_DEV=1")
			}

			cfg, err := config.Load(env)
			if (err != nil) != tt.wantErr {
				t.Fatalf("got err=%v, want err=%v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if tt.want != "" && cfg.Origin != tt.want {
				t.Fatalf("got origin=%q, want %q", cfg.Origin, tt.want)
			}
		})
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
	if !strings.Contains(err.Error(), "MARKR_WORKERS") {
		t.Fatalf("error should name MARKR_WORKERS, got: %v", err)
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

func TestLoad_Defaults(t *testing.T) {
	cfg, err := config.Load([]string{
		"MARKR_ORIGIN=https://example.com",
		"MARKR_DATA_DIR=/tmp/x",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Listen != "127.0.0.1:18150" {
		t.Fatalf("want default Listen=127.0.0.1:18150, got %q", cfg.Listen)
	}
	if cfg.UploadMaxMB != 60 {
		t.Fatalf("want default UploadMaxMB=60, got %d", cfg.UploadMaxMB)
	}
	if cfg.MaxPixels != 60_000_000 {
		t.Fatalf("want default MaxPixels=60000000, got %d", cfg.MaxPixels)
	}
	if cfg.QuotaPhotos != 2000 {
		t.Fatalf("want default QuotaPhotos=2000, got %d", cfg.QuotaPhotos)
	}
	if cfg.Workers != 2 {
		t.Fatalf("want default Workers=2, got %d", cfg.Workers)
	}
}

func TestLoad_RedactedExcludesSecrets(t *testing.T) {
	sentinel := "super-secret-value-12345"
	cfg, err := config.Load([]string{
		"MARKR_ORIGIN=https://example.com",
		"MARKR_DATA_DIR=/tmp/x",
		"MARKR_S3_SECRET_KEY=" + sentinel,
		"MARKR_REPLICA_SECRET_KEY=" + sentinel,
		"MARKR_EO_SECRET_KEY=" + sentinel,
		"MARKR_EO_SECRET_ID=" + sentinel,
		"MARKR_SMTP_CONFIG_FILE=" + sentinel,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	redacted := cfg.Redacted()
	for _, v := range redacted {
		if strings.Contains(v, sentinel) {
			t.Fatalf("Redacted() contains secret: %v", redacted)
		}
	}
}

func TestLoad_S3PathStyle(t *testing.T) {
	base := []string{"MARKR_ORIGIN=https://example.com", "MARKR_DATA_DIR=/tmp/x"}
	cfg, err := config.Load(base)
	if err != nil || cfg.S3PathStyle {
		t.Fatalf("default path style = %v, %v", cfg.S3PathStyle, err)
	}
	cfg, err = config.Load(append(base, "MARKR_S3_PATH_STYLE=true"))
	if err != nil || !cfg.S3PathStyle {
		t.Fatalf("path style = %v, %v", cfg.S3PathStyle, err)
	}
}

func TestLoad_ReplicaPathStyle(t *testing.T) {
	base := []string{"MARKR_ORIGIN=https://example.com", "MARKR_DATA_DIR=/tmp/x"}
	cfg, err := config.Load(base)
	if err != nil || cfg.ReplicaPathStyle {
		t.Fatalf("default replica path style = %v, %v", cfg.ReplicaPathStyle, err)
	}
	cfg, err = config.Load(append(base, "MARKR_REPLICA_PATH_STYLE=true"))
	if err != nil || !cfg.ReplicaPathStyle {
		t.Fatalf("replica path style = %v, %v", cfg.ReplicaPathStyle, err)
	}
}
