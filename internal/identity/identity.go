// Package identity implements email-verified registration, password login,
// server-side sessions, CSRF protection and persisted rate limits (spec §5).
//
// It reproduces the semantics of the old server/identity.mjs. Client IPs for
// rate limiting come from r.RemoteAddr only; X-Forwarded-For is never trusted
// because SP1 has no trusted-proxy configuration.
package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	netmail "net/mail"
	"net/netip"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/scrypt"
	"golang.org/x/net/idna"
	"golang.org/x/text/unicode/norm"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/timeStarry/frameMark/internal/clock"
	"github.com/timeStarry/frameMark/internal/httperr"
	"github.com/timeStarry/frameMark/internal/mail"
)

// Mail, Mailer and MailerFunc alias the mail package types so identity can
// consume a sender without mail importing identity.
type (
	Mail       = mail.Message
	Mailer     = mail.Sender
	MailerFunc = mail.SenderFunc
)

// Deps configures a Service. Now returns Unix milliseconds; nil means
// clock.Now. A nil Mailer makes register/verify return 503.
type Deps struct {
	Origin           string
	Dev              bool
	Enabled          bool
	RegistrationOpen bool
	Now              func() int64
	Mailer           Mailer
}

const (
	anonMs       = 15 * 60_000
	sessionMs    = 7 * 24 * 3_600_000
	idleMs       = 24 * 3_600_000
	pendingMs    = 30 * 60_000
	rateMs       = 15 * 60_000
	pruneEveryMs = 60_000
	maxBody      = 128 << 10
	scryptN      = 131072
	scryptR      = 8
	scryptP      = 1
	scryptLen    = 64
	maxHashing   = 2
)

const (
	msgOrigin      = "请求来源无效，请从本站重试。"
	msgCSRF        = "会话校验失败，请刷新页面后重试。"
	msgRate        = "请求过于频繁，请在 15 分钟后重试。"
	msgBusy        = "登录服务繁忙，请稍后重试。"
	msgEmail       = "请填写有效邮箱。"
	msgPassword    = "密码至少 15 个字符，最多 256 字节。"
	msgClosed      = "注册尚未开放。"
	msgNoMailer    = "验证邮件服务暂不可用。"
	msgTokenBad    = "验证链接无效或已过期。"
	msgTokenUsed   = "验证链接无效或已使用。"
	msgLogin       = "邮箱或密码不正确。"
	msgNeedLogin   = "请先登录。"
	msgRegistered  = "如果该邮箱可以注册，验证邮件已发送。请在 30 分钟内打开链接并设置密码。"
	msgBodyTooBig  = "请求体过大。"
	msgBadJSON     = "请求格式无效。"
	dummyHash      = "scrypt-v1$00000000000000000000000000000000$" + "0000000000000000000000000000000000000000000000000000000000000000" + "0000000000000000000000000000000000000000000000000000000000000000"
	cookieHTTPS    = "__Host-markr_session"
	cookieDev      = "markr_dev_session"
	encodingPrefix = "scrypt-v1"
)

var (
	tokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	saltRe  = regexp.MustCompile(`^[a-f0-9]{32}$`)
	hashRe  = regexp.MustCompile(`^[a-f0-9]{128}$`)
)

// Service is the identity subsystem bound to one database.
type Service struct {
	db     *sql.DB
	deps   Deps
	secure bool
	cookie string
	slots  chan struct{} // bounds concurrent scrypt work only

	// Verification mail is sent by background workers so that register's
	// response never depends on SMTP state or on scrypt load (spec §5: the
	// same 202 whether or not the email exists).
	mailMu     sync.RWMutex // guards mailClosed and sends on mailq
	mailClosed bool
	mailq      chan mailJob
	mailWG     sync.WaitGroup
	mailDone   chan struct{}
	mailOnce   sync.Once

	lastPrune atomic.Int64 // Deps.Now of the last prune; 0 = never
}

const (
	mailWorkers   = 2
	mailQueueSize = 64
)

type mailJob struct {
	msg  Mail
	hash string // pending_verifications.hash to delete if the send fails
}

