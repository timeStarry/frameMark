package httperr_test

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timeStarry/frameMark/internal/httperr"
)

func TestFailMapsStatus(t *testing.T) {
	err := httperr.Fail(403, "会话校验失败")
	w := httptest.NewRecorder()
	httperr.Write(w, err)
	if w.Code != 403 {
		t.Fatalf("want 403, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("want Content-Type=application/json; charset=utf-8, got %q", ct)
	}

	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}
	if body["error"] != "会话校验失败" {
		t.Fatalf("want error=会话校验失败, got %q", body["error"])
	}
}

func TestWriteUnknownErrorIs500(t *testing.T) {
	w := httptest.NewRecorder()
	httperr.Write(w, errors.New("boom"))
	if w.Code != 500 {
		t.Fatalf("want 500, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("want Content-Type=application/json; charset=utf-8, got %q", ct)
	}

	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}
	if !strings.Contains(body["error"], "处理失败") {
		t.Fatalf("error message should be generic, got %q", body["error"])
	}
	// Ensure internal error text is not leaked
	if strings.Contains(body["error"], "boom") {
		t.Fatalf("error body leaks internal error text: %q", body["error"])
	}
}

func TestFailInvalidStatusCode(t *testing.T) {
	tests := []struct {
		name   string
		status int
	}{
		{"too low", 0},
		{"too low", 399},
		{"too high", 600},
		{"too high", 999},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			httperr.Write(w, httperr.Fail(tt.status, "test"))
			if w.Code != 500 {
				t.Fatalf("want 500 for invalid status %d, got %d", tt.status, w.Code)
			}
		})
	}
}
