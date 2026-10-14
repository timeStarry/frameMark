package storage

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newOfflineClient(t *testing.T, public string) *Client {
	t.Helper()
	c, err := New(context.Background(), Options{
		Endpoint:       "http://127.0.0.1:1",
		Region:         "us-east-1",
		AccessKey:      "AKIDEXAMPLE",
		SecretKey:      "secret-example",
		PathStyle:      true,
		PublicEndpoint: public,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func hexSum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestPresignPutSignsContentTypeAndChecksum(t *testing.T) {
	c := newOfflineClient(t, "")
	sum := hexSum([]byte("hello"))
	req, err := c.PresignPut(context.Background(), "bkt", "o/photo 1.jpg", "image/jpeg", sum, 15*time.Minute)
	if err != nil {
		t.Fatalf("PresignPut: %v", err)
	}
	if req.Method != "PUT" {
		t.Fatalf("method = %q", req.Method)
	}
	u, err := url.Parse(req.URL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("X-Amz-Signature") == "" {
		t.Fatalf("missing X-Amz-Signature: %s", req.URL)
	}
	if q.Get("X-Amz-Expires") != "900" {
		t.Fatalf("X-Amz-Expires = %q", q.Get("X-Amz-Expires"))
	}
	signed := strings.Split(q.Get("X-Amz-SignedHeaders"), ";")
	for _, want := range []string{"content-type", "x-amz-checksum-sha256", "host"} {
		if !contains(signed, want) {
			t.Fatalf("signed headers %v missing %q", signed, want)
		}
	}
	raw, _ := hex.DecodeString(sum)
	if got := req.Headers["X-Amz-Checksum-Sha256"]; got != base64.StdEncoding.EncodeToString(raw) {
		t.Fatalf("checksum header = %q (headers %v)", got, req.Headers)
	}
	if req.Headers["Content-Type"] != "image/jpeg" {
		t.Fatalf("content-type header = %q", req.Headers["Content-Type"])
	}
	for k := range req.Headers {
		if strings.EqualFold(k, "host") {
			t.Fatalf("Host must not be returned: %v", req.Headers)
		}
	}
	// Every signed header other than host must be handed to the browser.
	for _, h := range signed {
		if h == "host" {
			continue
		}
		found := false
		for k := range req.Headers {
			if strings.EqualFold(k, h) {
				found = true
			}
		}
		if !found {
			t.Fatalf("signed header %q not in returned headers %v", h, req.Headers)
		}
	}
}

func TestPresignPutRejectsBadHex(t *testing.T) {
	c := newOfflineClient(t, "")
	good := hexSum([]byte("x"))
	for _, bad := range []string{"", "abc", strings.ToUpper(good), good[:63] + "g", good + "00"} {
		if _, err := c.PresignPut(context.Background(), "b", "k", "image/jpeg", bad, time.Minute); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
	if _, err := c.PresignPut(context.Background(), "b", "k", "", good, time.Minute); err == nil {
		t.Fatal("expected error for empty content type")
	}
}

func TestPresignGetContentDisposition(t *testing.T) {
	c := newOfflineClient(t, "")
	s, err := c.PresignGet(context.Background(), "bkt", "o/1.jpg", 5*time.Minute, "我的 照片;1.jpg")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(s)
	q := u.Query()
	if q.Get("X-Amz-Signature") == "" || q.Get("X-Amz-Expires") != "300" {
		t.Fatalf("bad presign: %s", s)
	}
	want := "attachment; filename*=UTF-8''%E6%88%91%E7%9A%84%20%E7%85%A7%E7%89%87%3B1.jpg"
	if got := q.Get("response-content-disposition"); got != want {
		t.Fatalf("disposition = %q, want %q", got, want)
	}

	s, err = c.PresignGet(context.Background(), "bkt", "o/1.jpg", 5*time.Minute, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "response-content-disposition") {
		t.Fatalf("unexpected disposition: %s", s)
	}
}

func TestPresignUsesPublicEndpoint(t *testing.T) {
	c := newOfflineClient(t, "https://cdn-upload.example.com")
	s, err := c.PresignGet(context.Background(), "bkt", "k", time.Minute, "")
	if err != nil {
		t.Fatal(err)
	}
	if u, _ := url.Parse(s); u.Host != "cdn-upload.example.com" {
		t.Fatalf("get host = %q", u.Host)
	}
	p, err := c.PresignPut(context.Background(), "bkt", "k", "image/png", hexSum(nil), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if u, _ := url.Parse(p.URL); u.Host != "cdn-upload.example.com" {
		t.Fatalf("put host = %q", u.Host)
	}

	c2 := newOfflineClient(t, "")
	s, _ = c2.PresignGet(context.Background(), "bkt", "k", time.Minute, "")
	if u, _ := url.Parse(s); u.Host != "127.0.0.1:1" {
		t.Fatalf("default host = %q", u.Host)
	}
}

func TestDeletePrefixGuards(t *testing.T) {
	c := newOfflineClient(t, "")
	for _, p := range []string{"", "/", "d", "d/abc"} {
		if _, err := c.DeletePrefix(context.Background(), "b", p); err == nil {
			t.Fatalf("expected error for prefix %q", p)
		}
	}
}

func TestNewValidates(t *testing.T) {
	if _, err := New(context.Background(), Options{Region: "r", AccessKey: "a", SecretKey: "s"}); err == nil {
		t.Fatal("expected error for missing endpoint")
	}
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
