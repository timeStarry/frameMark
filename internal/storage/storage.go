// Package storage is the S3 abstraction used for originals and derived
// objects. One implementation serves Volcengine TOS (virtual-host style) in
// production and MinIO (path style) in tests and development.
package storage

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

var (
	// ErrNotFound is returned when the requested object does not exist.
	ErrNotFound = errors.New("storage: object not found")
	// ErrTooLarge is returned by Get when the object exceeds the byte cap.
	ErrTooLarge = errors.New("storage: object exceeds size limit")
)

// deleteBatch is the S3 DeleteObjects per-request maximum.
const deleteBatch = 1000

// maxPresignTTL is the SigV4 presign limit.
const maxPresignTTL = 7 * 24 * time.Hour

// Delete modes for Options.DeleteMode.
const (
	DeleteModeBatch  = "batch"
	DeleteModeSingle = "single"
)

// Options configures a Client.
type Options struct {
	Endpoint  string
	Region    string
	AccessKey string
	SecretKey string
	// PathStyle selects path-style addressing (MinIO). TOS uses virtual-host
	// style, so leave it false there.
	PathStyle bool
	// PublicEndpoint, when set, is the base endpoint used for presigned URLs
	// handed to browsers. Empty means Endpoint. It is a service base
	// endpoint, not a bucket-bound domain: with PathStyle=false the bucket is
	// prepended as a subdomain (https://{bucket}.{PublicEndpoint host}/{key}).
	PublicEndpoint string
	// DeleteMode selects how DeletePrefix removes keys: "batch" (default when
	// empty) uses DeleteObjects; "single" issues one DeleteObject per key for
	// services that reject DeleteObjects without Content-MD5.
	DeleteMode string
}

// Object is the metadata returned by Head.
type Object struct {
	Size        int64
	ContentType string
	// ChecksumSHA256Hex is the stored full-object SHA-256 in lowercase hex.
	// Empty means the service reported no verifiable SHA-256 (not stored, not
	// echoed, or a multipart composite): the upload is UNVERIFIED and callers
	// must treat it as a mismatch. Use ChecksumMatches rather than comparing
	// directly.
	ChecksumSHA256Hex string
}

// ChecksumMatches reports whether the stored SHA-256 equals wantHex. It
// returns false when either value is empty and compares in constant time.
func (o Object) ChecksumMatches(wantHex string) bool {
	if o.ChecksumSHA256Hex == "" || wantHex == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(o.ChecksumSHA256Hex), []byte(wantHex)) == 1
}

// PresignedRequest is a presigned request a browser must replay exactly:
// same method, URL and every header in Headers.
type PresignedRequest struct {
	URL     string
	Method  string
	Headers map[string]string
}

// Client is an S3 client plus a presigner.
type Client struct {
	s3           *s3.Client
	presigner    *s3.PresignClient
	singleDelete bool
}

// newHTTPClient bounds dial, TLS handshake and time-to-first-response-byte so
// a stalled connection fails instead of hanging a worker. Body transfer is
// still bounded by the caller's ctx.
func newHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	tr.TLSHandshakeTimeout = 10 * time.Second
	tr.ResponseHeaderTimeout = 30 * time.Second
	tr.ExpectContinueTimeout = 1 * time.Second
	return &http.Client{Transport: tr}
}

// New builds a Client. It performs no network I/O.
func New(ctx context.Context, opts Options) (*Client, error) {
	_ = ctx
	if opts.Endpoint == "" {
		return nil, errors.New("storage: endpoint is required")
	}
	if opts.Region == "" {
		return nil, errors.New("storage: region is required")
	}
	if opts.AccessKey == "" || opts.SecretKey == "" {
		return nil, errors.New("storage: access key and secret key are required")
	}
	switch opts.DeleteMode {
	case "", DeleteModeBatch, DeleteModeSingle:
	default:
		return nil, fmt.Errorf("storage: unknown delete mode %q (want %q or %q)", opts.DeleteMode, DeleteModeBatch, DeleteModeSingle)
	}
	httpClient := newHTTPClient()
	build := func(endpoint string) *s3.Client {
		return s3.New(s3.Options{
			Region:       opts.Region,
			Credentials:  credentials.NewStaticCredentialsProvider(opts.AccessKey, opts.SecretKey, ""),
			BaseEndpoint: aws.String(endpoint),
			UsePathStyle: opts.PathStyle,
			HTTPClient:   httpClient,
			// Only add checksums the operation requires (e.g. DeleteObjects);
			// presigned PUTs carry the caller-declared SHA-256 explicitly.
			RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
			ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
		})
	}
	main := build(opts.Endpoint)
	presignBase := main
	if opts.PublicEndpoint != "" {
		presignBase = build(opts.PublicEndpoint)
	}
	return &Client{
		s3:           main,
		presigner:    s3.NewPresignClient(presignBase),
		singleDelete: opts.DeleteMode == DeleteModeSingle,
	}, nil
}

