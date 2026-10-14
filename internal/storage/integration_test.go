package storage

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// noProxyHTTP ignores HTTP(S)_PROXY env vars so requests reach local MinIO.
var noProxyHTTP = &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 30 * time.Second}

// integration returns a client against real S3 and a fresh bucket that is
// emptied and removed when the test ends.
func integration(t *testing.T) (*Client, string) {
	t.Helper()
	endpoint := os.Getenv("MARKR_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("MARKR_TEST_S3_ENDPOINT not set")
	}
	c, err := New(context.Background(), Options{
		Endpoint:  endpoint,
		Region:    "us-east-1",
		AccessKey: os.Getenv("MARKR_TEST_S3_ACCESS_KEY"),
		SecretKey: os.Getenv("MARKR_TEST_S3_SECRET_KEY"),
		PathStyle: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// The SDK's default transport honours proxy env vars; swap it out.
	c.s3 = s3.New(c.s3.Options(), func(o *s3.Options) { o.HTTPClient = noProxyHTTP })

	var rb [6]byte
	_, _ = rand.Read(rb[:])
	bucket := "markr-test-" + hex.EncodeToString(rb[:])
	ctx := context.Background()
	if _, err := c.s3.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)}); err != nil {
		t.Fatalf("create bucket: %v", err)
	}
	t.Cleanup(func() {
		p := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{Bucket: aws.String(bucket)})
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				t.Errorf("cleanup list: %v", err)
				return
			}
			var ids []types.ObjectIdentifier
			for _, o := range page.Contents {
				ids = append(ids, types.ObjectIdentifier{Key: o.Key})
			}
			if len(ids) > 0 {
				if _, err := c.s3.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: aws.String(bucket), Delete: &types.Delete{Objects: ids}}); err != nil {
					t.Errorf("cleanup delete: %v", err)
				}
			}
		}
		if _, err := c.s3.DeleteBucket(ctx, &s3.DeleteBucketInput{Bucket: aws.String(bucket)}); err != nil {
			t.Errorf("cleanup bucket: %v", err)
		}
	})
	return c, bucket
}

