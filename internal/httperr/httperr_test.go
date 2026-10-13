package httperr_test

import (
	"errors"
	"net/http/httptest"
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
}

func TestWriteUnknownErrorIs500(t *testing.T) {
	w := httptest.NewRecorder()
	httperr.Write(w, errors.New("boom"))
	if w.Code != 500 {
		t.Fatalf("want 500, got %d", w.Code)
	}
}