// Put uploads body. cacheControl may be empty.
func (c *Client) Put(ctx context.Context, bucket, key string, body []byte, contentType, cacheControl string) error {
	in := &s3.PutObjectInput{
		Bucket:        aws.String(bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader(body),
		ContentLength: aws.Int64(int64(len(body))),
	}
	if contentType != "" {
		in.ContentType = aws.String(contentType)
	}
	if cacheControl != "" {
		in.CacheControl = aws.String(cacheControl)
	}
	if _, err := c.s3.PutObject(ctx, in); err != nil {
		return wrap("put", bucket, key, err)
	}
	return nil
}

// Get downloads an object, refusing anything larger than maxBytes.
func (c *Client) Get(ctx context.Context, bucket, key string, maxBytes int64) ([]byte, error) {
	if maxBytes < 0 {
		return nil, errors.New("storage: maxBytes must be non-negative")
	}
	out, err := c.s3.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		return nil, wrap("get", bucket, key, err)
	}
	defer out.Body.Close()
	if out.ContentLength != nil && *out.ContentLength > maxBytes {
		return nil, ErrTooLarge
	}
	limit := maxBytes
	if limit < math.MaxInt64 {
		limit++ // read one extra byte to detect overflow of the cap
	}
	data, err := io.ReadAll(io.LimitReader(out.Body, limit))
	if err != nil {
		return nil, wrap("get", bucket, key, err)
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrTooLarge
	}
	return data, nil
}

// Head returns object metadata including the stored SHA-256 checksum (hex),
// which is empty when the object has no full-object SHA-256 checksum (see
// Object.ChecksumSHA256Hex: empty means unverified). A missing bucket also
// yields ErrNotFound, because HEAD 404 responses have no body to distinguish
// NoSuchBucket; verify buckets at startup.
func (c *Client) Head(ctx context.Context, bucket, key string) (Object, error) {
	out, err := c.s3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket:       aws.String(bucket),
		Key:          aws.String(key),
		ChecksumMode: types.ChecksumModeEnabled,
	})
	if err != nil {
		return Object{}, wrap("head", bucket, key, err)
	}
	obj := Object{Size: aws.ToInt64(out.ContentLength), ContentType: aws.ToString(out.ContentType)}
	if s := aws.ToString(out.ChecksumSHA256); s != "" {
		// Composite (multipart) checksums look like "base64-N" and do not
		// decode to 32 bytes; those are reported as empty.
		if raw, err := base64.StdEncoding.DecodeString(s); err == nil && len(raw) == 32 {
			obj.ChecksumSHA256Hex = hex.EncodeToString(raw)
		}
	}
	return obj, nil
}

// Delete removes an object. A missing key is not an error. Note that a
// missing bucket is indistinguishable here (HEAD/DELETE 404s carry no error
// body), so callers should verify buckets at startup (e.g. HeadBucket).
func (c *Client) Delete(ctx context.Context, bucket, key string) error {
	_, err := c.s3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		if isNotFound(err) {
			return nil
		}
		return wrap("delete", bucket, key, err)
	}
	return nil
}

// DeletePrefix removes every object under prefix and returns how many were
// deleted. prefix must be non-empty and end with "/" so a bug can never wipe
// a whole bucket or a sibling prefix sharing the same leading characters.
func (c *Client) DeletePrefix(ctx context.Context, bucket, prefix string) (int, error) {
	if prefix == "" || prefix == "/" || !strings.HasSuffix(prefix, "/") {
		return 0, fmt.Errorf("storage: refusing to delete prefix %q: must be non-empty and end with \"/\"", prefix)
	}
	deleted := 0
	p := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
		Bucket:  aws.String(bucket),
		Prefix:  aws.String(prefix),
		MaxKeys: aws.Int32(deleteBatch),
	})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return deleted, wrap("list", bucket, prefix, err)
		}
		if c.singleDelete {
			for _, o := range page.Contents {
				if _, err := c.s3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: o.Key}); err != nil && !isNotFound(err) {
					return deleted, wrap("delete-prefix", bucket, prefix, err)
				}
				deleted++
			}
			continue
		}
		ids := make([]types.ObjectIdentifier, 0, len(page.Contents))
		for _, o := range page.Contents {
			ids = append(ids, types.ObjectIdentifier{Key: o.Key})
		}
		for start := 0; start < len(ids); start += deleteBatch {
			end := min(start+deleteBatch, len(ids))
			out, err := c.s3.DeleteObjects(ctx, &s3.DeleteObjectsInput{
				Bucket: aws.String(bucket),
				Delete: &types.Delete{Objects: ids[start:end], Quiet: aws.Bool(true)},
			})
			if err != nil {
				return deleted, wrap("delete-prefix", bucket, prefix, err)
			}
			if len(out.Errors) > 0 {
				e := out.Errors[0]
				return deleted + (end - start - len(out.Errors)), fmt.Errorf("storage: delete-prefix %s/%s: %d keys failed, first %q: %s",
					bucket, prefix, len(out.Errors), aws.ToString(e.Key), aws.ToString(e.Code))
			}
			deleted += end - start
		}
	}
	return deleted, nil
}

