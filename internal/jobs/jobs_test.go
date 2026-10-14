package jobs_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
	done := make(chan struct{})
	go func() { defer close(done); mustNone(t, q) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Claim deadlocked calling OnDead")
	}
	if state != "dead" {
		t.Fatalf("hook saw state %q", state)
	}
}