// New builds a Service and starts its mail workers. It performs no I/O.
// Call Close on shutdown to drain queued mail. Origin must be an https
// origin, or http only when Dev is set; the cookie name and Secure flag
// follow the scheme.
func New(d *sql.DB, deps Deps) (*Service, error) {
	u, err := url.Parse(deps.Origin)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("identity: origin must be an absolute http(s) origin")
	}
	if u.Scheme == "http" && !deps.Dev {
		return nil, errors.New("identity: http origin requires dev mode")
	}
	if deps.Now == nil {
		deps.Now = clock.Now
	}
	if isNil(deps.Mailer) {
		deps.Mailer = nil
	}
	secure := strings.HasPrefix(deps.Origin, "https://")
	name := cookieDev
	if secure {
		name = cookieHTTPS
	}
	s := &Service{db: d, deps: deps, secure: secure, cookie: name, slots: make(chan struct{}, maxHashing),
		mailq: make(chan mailJob, mailQueueSize), mailDone: make(chan struct{})}
	s.mailWG.Add(mailWorkers)
	for i := 0; i < mailWorkers; i++ {
		go s.mailWorker()
	}
	return s, nil
}

// isNil reports whether m is nil or an interface holding a nil func/pointer.
func isNil(m Mailer) bool {
	if m == nil {
		return true
	}
	v := reflect.ValueOf(m)
	switch v.Kind() {
	case reflect.Func, reflect.Pointer, reflect.Map, reflect.Chan, reflect.Slice, reflect.Interface:
		return v.IsNil()
	}
	return false
}

// Close stops accepting mail jobs, lets the workers drain the queue, and
// waits for them until ctx is done. It is safe to call more than once.
func (s *Service) Close(ctx context.Context) error {
	s.mailMu.Lock()
	if !s.mailClosed {
		s.mailClosed = true
		close(s.mailq)
	}
	s.mailMu.Unlock()
	s.mailOnce.Do(func() {
		go func() { s.mailWG.Wait(); close(s.mailDone) }()
	})
	select {
	case <-s.mailDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// enqueue offers job to the queue without blocking. False means the queue is
// full or closed.
func (s *Service) enqueue(job mailJob) bool {
	s.mailMu.RLock()
	defer s.mailMu.RUnlock()
	if s.mailClosed {
		return false
	}
	select {
	case s.mailq <- job:
		return true
	default:
		return false
	}
}

func (s *Service) mailWorker() {
	defer s.mailWG.Done()
	for job := range s.mailq {
		if err := s.sendJob(job); err != nil {
			// Fixed category only: no address, URL or server text.
			log.Print("identity: verification mail send failed")
			s.dropPending(job.hash)
		}
	}
}

func (s *Service) sendJob(job mailJob) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("mailer panicked")
		}
	}()
	if s.deps.Mailer == nil {
		return errors.New("no mailer")
	}
	return s.deps.Mailer.Send(job.msg)
}

// dropPending removes a pending row whose link can no longer be delivered.
func (s *Service) dropPending(hash string) {
	if hash == "" {
		return
	}
	if _, err := s.db.Exec(`DELETE FROM pending_verifications WHERE hash=?`, hash); err != nil {
		log.Print("identity: could not delete undeliverable pending verification")
	}
}

// --- primitives ---

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func digest(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func derive(pw, salt string) ([]byte, error) {
	return scrypt.Key([]byte(pw), []byte(salt), scryptN, scryptR, scryptP, scryptLen)
}

// HashPassword returns scrypt-v1$<salt hex>$<hash hex>. As in the Node
// implementation, the 32-char hex salt string itself is the scrypt salt.
func HashPassword(pw string) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	salt := hex.EncodeToString(b)
	key, err := derive(pw, salt)
	if err != nil {
		return "", err
	}
	return encodingPrefix + "$" + salt + "$" + hex.EncodeToString(key), nil
}

// VerifyPassword reports whether pw matches encoded. Malformed encodings
// return false.
func VerifyPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 3 || parts[0] != encodingPrefix || !saltRe.MatchString(parts[1]) || !hashRe.MatchString(parts[2]) {
		return false
	}
	want, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	got, err := derive(pw, parts[1])
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// bounded runs fn if fewer than maxHashing scrypt operations are in flight,
// else 503. Mail never uses these slots.
func (s *Service) bounded(fn func() error) error {
	select {
	case s.slots <- struct{}{}:
	default:
		return httperr.Fail(http.StatusServiceUnavailable, msgBusy)
	}
	defer func() { <-s.slots }()
	return fn()
}

