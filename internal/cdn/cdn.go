// Package cdn purges cached public derived images from the CDN.
//
// The production implementation talks to Tencent Cloud EdgeOne (EO) through
// the official SDK. When EO credentials are not configured a noop purger is
// used instead and a single warning is logged (spec §3). Withdrawal (spec §7)
// rotates derived objects under d/{photoId}/{hash}/ and then purges the old
// prefixes, so the API is prefix based.
package cdn

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	sdkerrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	teo "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/teo/v20220901"
)

const (
	// BatchSize is the maximum number of targets sent in one EO
	// CreatePurgeTask call. Larger prefix lists are split into consecutive
	// batches of this size, sent in order; the first failing batch aborts.
	BatchSize = 100

	eoEndpoint       = "teo.tencentcloudapi.com"
	eoRegion         = "" // EO is a global service.
	eoTimeoutSeconds = 10
	purgeType        = "purge_prefix"
	// purgeMethod is set explicitly: we do not rely on EO's default mode.
	purgeMethod = "invalidate"
)

// ErrInvalidPrefix is returned when a prefix is not a relative path ending
// in "/" (for example an absolute URL, a leading "/", or a missing trailing
// "/").
var ErrInvalidPrefix = errors.New("cdn: invalid purge prefix")

// Purger invalidates cached CDN content under the given relative prefixes,
// such as "d/{photoId}/{hash}/".
type Purger interface {
	PurgePrefixes(ctx context.Context, prefixes []string) error
}

// Options configures the EO purger. If SecretID, SecretKey or ZoneID is
// empty, New returns a noop purger.
type Options struct {
	SecretID  string
	SecretKey string
	ZoneID    string
	// Base is the public CDN origin, e.g. "https://img.example.com".
	// Targets are Base + "/" + prefix.
	Base string
}

// ErrInvalidBase is returned by New when EO credentials are set but Base is
// not an https origin (scheme + host only, optional single trailing "/").
var ErrInvalidBase = errors.New("cdn: invalid CDN base")

// New returns an EO-backed Purger. It returns a noop Purger (with one
// secret-free warning via logf) when any EO credential is missing, or when
// credentials are set but Base is empty (no CDN in front of public images,
// so nothing to purge). With credentials set, a non-empty Base that is not
// a plain https origin is an error wrapping ErrInvalidBase. logf may be nil.
func New(opts Options, logf func(format string, args ...any)) (Purger, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if opts.SecretID == "" || opts.SecretKey == "" || opts.ZoneID == "" {
		logf("cdn: EO purge not configured (MARKR_EO_* incomplete); using noop purger, withdrawn public images stay cached until CDN expiry")
		return noop{}, nil
	}
	if opts.Base == "" {
		logf("cdn: EO credentials set but MARKR_CDN_BASE is empty; using noop purger")
		return noop{}, nil
	}
	base, err := parseBase(opts.Base)
	if err != nil {
		return nil, err
	}
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = eoEndpoint
	cpf.HttpProfile.ReqTimeout = eoTimeoutSeconds
	client, err := teo.NewClient(common.NewCredential(opts.SecretID, opts.SecretKey), eoRegion, cpf)
	if err != nil {
		// The SDK error is not wrapped: keep secrets out of the message.
		return nil, errors.New("cdn: EO client init failed")
	}
	return newEO(client, opts.ZoneID, base, []string{opts.SecretID, opts.SecretKey}), nil
}

// parseBase validates base as "https://host[:port]" with an optional single
// trailing "/", and returns it without the trailing "/". Error messages
// never echo the input, which could carry userinfo credentials.
func parseBase(base string) (string, error) {
	invalid := func(why string) (string, error) {
		return "", fmt.Errorf("%w: %s", ErrInvalidBase, why)
	}
	if strings.ContainsAny(base, "?#") {
		return invalid("query or fragment not allowed")
	}
	u, err := url.Parse(base)
	if err != nil {
		return invalid("not a valid URL")
	}
	switch {
	case u.Scheme != "https":
		return invalid("scheme must be https")
	case u.User != nil:
		return invalid("userinfo not allowed")
	case u.Opaque != "" || u.Hostname() == "":
		return invalid("host is required")
	case u.Path != "" && u.Path != "/":
		return invalid("path not allowed")
	case u.RawQuery != "" || u.ForceQuery || u.Fragment != "":
		return invalid("query or fragment not allowed")
	}
	return u.Scheme + "://" + u.Host, nil
}

// purgeAPI is the subset of the EO client used here; tests inject a fake.
type purgeAPI interface {
	CreatePurgeTaskWithContext(ctx context.Context, req *teo.CreatePurgeTaskRequest) (*teo.CreatePurgeTaskResponse, error)
}

type eoPurger struct {
	api     purgeAPI
	zoneID  string
	base    string
	secrets []string
}

func newEO(api purgeAPI, zoneID, base string, secrets []string) *eoPurger {
	var s []string
	for _, v := range secrets {
		if v != "" {
			s = append(s, v)
		}
	}
	return &eoPurger{api: api, zoneID: zoneID, base: strings.TrimRight(base, "/"), secrets: s}
}

