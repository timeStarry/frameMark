// Package jobs is a SQLite-backed work queue with leases, heartbeats,
// exponential-backoff retries and dead-lettering (spec §6.2, §6.3).
//
// db.Open caps the pool at one connection, so every method here runs single
// statements and never holds a transaction or open rows across work.
// EnqueueTx is the exception: it writes through the caller's transaction.
package jobs

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	// MaxAttempts is the number of claims a job gets before it goes dead.
	MaxAttempts = 5
	// LeaseMillis is how long a claim or heartbeat keeps a job.
	LeaseMillis = int64(2 * 60 * 1000)
	// BaseBackoffMillis is the first retry delay; it doubles per attempt.
	BaseBackoffMillis = int64(30 * 1000)

	// DeadHookTimeout bounds each OnDead call. See OnDead.
	DeadHookTimeout = 30 * time.Second

	maxErrorBytes = 500

	leaseExpiredReason = "lease expired at max attempts"
	leaseExpiredSuffix = " (" + leaseExpiredReason + ")"
)

var (
	// ErrLeaseLost means the job is no longer running under the caller's lease
	// (it expired and was reclaimed, or already finished).
	ErrLeaseLost = errors.New("jobs: lease lost")
	// ErrBadKind means kind does not match ^[a-z_]{1,40}$.
	ErrBadKind = errors.New("jobs: invalid kind")

	kindRE = regexp.MustCompile(`^[a-z_]{1,40}$`)
)

// Job is a claimed unit of work. LeaseToken identifies this claim.
type Job struct {
	ID         string
	Kind       string
	Payload    json.RawMessage
	Attempts   int
	LeaseToken string
}

// DeadHook is called once for every job that becomes dead. See Queue.OnDead.
type DeadHook func(ctx context.Context, j Job)

// Queue is the job queue. It is safe for concurrent use.
type Queue struct {
	db     *sql.DB
	now    func() int64
	onDead atomic.Pointer[DeadHook]
}

// New returns a Queue over d using now (Unix ms) as its clock.
func New(d *sql.DB, now func() int64) *Queue {
	return &Queue{db: d, now: now}
}

// OnDead registers fn to run exactly once for each job that becomes dead,
// whether by a permanent Fail, a Fail on the last attempt, or a lease that
// expired on the last attempt (a crashed worker, swept up by any later Claim
// regardless of its kind filter). This lets an owner react, e.g. setting a
// photo to failed (spec §6.2). Passing nil removes the hook.
//
// fn runs after the statement that killed the job has finished, on the
// goroutine that called Fail or Claim. Its ctx is detached from the caller's
// (context.WithoutCancel, so values are kept but the caller's cancellation and
// deadline are not), with its own DeadHookTimeout deadline: the job is already
// committed as dead, so a shutdown or a deadline poll must not abort the only
// notification. fn may use the database. A panic in fn is recovered, logged
// via slog at Error level with the job id and kind (never the payload), and
// does not affect the caller.
//
// The queue never retries fn. If fn fails or the process dies before it
// runs, the owner must reconcile at startup using DeadSince.
func (q *Queue) OnDead(fn DeadHook) {
	if fn == nil {
		q.onDead.Store(nil)
		return
	}
	q.onDead.Store(&fn)
}

func (q *Queue) fireDead(ctx context.Context, j Job) {
	p := q.onDead.Load()
	if p == nil {
		return
	}
	hctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), DeadHookTimeout)
	defer cancel()
	defer func() {
		if r := recover(); r != nil {
			slog.Error("jobs: OnDead hook panicked", "id", j.ID, "kind", j.Kind, "panic", r)
		}
	}()
	(*p)(hctx, j)
}

// Enqueue adds a job that is ready immediately.
func (q *Queue) Enqueue(ctx context.Context, kind string, payload any) (string, error) {
	return q.EnqueueAt(ctx, kind, payload, q.now())
}

// EnqueueAt adds a job that becomes claimable at runAfter (Unix ms).
func (q *Queue) EnqueueAt(ctx context.Context, kind string, payload any, runAfter int64) (string, error) {
	return q.insert(ctx, q.db, kind, payload, runAfter)
}

