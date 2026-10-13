package identity_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/identity"
)

const (
	origin   = "https://markr.example"
	password = "isolated fixture long passphrase 2026"
	t0       = int64(1_700_000_000_000)
	minute   = int64(60_000)
	hour     = 60 * minute
	day      = 24 * hour
)

var (
	tokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	// fixtureHash is scrypt(password) at production cost, computed once.
	fixtureHash string
)

func TestMain(m *testing.M) {
	h, err := identity.HashPassword(password)
	if err != nil {
		panic(err)
	}
	fixtureHash = h
	os.Exit(m.Run())
}

type env struct {
	t      *testing.T
	d      *sql.DB
	now    atomic.Int64
	deps   identity.Deps
	h      http.Handler
	svc    *identity.Service
	mu     sync.Mutex
	outbox []identity.Mail
	sent   chan struct{} // one signal per delivered mail
}

func newEnv(t *testing.T, mod func(*identity.Deps)) *env {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "markr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, d: d, sent: make(chan struct{}, 1024)}
	e.now.Store(t0)
	e.deps = identity.Deps{
		Origin:           origin,
		Enabled:          true,
		RegistrationOpen: true,
		Now:              e.now.Load,
		Mailer: identity.MailerFunc(func(m identity.Mail) error {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.outbox = append(e.outbox, m)
			e.sent <- struct{}{}
			return nil
		}),
	}
	if mod != nil {
		mod(&e.deps)
	}
	e.start()
	// Registered after the DB cleanup, so it runs first (LIFO).
	t.Cleanup(func() { e.svc.Close(context.Background()) })
	return e
}

func (e *env) start() {
	svc, err := identity.New(e.d, e.deps)
	if err != nil {
		e.t.Fatal(err)
	}
	e.svc, e.h = svc, svc.Handler()
}

// restart builds a fresh Service on the same database (rate limits and
// sessions must survive).
func (e *env) restart() {
	if err := e.svc.Close(context.Background()); err != nil {
		e.t.Fatal(err)
	}
	e.start()
}

// drain waits for every queued mail job to finish, then restarts so the
// env stays usable.
func (e *env) drain() { e.restart() }

// awaitMail blocks until the fake mailer has delivered one more message.
func (e *env) awaitMail() {
	e.t.Helper()
	select {
	case <-e.sent:
	case <-time.After(5 * time.Second):
		e.t.Fatal("verification mail was not sent")
	}
}

func (e *env) tick(ms int64) { e.now.Add(ms) }

func (e *env) count(table string) int {
	var n int
	if err := e.d.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) lastToken() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.outbox) == 0 {
		e.t.Fatal("no mail sent")
	}
	u := e.outbox[len(e.outbox)-1].URL
	tok, ok := strings.CutPrefix(u, origin+"/login#verify=")
	if !ok || !tokenRe.MatchString(tok) {
		e.t.Fatalf("bad verification url %q", u)
	}
	return tok
}

func (e *env) mails() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.outbox)
}

// insertUser adds an existing user with the fixture password.
func (e *env) insertUser(id, email string) {
	if _, err := e.d.Exec("INSERT INTO users(id,email,password,created_at) VALUES(?,?,?,?)", id, email, fixtureHash, t0); err != nil {
		e.t.Fatal(err)
	}
}

type client struct {
	e      *env
	name   string // cookie name
	cookie string // cookie value
	csrf   string
	ip     string
}

func (e *env) client() *client {
	name := "__Host-markr_session"
	if strings.HasPrefix(e.deps.Origin, "http://") {
		name = "markr_dev_session"
	}
	return &client{e: e, name: name, ip: "192.0.2.1:4000"}
}

type resp struct {
	code   int
	body   map[string]any
	header http.Header
	set    []string
}

