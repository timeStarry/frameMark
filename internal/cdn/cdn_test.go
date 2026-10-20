package cdn

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	sdkerrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	teo "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/teo/v20220901"
)

const testBase = "https://img.example.test"

type fakeAPI struct {
	mu       sync.Mutex
	reqs     []*teo.CreatePurgeTaskRequest
	err      error
	failList []*teo.FailReason
}

func (f *fakeAPI) CreatePurgeTaskWithContext(ctx context.Context, req *teo.CreatePurgeTaskRequest) (*teo.CreatePurgeTaskResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	if f.err != nil {
		return nil, f.err
	}
	resp := teo.NewCreatePurgeTaskResponse()
	resp.Response = &teo.CreatePurgeTaskResponseParams{
		JobId:      strp("job-1"),
		FailedList: f.failList,
	}
	return resp, nil
}

func strp(s string) *string { return &s }

func targets(req *teo.CreatePurgeTaskRequest) []string {
	out := make([]string, 0, len(req.Targets))
	for _, t := range req.Targets {
		out = append(out, *t)
	}
	return out
}

type logRecorder struct {
	lines []string
}

func (l *logRecorder) logf(format string, args ...any) {
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func TestNewNoopWhenUnconfigured(t *testing.T) {
	cases := []Options{
		{SecretKey: "sk-secret", ZoneID: "zone-1", Base: testBase},
		{SecretID: "AKIDsecret", ZoneID: "zone-1", Base: testBase},
		{SecretID: "AKIDsecret", SecretKey: "sk-secret", Base: testBase},
		{},
	}
	for i, opts := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			rec := &logRecorder{}
			p, err := New(opts, rec.logf)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if _, ok := p.(noop); !ok {
				t.Fatalf("expected noop purger, got %T", p)
			}
			if len(rec.lines) != 1 {
				t.Fatalf("expected exactly one warning, got %d: %v", len(rec.lines), rec.lines)
			}
			if strings.Contains(rec.lines[0], "AKIDsecret") || strings.Contains(rec.lines[0], "sk-secret") {
				t.Fatalf("warning leaks secret: %q", rec.lines[0])
			}
			// Further calls must not log again.
			if err := p.PurgePrefixes(context.Background(), []string{"d/p1/h1/"}); err != nil {
				t.Fatalf("noop purge: %v", err)
			}
			if err := p.PurgePrefixes(context.Background(), []string{"d/p2/h2/"}); err != nil {
				t.Fatalf("noop purge: %v", err)
			}
			if len(rec.lines) != 1 {
				t.Fatalf("warning logged more than once: %v", rec.lines)
			}
		})
	}
}

func TestNewConfiguredReturnsEO(t *testing.T) {
	rec := &logRecorder{}
	p, err := New(Options{SecretID: "id", SecretKey: "key", ZoneID: "zone-1", Base: testBase + "/"}, rec.logf)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	eo, ok := p.(*eoPurger)
	if !ok {
		t.Fatalf("expected *eoPurger, got %T", p)
	}
	if eo.base != testBase {
		t.Fatalf("base not normalized: %q", eo.base)
	}
	if len(rec.lines) != 0 {
		t.Fatalf("unexpected log lines: %v", rec.lines)
	}
}

func TestPurgeRequestShape(t *testing.T) {
	api := &fakeAPI{}
	p := newEO(api, "zone-1", testBase, nil)
	if err := p.PurgePrefixes(context.Background(), []string{"d/p1/h1/", "d/p2/h2/"}); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if len(api.reqs) != 1 {
		t.Fatalf("expected 1 call, got %d", len(api.reqs))
	}
	req := api.reqs[0]
	if *req.ZoneId != "zone-1" || *req.Type != "purge_prefix" || *req.Method != "invalidate" {
		t.Fatalf("bad request: zone=%s type=%s method=%s", *req.ZoneId, *req.Type, *req.Method)
	}
	got := targets(req)
	want := []string{testBase + "/d/p1/h1/", testBase + "/d/p2/h2/"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("targets = %v, want %v", got, want)
	}
}

func TestPurgeEmptyIsNoop(t *testing.T) {
	api := &fakeAPI{}
	p := newEO(api, "zone-1", testBase, nil)
	if err := p.PurgePrefixes(context.Background(), nil); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if len(api.reqs) != 0 {
		t.Fatalf("expected no calls, got %d", len(api.reqs))
	}
}