// normalizeEmail: trim, NFC, lowercase, IDNA-ASCII the domain, then require
// a bare addr-spec with a dotted domain and at most 254 bytes.
func normalizeEmail(v string) (string, error) {
	bad := httperr.Fail(http.StatusBadRequest, msgEmail)
	e := strings.ToLower(norm.NFC.String(strings.TrimSpace(v)))
	at := strings.LastIndexByte(e, '@')
	if at <= 0 || at == len(e)-1 {
		return "", bad
	}
	domain, err := idna.Lookup.ToASCII(e[at+1:])
	if err != nil {
		return "", bad
	}
	e = e[:at+1] + domain
	if len(e) > 254 || strings.ContainsAny(e, "\r\n\t\x00 ") {
		return "", bad
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return "", bad
	}
	for _, l := range labels {
		if l == "" {
			return "", bad
		}
	}
	a, err := netmail.ParseAddress(e)
	if err != nil || a.Name != "" || a.Address != e {
		return "", bad
	}
	return e, nil
}

func validPassword(v any) (string, error) {
	pw, ok := v.(string)
	if !ok || utf8.RuneCountInString(pw) < 15 || len(pw) > 256 {
		return "", httperr.Fail(http.StatusBadRequest, msgPassword)
	}
	return pw, nil
}

func clientIP(r *http.Request) string { return rateIP(r.RemoteAddr) }

// rateIP turns a RemoteAddr into a rate-limit bucket: IPv4 (including
// IPv4-mapped IPv6) by full address, IPv6 by its /64, since one subscriber
// normally holds a whole /64.
func rateIP(remote string) string {
	host := remote
	if h, _, err := net.SplitHostPort(remote); err == nil {
		host = h
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	addr = addr.WithZone("").Unmap()
	if addr.Is4() {
		return addr.String()
	}
	p, err := addr.Prefix(64)
	if err != nil {
		return addr.String()
	}
	return p.String()
}

// rate counts one hit for key in a fixed 15-minute window that starts at the
// first hit. An expired row restarts at 1, so correctness never depends on
// prune having run.
func (s *Service) rate(key string, limit int) error {
	now := s.deps.Now()
	var n int
	err := s.db.QueryRow(`INSERT INTO rate_limits(key,count,expires_at) VALUES(?1,1,?3)
		ON CONFLICT(key) DO UPDATE SET
			count      = CASE WHEN expires_at <= ?2 THEN 1 ELSE count+1 END,
			expires_at = CASE WHEN expires_at <= ?2 THEN ?3 ELSE expires_at END
		RETURNING count`, digest(key), now, now+rateMs).Scan(&n)
	if err != nil {
		return err
	}
	if n > limit {
		return httperr.Fail(http.StatusTooManyRequests, msgRate)
	}
	return nil
}

// --- sessions ---

type session struct {
	hash    string
	user    string
	csrf    string
	expires int64
}

type state struct {
	sess   *session
	viewer string
}

type ctxKey struct{}

// User returns the logged-in user id for the request, or "" when anonymous.
func User(ctx context.Context) string {
	if st, ok := ctx.Value(ctxKey{}).(*state); ok {
		return st.viewer
	}
	return ""
}

// maybePrune runs prune at most once per pruneEveryMs. Lookups and rate
// limits check expiry themselves, so pruning only bounds table size.
func (s *Service) maybePrune(now int64) error {
	last := s.lastPrune.Load()
	if last != 0 && now-last < pruneEveryMs {
		return nil
	}
	if !s.lastPrune.CompareAndSwap(last, now) {
		return nil // another request is pruning
	}
	return s.prune(now)
}

func (s *Service) prune(now int64) error {
	if _, err := s.db.Exec(`DELETE FROM pending_verifications WHERE expires_at<=?`, now); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at<=? OR touched_at<=?`, now, now-idleMs); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM rate_limits WHERE expires_at<=?`, now)
	return err
}