func (c *client) do(method, path, body string, hdr map[string]string) resp {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	r.RemoteAddr = c.ip
	if method != http.MethodGet {
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", c.csrf)
	}
	if c.cookie != "" {
		r.Header.Set("Cookie", c.name+"="+c.cookie)
	}
	for k, v := range hdr {
		if v == "<delete>" {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	c.e.h.ServeHTTP(w, r)
	out := resp{code: w.Code, header: w.Header(), set: w.Header().Values("Set-Cookie")}
	for _, ck := range w.Result().Cookies() {
		if ck.Name == c.name {
			if ck.MaxAge < 0 {
				c.cookie = ""
			} else {
				c.cookie = ck.Value
			}
		}
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out.body)
	if tok, ok := out.body["csrfToken"].(string); ok {
		c.csrf = tok
	}
	return out
}

// doRaw sends a write with valid Origin/CSRF/cookie and lets edit add raw
// (possibly repeated) headers.
func (c *client) doRaw(method, path string, edit func(http.Header)) resp {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = c.ip
	r.Header.Set("Origin", origin)
	r.Header.Set("X-CSRF-Token", c.csrf)
	r.Header.Set("Cookie", c.name+"="+c.cookie)
	edit(r.Header)
	w := httptest.NewRecorder()
	c.e.h.ServeHTTP(w, r)
	out := resp{code: w.Code, header: w.Header()}
	_ = json.Unmarshal(w.Body.Bytes(), &out.body)
	return out
}

func (c *client) bootstrap() resp { return c.do(http.MethodGet, "/api/auth/session", "", nil) }

func (c *client) post(path, body string) resp { return c.do(http.MethodPost, path, body, nil) }

func (c *client) register(email string) string {
	c.e.t.Helper()
	if c.csrf == "" {
		c.bootstrap()
	}
	before := c.e.mails()
	r := c.post("/api/auth/register", `{"email":"`+email+`"}`)
	if r.code != 202 {
		c.e.t.Fatalf("register %s: %d %v", email, r.code, r.body)
	}
	c.e.awaitMail()
	if c.e.mails() != before+1 {
		c.e.t.Fatalf("register %s: want exactly one new mail", email)
	}
	return c.e.lastToken()
}

func (c *client) verify(tok string) resp {
	return c.post("/api/auth/verify", `{"token":"`+tok+`","password":"`+password+`"}`)
}

func (c *client) login(email, pw string) resp {
	if c.csrf == "" {
		c.bootstrap()
	}
	return c.post("/api/auth/login", `{"email":"`+email+`","password":"`+pw+`"}`)
}

func (c *client) viewer() any { return c.bootstrap().body["user"] }

func errMsg(r resp) string { s, _ := r.body["error"].(string); return s }

// --- password hashing ---

func TestPasswordHashingIsSaltedAndVerifies(t *testing.T) {
	if !regexp.MustCompile(`^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$`).MatchString(fixtureHash) {
		t.Fatalf("bad encoding %q", fixtureHash)
	}
	other, err := identity.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if other == fixtureHash {
		t.Fatal("hashes must be salted")
	}
	if !identity.VerifyPassword(password, fixtureHash) {
		t.Fatal("correct password rejected")
	}
	if identity.VerifyPassword("wrong password long enough", fixtureHash) {
		t.Fatal("wrong password accepted")
	}
	for _, bad := range []string{"corrupt", "", "scrypt-v1$zz$00", "scrypt-v2" + fixtureHash[9:], fixtureHash + "$x", strings.ToUpper(fixtureHash)} {
		if identity.VerifyPassword(password, bad) {
			t.Fatalf("malformed encoding %q accepted", bad)
		}
	}
}

// --- brief scenario: register behind CSRF ---

func TestRegisterRequiresOriginAndCSRF(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	boot := c.bootstrap()
	if boot.code != 200 || boot.body["user"] != nil || boot.body["registrationOpen"] != true || !tokenRe.MatchString(c.csrf) || !tokenRe.MatchString(c.cookie) {
		t.Fatalf("bad bootstrap %d %v", boot.code, boot.body)
	}
	body := `{"email":"a@b.co"}`
	if r := c.do("POST", "/api/auth/register", body, map[string]string{"Origin": "https://evil.example"}); r.code != 403 || errMsg(r) != "请求来源无效，请从本站重试。" {
		t.Fatalf("foreign origin: %d %v", r.code, r.body)
	}
	if r := c.do("POST", "/api/auth/register", body, map[string]string{"X-CSRF-Token": "wrong"}); r.code != 403 || errMsg(r) != "会话校验失败，请刷新页面后重试。" {
		t.Fatalf("bad csrf: %d %v", r.code, r.body)
	}
	if e.mails() != 0 {
		t.Fatal("mail sent despite CSRF failure")
	}
	r := c.post("/api/auth/register", body)
	if r.code == 202 {
		e.awaitMail()
	}
	if r.code != 202 || r.body["message"] != "如果该邮箱可以注册，验证邮件已发送。请在 30 分钟内打开链接并设置密码。" || e.mails() != 1 {
		t.Fatalf("register: %d %v mails=%d", r.code, r.body, e.mails())
	}
	e.lastToken()
}

// --- verification lifecycle ---

func TestVerificationIsOneTimeAndReplacesOlderLinks(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	first := c.register("pending@example.com")
	if e.count("users") != 0 {
		t.Fatal("user created before verification")
	}
	var stored string
	if err := e.d.QueryRow("SELECT hash FROM pending_verifications").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == first || len(stored) != 64 {
		t.Fatalf("token must be stored as sha256 hex, got %q", stored)
	}
	if r := c.login("pending@example.com", password); r.code != 401 {
		t.Fatalf("login before verify: %d", r.code)
	}
	second := c.register(" PENDING@example.com ")
	if second == first {
		t.Fatal("re-register must issue a new token")
	}
	if r := c.verify(first); r.code != 400 || errMsg(r) != "验证链接无效或已过期。" {
		t.Fatalf("superseded token: %d %v", r.code, r.body)
	}
	anon := c.cookie
	r := c.verify(second)
	if r.code != 201 || !tokenRe.MatchString(c.csrf) {
		t.Fatalf("verify: %d %v", r.code, r.body)
	}
	id, _ := r.body["user"].(string)
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
		t.Fatalf("user id must be UUIDv7, got %q", id)
	}
	if c.cookie == anon {
		t.Fatal("session must rotate on verify")
	}
	if c.viewer() != id {
		t.Fatal("verified session not logged in")
	}
	if r := c.verify(second); r.code != 400 {
		t.Fatalf("replay: %d", r.code)
	}
	var email, pw string
	if err := e.d.QueryRow("SELECT email,password FROM users WHERE id=?", id).Scan(&email, &pw); err != nil {
		t.Fatal(err)
	}
	if email != "pending@example.com" || !strings.HasPrefix(pw, "scrypt-v1$") || strings.Contains(pw, password) {
		t.Fatalf("stored user %q %q", email, pw)
	}
	// Registering an existing account: same 202, no mail, no new user.
	before := e.mails()
	if r := c.post("/api/auth/register", `{"email":"pending@example.com"}`); r.code != 202 || r.body["message"] != "如果该邮箱可以注册，验证邮件已发送。请在 30 分钟内打开链接并设置密码。" {
		t.Fatalf("existing register: %d %v", r.code, r.body)
	}
	e.drain()
	if e.mails() != before || e.count("users") != 1 || e.count("pending_verifications") != 0 {
		t.Fatal("existing email must not send mail or create rows")
	}
	// Old anonymous cookie is dead after rotation.
	old := e.client()
	old.cookie = anon
	if r := old.bootstrap(); r.body["user"] != nil || old.cookie == anon {
		t.Fatal("pre-rotation cookie still valid")
	}
}

func TestVerificationTokenExpiresAfter30Minutes(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	tok := c.register("expired@example.com")
	e.tick(30*minute + 1)
	c.bootstrap() // anonymous session also expired (15 min); get a fresh one
	if r := c.verify(tok); r.code != 400 || errMsg(r) != "验证链接无效或已过期。" {
		t.Fatalf("expired token: %d %v", r.code, r.body)
	}
	if e.count("users") != 0 || e.count("pending_verifications") != 0 {
		t.Fatal("expired pending must be pruned and create no user")
	}
}

func TestVerifyRejectsMalformedTokenAndPasswordRules(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	c.bootstrap()
	for _, body := range []string{`{"token":"short","password":"` + password + `"}`, `{"token":123,"password":"` + password + `"}`, `{"password":"` + password + `"}`} {
		if r := c.post("/api/auth/verify", body); r.code != 400 || errMsg(r) != "验证链接无效或已过期。" {
			t.Fatalf("%s: %d %v", body, r.code, r.body)
		}
	}
	tok := strings.Repeat("A", 43)
	for _, pw := range []string{"fourteen chars", "", strings.Repeat("é", 129)} {
		if r := c.post("/api/auth/verify", `{"token":"`+tok+`","password":"`+pw+`"}`); r.code != 400 || errMsg(r) != "密码至少 15 个字符，最多 256 字节。" {
			t.Fatalf("pw %q: %d %v", pw, r.code, r.body)
		}
	}
	// 15 runes but multi-byte is fine; unknown token then fails as invalid.
	if r := c.post("/api/auth/verify", `{"token":"`+tok+`","password":"`+strings.Repeat("密", 15)+`"}`); r.code != 400 || errMsg(r) != "验证链接无效或已过期。" {
		t.Fatalf("unknown token: %d %v", r.code, r.body)
	}
}

func TestConcurrentVerifyCreatesOneUser(t *testing.T) {
	e := newEnv(t, nil)
	a, b := e.client(), e.client()
	tok := a.register("race@example.com")
	b.bootstrap()
	codes := make([]int, 2)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i, c := range []*client{a, b} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			codes[i] = c.verify(tok).code
		}()
	}
	close(start)
	wg.Wait()
	if !((codes[0] == 201 && codes[1] == 400) || (codes[0] == 400 && codes[1] == 201)) {
		t.Fatalf("want one 201 and one 400, got %v", codes)
	}
	if e.count("users") != 1 {
		t.Fatalf("want exactly one user, got %d", e.count("users"))
	}
}

