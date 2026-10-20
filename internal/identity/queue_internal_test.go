package identity

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/timeStarry/frameMark/internal/db"
)

const qOrigin = "https://markr.example"

func newQueueSvc(t *testing.T, m Mailer) (*Service, *sql.DB) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "q.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	s := newTestService(t, d, Deps{Origin: qOrigin, Enabled: true, RegistrationOpen: true, Now: func() int64 { return 1_700_000_000_000 }, Mailer: m})
	t.Cleanup(func() { s.Close(context.Background()) })
	if _, err := d.Exec(`INSERT INTO users(id,email,password,created_at) VALUES('u1','old@example.com',?,0)`, dummyHash); err != nil {
		t.Fatal(err)
	}
	return s, d
}

// register bootstraps a fresh anonymous session from ip and registers email.
func register(t *testing.T, h http.Handler, ip, email string) (int, string) {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/auth/session", nil)
	r.RemoteAddr = ip + ":1"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var boot struct{ CSRFToken string }
	_ = json.Unmarshal(w.Body.Bytes(), &boot)
	var cookie string
	for _, c := range w.Result().Cookies() {
		cookie = c.Name + "=" + c.Value
	}
	r = httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(`{"email":"`+email+`"}`))
	r.RemoteAddr = ip + ":1"
	r.Header.Set("Origin", qOrigin)
	r.Header.Set("X-CSRF-Token", boot.CSRFToken)
	r.Header.Set("Cookie", cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func pendingCount(t *testing.T, d *sql.DB) int {
	t.Helper()
	var n int
	if err := d.QueryRow(`SELECT count(*) FROM pending_verifications`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// captureLog redirects the standard logger. Tests using it must not run in
// parallel.
func captureLog(t *testing.T) *lockedBuffer {
	b := &lockedBuffer{}
	prev := log.Writer()
	log.SetOutput(b)
	t.Cleanup(func() { log.SetOutput(prev) })
	return b
}

type lockedBuffer struct {
	mu  chan struct{}
	buf bytes.Buffer
}

func (b *lockedBuffer) lock() {
	if b.mu == nil {
		b.mu = make(chan struct{}, 1)
	}
	b.mu <- struct{}{}
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.lock()
	defer func() { <-b.mu }()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.lock()
	defer func() { <-b.mu }()
	return b.buf.String()
}

func assertUniform(t *testing.T, codeOld int, bodyOld string, codeNew int, bodyNew string) {
	t.Helper()
	if codeOld != 202 || codeNew != 202 || bodyOld != bodyNew {
		t.Fatalf("register not uniform: existing=%d %q new=%d %q", codeOld, bodyOld, codeNew, bodyNew)
	}
}

func TestRegisterUniformWhileScryptSaturated(t *testing.T) {
	sent := make(chan Mail, 4)
	s, d := newQueueSvc(t, MailerFunc(func(m Mail) error { sent <- m; return nil }))
	h := s.Handler()
	s.slots <- struct{}{}
	s.slots <- struct{}{}
	codeOld, bodyOld := register(t, h, "192.0.2.1", "old@example.com")
	codeNew, bodyNew := register(t, h, "192.0.2.2", "new@example.com")
	<-s.slots
	<-s.slots
	assertUniform(t, codeOld, bodyOld, codeNew, bodyNew)
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(sent)
	var got []string
	for m := range sent {
		got = append(got, m.To)
	}
	if len(got) != 1 || got[0] != "new@example.com" {
		t.Fatalf("want one mail to new@example.com, got %v", got)
	}
	if pendingCount(t, d) != 1 {
		t.Fatal("pending row must stay after successful send")
	}
}

func TestRegisterUniformWhenMailFails(t *testing.T) {
	buf := captureLog(t)
	s, d := newQueueSvc(t, MailerFunc(func(m Mail) error {
		return errors.New("535 secret server text for " + m.To)
	}))
	h := s.Handler()
	codeOld, bodyOld := register(t, h, "192.0.2.1", "old@example.com")
	codeNew, bodyNew := register(t, h, "192.0.2.2", "new@example.com")
	assertUniform(t, codeOld, bodyOld, codeNew, bodyNew)
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if pendingCount(t, d) != 0 {
		t.Fatal("failed send must delete the pending row")
	}
	out := buf.String()
	if !strings.Contains(out, "verification mail send failed") {
		t.Fatalf("want failure category logged, got %q", out)
	}
	for _, leak := range []string{"new@example.com", "verify=", "secret", "535"} {
		if strings.Contains(out, leak) {
			t.Fatalf("log leaks %q: %q", leak, out)
		}
	}
}

func TestRegisterUniformWhenMailPanics(t *testing.T) {
	captureLog(t)
	s, d := newQueueSvc(t, MailerFunc(func(Mail) error { panic("boom") }))
	h := s.Handler()
	codeOld, bodyOld := register(t, h, "192.0.2.1", "old@example.com")
	codeNew, bodyNew := register(t, h, "192.0.2.2", "new@example.com")
	assertUniform(t, codeOld, bodyOld, codeNew, bodyNew)
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if pendingCount(t, d) != 0 {
		t.Fatal("panicking send must delete the pending row")
	}
}

func TestRegisterUniformWhenQueueFull(t *testing.T) {
	buf := captureLog(t)
	entered, release := make(chan struct{}, mailWorkers), make(chan struct{})
	s, d := newQueueSvc(t, MailerFunc(func(Mail) error {
		select { // signal without blocking once the queue drains
		case entered <- struct{}{}:
		default:
		}
		<-release
		return nil
	}))
	// Occupy both workers, then fill the buffer.
	for i := 0; i < mailWorkers; i++ {
		if !s.enqueue(mailJob{}) {
			t.Fatal("enqueue refused")
		}
	}
	for i := 0; i < mailWorkers; i++ {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("workers did not start")
		}
	}
	for i := 0; i < mailQueueSize; i++ {
		if !s.enqueue(mailJob{}) {
			t.Fatalf("queue full after %d", i)
		}
	}
	if s.enqueue(mailJob{}) {
		t.Fatal("queue must be full")
	}
	h := s.Handler()
	codeOld, bodyOld := register(t, h, "192.0.2.1", "old@example.com")
	codeNew, bodyNew := register(t, h, "192.0.2.2", "new@example.com")
	assertUniform(t, codeOld, bodyOld, codeNew, bodyNew)
	if pendingCount(t, d) != 0 {
		t.Fatal("dropped job must delete its pending row")
	}
	if out := buf.String(); !strings.Contains(out, "mail queue full") || strings.Contains(out, "new@example.com") || strings.Contains(out, "verify=") {
		t.Fatalf("queue-full log: %q", out)
	}
	close(release)
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestCloseStopsAcceptingAndHonorsContext(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	s, _ := newQueueSvc(t, MailerFunc(func(Mail) error { entered <- struct{}{}; <-release; return nil }))
	if !s.enqueue(mailJob{}) {
		t.Fatal("enqueue refused")
	}
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Close(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Close with done ctx and busy worker: %v", err)
	}
	if s.enqueue(mailJob{}) {
		t.Fatal("enqueue accepted after Close")
	}
	close(release)
	if err := s.Close(context.Background()); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

type nilSender struct{}

func (*nilSender) Send(Mail) error { return nil }

func TestTypedNilMailerIsNoMailer(t *testing.T) {
	for name, m := range map[string]Mailer{"func": MailerFunc(nil), "ptr": (*nilSender)(nil)} {
		t.Run(name, func(t *testing.T) {
			s, d := newQueueSvc(t, m)
			code, body := register(t, s.Handler(), "192.0.2.1", "new@example.com")
			if code != 503 || !strings.Contains(body, msgNoMailer) || pendingCount(t, d) != 0 {
				t.Fatalf("typed-nil mailer: %d %s", code, body)
			}
		})
	}
}

// newTestService adapts to New's signature.
func newTestService(t *testing.T, d *sql.DB, deps Deps) *Service {
	t.Helper()
	s, err := New(d, deps)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