// Copy performs a server-side copy.
func (c *Client) Copy(ctx context.Context, srcBucket, srcKey, dstBucket, dstKey string) error {
	_, err := c.s3.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(dstBucket),
		Key:        aws.String(dstKey),
		CopySource: aws.String(escapePath(srcBucket + "/" + srcKey)),
		// Recompute SHA-256 on the copy so Head can verify replicas.
		ChecksumAlgorithm: types.ChecksumAlgorithmSha256,
	})
	if err != nil {
		return wrap("copy", srcBucket, srcKey, err)
	}
	return nil
}

// PresignPut presigns a PUT bound to contentType and the SHA-256 checksum
// (lowercase hex). The browser must send exactly the returned headers.
func (c *Client) PresignPut(ctx context.Context, bucket, key, contentType, sha256Hex string, ttl time.Duration) (PresignedRequest, error) {
	if !isLowerHex64(sha256Hex) {
		return PresignedRequest{}, errors.New("storage: sha256 must be 64 lowercase hex characters")
	}
	if contentType == "" {
		return PresignedRequest{}, errors.New("storage: content type is required")
	}
	if ttl <= 0 || ttl > maxPresignTTL {
		return PresignedRequest{}, errors.New("storage: ttl must be in (0, 7d]")
	}
	raw, _ := hex.DecodeString(sha256Hex)
	req, err := c.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:         aws.String(bucket),
		Key:            aws.String(key),
		ContentType:    aws.String(contentType),
		ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(raw)),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return PresignedRequest{}, wrap("presign-put", bucket, key, err)
	}
	headers := make(map[string]string, len(req.SignedHeader))
	for name, vals := range req.SignedHeader {
		if strings.EqualFold(name, "Host") || len(vals) == 0 {
			continue
		}
		headers[http.CanonicalHeaderKey(name)] = strings.Join(vals, ",")
	}
	return PresignedRequest{URL: req.URL, Method: req.Method, Headers: headers}, nil
}

// PresignGet presigns a GET. A non-empty downloadName forces an attachment
// Content-Disposition with an RFC 5987 encoded filename.
func (c *Client) PresignGet(ctx context.Context, bucket, key string, ttl time.Duration, downloadName string) (string, error) {
	if ttl <= 0 || ttl > maxPresignTTL {
		return "", errors.New("storage: ttl must be in (0, 7d]")
	}
	in := &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)}
	if downloadName != "" {
		in.ResponseContentDisposition = aws.String("attachment; filename*=UTF-8''" + rfc5987Encode(downloadName))
	}
	req, err := c.presigner.PresignGetObject(ctx, in, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", wrap("presign-get", bucket, key, err)
	}
	return req.URL, nil
}

// opError is a storage error whose message names only the operation, bucket,
// key and a coarse category. The SDK error (which may embed the endpoint host,
// request URL and query string) stays reachable via Unwrap.
type opError struct {
	msg string
	err error
}

func (e *opError) Error() string { return e.msg }
func (e *opError) Unwrap() error { return e.err }

func wrap(op, bucket, key string, err error) error {
	prefix := fmt.Sprintf("storage: %s %s/%s: ", op, bucket, key)
	if isNotFound(err) {
		return &opError{msg: prefix + ErrNotFound.Error(), err: notFoundError{err}}
	}
	return &opError{msg: prefix + category(err), err: err}
}

// notFoundError makes errors.Is(err, ErrNotFound) true while keeping the SDK
// error reachable.
type notFoundError struct{ err error }

func (e notFoundError) Error() string   { return ErrNotFound.Error() }
func (e notFoundError) Unwrap() []error { return []error{ErrNotFound, e.err} }

func category(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	var api smithy.APIError
	if errors.As(err, &api) {
		code := api.ErrorCode()
		var re *smithyhttp.ResponseError
		if errors.As(err, &re) {
			return fmt.Sprintf("service error %d %s", re.HTTPStatusCode(), code)
		}
		return "service error " + code
	}
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) {
		return fmt.Sprintf("service error %d", re.HTTPStatusCode())
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "transport timeout"
	}
	var oe *net.OpError
	if errors.As(err, &oe) {
		return "transport error"
	}
	return "request failed"
}

func isNotFound(err error) bool {
	var nsk *types.NoSuchKey
	var nf *types.NotFound
	if errors.As(err, &nsk) || errors.As(err, &nf) {
		return true
	}
	var api smithy.APIError
	if errors.As(err, &api) {
		switch api.ErrorCode() {
		case "NoSuchKey", "NotFound":
			return true
		}
	}
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) && re.HTTPStatusCode() == http.StatusNotFound {
		// A 404 on a missing bucket is a configuration error, not a missing key.
		if errors.As(err, &api) && api.ErrorCode() == "NoSuchBucket" {
			return false
		}
		return true
	}
	return false
}

func isLowerHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

// rfc5987Encode percent-encodes everything outside RFC 5987 attr-char.
func rfc5987Encode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if isAttrChar(ch) {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

func isAttrChar(ch byte) bool {
	switch {
	case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		return true
	}
	return strings.IndexByte("!#$&+-.^_`|~", ch) >= 0
}

// escapePath URL-encodes each "/"-separated segment for x-amz-copy-source.
func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}