func TestVerifyEmailTakenInsideTransactionIs400(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	tok := c.register("taken@example.com")
	e.insertUser("01900000-0000-7000-8000-000000000001", "taken@example.com")
	if r := c.verify(tok); r.code != 400 || errMsg(r) != "验证链接无效或已使用。" {
		t.Fatalf("constraint: %d %v", r.code, r.body)
	}
	if e.count("users") != 1 || e.count("pending_verifications") != 1 {
		t.Fatal("transaction must roll back")
	}
}

// --- login ---

func TestLoginNormalizesEmailAndRotatesSession(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "alice@example.com")
	c := e.client()
	c.bootstrap()
	anon, anonCSRF := c.cookie, c.csrf
	r := c.login(" ALICE@Example.COM ", password)
	if r.code != 200 || r.body["user"] != "u1" {
		t.Fatalf("login: %d %v", r.code, r.body)
	}
	if c.cookie == anon || c.csrf == anonCSRF {
		t.Fatal("login must rotate cookie and csrf")
	}
	if e.count("sessions") != 1 {
		t.Fatalf("old session must be deleted, have %d", e.count("sessions"))
	}
	if r := c.login("alice@example.com", "wrong password long enough"); r.code != 401 || errMsg(r) != "邮箱或密码不正确。" {
		t.Fatalf("wrong password: %d %v", r.code, r.body)
	}
}