// cookieValue returns the session cookie value only when exactly one cookie
// of that name is present. Parsed by hand: net/http silently drops invalid
// values, which would turn a duplicate into a single cookie.
func (s *Service) cookieValue(r *http.Request) (string, bool) {
	var found []string
	for _, line := range r.Header.Values("Cookie") {
		for _, part := range strings.Split(line, ";") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(part), s.cookie+"="); ok {
				found = append(found, v)
			}
		}
	}
	if len(found) != 1 || !tokenRe.MatchString(found[0]) {
		return "", false
	}
	return found[0], true
}

func (s *Service) lookup(r *http.Request, now int64) (*session, error) {
	v, ok := s.cookieValue(r)
	if !ok {
		return nil, nil
	}
	var sess session
	var user sql.NullString
	err := s.db.QueryRow(`SELECT hash,user_id,csrf,expires_at FROM sessions WHERE hash=? AND expires_at>? AND touched_at>?`,
		digest(v), now, now-idleMs).Scan(&sess.hash, &user, &sess.csrf, &sess.expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sess.user = user.String
	return &sess, nil
}

func (s *Service) setCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: s.cookie, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode})
}

// issue rotates the session: the current row (if any) is deleted and a new
// one is created for user ("" = anonymous).
func (s *Service) issue(w http.ResponseWriter, st *state, user string) error {
	now := s.deps.Now()
	if st.sess != nil {
		if _, err := s.db.Exec(`DELETE FROM sessions WHERE hash=?`, st.sess.hash); err != nil {
			return err
		}
	}
	value, csrf := newToken(), newToken()
	expires := now + anonMs
	var uid any
	if user != "" {
		expires = now + sessionMs
		uid = user
	}
	if _, err := s.db.Exec(`INSERT INTO sessions(hash,user_id,csrf,expires_at,touched_at) VALUES(?,?,?,?,?)`,
		digest(value), uid, csrf, expires, now); err != nil {
		return err
	}
	s.setCookie(w, value, int((expires-now)/1000))
	st.sess = &session{hash: digest(value), user: user, csrf: csrf, expires: expires}
	st.viewer = user
	return nil
}

// Middleware handles every /api/ request: no-store caching, a 128 KiB body
// limit, pruning, session lookup and touch, and CSRF checks on writes.
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		st := &state{}
		if s.deps.Enabled {
			now := s.deps.Now()
			if err := s.maybePrune(now); err != nil {
				httperr.Write(w, err)
				return
			}
			sess, err := s.lookup(r, now)
			if err != nil {
				httperr.Write(w, err)
				return
			}
			if sess != nil {
				if _, err := s.db.Exec(`UPDATE sessions SET touched_at=? WHERE hash=?`, now, sess.hash); err != nil {
					httperr.Write(w, err)
					return
				}
				st.sess, st.viewer = sess, sess.user
			}
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if err := s.checkWrite(r, st.sess); err != nil {
				httperr.Write(w, err)
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, st)))
	})
}

func (s *Service) checkWrite(r *http.Request, sess *session) error {
	origins := r.Header.Values("Origin")
	sites := r.Header.Values("Sec-Fetch-Site")
	if len(origins) != 1 || origins[0] != s.deps.Origin || len(sites) > 1 || (len(sites) == 1 && sites[0] == "cross-site") {
		return httperr.Fail(http.StatusForbidden, msgOrigin)
	}
	tokens := r.Header.Values("X-CSRF-Token")
	if sess == nil || len(tokens) != 1 || !tokenRe.MatchString(tokens[0]) ||
		subtle.ConstantTimeCompare([]byte(tokens[0]), []byte(sess.csrf)) != 1 {
		return httperr.Fail(http.StatusForbidden, msgCSRF)
	}
	return nil
}

// --- routes ---

// Routes mounts /api/auth/* when identity is enabled.
func (s *Service) Routes(r chi.Router) {
	if !s.deps.Enabled {
		return
	}
	r.Get("/api/auth/session", s.handle(s.getSession))
	r.Post("/api/auth/register", s.handle(s.register))
	r.Post("/api/auth/verify", s.handle(s.verify))
	r.Post("/api/auth/login", s.handle(s.login))
	r.Post("/api/auth/logout", s.handle(s.logout))
	r.Post("/api/auth/logout-all", s.handle(s.logoutAll))
}