// EnqueueTx adds a ready job inside the caller's transaction, so the job
// exists exactly when the caller's other writes commit. The caller owns tx.
func (q *Queue) EnqueueTx(ctx context.Context, tx *sql.Tx, kind string, payload any) (string, error) {
	return q.insert(ctx, tx, kind, payload, q.now())
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (q *Queue) insert(ctx context.Context, x execer, kind string, payload any, runAfter int64) (string, error) {
	if !kindRE.MatchString(kind) {
		return "", fmt.Errorf("%w: %q", ErrBadKind, kind)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("jobs: marshal payload: %w", err)
	}
	u, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	id := u.String()
	_, err = x.ExecContext(ctx,
		`INSERT INTO jobs (id, kind, payload, state, attempts, run_after, created_at) VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
		id, kind, string(body), runAfter, q.now())
	if err != nil {
		return "", fmt.Errorf("jobs: enqueue: %w", err)
	}
	return id, nil
}

// Claim leases the next ready job, optionally restricted to kinds (empty
// means any). It returns (nil, nil) when nothing is ready. Ready means queued
// and due, or running with an expired lease. A job whose lease expired after
// its MaxAttempts-th claim is marked dead instead of being run again.
func (q *Queue) Claim(ctx context.Context, kinds []string) (*Job, error) {
	now := q.now()
	if err := q.sweepExpired(ctx, now); err != nil {
		return nil, err
	}

	token, err := newToken()
	if err != nil {
		return nil, err
	}
	args := []any{now + LeaseMillis, token, now, now, MaxAttempts}
	kindClause := ""
	if len(kinds) > 0 {
		kindClause = " AND kind IN (?" + strings.Repeat(",?", len(kinds)-1) + ")"
		for _, k := range kinds {
			args = append(args, k)
		}
	}
	// One statement, so the select-and-lease is atomic. The attempts guard on
	// the expired branch keeps it correct even without the dead-marking above.
	query := `UPDATE jobs SET state='running', attempts=attempts+1, lease_until=?, lease_token=?
		WHERE id = (SELECT id FROM jobs
			WHERE ((state='queued' AND run_after<=?) OR (state='running' AND lease_until<=? AND attempts<?))` + kindClause + `
			ORDER BY run_after, created_at LIMIT 1)
		RETURNING id, kind, payload, attempts`
	var (
		j       Job
		payload string
	)
	err = q.db.QueryRowContext(ctx, query, args...).Scan(&j.ID, &j.Kind, &payload, &j.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("jobs: claim: %w", err)
	}
	j.Payload = json.RawMessage(payload)
	j.LeaseToken = token
	return &j, nil
}

// sweepExpired marks dead every running job whose lease expired on its last
// attempt, keeping its previous last_error with a suffix, and fires OnDead
// once per job. Each job is killed by its own conditional UPDATE ... RETURNING,
// so a concurrent sweeper or a late Fail by the stale worker makes the UPDATE
// match nothing and no second hook call happens. Candidate rows are fully read
// and closed before any write, keeping the single pooled connection free.
func (q *Queue) sweepExpired(ctx context.Context, now int64) error {
	type cand struct {
		id      string
		lastErr sql.NullString
	}
	rows, err := q.db.QueryContext(ctx,
		`SELECT id, last_error FROM jobs WHERE state='running' AND lease_until<=? AND attempts>=?`,
		now, MaxAttempts)
	if err != nil {
		return fmt.Errorf("jobs: find expired: %w", err)
	}
	var cands []cand
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.id, &c.lastErr); err != nil {
			rows.Close()
			return fmt.Errorf("jobs: find expired: %w", err)
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("jobs: find expired: %w", err)
	}

	for _, c := range cands {
		msg := leaseExpiredReason
		if c.lastErr.Valid && c.lastErr.String != "" {
			msg = truncate(c.lastErr.String, maxErrorBytes-len(leaseExpiredSuffix)) + leaseExpiredSuffix
		}
		var (
			j       Job
			payload string
		)
		err := q.db.QueryRowContext(ctx,
			`UPDATE jobs SET state='dead', lease_until=NULL, lease_token=NULL, last_error=?, finished_at=?
			 WHERE id=? AND state='running' AND lease_until<=? AND attempts>=?
			 RETURNING id, kind, payload, attempts`,
			msg, now, c.id, now, MaxAttempts).Scan(&j.ID, &j.Kind, &payload, &j.Attempts)
		if errors.Is(err, sql.ErrNoRows) {
			continue // someone else finished or killed it first
		}
		if err != nil {
			return fmt.Errorf("jobs: expire lease: %w", err)
		}
		j.Payload = json.RawMessage(payload)
		q.fireDead(ctx, j)
	}
	return nil
}

// Heartbeat extends j's lease to now + LeaseMillis.
func (q *Queue) Heartbeat(ctx context.Context, j *Job) error {
	_, err := q.fenced(ctx, "heartbeat", j, `UPDATE jobs SET lease_until=?`, q.now()+LeaseMillis)
	return err
}

// Done marks j finished.
func (q *Queue) Done(ctx context.Context, j *Job) error {
	_, err := q.fenced(ctx, "done", j,
		`UPDATE jobs SET state='done', lease_until=NULL, lease_token=NULL, finished_at=?`, q.now())
	return err
}

// Fail records cause on j. A permanent failure, or a failure on the
// MaxAttempts-th attempt, makes the job dead; otherwise it is requeued after
// 30s × 2^(attempts-1). Going dead fires the OnDead hook once.
func (q *Queue) Fail(ctx context.Context, j *Job, permanent bool, cause error) error {
	msg := "unknown error"
	if cause != nil {
		msg = cause.Error()
	}
	msg = truncate(msg, maxErrorBytes)
	now := q.now()
	if permanent || j.Attempts >= MaxAttempts {
		dead, err := q.fenced(ctx, "fail", j,
			`UPDATE jobs SET state='dead', lease_until=NULL, lease_token=NULL, last_error=?, finished_at=?`,
			msg, now)
		if err != nil {
			return err
		}
		q.fireDead(ctx, dead)
		return nil
	}
	delay := BaseBackoffMillis << (max(j.Attempts, 1) - 1)
	_, err := q.fenced(ctx, "fail", j,
		`UPDATE jobs SET state='queued', run_after=?, lease_until=NULL, lease_token=NULL, last_error=?`,
		now+delay, msg)
	return err
}

// PurgeDone deletes done and dead jobs that finished before olderThan (Unix ms)
// and returns how many were removed.
func (q *Queue) PurgeDone(ctx context.Context, olderThan int64) (int, error) {
	res, err := q.db.ExecContext(ctx,
		`DELETE FROM jobs WHERE state IN ('done', 'dead') AND finished_at < ?`, olderThan)
	if err != nil {
		return 0, fmt.Errorf("jobs: purge: %w", err)
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// DeadSince returns dead jobs that finished at or after since (Unix ms),
// oldest first, restricted to kind unless kind is empty. LeaseToken is empty.
// It exists for startup reconciliation of owners whose OnDead hook did not
// run (e.g. the process crashed between the kill and the hook).
func (q *Queue) DeadSince(ctx context.Context, since int64, kind string) ([]Job, error) {
	query := `SELECT id, kind, payload, attempts FROM jobs WHERE state='dead' AND finished_at>=?`
	args := []any{since}
	if kind != "" {
		query += ` AND kind=?`
		args = append(args, kind)
	}
	query += ` ORDER BY finished_at, created_at`
	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("jobs: dead since: %w", err)
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		var (
			j       Job
			payload string
		)
		if err := rows.Scan(&j.ID, &j.Kind, &payload, &j.Attempts); err != nil {
			return nil, fmt.Errorf("jobs: dead since: %w", err)
		}
		j.Payload = json.RawMessage(payload)
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("jobs: dead since: %w", err)
	}
	return out, nil
}

// fenced runs set (an "UPDATE jobs SET ..." prefix) only while j is still
// running under its lease token, returning the updated row, or ErrLeaseLost
// if no row matched.
func (q *Queue) fenced(ctx context.Context, op string, j *Job, set string, args ...any) (Job, error) {
	var (
		out     Job
		payload string
	)
	err := q.db.QueryRowContext(ctx,
		set+` WHERE id=? AND lease_token=? AND state='running' RETURNING id, kind, payload, attempts`,
		append(args, j.ID, j.LeaseToken)...).Scan(&out.ID, &out.Kind, &payload, &out.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, ErrLeaseLost
	}
	if err != nil {
		return Job{}, fmt.Errorf("jobs: %s: %w", op, err)
	}
	out.Payload = json.RawMessage(payload)
	return out, nil
}

func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("jobs: lease token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// truncate replaces invalid UTF-8 with U+FFFD, then cuts s to at most n
// bytes at a rune boundary.
func truncate(s string, n int) string {
	s = strings.ToValidUTF8(s, "\uFFFD")
	if len(s) <= n {
		return s
	}
	i := n
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return s[:i]
}