func TestUnknownEmailLoginIs401ViaDummyHash(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	r := c.login("nobody@example.com", password)
	if r.code != 401 || errMsg(r) != "邮箱或密码不正确。" {
		t.Fatalf("unknown email: %d %v", r.code, r.body)
	}
	if r := c.login("not-an-email", password); r.code != 400 || errMsg(r) != "请填写有效邮箱。" {
		t.Fatalf("bad email: %d %v", r.code, r.body)
	}
}

// --- sessions ---

func TestLogoutAndLogoutAll(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "s@example.com")
	a, b := e.client(), e.client()
	if a.login("s@example.com", password).code != 200 || b.login("s@example.com", password).code != 200 {
		t.Fatal("login failed")
	}
	// logout-all needs a viewer.
	anon := e.client()
	anon.bootstrap()
	if r := anon.post("/api/auth/logout-all", ""); r.code != 401 || errMsg(r) != "请先登录。" {
		t.Fatalf("anon logout-all: %d %v", r.code, r.body)
	}
	r := a.post("/api/auth/logout-all", "")
	if r.code != 200 || r.body["user"] != nil || !strings.Contains(strings.Join(r.set, ";"), "Max-Age=0") {
		t.Fatalf("logout-all: %d %v %v", r.code, r.body, r.set)
	}
	if b.viewer() != nil {
		t.Fatal("other session survived logout-all")
	}
	// logout ends only the current session; the old cookie is dead.
	c := e.client()
	c.login("s@example.com", password)
	old := c.cookie
	if r := c.post("/api/auth/logout", ""); r.code != 200 || r.body["user"] != nil {
		t.Fatalf("logout: %d %v", r.code, r.body)
	}
	c.cookie = old
	if c.viewer() != nil {
		t.Fatal("cookie valid after logout")
	}
}