func TestPurgeValidation(t *testing.T) {
	bad := []string{
		"https://img.example.test/d/p1/h1/",
		"//img.example.test/d/p1/h1/",
		"/d/p1/h1/",
		"d/p1/h1",
		"d/p1/h1/x.jpg",
		"",
		"/",
		"d/../secret/",
		"d/p1 h1/",
		"d/p1/h1/?x=1/",
		"d/p1/h1#frag/",
		"d/p1/#/",
		"d/p1\r\nX-Injected: 1/",
		"d/p1\n/",
		"d/p1\r/",
		"d/p1\t/",
		"d/./h1/",
		"d/p1/./",
		"d//h1/",
		"d/pé/h1/",
	}
	for _, prefix := range bad {
		t.Run(prefix, func(t *testing.T) {
			api := &fakeAPI{}
			p := newEO(api, "zone-1", testBase, nil)
			err := p.PurgePrefixes(context.Background(), []string{"d/ok/ok/", prefix})
			if !errors.Is(err, ErrInvalidPrefix) {
				t.Fatalf("expected ErrInvalidPrefix, got %v", err)
			}
			if len(api.reqs) != 0 {
				t.Fatalf("expected no calls on invalid input, got %d", len(api.reqs))
			}
		})
	}
}

func TestNoopAlsoValidates(t *testing.T) {
	p, err := New(Options{}, func(string, ...any) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := p.PurgePrefixes(context.Background(), []string{"/d/x/"}); !errors.Is(err, ErrInvalidPrefix) {
		t.Fatalf("expected ErrInvalidPrefix, got %v", err)
	}
}

func TestPurgeDedupe(t *testing.T) {
	api := &fakeAPI{}
	p := newEO(api, "zone-1", testBase, nil)
	in := []string{"d/a/1/", "d/b/2/", "d/a/1/", "d/c/3/", "d/b/2/"}
	if err := p.PurgePrefixes(context.Background(), in); err != nil {
		t.Fatalf("purge: %v", err)
	}
	got := targets(api.reqs[0])
	want := []string{testBase + "/d/a/1/", testBase + "/d/b/2/", testBase + "/d/c/3/"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("targets = %v, want %v", got, want)
	}
}

func TestPurgeBatching(t *testing.T) {
	api := &fakeAPI{}
	p := newEO(api, "zone-1", testBase, nil)
	in := make([]string, 250)
	for i := range in {
		in[i] = fmt.Sprintf("d/p%03d/h/", i)
	}
	if err := p.PurgePrefixes(context.Background(), in); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if len(api.reqs) != 3 {
		t.Fatalf("expected 3 calls, got %d", len(api.reqs))
	}
	sizes := []int{100, 100, 50}
	n := 0
	for i, req := range api.reqs {
		got := targets(req)
		if len(got) != sizes[i] {
			t.Fatalf("batch %d size = %d, want %d", i, len(got), sizes[i])
		}
		for _, tgt := range got {
			if want := testBase + "/" + in[n]; tgt != want {
				t.Fatalf("target %d = %q, want %q", n, tgt, want)
			}
			n++
		}
	}
}

func TestPurgeFailedListIsError(t *testing.T) {
	api := &fakeAPI{failList: []*teo.FailReason{
		{Reason: strp("quota exceeded"), Targets: []*string{strp(testBase + "/d/a/1/"), strp(testBase + "/d/b/2/")}},
		{Reason: strp("other"), Targets: []*string{strp(testBase + "/d/c/3/")}},
	}}
	p := newEO(api, "zone-1", testBase, nil)
	err := p.PurgePrefixes(context.Background(), []string{"d/a/1/", "d/b/2/", "d/c/3/"})
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "3") || !strings.Contains(msg, "quota exceeded") {
		t.Fatalf("error lacks count or first reason: %q", msg)
	}
	if strings.Contains(msg, "other") {
		t.Fatalf("error should include only the first reason: %q", msg)
	}
}

func TestPurgeSDKErrorRedactsSecret(t *testing.T) {
	api := &fakeAPI{err: errors.New("auth failed for AKIDsecret with key sk-secret")}
	p := newEO(api, "zone-1", testBase, []string{"AKIDsecret", "sk-secret"})
	err := p.PurgePrefixes(context.Background(), []string{"d/a/1/"})
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "AKIDsecret") || strings.Contains(err.Error(), "sk-secret") {
		t.Fatalf("error leaks secret: %q", err.Error())
	}
}

func TestPurgeStopsAfterFailedBatch(t *testing.T) {
	api := &fakeAPI{err: errors.New("boom")}
	p := newEO(api, "zone-1", testBase, nil)
	in := make([]string, 250)
	for i := range in {
		in[i] = fmt.Sprintf("d/p%03d/h/", i)
	}
	if err := p.PurgePrefixes(context.Background(), in); err == nil {
		t.Fatal("expected error")
	}
	if len(api.reqs) != 1 {
		t.Fatalf("expected to stop after first failed batch, got %d calls", len(api.reqs))
	}
}

