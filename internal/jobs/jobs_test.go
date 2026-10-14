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
	d.QueryRow(`SELECT COUNT(*) FROM jobs`).Scan(&n)
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

func TestPurgeDone(t *testing.T) {
	q, d, c := setup(t)
	ctx := context.Background()
	oldDone, _ := q.Enqueue(ctx, "a", nil)
	mustDone(t, q, "a")
	oldDead, _ := q.Enqueue(ctx, "b", nil)
	if err := q.Fail(ctx, mustClaim(t, q, "b"), true, errors.New("x")); err != nil {
		t.Fatal(err)
	}
	oldQueued, _ := q.Enqueue(ctx, "c", nil)
	oldRunning, _ := q.Enqueue(ctx, "e", nil)
	mustClaim(t, q, "e")
	c.advance(10 * sec)
	recentDone, _ := q.Enqueue(ctx, "f", nil)
	mustDone(t, q, "f")

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
	if !exists(oldQueued) || !exists(oldRunning) || !exists(recentDone) {
		t.Fatal("purged a row it should have kept")
	}
}

func mustDone(t *testing.T, q *jobs.Queue, kinds ...string) {
	t.Helper()
	if err := q.Done(context.Background(), mustClaim(t, q, kinds...)); err != nil {
		t.Fatal(err)
	}
}