func TestIdleTimeout24h(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "idle@example.com")
	c := e.client()
	c.login("idle@example.com", password)
	e.tick(day - 1)
	if c.viewer() != "u1" {
		t.Fatal("session expired before idle timeout")
	}
	e.tick(day)
	if c.viewer() != nil {
		t.Fatal("session survived 24h idle")
	}
}

func TestAbsoluteExpirySevenDaysDespiteActivity(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "abs@example.com")
	c := e.client()
	r := c.login("abs@example.com", password)
	set := strings.Join(r.set, ";")
	for _, want := range []string{"__Host-markr_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"} {
		if !strings.Contains(set, want) {
			t.Fatalf("cookie %q missing %q", set, want)
		}
	}
	if strings.Contains(set, "Domain=") {
		t.Fatal("host cookie must not set Domain")
	}
	for i := 0; i < 7; i++ {
		e.tick(23 * hour)
		if c.viewer() != "u1" {
			t.Fatalf("expired early after %d days of activity", i+1)
		}
	}
	e.tick(7*day - 7*23*hour) // exactly 7 days since login
	if c.viewer() != nil {
		t.Fatal("session survived 7-day absolute expiry")
	}
}

func TestAnonymousSessionExpiresIn15Minutes(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	r := c.bootstrap()
	if !strings.Contains(strings.Join(r.set, ";"), "Max-Age=900") {
		t.Fatalf("anon cookie max-age: %v", r.set)
	}
	first := c.cookie
	e.tick(15*minute - 1)
	c.bootstrap()
	if c.cookie != first {
		t.Fatal("anon session renewed before 15 minutes")
	}
	e.tick(1)
	c.bootstrap()
	if c.cookie == first {
		t.Fatal("anon session survived 15 minutes")
	}
}

func TestDevCookieHasNoSecureFlag(t *testing.T) {
	e := newEnv(t, func(d *identity.Deps) { d.Origin = "http://localhost:5173"; d.Dev = true })
	c := e.client()
	r := c.bootstrap()
	set := strings.Join(r.set, ";")
	if !strings.Contains(set, "markr_dev_session=") || strings.Contains(set, "Secure") || !strings.Contains(set, "HttpOnly") || !strings.Contains(set, "SameSite=Lax") {
		t.Fatalf("dev cookie: %q", set)
	}
}

func TestDuplicateOrMalformedCookieIsNoSession(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "dup@example.com")
	c := e.client()
	c.login("dup@example.com", password)
	good := c.cookie
	other := e.client()
	other.bootstrap()
	dup := other.do("GET", "/api/auth/session", "", map[string]string{"Cookie": c.name + "=" + good + "; " + c.name + "=" + other.cookie})
	if dup.body["user"] != nil || len(dup.set) == 0 {
		t.Fatalf("duplicate cookie must be ignored: %v", dup.body)
	}
	for _, v := range []string{good + "x", good[:42], strings.Repeat("é", 43), good[:42] + "="} {
		r := c.do("GET", "/api/auth/session", "", map[string]string{"Cookie": c.name + "=" + v})
		if r.body["user"] != nil {
			t.Fatalf("malformed cookie %q accepted", v)
		}
	}
	// Spoofed identity headers do nothing.
	anon := e.client()
	if r := anon.do("GET", "/api/auth/session", "", map[string]string{"X-User": "u1", "X-Forwarded-For": "10.0.0.1"}); r.body["user"] != nil {
		t.Fatal("header spoofing granted identity")
	}
}