// Handler is Middleware wrapped around a fresh chi router carrying Routes.
// The middleware wraps the router (rather than r.Use) so it still runs when
// identity is disabled and chi has no routes registered.
func (s *Service) Handler() http.Handler {
	r := chi.NewRouter()
	s.Routes(r)
	return s.Middleware(r)
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, st *state) (int, any, error)

func (s *Service) handle(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		st, ok := r.Context().Value(ctxKey{}).(*state)
		if !ok {
			httperr.Write(w, errors.New("identity middleware not installed"))
			return
		}
		code, body, err := fn(w, r, st)
		if err != nil {
			httperr.Write(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(body)
	}
}

type input struct {
	Email    any `json:"email"`
	Password any `json:"password"`
	Token    any `json:"token"`
}

func decode(r *http.Request) (input, error) {
	var in input
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(&in)
	if err == nil {
		// Exactly one JSON value: anything after it but whitespace is refused.
		if extra := dec.Decode(&struct{}{}); !errors.Is(extra, io.EOF) {
			err = extra
			if err == nil {
				err = errors.New("trailing data")
			}
		}
	} else if errors.Is(err, io.EOF) {
		return in, nil // empty body is {}
	}
	var tooBig *http.MaxBytesError
	switch {
	case err == nil:
		return in, nil
	case errors.As(err, &tooBig):
		return in, httperr.Fail(http.StatusRequestEntityTooLarge, msgBodyTooBig)
	default:
		return in, httperr.Fail(http.StatusBadRequest, msgBadJSON)
	}
}

func emailOf(v any) (string, error) {
	e, ok := v.(string)
	if !ok {
		return "", httperr.Fail(http.StatusBadRequest, msgEmail)
	}
	return normalizeEmail(e)
}

func nullable(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func (s *Service) getSession(w http.ResponseWriter, r *http.Request, st *state) (int, any, error) {
	if st.sess == nil {
		if err := s.rate("bootstrap:"+clientIP(r), 60); err != nil {
			return 0, nil, err
		}
		if err := s.issue(w, st, ""); err != nil {
			return 0, nil, err
		}
	}
	return http.StatusOK, map[string]any{"user": nullable(st.viewer), "csrfToken": st.sess.csrf, "registrationOpen": s.deps.RegistrationOpen}, nil
}

func (s *Service) registration() error {
	if !s.deps.RegistrationOpen {
		return httperr.Fail(http.StatusForbidden, msgClosed)
	}
	if s.deps.Mailer == nil {
		return httperr.Fail(http.StatusServiceUnavailable, msgNoMailer)
	}
	return nil
}

func (s *Service) register(w http.ResponseWriter, r *http.Request, st *state) (int, any, error) {
	if err := s.registration(); err != nil {
		return 0, nil, err
	}
	if err := s.rate("register-ip:"+clientIP(r), 5); err != nil {
		return 0, nil, err
	}
	in, err := decode(r)
	if err != nil {
		return 0, nil, err
	}
	email, err := emailOf(in.Email)
	if err != nil {
		return 0, nil, err
	}
	if err := s.rate("register-email:"+email, 3); err != nil {
		return 0, nil, err
	}
	var exists int
	if err := s.db.QueryRow(`SELECT count(*) FROM users WHERE email=?`, email).Scan(&exists); err != nil {
		return 0, nil, err
	}
	if exists == 0 {
		value := newToken()
		hash := digest(value)
		if _, err := s.db.Exec(`INSERT INTO pending_verifications(email,hash,expires_at) VALUES(?,?,?)
			ON CONFLICT(email) DO UPDATE SET hash=excluded.hash, expires_at=excluded.expires_at`,
			email, hash, s.deps.Now()+pendingMs); err != nil {
			return 0, nil, err
		}
		job := mailJob{msg: Mail{To: email, URL: s.deps.Origin + "/login#verify=" + value}, hash: hash}
		if !s.enqueue(job) {
			log.Print("identity: mail queue full")
			s.dropPending(hash)
		}
	}
	// Identical for existing and new emails and for any mail outcome.
	return http.StatusAccepted, map[string]string{"message": msgRegistered}, nil
}

func isConstraint(err error) bool {
	var se *sqlite.Error
	return errors.As(err, &se) && se.Code()&0xff == sqlite3.SQLITE_CONSTRAINT
}

func (s *Service) verify(w http.ResponseWriter, r *http.Request, st *state) (int, any, error) {
	if err := s.registration(); err != nil {
		return 0, nil, err
	}
	if err := s.rate("verify-ip:"+clientIP(r), 10); err != nil {
		return 0, nil, err
	}
	in, err := decode(r)
	if err != nil {
		return 0, nil, err
	}
	pw, err := validPassword(in.Password)
	if err != nil {
		return 0, nil, err
	}
	value, ok := in.Token.(string)
	if !ok || !tokenRe.MatchString(value) {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgTokenBad)
	}
	hash := digest(value)
	var pendingEmail string
	err = s.db.QueryRow(`SELECT email FROM pending_verifications WHERE hash=? AND expires_at>?`, hash, s.deps.Now()).Scan(&pendingEmail)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgTokenBad)
	}
	if err != nil {
		return 0, nil, err
	}
	var encoded string
	if err := s.bounded(func() (e error) { encoded, e = HashPassword(pw); return }); err != nil {
		return 0, nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return 0, nil, err
	}
	if err := s.consume(hash, id.String(), encoded); err != nil {
		return 0, nil, err
	}
	if err := s.issue(w, st, id.String()); err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, map[string]any{"user": id.String(), "csrfToken": st.sess.csrf}, nil
}

