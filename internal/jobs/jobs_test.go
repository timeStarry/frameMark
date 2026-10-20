package jobs_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/jobs"
)

const (
	sec   = int64(1000)
	lease = 2 * 60 * sec
	t0    = int64(1_700_000_000_000)
)

type fakeClock struct{ ms atomic.Int64 }

func (c *fakeClock) now() int64      { return c.ms.Load() }
func (c *fakeClock) advance(d int64) { c.ms.Add(d) }

func setup(t *testing.T) (*jobs.Queue, *sql.DB, *fakeClock) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "jobs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	c := &fakeClock{}
	c.ms.Store(t0)
	return jobs.New(d, c.now), d, c
}

type row struct {
	state     string
	attempts  int
	runAfter  int64
	lease     sql.NullInt64
	token     sql.NullString
	lastError sql.NullString
}

func getRow(t *testing.T, d *sql.DB, id string) row {
	t.Helper()
	var r row
	err := d.QueryRow(`SELECT state, attempts, run_after, lease_until, lease_token, last_error FROM jobs WHERE id=?`, id).
		Scan(&r.state, &r.attempts, &r.runAfter, &r.lease, &r.token, &r.lastError)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func mustClaim(t *testing.T, q *jobs.Queue, kinds ...string) *jobs.Job {
	t.Helper()
	j, err := q.Claim(context.Background(), kinds)
	if err != nil {
		t.Fatal(err)
	}
	if j == nil {
		t.Fatal("expected a job, got nil")
	}
	return j
}

func mustNone(t *testing.T, q *jobs.Queue, kinds ...string) {
	t.Helper()
	j, err := q.Claim(context.Background(), kinds)
	if err != nil {
		t.Fatal(err)
	}
	if j != nil {
		t.Fatalf("expected nil, got job %s (%s)", j.ID, j.Kind)
	}
}

func TestEnqueueClaimDone(t *testing.T) {
	q, d, _ := setup(t)
	ctx := context.Background()
	id, err := q.Enqueue(ctx, "process_photo", map[string]string{"photoId": "p1"})
	if err != nil {
		t.Fatal(err)
	}
	if r := getRow(t, d, id); r.state != "queued" || r.attempts != 0 || r.runAfter != t0 {
		t.Fatalf("after enqueue: %+v", r)
	}
	j := mustClaim(t, q)
	if j.ID != id || j.Kind != "process_photo" || j.Attempts != 1 {
		t.Fatalf("claimed %+v", j)
	}
	r := getRow(t, d, id)
	if r.state != "running" || r.attempts != 1 || r.lease.Int64 != t0+lease || !r.token.Valid || r.token.String == "" {
		t.Fatalf("after claim: %+v", r)
	}
	if err := q.Done(ctx, j); err != nil {
		t.Fatal(err)
	}
	if r := getRow(t, d, id); r.state != "done" || r.lease.Valid || r.token.Valid {
		t.Fatalf("after done: %+v", r)
	}
	mustNone(t, q)
	if err := q.Done(ctx, j); !errors.Is(err, jobs.ErrLeaseLost) {
		t.Fatalf("second Done: want ErrLeaseLost, got %v", err)
	}
}

func TestClaimEmptyAndNotDue(t *testing.T) {
	q, _, c := setup(t)
	ctx := context.Background()
	mustNone(t, q)
	if _, err := q.EnqueueAt(ctx, "later", nil, t0+10*sec); err != nil {
		t.Fatal(err)
	}
	mustNone(t, q)
	c.advance(10*sec - 1)
	mustNone(t, q)
	c.advance(1)
	mustClaim(t, q)
}

func TestKindFilter(t *testing.T) {
	q, _, _ := setup(t)
	ctx := context.Background()
	a, _ := q.Enqueue(ctx, "alpha", 1)
	b, _ := q.Enqueue(ctx, "beta", 2)
	mustNone(t, q, "gamma")
	if j := mustClaim(t, q, "beta"); j.ID != b {
		t.Fatalf("want beta job %s, got %s", b, j.ID)
	}
	mustNone(t, q, "beta")
	if j := mustClaim(t, q, "gamma", "alpha"); j.ID != a {
		t.Fatalf("want alpha job %s, got %s", a, j.ID)
	}
}

func TestClaimAnyKindAndOrder(t *testing.T) {
	q, _, _ := setup(t)
	ctx := context.Background()
	late, _ := q.EnqueueAt(ctx, "x", nil, t0-1*sec)
	early, _ := q.EnqueueAt(ctx, "y", nil, t0-5*sec)
	if j := mustClaim(t, q); j.ID != early {
		t.Fatalf("want earliest run_after first")
	}
	if j := mustClaim(t, q); j.ID != late {
		t.Fatalf("want later job second")
	}
}

func TestBackoffScheduleAndDeadAfterMaxAttempts(t *testing.T) {
	q, d, c := setup(t)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "flaky", nil)
	wantDelays := []int64{30 * sec, 60 * sec, 120 * sec, 240 * sec}
	for i, delay := range wantDelays {
		j := mustClaim(t, q)
		if j.Attempts != i+1 {
			t.Fatalf("attempt %d: Attempts=%d", i+1, j.Attempts)
		}
		now := c.now()
		if err := q.Fail(ctx, j, false, errors.New("network")); err != nil {
			t.Fatal(err)
		}
		r := getRow(t, d, id)
		if r.state != "queued" || r.runAfter != now+delay || r.lease.Valid || r.token.Valid || r.lastError.String != "network" {
			t.Fatalf("attempt %d: %+v, want run_after=%d", i+1, r, now+delay)
		}
		c.advance(delay - 1)
		mustNone(t, q)
		c.advance(1)
	}
	j := mustClaim(t, q)
	if j.Attempts != jobs.MaxAttempts {
		t.Fatalf("Attempts=%d", j.Attempts)
	}
	if err := q.Fail(ctx, j, false, errors.New("still broken")); err != nil {
		t.Fatal(err)
	}
	if r := getRow(t, d, id); r.state != "dead" || r.lastError.String != "still broken" || r.lease.Valid {
		t.Fatalf("after 5th failure: %+v", r)
	}
	c.advance(24 * 3600 * sec)
	mustNone(t, q)
}