// --- CSRF ---

func TestCSRFFailuresAre403(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "csrf@example.com")
	c := e.client()
	c.login("csrf@example.com", password)
	origin403 := "请求来源无效，请从本站重试。"
	session403 := "会话校验失败，请刷新页面后重试。"
	cases := []struct {
		hdr  map[string]string
		want string
	}{
		{map[string]string{"X-CSRF-Token": ""}, session403},
		{map[string]string{"X-CSRF-Token": "<delete>"}, session403},
		{map[string]string{"X-CSRF-Token": strings.Repeat("é", 43)}, session403},
		{map[string]string{"X-CSRF-Token": strings.Repeat("A", 43)}, session403},
		{map[string]string{"Origin": "https://evil.example"}, origin403},
		{map[string]string{"Origin": "<delete>"}, origin403},
		{map[string]string{"Origin": origin + "/"}, origin403},
		{map[string]string{"Sec-Fetch-Site": "cross-site"}, origin403},
		{map[string]string{"Cookie": "<delete>"}, session403},
	}
	for _, tc := range cases {
		r := c.do("POST", "/api/auth/logout", "", tc.hdr)
		if r.code != 403 || errMsg(r) != tc.want {
			t.Errorf("%v: %d %v", tc.hdr, r.code, r.body)
		}
	}
	if c.viewer() != "u1" {
		t.Fatal("rejected writes must not log out")
	}
	// Duplicate Sec-Fetch-Site values fail closed.
	if r := c.doRaw("POST", "/api/auth/logout", func(h http.Header) {
		h.Add("Sec-Fetch-Site", "same-origin")
		h.Add("Sec-Fetch-Site", "cross-site")
	}); r.code != 403 || errMsg(r) != origin403 {
		t.Errorf("duplicate Sec-Fetch-Site: %d %v", r.code, r.body)
	}
	// Origin: null and lowercase methods are rejected.
	if r := c.do("POST", "/api/auth/logout", "", map[string]string{"Origin": "null"}); r.code != 403 || errMsg(r) != origin403 {
		t.Errorf("Origin null: %d %v", r.code, r.body)
	}
	for _, m := range []string{"post", "get"} {
		if r := c.do(m, "/api/auth/logout", "", map[string]string{"Origin": "https://evil.example", "X-CSRF-Token": "<delete>"}); r.code != 403 {
			t.Errorf("lowercase %s must require CSRF: %d", m, r.code)
		}
	}
	// Safe methods pass the middleware without a token (no handler: 405).
	for _, m := range []string{"HEAD", "OPTIONS"} {
		if r := c.do(m, "/api/auth/session", "", map[string]string{"Origin": "<delete>", "X-CSRF-Token": "<delete>"}); r.code == 403 {
			t.Errorf("%s must not be CSRF-checked: %d", m, r.code)
		}
	}
	if c.viewer() != "u1" {
		t.Fatal("rejected writes must not log out")
	}
	// Missing Sec-Fetch-Site with a valid Origin is accepted.
	if r := c.do("POST", "/api/auth/logout", "", map[string]string{"Sec-Fetch-Site": "<delete>"}); r.code != 200 {
		t.Fatalf("no fetch metadata rejected: %d %v", r.code, r.body)
	}
	c.bootstrap() // logged out above; get a fresh anonymous session
	if r := c.login("csrf@example.com", password); r.code != 200 {
		t.Fatalf("re-login: %d %v", r.code, r.body)
	}
	// Same-origin and same-site fetch metadata are accepted.
	if r := c.do("POST", "/api/auth/logout", "", map[string]string{"Sec-Fetch-Site": "same-origin"}); r.code != 200 {
		t.Fatalf("valid write rejected: %d %v", r.code, r.body)
	}
}

// --- rate limits ---

