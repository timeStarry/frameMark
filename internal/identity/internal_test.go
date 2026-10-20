package identity

import (
	"errors"
	"testing"

	"github.com/timeStarry/frameMark/internal/httperr"
)

func TestNormalizeEmail(t *testing.T) {
	ok := map[string]string{
		" Alice+Photos@Example.COM ": "alice+photos@example.com",
		"摄影@例子.公司":                   "摄影@xn--fsqu00a.xn--55qx5d",
		"摄影@xn--fsqu00a.xn--55qx5d":  "摄影@xn--fsqu00a.xn--55qx5d",
		"a.b@example.com":            "a.b@example.com",
	}
	for in, want := range ok {
		got, err := normalizeEmail(in)
		if err != nil || got != want {
			t.Errorf("normalizeEmail(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	long := make([]byte, 250)
	for i := range long {
		long[i] = 'a'
	}
	for _, in := range []string{"bad", "a\r\nBcc:b@example.com", "a@localhost", "", "A <a@example.com>", `"a b"@example.com`, string(long) + "@x.co", "a@b@example.com"} {
		if got, err := normalizeEmail(in); err == nil {
			t.Errorf("normalizeEmail(%q) = %q, want error", in, got)
		}
	}
}

func TestBoundedRejectsThirdConcurrentHash(t *testing.T) {
	s := &Service{slots: make(chan struct{}, 2)}
	s.slots <- struct{}{}
	s.slots <- struct{}{}
	err := s.bounded(func() error { t.Fatal("must not run"); return nil })
	var se *httperr.StatusError
	if !errors.As(err, &se) || se.Status != 503 || se.Msg != "登录服务繁忙，请稍后重试。" {
		t.Fatalf("got %v", err)
	}
	<-s.slots
	if err := s.bounded(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(s.slots) != 1 {
		t.Fatal("slot not released")
	}
}