// consume atomically deletes the pending row and creates the user. The
// DELETE ... RETURNING takes the write lock first, so of two concurrent
// verifies with one token exactly one sees the row.
func (s *Service) consume(hash, id, encoded string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.deps.Now()
	var email string
	err = tx.QueryRow(`DELETE FROM pending_verifications WHERE hash=? AND expires_at>? RETURNING email`, hash, now).Scan(&email)
	if errors.Is(err, sql.ErrNoRows) {
		return httperr.Fail(http.StatusBadRequest, msgTokenBad)
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO users(id,email,password,created_at) VALUES(?,?,?,?)`, id, email, encoded, now); err != nil {
		if isConstraint(err) {
			return httperr.Fail(http.StatusBadRequest, msgTokenUsed)
		}
		return err
	}
	return tx.Commit()
}

func (s *Service) login(w http.ResponseWriter, r *http.Request, st *state) (int, any, error) {
	if err := s.rate("auth-ip:"+clientIP(r), 10); err != nil {
		return 0, nil, err
	}
	in, err := decode(r)
	if err != nil {
		return 0, nil, err
	}
	email, err := emailOf(in.Email)
	if err != nil {
		return 0, nil, err
	}
	pw, err := validPassword(in.Password)
	if err != nil {
		return 0, nil, err
	}
	if err := s.rate("account:"+email, 10); err != nil {
		return 0, nil, err
	}
	var id, encoded string
	err = s.db.QueryRow(`SELECT id,password FROM users WHERE email=?`, email).Scan(&id, &encoded)
	found := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, nil, err
	}
	if !found {
		encoded = dummyHash // same scrypt cost whether or not the account exists
	}
	var valid bool
	if err := s.bounded(func() error { valid = VerifyPassword(pw, encoded); return nil }); err != nil {
		return 0, nil, err
	}
	if !valid || !found {
		return 0, nil, httperr.Fail(http.StatusUnauthorized, msgLogin)
	}
	if err := s.issue(w, st, id); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"user": id, "csrfToken": st.sess.csrf}, nil
}

func (s *Service) logout(w http.ResponseWriter, r *http.Request, st *state) (int, any, error) {
	if st.sess != nil {
		if _, err := s.db.Exec(`DELETE FROM sessions WHERE hash=?`, st.sess.hash); err != nil {
			return 0, nil, err
		}
	}
	s.setCookie(w, "", -1)
	st.sess, st.viewer = nil, ""
	return http.StatusOK, map[string]any{"user": nil}, nil
}

func (s *Service) logoutAll(w http.ResponseWriter, r *http.Request, st *state) (int, any, error) {
	if st.viewer == "" {
		return 0, nil, httperr.Fail(http.StatusUnauthorized, msgNeedLogin)
	}
	if _, err := s.db.Exec(`DELETE FROM sessions WHERE user_id=?`, st.viewer); err != nil {
		return 0, nil, err
	}
	s.setCookie(w, "", -1)
	st.sess, st.viewer = nil, ""
	return http.StatusOK, map[string]any{"user": nil}, nil
}