func TestRegisterEmailRateLimitPersistsAndResets(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	for i := 0; i < 3; i++ {
		c.register("rate@example.com")
	}
	e.restart()
	r := c.post("/api/auth/register", `{"email":"RATE@example.com"}`)
	if r.code != 429 || errMsg(r) != "请求过于频繁，请在 15 分钟后重试。" {
		t.Fatalf("4th register: %d %v", r.code, r.body)
	}
	var key string
	if err := e.d.QueryRow("SELECT key FROM rate_limits LIMIT 1").Scan(&key); err != nil || len(key) != 64 || strings.Contains(key, "rate") {
		t.Fatalf("rate key must be a digest, got %q %v", key, err)
	}
	e.tick(15*minute + 1)
	c.bootstrap()
	c.register("rate@example.com")
}

func TestAuthIPRateLimit(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	c.bootstrap()
	for i := 0; i < 10; i++ {
		if r := c.login("ip@example.com", "short"); r.code != 400 {
			t.Fatalf("attempt %d: %d", i+1, r.code)
		}
	}
	if r := c.login("ip@example.com", "short"); r.code != 429 {
		t.Fatalf("11th: %d", r.code)
	}
	other := e.client()
	other.ip = "198.51.100.7:1"
	if r := other.login("ip@example.com", "short"); r.code != 400 {
		t.Fatalf("other ip limited: %d", r.code)
	}
}

func TestRegisterIPRateLimit(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	for i := 0; i < 5; i++ {
		c.register("ip" + string(rune('a'+i)) + "@example.com")
	}
	if r := c.post("/api/auth/register", `{"email":"ipz@example.com"}`); r.code != 429 {
		t.Fatalf("6th: %d", r.code)
	}
}

func TestBootstrapRateLimit(t *testing.T) {
	e := newEnv(t, nil)
	for i := 0; i < 60; i++ {
		if r := e.client().bootstrap(); r.code != 200 {
			t.Fatalf("bootstrap %d: %d", i+1, r.code)
		}
	}
	if r := e.client().bootstrap(); r.code != 429 {
		t.Fatalf("61st bootstrap: %d", r.code)
	}
}

// --- configuration and failure modes ---

func TestRegistrationClosedAndMailFailures(t *testing.T) {
	cases := []struct {
		name string
		mod  func(*identity.Deps)
		code int
		msg  string
	}{
		{"closed", func(d *identity.Deps) { d.RegistrationOpen = false }, 403, "注册尚未开放。"},
		{"no mailer", func(d *identity.Deps) { d.Mailer = nil }, 503, "验证邮件服务暂不可用。"},
		{"mail fails", func(d *identity.Deps) {
			d.Mailer = identity.MailerFunc(func(identity.Mail) error { return errors.New("secret smtp error") })
		}, 202, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t, tc.mod)
			c := e.client()
			boot := c.bootstrap()
			if boot.body["registrationOpen"] != e.deps.RegistrationOpen {
				t.Fatalf("registrationOpen: %v", boot.body)
			}
			r := c.post("/api/auth/register", `{"email":"failure@example.com"}`)
			if r.code != tc.code || errMsg(r) != tc.msg {
				t.Fatalf("%d %v", r.code, r.body)
			}
			e.drain() // the failed send deletes its pending row asynchronously
			if strings.Contains(errMsg(r), "secret") || e.count("pending_verifications") != 0 {
				t.Fatal("leak or pending row left")
			}
			if tc.name != "mail fails" {
				vr := c.post("/api/auth/verify", `{"token":"`+strings.Repeat("A", 43)+`","password":"`+password+`"}`)
				if vr.code != tc.code || errMsg(vr) != tc.msg {
					t.Fatalf("verify: %d %v", vr.code, vr.body)
				}
			}
		})
	}
}

func TestDisabledIdentity(t *testing.T) {
	e := newEnv(t, func(d *identity.Deps) { d.Enabled = false })
	c := e.client()
	if r := c.bootstrap(); r.code != 404 {
		t.Fatalf("auth routes must not be mounted: %d", r.code)
	}
	if r := c.post("/api/auth/login", `{}`); r.code != 403 {
		t.Fatalf("writes must fail CSRF: %d", r.code)
	}
}