func (p *eoPurger) PurgePrefixes(ctx context.Context, prefixes []string) error {
	clean, err := normalize(prefixes)
	if err != nil {
		return err
	}
	total := len(clean)
	batches := (total + BatchSize - 1) / BatchSize
	for i, start := 0, 0; start < total; i, start = i+1, start+BatchSize {
		// start is also the number of targets already accepted by EO.
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("cdn: purge stopped before batch %d/%d (%d of %d targets purged): %w", i+1, batches, start, total, err)
		}
		end := min(start+BatchSize, total)
		if err := p.purgeBatch(ctx, clean[start:end]); err != nil {
			return fmt.Errorf("cdn: purge batch %d/%d failed (%d of %d targets purged): %w", i+1, batches, start, total, err)
		}
	}
	return nil
}

func (p *eoPurger) purgeBatch(ctx context.Context, prefixes []string) error {
	req := teo.NewCreatePurgeTaskRequest()
	req.ZoneId = common.StringPtr(p.zoneID)
	req.Type = common.StringPtr(purgeType)
	req.Method = common.StringPtr(purgeMethod)
	req.Targets = make([]*string, 0, len(prefixes))
	for _, prefix := range prefixes {
		req.Targets = append(req.Targets, common.StringPtr(p.base+"/"+prefix))
	}

	resp, err := p.api.CreatePurgeTaskWithContext(ctx, req)
	if err != nil {
		return p.sdkError(len(prefixes), err)
	}
	if resp == nil || resp.Response == nil {
		return fmt.Errorf("cdn: EO purge of %d targets returned empty response", len(prefixes))
	}
	if fl := resp.Response.FailedList; len(fl) > 0 {
		failed := 0
		first := ""
		for _, f := range fl {
			if f == nil {
				continue
			}
			failed += len(f.Targets)
			if first == "" && f.Reason != nil {
				first = *f.Reason
			}
		}
		if failed == 0 {
			// EO gave reasons without listing targets; treat the batch as failed.
			failed = len(prefixes)
		}
		return fmt.Errorf("cdn: EO purge failed for %d targets: %s", failed, p.redact(first))
	}
	return nil
}

// sdkError converts an SDK error into one whose message never contains the
// configured secrets. Context cancellation/deadline is preserved for
// errors.Is; the raw SDK error is not wrapped so it cannot leak via Unwrap.
func (p *eoPurger) sdkError(n int, err error) error {
	detail := err.Error()
	var sdkErr *sdkerrors.TencentCloudSDKError
	if errors.As(err, &sdkErr) {
		detail = fmt.Sprintf("code=%s message=%s request_id=%s", sdkErr.GetCode(), sdkErr.GetMessage(), sdkErr.GetRequestId())
	}
	msg := fmt.Sprintf("cdn: EO purge of %d targets failed: %s", n, p.redact(detail))
	var cause error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		cause = context.DeadlineExceeded
	case errors.Is(err, context.Canceled):
		cause = context.Canceled
	}
	return &purgeError{msg: msg, cause: cause}
}

func (p *eoPurger) redact(s string) string {
	for _, secret := range p.secrets {
		s = strings.ReplaceAll(s, secret, "[REDACTED]")
	}
	return s
}

type purgeError struct {
	msg   string
	cause error
}

func (e *purgeError) Error() string { return e.msg }
func (e *purgeError) Unwrap() error { return e.cause }

// normalize validates every prefix and returns them deduplicated in
// first-seen order.
func normalize(prefixes []string) ([]string, error) {
	seen := make(map[string]struct{}, len(prefixes))
	out := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		if err := validatePrefix(prefix); err != nil {
			return nil, err
		}
		if _, dup := seen[prefix]; dup {
			continue
		}
		seen[prefix] = struct{}{}
		out = append(out, prefix)
	}
	return out, nil
}

// validatePrefix accepts only relative paths of non-empty segments made of
// [A-Za-z0-9._~-] (no "." or ".." segments), ending in "/".
func validatePrefix(prefix string) error {
	if prefix == "" || strings.HasPrefix(prefix, "/") || !strings.HasSuffix(prefix, "/") {
		return fmt.Errorf("%w: %q", ErrInvalidPrefix, prefix)
	}
	for _, seg := range strings.Split(strings.TrimSuffix(prefix, "/"), "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("%w: %q", ErrInvalidPrefix, prefix)
		}
		for _, r := range seg {
			ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
				r == '.' || r == '_' || r == '~' || r == '-'
			if !ok {
				return fmt.Errorf("%w: %q", ErrInvalidPrefix, prefix)
			}
		}
	}
	return nil
}

// noop is used when EO is not configured. It still validates input so
// callers see the same contract in every environment.
type noop struct{}

func (noop) PurgePrefixes(_ context.Context, prefixes []string) error {
	_, err := normalize(prefixes)
	return err
}

// Fake is an in-memory Purger for tests. It validates input like the real
// purger, records purged prefixes in call order, and can be told to fail.
// The zero value is ready to use and safe for concurrent use.
type Fake struct {
	mu    sync.Mutex
	calls [][]string
	err   error
}

// PurgePrefixes records the (deduplicated) prefixes, or returns the
// configured error without recording.
func (f *Fake) PurgePrefixes(_ context.Context, prefixes []string) error {
	clean, err := normalize(prefixes)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	if len(clean) > 0 {
		f.calls = append(f.calls, clean)
	}
	return nil
}

// SetErr makes subsequent calls fail with err; nil restores success.
func (f *Fake) SetErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

// Prefixes returns a copy of all recorded prefixes, flattened in call order.
func (f *Fake) Prefixes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		out = append(out, c...)
	}
	return out
}

// Calls returns a copy of the recorded prefixes grouped per successful call.
func (f *Fake) Calls() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = append([]string(nil), c...)
	}
	return out
}