func TestPurgeContextErrorIsWrapped(t *testing.T) {
	api := &fakeAPI{err: context.DeadlineExceeded}
	p := newEO(api, "zone-1", testBase, nil)
	err := p.PurgePrefixes(context.Background(), []string{"d/a/1/"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
}

func TestFakeRecordsAndFails(t *testing.T) {
	f := &Fake{}
	var _ Purger = f
	if err := f.PurgePrefixes(context.Background(), []string{"d/a/1/", "d/b/2/"}); err != nil {
		t.Fatalf("fake purge: %v", err)
	}
	if err := f.PurgePrefixes(context.Background(), []string{"d/c/3/"}); err != nil {
		t.Fatalf("fake purge: %v", err)
	}
	got := f.Prefixes()
	if strings.Join(got, ",") != "d/a/1/,d/b/2/,d/c/3/" {
		t.Fatalf("recorded = %v", got)
	}
	got[0] = "mutated"
	if f.Prefixes()[0] != "d/a/1/" {
		t.Fatal("Prefixes must return a copy")
	}
	if len(f.Calls()) != 2 {
		t.Fatalf("calls = %d, want 2", len(f.Calls()))
	}

	boom := errors.New("boom")
	f.SetErr(boom)
	if err := f.PurgePrefixes(context.Background(), []string{"d/d/4/"}); !errors.Is(err, boom) {
		t.Fatalf("expected boom, got %v", err)
	}
	if len(f.Prefixes()) != 3 {
		t.Fatalf("failed call must not be recorded as purged: %v", f.Prefixes())
	}
	f.SetErr(nil)

	if err := f.PurgePrefixes(context.Background(), []string{"/bad"}); !errors.Is(err, ErrInvalidPrefix) {
		t.Fatalf("fake should validate, got %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = f.PurgePrefixes(context.Background(), []string{fmt.Sprintf("d/x%d/h/", i)})
		}(i)
	}
	wg.Wait()
	if len(f.Prefixes()) != 23 {
		t.Fatalf("concurrent recording lost entries: %d", len(f.Prefixes()))
	}
}

func TestNewBaseValidation(t *testing.T) {
	creds := Options{SecretID: "AKIDsecret", SecretKey: "sk-secret", ZoneID: "zone-1"}

	good := map[string]string{
		"https://img.example.test":      "https://img.example.test",
		"https://img.example.test/":     "https://img.example.test",
		"https://img.example.test:8443": "https://img.example.test:8443",
	}
	for in, want := range good {
		t.Run("ok "+in, func(t *testing.T) {
			o := creds
			o.Base = in
			p, err := New(o, func(string, ...any) {})
			if err != nil {
				t.Fatalf("New(%q): %v", in, err)
			}
			eo, ok := p.(*eoPurger)
			if !ok {
				t.Fatalf("expected *eoPurger, got %T", p)
			}
			if eo.base != want {
				t.Fatalf("base = %q, want %q", eo.base, want)
			}
		})
	}

	bad := []string{
		"img.example.test",
		"http://img.example.test",
		"ftp://img.example.test",
		"https://",
		"https:///d",
		"https://img.example.test/sub",
		"https://img.example.test/sub/",
		"https://img.example.test//",
		"https://img.example.test?x=1",
		"https://img.example.test/?",
		"https://img.example.test#frag",
		"https://user:pass@img.example.test",
		"https://user@img.example.test",
		"//img.example.test",
		"https://img.example.test\r\n",
		" https://img.example.test",
		"://bad",
	}
	for _, in := range bad {
		t.Run("bad "+in, func(t *testing.T) {
			o := creds
			o.Base = in
			rec := &logRecorder{}
			p, err := New(o, rec.logf)
			if !errors.Is(err, ErrInvalidBase) {
				t.Fatalf("New(%q) err = %v, want ErrInvalidBase", in, err)
			}
			if p != nil {
				t.Fatalf("expected nil purger on error, got %T", p)
			}
			msg := err.Error()
			if strings.Contains(msg, "AKIDsecret") || strings.Contains(msg, "sk-secret") || strings.Contains(msg, "pass") {
				t.Fatalf("error leaks secret: %q", msg)
			}
		})
	}
}

func TestNewEmptyBaseWithCredsIsNoop(t *testing.T) {
	rec := &logRecorder{}
	p, err := New(Options{SecretID: "AKIDsecret", SecretKey: "sk-secret", ZoneID: "zone-1"}, rec.logf)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, ok := p.(noop); !ok {
		t.Fatalf("expected noop, got %T", p)
	}
	if len(rec.lines) != 1 {
		t.Fatalf("expected one warning, got %v", rec.lines)
	}
	if strings.Contains(rec.lines[0], "AKIDsecret") || strings.Contains(rec.lines[0], "sk-secret") {
		t.Fatalf("warning leaks secret: %q", rec.lines[0])
	}
}

// scriptedAPI returns per-call results and can cancel a context mid-run.
type scriptedAPI struct {
	calls   int
	errs    map[int]error
	fails   map[int][]*teo.FailReason
	onCall  func(n int)
	targets [][]string
}

func (s *scriptedAPI) CreatePurgeTaskWithContext(ctx context.Context, req *teo.CreatePurgeTaskRequest) (*teo.CreatePurgeTaskResponse, error) {
	n := s.calls
	s.calls++
	s.targets = append(s.targets, targets(req))
	if s.onCall != nil {
		s.onCall(n)
	}
	if err := s.errs[n]; err != nil {
		return nil, err
	}
	resp := teo.NewCreatePurgeTaskResponse()
	resp.Response = &teo.CreatePurgeTaskResponseParams{JobId: strp("job"), FailedList: s.fails[n]}
	return resp, nil
}

func manyPrefixes(n int) []string {
	in := make([]string, n)
	for i := range in {
		in[i] = fmt.Sprintf("d/p%03d/h/", i)
	}
	return in
}

func TestPurgeChecksContextBetweenBatches(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	api := &scriptedAPI{onCall: func(n int) {
		if n == 0 {
			cancel()
		}
	}}
	p := newEO(api, "zone-1", testBase, nil)
	err := p.PurgePrefixes(ctx, manyPrefixes(250))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if api.calls != 1 {
		t.Fatalf("expected 1 call before cancellation was noticed, got %d", api.calls)
	}
	if !strings.Contains(err.Error(), "100 of 250") {
		t.Fatalf("error should report progress: %q", err.Error())
	}
}

func TestPurgeCanceledBeforeStartMakesNoCall(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	api := &scriptedAPI{}
	p := newEO(api, "zone-1", testBase, nil)
	if err := p.PurgePrefixes(ctx, []string{"d/a/1/"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if api.calls != 0 {
		t.Fatalf("expected no calls, got %d", api.calls)
	}
}

func TestPurgePartialFailureReportsProgress(t *testing.T) {
	api := &scriptedAPI{errs: map[int]error{1: errors.New("network down")}}
	p := newEO(api, "zone-1", testBase, nil)
	err := p.PurgePrefixes(context.Background(), manyPrefixes(250))
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "batch 2/3") || !strings.Contains(msg, "100 of 250") {
		t.Fatalf("error should report batch and succeeded count: %q", msg)
	}
	if api.calls != 2 {
		t.Fatalf("expected stop after failing batch, got %d calls", api.calls)
	}
}

func TestPurgePartialFailedListReportsProgress(t *testing.T) {
	api := &scriptedAPI{fails: map[int][]*teo.FailReason{2: {{Reason: strp("quota"), Targets: []*string{strp("x")}}}}}
	p := newEO(api, "zone-1", testBase, nil)
	err := p.PurgePrefixes(context.Background(), manyPrefixes(250))
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "batch 3/3") || !strings.Contains(msg, "200 of 250") || !strings.Contains(msg, "quota") {
		t.Fatalf("unexpected message: %q", msg)
	}
}

func TestPurgeFailedListWithoutTargetsCountsBatch(t *testing.T) {
	api := &fakeAPI{failList: []*teo.FailReason{{Reason: strp("internal error")}}}
	p := newEO(api, "zone-1", testBase, nil)
	err := p.PurgePrefixes(context.Background(), []string{"d/a/1/", "d/b/2/"})
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if strings.Contains(msg, "failed for 0 targets") {
		t.Fatalf("misleading zero count: %q", msg)
	}
	if !strings.Contains(msg, "failed for 2 targets") || !strings.Contains(msg, "internal error") {
		t.Fatalf("unexpected message: %q", msg)
	}
}

func TestPurgeSDKErrorFormat(t *testing.T) {
	api := &fakeAPI{err: sdkerrors.NewTencentCloudSDKError("AuthFailure.SignatureFailure", "bad sig for AKIDsecret", "req-123")}
	p := newEO(api, "zone-1", testBase, []string{"AKIDsecret", "sk-secret"})
	err := p.PurgePrefixes(context.Background(), []string{"d/a/1/"})
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	for _, want := range []string{"AuthFailure.SignatureFailure", "req-123"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error lacks %q: %q", want, msg)
		}
	}
	if strings.Contains(msg, "AKIDsecret") {
		t.Fatalf("error leaks secret: %q", msg)
	}
}
