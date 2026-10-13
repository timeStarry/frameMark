// Package mail loads SMTP settings from a locked-down dotenv file and sends
// verification mail. It defines the Message/Sender types the identity
// service consumes, so identity imports mail and never the other way around.
package mail

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	netmail "net/mail"
	"net/smtp"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Message is one verification mail: recipient and the link to open.
type Message struct {
	To, URL string
}

// Sender delivers a Message.
type Sender interface {
	Send(Message) error
}

// SenderFunc adapts a function to Sender.
type SenderFunc func(Message) error

func (f SenderFunc) Send(m Message) error { return f(m) }

// Settings are the validated SMTP fields. Never log the struct with %+v; use
// String(), which redacts credentials.
type Settings struct {
	Host     string
	Port     int
	User     string
	Password string
	From     string
}

func (s Settings) String() string {
	mode := "STARTTLS"
	if s.Port == 465 {
		mode = "TLS"
	}
	return fmt.Sprintf("smtp host=%s port=%d tls=%s", s.Host, s.Port, mode)
}

var hostRe = regexp.MustCompile(`^[A-Za-z0-9.-]+$`)

// errUnsafe is the only error surfaced for file problems, so no path detail
// or content leaks into logs.
var errUnsafe = errors.New("SMTP configuration file unavailable or unsafe")

func checkOwner(uid uint32) error {
	if int(uid) != os.Getuid() {
		return errUnsafe
	}
	return nil
}

// LoadSMTP opens path with O_NOFOLLOW, requires a regular file owned by the
// current user with no group/other permission bits, and parses the
// SMTP_HOST/PORT/USER/PASSWORD/FROM fields. Other keys are ignored.
func LoadSMTP(path string) (Settings, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return Settings{}, errUnsafe
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0o077 != 0 {
		return Settings{}, errUnsafe
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return Settings{}, errUnsafe
	}
	if err := checkOwner(st.Uid); err != nil {
		return Settings{}, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, 64<<10))
	if err != nil {
		return Settings{}, errUnsafe
	}
	kv, err := parseDotenv(raw)
	if err != nil {
		return Settings{}, err
	}
	return validate(kv)
}

func parseDotenv(raw []byte) (map[string]string, error) {
	out := map[string]string{}
	for i, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSuffix(line, "\r")
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		k, v, ok := strings.Cut(t, "=")
		k = strings.TrimSpace(strings.TrimPrefix(k, "export "))
		if !ok || k == "" {
			return nil, fmt.Errorf("SMTP configuration line %d: expected KEY=VALUE", i+1)
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		out[k] = v
	}
	return out, nil
}

func hasCtl(s string) bool { return strings.ContainsAny(s, "\r\n\x00") }

func validate(kv map[string]string) (Settings, error) {
	s := Settings{Host: kv["SMTP_HOST"], User: kv["SMTP_USER"], Password: kv["SMTP_PASSWORD"], From: kv["SMTP_FROM"]}
	if s.Host == "" || !hostRe.MatchString(s.Host) {
		return Settings{}, errors.New("SMTP_HOST invalid")
	}
	port, err := strconv.Atoi(kv["SMTP_PORT"])
	if err != nil || (port != 465 && port != 587) {
		return Settings{}, errors.New("SMTP_PORT must be 465 or 587")
	}
	s.Port = port
	if s.User == "" || hasCtl(s.User) {
		return Settings{}, errors.New("SMTP_USER invalid")
	}
	if s.Password == "" || hasCtl(s.Password) {
		return Settings{}, errors.New("SMTP_PASSWORD invalid")
	}
	if !plainAddress(s.From) {
		return Settings{}, errors.New("SMTP_FROM must be a bare email address")
	}
	return s, nil
}

// plainAddress reports whether s is exactly one address with no display name.
func plainAddress(s string) bool {
	if s == "" || hasCtl(s) {
		return false
	}
	a, err := netmail.ParseAddress(s)
	return err == nil && a.Name == "" && a.Address == s
}

const subject = "Markr 邮箱验证"

func buildMessage(from string, m Message, now time.Time) ([]byte, error) {
	if !plainAddress(m.To) || hasCtl(m.URL) || m.URL == "" {
		return nil, errors.New("invalid verification message")
	}
	body := "打开以下链接并设置密码，即可完成 Markr 注册。链接 30 分钟内有效，只能使用一次。\r\n\r\n" +
		m.URL + "\r\n\r\n如果你没有申请注册，请忽略此邮件。\r\n"
	var b bytes.Buffer
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", m.To)
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.BEncoding.Encode("UTF-8", subject))
	fmt.Fprintf(&b, "Date: %s\r\n", now.UTC().Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	enc := base64.StdEncoding.EncodeToString([]byte(body))
	for len(enc) > 76 {
		b.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc + "\r\n")
	return b.Bytes(), nil
}

const timeout = 10 * time.Second

type smtpSender struct{ s Settings }

// NewSMTP returns a Sender using implicit TLS on 465 and STARTTLS on 587.
// No connection is made until Send.
func NewSMTP(s Settings) Sender { return smtpSender{s: s} }

func (x smtpSender) Send(m Message) error {
	if x.s.Port != 465 && x.s.Port != 587 {
		return errors.New("smtp: unsupported port")
	}
	tlsCfg := &tls.Config{ServerName: x.s.Host, MinVersion: tls.VersionTLS12}
	addr := net.JoinHostPort(x.s.Host, strconv.Itoa(x.s.Port))
	dialer := &net.Dialer{Timeout: timeout}
	var conn net.Conn
	var err error
	if x.s.Port == 465 {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return errors.New("smtp: connect failed")
	}
	_ = conn.SetDeadline(time.Now().Add(3 * timeout))
	c, err := smtp.NewClient(conn, x.s.Host)
	if err != nil {
		conn.Close()
		return errors.New("smtp: greeting failed")
	}
	if x.s.Port == 587 {
		if err := c.StartTLS(tlsCfg); err != nil {
			c.Close()
			return errors.New("smtp: STARTTLS failed")
		}
	}
	return deliver(c, x.s, m)
}

// deliver runs AUTH, MAIL, RCPT and DATA on an established client and closes
// it. Errors are fixed strings so server text never reaches callers or logs.
// Once DATA is accepted the message is delivered; a failing QUIT is ignored.
func deliver(c *smtp.Client, s Settings, m Message) error {
	defer c.Close()
	msg, err := buildMessage(s.From, m, time.Now())
	if err != nil {
		return err
	}
	if err := c.Auth(smtp.PlainAuth("", s.User, s.Password, s.Host)); err != nil {
		return errors.New("smtp: authentication failed")
	}
	if err := c.Mail(s.From); err != nil {
		return errors.New("smtp: MAIL FROM rejected")
	}
	if err := c.Rcpt(m.To); err != nil {
		return errors.New("smtp: RCPT TO rejected")
	}
	w, err := c.Data()
	if err != nil {
		return errors.New("smtp: DATA rejected")
	}
	if _, err := w.Write(msg); err != nil {
		w.Close()
		return errors.New("smtp: write failed")
	}
	if err := w.Close(); err != nil {
		return errors.New("smtp: message rejected")
	}
	_ = c.Quit()
	return nil
}