func TestIntegrationPutGetHead(t *testing.T) {
	c, bucket := integration(t)
	ctx := context.Background()
	body := []byte("derived-bytes")
	key := "d/p1/abcd/w800.webp"
	if err := c.Put(ctx, bucket, key, body, "image/webp", "public, max-age=31536000, immutable"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := c.Get(ctx, bucket, key, int64(len(body)))
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if _, err := c.Get(ctx, bucket, key, int64(len(body))-1); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Get over cap err = %v, want ErrTooLarge", err)
	}
	out, err := c.s3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil || aws.ToString(out.CacheControl) != "public, max-age=31536000, immutable" {
		t.Fatalf("cache-control = %q, %v", aws.ToString(out.CacheControl), err)
	}

	// Head checksum: objects uploaded through the presigned flow carry it.
	sum := hexSum(body)
	pr, err := c.PresignPut(ctx, bucket, "o/p1", "image/jpeg", sum, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if code, msg := doPut(t, pr, body, nil); code != http.StatusOK {
		t.Fatalf("presigned PUT = %d %s", code, msg)
	}
	obj, err := c.Head(ctx, bucket, "o/p1")
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	if obj.Size != int64(len(body)) || obj.ContentType != "image/jpeg" || obj.ChecksumSHA256Hex != sum {
		t.Fatalf("Head = %+v, want size %d sum %s", obj, len(body), sum)
	}
}

func TestIntegrationNotFound(t *testing.T) {
	c, bucket := integration(t)
	ctx := context.Background()
	if _, err := c.Head(ctx, bucket, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Head missing err = %v", err)
	}
	if _, err := c.Get(ctx, bucket, "missing", 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing err = %v", err)
	}
	if err := c.Delete(ctx, bucket, "missing"); err != nil {
		t.Fatalf("Delete missing err = %v", err)
	}
}

func TestIntegrationPresignedPutBindings(t *testing.T) {
	c, bucket := integration(t)
	ctx := context.Background()
	body := []byte("original photo bytes")
	sum := hexSum(body)

	pr, err := c.PresignPut(ctx, bucket, "o/mismatch", "image/jpeg", sum, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	code, msg := doPut(t, pr, []byte("tampered photo bytes"), nil)
	if code < 400 || code >= 500 {
		t.Fatalf("checksum-mismatch PUT = %d %s, want 4xx", code, msg)
	}
	t.Logf("checksum mismatch rejected: %d %s", code, msg)
	if _, err := c.Head(ctx, bucket, "o/mismatch"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("object exists after rejected PUT: %v", err)
	}

	pr, err = c.PresignPut(ctx, bucket, "o/ctype", "image/jpeg", sum, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	code, msg = doPut(t, pr, body, map[string]string{"Content-Type": "image/png"})
	if code < 400 || code >= 500 {
		t.Fatalf("content-type mismatch PUT = %d %s, want 4xx", code, msg)
	}
	t.Logf("content-type mismatch rejected: %d %s", code, msg)

	// The same presigned request with the right headers still works.
	if code, msg := doPut(t, pr, body, nil); code != http.StatusOK {
		t.Fatalf("PUT = %d %s", code, msg)
	}
	obj, err := c.Head(ctx, bucket, "o/ctype")
	if err != nil || obj.ChecksumSHA256Hex != sum {
		t.Fatalf("Head = %+v, %v", obj, err)
	}
}

func TestIntegrationPresignedGet(t *testing.T) {
	c, bucket := integration(t)
	ctx := context.Background()
	if err := c.Put(ctx, bucket, "o/g", []byte("abc"), "image/jpeg", ""); err != nil {
		t.Fatal(err)
	}
	u, err := c.PresignGet(ctx, bucket, "o/g", 5*time.Minute, "照片.jpg")
	if err != nil {
		t.Fatal(err)
	}
	resp, err := noProxyHTTP.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	want := "attachment; filename*=UTF-8''%E7%85%A7%E7%89%87.jpg"
	if resp.StatusCode != 200 || resp.Header.Get("Content-Disposition") != want {
		t.Fatalf("GET = %d, disposition %q", resp.StatusCode, resp.Header.Get("Content-Disposition"))
	}
}

func TestIntegrationDeletePrefixAndCopy(t *testing.T) {
	c, bucket := integration(t)
	ctx := context.Background()
	const n = 1005
	sem := make(chan struct{}, 32)
	var wg sync.WaitGroup
	errs := make(chan error, n+2)
	for i := 0; i < n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			errs <- c.Put(ctx, bucket, fmt.Sprintf("d/p1/h/%04d", i), []byte("x"), "text/plain", "")
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// Sibling prefixes sharing leading characters must survive.
	for _, k := range []string{"d/p10/h/keep", "d/p1keep"} {
		if err := c.Put(ctx, bucket, k, []byte("keep"), "text/plain", ""); err != nil {
			t.Fatal(err)
		}
	}

	if err := c.Copy(ctx, bucket, "d/p10/h/keep", bucket, "replica/d/p10/h/keep copy"); err != nil {
		t.Fatalf("Copy: %v", err)
	}
	if got, err := c.Get(ctx, bucket, "replica/d/p10/h/keep copy", 100); err != nil || string(got) != "keep" {
		t.Fatalf("Get copy = %q, %v", got, err)
	}

	deleted, err := c.DeletePrefix(ctx, bucket, "d/p1/")
	if err != nil || deleted != n {
		t.Fatalf("DeletePrefix = %d, %v; want %d", deleted, err, n)
	}
	out, err := c.s3.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(bucket), Prefix: aws.String("d/p1/")})
	if err != nil || len(out.Contents) != 0 {
		t.Fatalf("remaining under prefix: %d, %v", len(out.Contents), err)
	}
	for _, k := range []string{"d/p10/h/keep", "d/p1keep"} {
		if _, err := c.Head(ctx, bucket, k); err != nil {
			t.Fatalf("sibling %s gone: %v", k, err)
		}
	}
}

// doPut replays a presigned request with its headers, applying overrides.
func doPut(t *testing.T, pr PresignedRequest, body []byte, override map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(pr.Method, pr.URL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range pr.Headers {
		req.Header.Set(k, v)
	}
	for k, v := range override {
		req.Header.Set(k, v)
	}
	resp, err := noProxyHTTP.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	msg := buf.String()
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return resp.StatusCode, msg
}