func TestPermanentFailureIsDead(t *testing.T) {
	q, d, _ := setup(t)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "decode", nil)
	j := mustClaim(t, q)
	if err := q.Fail(ctx, j, true, errors.New("unsupported format")); err != nil {
		t.Fatal(err)
	}
	if r := getRow(t, d, id); r.state != "dead" || r.attempts != 1 || r.lastError.String != "unsupported format" {
		t.Fatalf("%+v", r)
	}
	mustNone(t, q)
}

func TestExpiredLeaseReclaimedAndOldWorkerLosesLease(t *testing.T) {
	q, d, c := setup(t)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "slow", nil)
	first := mustClaim(t, q)
	c.advance(lease - 1)
	mustNone(t, q)
	c.advance(1)
	second := mustClaim(t, q)
	if second.ID != id || second.Attempts != 2 {
		t.Fatalf("reclaimed %+v", second)
	}
	if err := q.Done(ctx, first); !errors.Is(err, jobs.ErrLeaseLost) {
		t.Fatalf("Done: want ErrLeaseLost, got %v", err)
	}
	if err := q.Heartbeat(ctx, first); !errors.Is(err, jobs.ErrLeaseLost) {
		t.Fatalf("Heartbeat: want ErrLeaseLost, got %v", err)
	}
	if err := q.Fail(ctx, first, true, errors.New("x")); !errors.Is(err, jobs.ErrLeaseLost) {
		t.Fatalf("Fail: want ErrLeaseLost, got %v", err)
	}
	if r := getRow(t, d, id); r.state != "running" {
		t.Fatalf("old worker changed state: %+v", r)
	}
	if err := q.Done(ctx, second); err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeatExtendsLease(t *testing.T) {
	q, d, c := setup(t)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "slow", nil)
	j := mustClaim(t, q)
	c.advance(90 * sec)
	if err := q.Heartbeat(ctx, j); err != nil {
		t.Fatal(err)
	}
	if r := getRow(t, d, id); r.lease.Int64 != c.now()+lease {
		t.Fatalf("lease_until=%d want %d", r.lease.Int64, c.now()+lease)
	}
	c.advance(90 * sec) // past the original lease, inside the extended one
	mustNone(t, q)
	if err := q.Done(ctx, j); err != nil {
		t.Fatal(err)
	}
}