func TestMiddlewareHeadersBodyLimitAndUser(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "mw@example.com")
	c := e.client()
	if r := c.bootstrap(); r.header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("cache-control: %q", r.header.Get("Cache-Control"))
	}
	big := `{"email":"` + strings.Repeat("a", 129<<10) + `"}`
	if r := c.post("/api/auth/register", big); r.code != 413 {
		t.Fatalf("oversized body: %d", r.code)
	}
	if r := c.post("/api/auth/register", `{not json`); r.code != 400 {
		t.Fatalf("bad json: %d", r.code)
	}
	c.login("mw@example.com", password)

	svc, err := identity.New(e.d, e.deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close(context.Background()) })
	var seen string
	h := svc.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen = identity.User(r.Context()) }))
	req := httptest.NewRequest("GET", "/api/anything", nil)
	req.Header.Set("Cookie", c.name+"="+c.cookie)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if seen != "u1" {
		t.Fatalf("User(ctx) = %q", seen)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/anything", nil))
	if seen != "" {
		t.Fatalf("anonymous User(ctx) = %q", seen)
	}
}

func TestNewRejectsHTTPOriginOutsideDev(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "n.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := identity.New(d, identity.Deps{Origin: "http://localhost:5173"}); err == nil {
		t.Fatal("http origin without Dev must be refused")
	}
	for _, o := range []string{"", "ftp://x", "localhost"} {
		if _, err := identity.New(d, identity.Deps{Origin: o, Dev: true}); err == nil {
			t.Errorf("origin %q must be refused", o)
		}
	}
	s, err := identity.New(d, identity.Deps{Origin: "https://markr.example", Dev: true})
	if err != nil {
		t.Fatal(err)
	}
	s.Close(context.Background())
}

func TestStrictJSONOverHTTP(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	c.bootstrap()
	for _, body := range []string{`{"email":"a@b.co"}{"email":"c@d.co"}`, `{"email":"a@b.co"} x`, `{"email":"a@b.co","admin":true}`} {
		if r := c.post("/api/auth/register", body); r.code != 400 || errMsg(r) != "请求格式无效。" {
			t.Errorf("%s: %d %v", body, r.code, r.body)
		}
	}
	e.drain()
	if e.mails() != 0 || e.count("pending_verifications") != 0 {
		t.Fatal("rejected body must not register")
	}
}

func TestAbsoluteExpiryBoundaryIsExclusive(t *testing.T) {
	e := newEnv(t, nil)
	e.insertUser("u1", "edge@example.com")
	c := e.client()
	c.login("edge@example.com", password)
	e.tick(7*day - 1)
	// keep it from idling out: touch was at login, so refresh it via direct SQL
	if _, err := e.d.Exec("UPDATE sessions SET touched_at=?", e.now.Load()); err != nil {
		t.Fatal(err)
	}
	if c.viewer() != "u1" {
		t.Fatal("session ended before expires_at")
	}
	e.tick(1) // now == expires_at
	if c.viewer() != nil {
		t.Fatal("expires_at == now must be no session")
	}
}

func TestPendingSurvivesVerifyRollback(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	tok := c.register("rollback@example.com")
	e.insertUser("u-taken", "rollback@example.com")
	if r := c.verify(tok); r.code != 400 {
		t.Fatalf("verify: %d", r.code)
	}
	var n int
	if err := e.d.QueryRow("SELECT count(*) FROM pending_verifications WHERE email='rollback@example.com'").Scan(&n); err != nil || n != 1 {
		t.Fatalf("pending row must survive rollback: n=%d err=%v", n, err)
	}
}

func TestIPv6RateLimitIsPer64(t *testing.T) {
	e := newEnv(t, nil)
	for i := 0; i < 10; i++ {
		c := e.client()
		c.ip = fmt.Sprintf("[2001:db8:1:2::%x]:443", i+1)
		c.bootstrap()
		if r := c.login("v6@example.com", "short"); r.code != 400 {
			t.Fatalf("attempt %d: %d", i+1, r.code)
		}
	}
	c := e.client()
	c.ip = "[2001:db8:1:2:ffff::1]:443"
	c.bootstrap()
	if r := c.login("v6@example.com", "short"); r.code != 429 {
		t.Fatalf("same /64 must share auth-ip bucket: %d", r.code)
	}
}
