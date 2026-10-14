// Package jobs is a SQLite-backed work queue with leases, heartbeats,
// exponential-backoff retries and dead-lettering (spec §6.2, §6.3).
//
// db.Open caps the pool at one connection, so every method here runs single
// statements and never holds a transaction or open rows across work.
package jobs

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
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

	maxErrorBytes = 500
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

// Queue is the job queue. It is safe for concurrent use.
type Queue struct {
	db  *sql.DB
	now func() int64
}

// New returns a Queue over d using now (Unix ms) as its clock.
func New(d *sql.DB, now func() int64) *Queue {
	return &Queue{db: d, now: now}
}

// Enqueue adds a job that is ready immediately.
func (q *Queue) Enqueue(ctx context.Context, kind string, payload any) (string, error) {
	return q.EnqueueAt(ctx, kind, payload, q.now())
}

// EnqueueAt adds a job that becomes claimable at runAfter (Unix ms).
func (q *Queue) EnqueueAt(ctx context.Context, kind string, payload any, runAfter int64) (string, error) {
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
	_, err = q.db.ExecContext(ctx,
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
	if _, err := q.db.ExecContext(ctx,
		`UPDATE jobs SET state='dead', lease_until=NULL, lease_token=NULL, last_error=?
		 WHERE state='running' AND lease_until<=? AND attempts>=?`,
		fmt.Sprintf("lease expired on attempt %d of %d", MaxAttempts, MaxAttempts), now, MaxAttempts); err != nil {
		return nil, fmt.Errorf("jobs: expire leases: %w", err)
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

// Heartbeat extends j's lease to now + LeaseMillis.
func (q *Queue) Heartbeat(ctx context.Context, j *Job) error {
	return q.fenced(ctx, "heartbeat", j, `UPDATE jobs SET lease_until=?`, q.now()+LeaseMillis)
}

// Done marks j finished.
func (q *Queue) Done(ctx context.Context, j *Job) error {
	return q.fenced(ctx, "done", j, `UPDATE jobs SET state='done', lease_until=NULL, lease_token=NULL`)
}

// Fail records cause on j. A permanent failure, or a failure on the
// MaxAttempts-th attempt, makes the job dead; otherwise it is requeued after
// 30s × 2^(attempts-1).
func (q *Queue) Fail(ctx context.Context, j *Job, permanent bool, cause error) error {
	msg := "unknown error"
	if cause != nil {
		msg = cause.Error()
	}
	msg = truncate(msg, maxErrorBytes)
	if permanent || j.Attempts >= MaxAttempts {
		return q.fenced(ctx, "fail", j,
			`UPDATE jobs SET state='dead', lease_until=NULL, lease_token=NULL, last_error=?`, msg)
	}
	delay := BaseBackoffMillis << (max(j.Attempts, 1) - 1)
	return q.fenced(ctx, "fail", j,
		`UPDATE jobs SET state='queued', run_after=?, lease_until=NULL, lease_token=NULL, last_error=?`,
		q.now()+delay, msg)
}

// PurgeDone deletes done and dead jobs created before olderThan (Unix ms) and
// returns how many were removed.
func (q *Queue) PurgeDone(ctx context.Context, olderThan int64) (int, error) {
	res, err := q.db.ExecContext(ctx,
		`DELETE FROM jobs WHERE state IN ('done', 'dead') AND created_at < ?`, olderThan)
	if err != nil {
		return 0, fmt.Errorf("jobs: purge: %w", err)
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// fenced runs set (an "UPDATE jobs SET ..." prefix) only while j is still
// running under its lease token, returning ErrLeaseLost otherwise.
func (q *Queue) fenced(ctx context.Context, op string, j *Job, set string, args ...any) error {
	res, err := q.db.ExecContext(ctx, set+` WHERE id=? AND lease_token=? AND state='running'`,
		append(args, j.ID, j.LeaseToken)...)
	if err != nil {
		return fmt.Errorf("jobs: %s: %w", op, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("jobs: %s: %w", op, err)
	}
	if n == 0 {
		return ErrLeaseLost
	}
	return nil
}

func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("jobs: lease token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// truncate cuts s to at most n bytes without splitting a UTF-8 sequence.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}