func TestExpiredLeaseAtMaxAttemptsGoesDead(t *testing.T) {
	q, d, c := setup(t)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "crashy", nil)
	for i := 1; i <= jobs.MaxAttempts; i++ {
		j := mustClaim(t, q)
		if j.Attempts != i {
			t.Fatalf("claim %d: Attempts=%d", i, j.Attempts)
		}
		c.advance(lease) // worker vanished; lease expires
	}
	mustNone(t, q)
	r := getRow(t, d, id)
	if r.state != "dead" || r.attempts != jobs.MaxAttempts || r.lease.Valid || r.token.Valid || r.lastError.String == "" {
		t.Fatalf("%+v", r)
	}
}

func TestConcurrentClaimsEachJobOnce(t *testing.T) {
	q, _, _ := setup(t)
	ctx := context.Background()
	const n = 50
	for i := 0; i < n; i++ {
		if _, err := q.Enqueue(ctx, "work", i); err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	seen := map[string]int{}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				j, err := q.Claim(ctx, nil)
				if err != nil {
					errs <- err
					return
				}
				if j == nil {
					return
				}
				mu.Lock()
				seen[j.ID]++
				mu.Unlock()
				if err := q.Done(ctx, j); err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if len(seen) != n {
		t.Fatalf("claimed %d distinct jobs, want %d", len(seen), n)
	}
	for id, k := range seen {
		if k != 1 {
			t.Fatalf("job %s claimed %d times", id, k)
		}
	}
}

func TestPayloadRoundTrip(t *testing.T) {
	q, _, _ := setup(t)
	type p struct {
		PhotoID string `json:"photoId"`
		Tiers   []int  `json:"tiers"`
		Note    string `json:"note"`
	}
	in := p{PhotoID: "abc", Tiers: []int{480, 1280}, Note: "引号\"和中文"}
	if _, err := q.Enqueue(context.Background(), "process_photo", in); err != nil {
		t.Fatal(err)
	}
	j := mustClaim(t, q)
	var out p
	if err := json.Unmarshal(j.Payload, &out); err != nil {
		t.Fatal(err)
	}
	if out.PhotoID != in.PhotoID || len(out.Tiers) != 2 || out.Tiers[1] != 1280 || out.Note != in.Note {
		t.Fatalf("round trip: %+v", out)
	}
}

func TestBadKindRejected(t *testing.T) {
	q, d, _ := setup(t)
	ctx := context.Background()
	for _, k := range []string{"", "Upper", "with-dash", "digits1", "has space", strings.Repeat("a", 41)} {
		if _, err := q.Enqueue(ctx, k, nil); !errors.Is(err, jobs.ErrBadKind) {
			t.Errorf("kind %q: want ErrBadKind, got %v", k, err)
		}
		if _, err := q.EnqueueAt(ctx, k, nil, t0); !errors.Is(err, jobs.ErrBadKind) {
			t.Errorf("EnqueueAt kind %q: want ErrBadKind, got %v", k, err)
		}
	}
	if _, err := q.Enqueue(ctx, strings.Repeat("a", 40), nil); err != nil {
		t.Errorf("40-char kind rejected: %v", err)
	}
	if _, err := q.Enqueue(ctx, "bad", make(chan int)); err == nil {
		t.Error("unmarshalable payload accepted")
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM jobs`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows=%d want 1", n)
	}
}

func TestLastErrorTruncated(t *testing.T) {
	q, d, _ := setup(t)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "big", nil)
	j := mustClaim(t, q)
	msg := strings.Repeat("错", 400) // 1200 bytes of 3-byte runes
	if err := q.Fail(ctx, j, true, errors.New(msg)); err != nil {
		t.Fatal(err)
	}
	le := getRow(t, d, id).lastError.String
	if len(le) > 500 || len(le) < 495 || !strings.HasPrefix(msg, le) {
		t.Fatalf("len=%d", len(le))
	}
	if !utf8.ValidString(le) {
		t.Fatal("truncation split a rune")
	}
	id2, _ := q.Enqueue(ctx, "nilcause", nil)
	j2 := mustClaim(t, q)
	if err := q.Fail(ctx, j2, true, nil); err != nil {
		t.Fatal(err)
	}
	if getRow(t, d, id2).lastError.String == "" {
		t.Fatal("nil cause left last_error empty")
	}
}

func TestPurgeDoneUsesFinishTime(t *testing.T) {
	q, d, c := setup(t)
	ctx := context.Background()
	oldDone, _ := q.Enqueue(ctx, "a", nil)
	mustDone(t, q, "a")
	oldDead, _ := q.Enqueue(ctx, "b", nil)
	if err := q.Fail(ctx, mustClaim(t, q, "b"), true, errors.New("x")); err != nil {
		t.Fatal(err)
	}
	queued, _ := q.Enqueue(ctx, "c", nil)
	running, _ := q.Enqueue(ctx, "e", nil)
	mustClaim(t, q, "e")
	// Created long ago, but only finishes after the cutoff: must survive.
	lateDone, _ := q.Enqueue(ctx, "f", nil)
	lateDead, _ := q.Enqueue(ctx, "g", nil)
	c.advance(10 * sec)
	mustDone(t, q, "f")
	if err := q.Fail(ctx, mustClaim(t, q, "g"), true, errors.New("y")); err != nil {
		t.Fatal(err)
	}

	var fin sql.NullInt64
	if err := d.QueryRow(`SELECT finished_at FROM jobs WHERE id=?`, lateDone).Scan(&fin); err != nil {
		t.Fatal(err)
	}
	if fin.Int64 != t0+10*sec {
		t.Fatalf("finished_at=%v want %d", fin, t0+10*sec)
	}

	n, err := q.PurgeDone(ctx, t0+1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("purged %d want 2", n)
	}
	exists := func(id string) bool {
		var k int
		if err := d.QueryRow(`SELECT COUNT(*) FROM jobs WHERE id=?`, id).Scan(&k); err != nil {
			t.Fatal(err)
		}
		return k == 1
	}
	if exists(oldDone) || exists(oldDead) {
		t.Fatal("old done/dead rows not purged")
	}
	for _, id := range []string{queued, running, lateDone, lateDead} {
		if !exists(id) {
			t.Fatalf("purged %s, which it should have kept", id)
		}
	}
}

func mustDone(t *testing.T, q *jobs.Queue, kinds ...string) {
	t.Helper()
	if err := q.Done(context.Background(), mustClaim(t, q, kinds...)); err != nil {
		t.Fatal(err)
	}
}

func TestLastErrorInvalidUTF8(t *testing.T) {
	q, d, _ := setup(t)
	ctx := context.Background()
	for _, pos := range []int{0, 10} {
		id, _ := q.Enqueue(ctx, "bin", nil)
		j := mustClaim(t, q)
		raw := strings.Repeat("a", pos) + "\xff" + strings.Repeat("b", 1000)
		if err := q.Fail(ctx, j, true, errors.New(raw)); err != nil {
			t.Fatal(err)
		}
		le := getRow(t, d, id).lastError.String
		if !utf8.ValidString(le) || len(le) > 500 || len(le) < 490 {
			t.Fatalf("pos %d: valid=%v len=%d", pos, utf8.ValidString(le), len(le))
		}
		if !strings.HasPrefix(le, strings.Repeat("a", pos)+"\uFFFDbbb") {
			t.Fatalf("pos %d: prefix %q", pos, le[:min(len(le), 20)])
		}
	}
	// Short message with an invalid byte is sanitised too.
	id, _ := q.Enqueue(ctx, "bin", nil)
	if err := q.Fail(ctx, mustClaim(t, q), true, errors.New("x\xffy")); err != nil {
		t.Fatal(err)
	}
	if le := getRow(t, d, id).lastError.String; le != "x\uFFFDy" {
		t.Fatalf("got %q", le)
	}
}

type deadRec struct {
	mu   sync.Mutex
	jobs []jobs.Job
}

func (r *deadRec) hook(_ context.Context, j jobs.Job) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.jobs = append(r.jobs, j)
}

func (r *deadRec) got() []jobs.Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]jobs.Job(nil), r.jobs...)
}

func assertOneDead(t *testing.T, r *deadRec, id, kind string, attempts int, payload string) {
	t.Helper()
	got := r.got()
	if len(got) != 1 {
		t.Fatalf("OnDead called %d times, want 1: %+v", len(got), got)
	}
	g := got[0]
	if g.ID != id || g.Kind != kind || g.Attempts != attempts || string(g.Payload) != payload {
		t.Fatalf("OnDead got %+v (payload %s)", g, g.Payload)
	}
}

func TestOnDeadPermanentFail(t *testing.T) {
	q, _, _ := setup(t)
	r := &deadRec{}
	q.OnDead(r.hook)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "decode", map[string]string{"photoId": "p1"})
	j := mustClaim(t, q)
	if err := q.Fail(ctx, j, true, errors.New("bad")); err != nil {
		t.Fatal(err)
	}
	if err := q.Fail(ctx, j, true, errors.New("bad")); !errors.Is(err, jobs.ErrLeaseLost) {
		t.Fatalf("repeat Fail: %v", err)
	}
	mustNone(t, q)
	assertOneDead(t, r, id, "decode", 1, `{"photoId":"p1"}`)
}

func TestOnDeadRetriesExhausted(t *testing.T) {
	q, _, c := setup(t)
	r := &deadRec{}
	q.OnDead(r.hook)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "flaky", 7)
	for i := 1; i <= jobs.MaxAttempts; i++ {
		j := mustClaim(t, q)
		if err := q.Fail(ctx, j, false, errors.New("503")); err != nil {
			t.Fatal(err)
		}
		if i < jobs.MaxAttempts && len(r.got()) != 0 {
			t.Fatalf("OnDead fired on retryable attempt %d", i)
		}
		c.advance(10 * 60 * sec)
	}
	mustNone(t, q)
	assertOneDead(t, r, id, "flaky", jobs.MaxAttempts, `7`)
}

func TestOnDeadLeaseExpiryAtMaxAttempts(t *testing.T) {
	q, d, c := setup(t)
	r := &deadRec{}
	q.OnDead(r.hook)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "crashy", "p")
	for i := 1; i <= jobs.MaxAttempts; i++ {
		j := mustClaim(t, q)
		if i < jobs.MaxAttempts {
			// Record a real failure first so the crash path must keep it.
			if err := q.Fail(ctx, j, false, errors.New("TOS 503")); err != nil {
				t.Fatal(err)
			}
			c.advance(10 * 60 * sec)
			continue
		}
		c.advance(jobs.LeaseMillis) // worker crashed on the last attempt
	}
	if len(r.got()) != 0 {
		t.Fatal("OnDead fired before the expired lease was noticed")
	}
	mustNone(t, q)
	mustNone(t, q) // a second sweep must not fire again
	assertOneDead(t, r, id, "crashy", jobs.MaxAttempts, `"p"`)
	row := getRow(t, d, id)
	if row.state != "dead" || row.lastError.String != "TOS 503 (lease expired at max attempts)" {
		t.Fatalf("%+v", row)
	}
	var fin sql.NullInt64
	if err := d.QueryRow(`SELECT finished_at FROM jobs WHERE id=?`, id).Scan(&fin); err != nil || fin.Int64 != c.now() {
		t.Fatalf("finished_at=%v err=%v want %d", fin, err, c.now())
	}
}

func TestLeaseExpirySuffixWithinCap(t *testing.T) {
	q, d, c := setup(t)
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "crashy", nil)
	long := strings.Repeat("错", 400)
	for i := 1; i <= jobs.MaxAttempts; i++ {
		j := mustClaim(t, q)
		if i < jobs.MaxAttempts {
			if err := q.Fail(ctx, j, false, errors.New(long)); err != nil {
				t.Fatal(err)
			}
			c.advance(10 * 60 * sec)
			continue
		}
		c.advance(jobs.LeaseMillis)
	}
	mustNone(t, q)
	le := getRow(t, d, id).lastError.String
	if len(le) > 500 || !utf8.ValidString(le) || !strings.HasSuffix(le, " (lease expired at max attempts)") || !strings.HasPrefix(le, "错错") {
		t.Fatalf("len=%d valid=%v tail=%q", len(le), utf8.ValidString(le), le[max(0, len(le)-40):])
	}

	// A crash with no previous error records just the reason.
	id2, _ := q.Enqueue(ctx, "crashy", nil)
	for i := 1; i <= jobs.MaxAttempts; i++ {
		mustClaim(t, q)
		c.advance(jobs.LeaseMillis)
	}
	mustNone(t, q)
	if le := getRow(t, d, id2).lastError.String; le != "lease expired at max attempts" {
		t.Fatalf("got %q", le)
	}
}

func TestOnDeadPanicDoesNotBreakClaim(t *testing.T) {
	q, d, c := setup(t)
	calls := 0
	q.OnDead(func(context.Context, jobs.Job) {
		calls++
		panic("boom")
	})
	ctx := context.Background()
	a, _ := q.Enqueue(ctx, "crashy", nil)
	b, _ := q.Enqueue(ctx, "crashy", nil)
	for i := 1; i <= jobs.MaxAttempts; i++ {
		mustClaim(t, q)
		mustClaim(t, q)
		c.advance(jobs.LeaseMillis)
	}
	next, _ := q.Enqueue(ctx, "other", nil)
	j := mustClaim(t, q) // sweeps both dead jobs, hook panics twice, still claims
	if j.ID != next {
		t.Fatalf("claimed %s want %s", j.ID, next)
	}
	if calls != 2 {
		t.Fatalf("hook calls=%d want 2", calls)
	}
	for _, id := range []string{a, b} {
		if getRow(t, d, id).state != "dead" {
			t.Fatalf("%s not dead", id)
		}
	}
	// Fail's dead path also survives a panicking hook.
	if err := q.Fail(ctx, j, true, errors.New("x")); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("hook calls=%d want 3", calls)
	}
}

func TestOnDeadHookCanUseDB(t *testing.T) {
	// The hook runs after the dead-mark statement has finished, so it can use
	// the (single-connection) pool without deadlocking.
	q, d, c := setup(t)
	var state string
	q.OnDead(func(ctx context.Context, j jobs.Job) {
		if err := d.QueryRowContext(ctx, `SELECT state FROM jobs WHERE id=?`, j.ID).Scan(&state); err != nil {
			t.Errorf("hook query: %v", err)
		}
	})
	ctx := context.Background()
	q.Enqueue(ctx, "crashy", nil)
	for i := 1; i <= jobs.MaxAttempts; i++ {
		mustClaim(t, q)
		c.advance(jobs.LeaseMillis)
	}
	type result struct {
		j   *jobs.Job
		err error
	}
	res := make(chan result, 1)
	go func() {
		j, err := q.Claim(ctx, nil)
		res <- result{j, err}
	}()
	select {
	case r := <-res:
		if r.err != nil || r.j != nil {
			t.Fatalf("Claim = %+v, %v; want nil, nil", r.j, r.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Claim deadlocked calling OnDead")
	}
	if state != "dead" {
		t.Fatalf("hook saw state %q", state)
	}
}

type ctxKey struct{}

func TestOnDeadContextDetachedWithTimeout(t *testing.T) {
	q, _, c := setup(t)
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), ctxKey{}, "v"))
	defer cancel()
	var (
		calls       int
		errAfter    error
		value       any
		hasDeadline bool
		remaining   time.Duration
	)
	q.OnDead(func(ctx context.Context, j jobs.Job) {
		calls++
		cancel() // the caller's ctx goes away after the kill has committed
		errAfter = ctx.Err()
		value = ctx.Value(ctxKey{})
		var dl time.Time
		dl, hasDeadline = ctx.Deadline()
		remaining = time.Until(dl)
	})
	check := func(path string) {
		t.Helper()
		if calls != 1 {
			t.Fatalf("%s: calls=%d", path, calls)
		}
		if errAfter != nil {
			t.Fatalf("%s: hook ctx cancelled with caller: %v", path, errAfter)
		}
		if value != "v" {
			t.Fatalf("%s: hook ctx lost values: %v", path, value)
		}
		if !hasDeadline || remaining <= 25*time.Second || remaining > jobs.DeadHookTimeout {
			t.Fatalf("%s: deadline=%v remaining=%v", path, hasDeadline, remaining)
		}
	}

	// Fail path.
	if _, err := q.Enqueue(parent, "decode", nil); err != nil {
		t.Fatal(err)
	}
	if err := q.Fail(parent, mustClaim(t, q), true, errors.New("bad")); err != nil {
		t.Fatal(err)
	}
	check("fail")

	// Sweep path.
	calls = 0
	parent, cancel = context.WithCancel(context.WithValue(context.Background(), ctxKey{}, "v"))
	defer cancel()
	q.Enqueue(parent, "crashy", nil)
	for i := 1; i <= jobs.MaxAttempts; i++ {
		mustClaim(t, q)
		c.advance(jobs.LeaseMillis)
	}
	// The hook cancels the caller's ctx mid-Claim, so Claim's own claim
	// statement legitimately fails with that cancellation afterwards.
	if j, err := q.Claim(parent, nil); j != nil || (err != nil && !errors.Is(err, context.Canceled)) {
		t.Fatalf("Claim = %+v, %v", j, err)
	}
	check("sweep")
}

func TestOnDeadPanicLogged(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	q, _, _ := setup(t)
	q.OnDead(func(context.Context, jobs.Job) { panic("hook bug") })
	ctx := context.Background()
	id, _ := q.Enqueue(ctx, "decode", map[string]string{"secret": "do-not-log"})
	if err := q.Fail(ctx, mustClaim(t, q), true, errors.New("bad")); err != nil {
		t.Fatal(err)
	}
	var rec map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &rec); err != nil {
		t.Fatalf("want one JSON log line, got %q: %v", buf.String(), err)
	}
	if rec["level"] != "ERROR" || rec["id"] != id || rec["kind"] != "decode" || rec["panic"] != "hook bug" {
		t.Fatalf("log record %v", rec)
	}
	if strings.Contains(buf.String(), "do-not-log") || strings.Contains(buf.String(), "payload") {
		t.Fatalf("payload leaked into log: %s", buf.String())
	}
}

func TestDeadSince(t *testing.T) {
	q, _, c := setup(t)
	ctx := context.Background()
	kill := func(kind string, payload any) string {
		t.Helper()
		id, err := q.Enqueue(ctx, kind, payload)
		if err != nil {
			t.Fatal(err)
		}
		if err := q.Fail(ctx, mustClaim(t, q, kind), true, errors.New("x")); err != nil {
			t.Fatal(err)
		}
		return id
	}
	_ = kill("process_photo", 1) // before the cutoff
	c.advance(10 * sec)
	cutoff := c.now()
	a := kill("process_photo", map[string]string{"photoId": "a"})
	c.advance(sec)
	other := kill("rotate_derived", 2)
	c.advance(sec)
	b := kill("process_photo", map[string]string{"photoId": "b"})
	q.Enqueue(ctx, "process_photo", 3) // queued, not dead
	mustDone(t, q, "process_photo")    // done, not dead

	got, err := q.DeadSince(ctx, cutoff, "process_photo")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != a || got[1].ID != b {
		t.Fatalf("got %+v", got)
	}
	if got[0].Kind != "process_photo" || got[0].Attempts != 1 || string(got[0].Payload) != `{"photoId":"a"}` || got[0].LeaseToken != "" {
		t.Fatalf("job fields %+v", got[0])
	}

	all, err := q.DeadSince(ctx, cutoff, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 || all[0].ID != a || all[1].ID != other || all[2].ID != b {
		t.Fatalf("any kind: %+v", all)
	}

	none, err := q.DeadSince(ctx, c.now()+1, "")
	if err != nil || len(none) != 0 {
		t.Fatalf("future cutoff: %v %v", none, err)
	}
}

func TestEnqueueTxCommitsAndRollsBackWithCaller(t *testing.T) {
	q, d, _ := setup(t)
	ctx := context.Background()

	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.EnqueueTx(ctx, tx, "process_photo", map[string]string{"photoId": "a"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	mustNone(t, q)

	tx, err = d.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	id, err := q.EnqueueTx(ctx, tx, "process_photo", map[string]string{"photoId": "b"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.EnqueueTx(ctx, tx, "Bad Kind", nil); !errors.Is(err, jobs.ErrBadKind) {
		t.Fatalf("want ErrBadKind, got %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	j := mustClaim(t, q)
	if j.ID != id || j.Kind != "process_photo" || string(j.Payload) != `{"photoId":"b"}` {
		t.Fatalf("unexpected job %+v", j)
	}
}

func TestBusy(t *testing.T) {
	q, d, clk := setup(t)
	ctx := context.Background()
	p := func(id string) map[string]string { return map[string]string{"photoId": id} }
	busy := func(kinds []string, photo, except string, due bool) bool {
		t.Helper()
		b, err := q.Busy(ctx, kinds, photo, except, due)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	rot := []string{"rotate_derived"}

	if busy(rot, "a", "", true) {
		t.Fatal("empty queue is busy")
	}
	later, _ := q.EnqueueAt(ctx, "rotate_derived", p("a"), clk.now()+sec)
	if busy(rot, "a", "", true) {
		t.Fatal("a queued job that is not due counts")
	}
	clk.advance(sec)
	if !busy(rot, "a", "", true) {
		t.Fatal("a queued, due job must count when due=true")
	}
	if busy(rot, "a", "", false) {
		t.Fatal("a queued job counts with due=false")
	}
	if busy(rot, "a", later, true) || busy(rot, "b", "", true) || busy([]string{"process_photo"}, "a", "", true) {
		t.Fatal("exceptID, photoId or kind filter ignored")
	}

	j := mustClaim(t, q)
	if !busy(rot, "a", "", false) {
		t.Fatal("a running job must count")
	}
	if busy(rot, "a", j.ID, false) {
		t.Fatal("the caller's own job must not count")
	}
	// An expired lease is claimable again: it counts only as due.
	clk.advance(lease)
	if busy(rot, "a", "", false) || !busy(rot, "a", "", true) {
		t.Fatal("expired lease must count only as due")
	}
	if _, err := d.Exec(`UPDATE jobs SET state='done' WHERE id=?`, j.ID); err != nil {
		t.Fatal(err)
	}
	if busy(rot, "a", "", true) {
		t.Fatal("a done job counts")
	}
}

func TestRunningBefore(t *testing.T) {
	q, _, clk := setup(t)
	ctx := context.Background()
	p := map[string]string{"photoId": "a"}
	older, _ := q.Enqueue(ctx, "rotate_derived", p)
	clk.advance(1)
	newer, _ := q.Enqueue(ctx, "rotate_derived", p)
	rb := func(id string) bool {
		t.Helper()
		b, err := q.RunningBefore(ctx, []string{"rotate_derived"}, "a", id)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	if rb(newer) {
		t.Fatal("queued jobs must not count")
	}
	j1 := mustClaim(t, q)
	j2 := mustClaim(t, q)
	if j1.ID != older || j2.ID != newer {
		t.Fatalf("claim order %s %s", j1.ID, j2.ID)
	}
	if !rb(newer) {
		t.Fatal("older running job must count for the newer one")
	}
	if rb(older) {
		t.Fatal("a newer running job must not count for the older one")
	}
	clk.advance(lease)
	if rb(newer) {
		t.Fatal("an expired lease must not count")
	}
}

func TestDeferDoesNotSpendAttempt(t *testing.T) {
	q, d, clk := setup(t)
	ctx := context.Background()
	id, err := q.Enqueue(ctx, "rotate_derived", map[string]string{"photoId": "a"})
	if err != nil {
		t.Fatal(err)
	}
	// Defer far more often than MaxAttempts: the job must stay alive.
	for i := 0; i < jobs.MaxAttempts*3; i++ {
		j := mustClaim(t, q)
		if j.ID != id {
			t.Fatalf("claimed %s want %s", j.ID, id)
		}
		if err := q.Defer(ctx, j, time.Second, "busy"); err != nil {
			t.Fatal(err)
		}
		if j2, _ := q.Claim(ctx, nil); j2 != nil {
			t.Fatal("deferred job claimable before its delay")
		}
		clk.advance(sec)
	}
	var state string
	var attempts int
	if err := d.QueryRow(`SELECT state, attempts FROM jobs WHERE id=?`, id).Scan(&state, &attempts); err != nil {
		t.Fatal(err)
	}
	if state != "queued" || attempts != 0 {
		t.Fatalf("after defers: state %s attempts %d, want queued 0", state, attempts)
	}
	j := mustClaim(t, q)
	if err := q.Defer(ctx, &jobs.Job{ID: j.ID, LeaseToken: "stale"}, time.Second, "x"); !errors.Is(err, jobs.ErrLeaseLost) {
		t.Fatalf("defer with a stale lease: %v", err)
	}
}
