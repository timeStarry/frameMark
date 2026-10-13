package mail

import (
	"encoding/base64"
	"net"
	"net/smtp"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const goodEnv = `# Markr SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=587

SMTP_USER=fixture@example.com
SMTP_PASSWORD='fixture special # value'
SMTP_FROM="markr@example.com"
UNRELATED_SECRET=ignored
`

func writeFile(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "smtp.env")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadSMTPParsesWhitelistedFields(t *testing.T) {
	s, err := LoadSMTP(writeFile(t, goodEnv, 0o600))
	if err != nil {
		t.Fatalf("LoadSMTP: %v", err)
	}
	want := Settings{Host: "smtp.example.com", Port: 587, User: "fixture@example.com", Password: "fixture special # value", From: "markr@example.com"}
	if s != want {
		t.Fatalf("got %+v, want %+v", s, want)
	}
	if strings.Contains(s.String(), "fixture special") || strings.Contains(s.String(), "fixture@example.com") {
		t.Fatalf("String() leaks secrets: %s", s.String())
	}
}

func TestLoadSMTPPort465(t *testing.T) {
	s, err := LoadSMTP(writeFile(t, strings.Replace(goodEnv, "SMTP_PORT=587", "SMTP_PORT=465", 1), 0o400))
	if err != nil || s.Port != 465 {
		t.Fatalf("got %+v, %v", s, err)
	}
}

func TestLoadSMTPRejectsUnsafeFiles(t *testing.T) {
	for _, mode := range []os.FileMode{0o640, 0o604, 0o644, 0o610, 0o601} {
		if _, err := LoadSMTP(writeFile(t, goodEnv, mode)); err == nil {
			t.Errorf("mode %o must be rejected", mode)
		}
	}
	// Symlink to a safe file is refused (O_NOFOLLOW).
	target := writeFile(t, goodEnv, 0o600)
	link := filepath.Join(t.TempDir(), "link.env")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSMTP(link); err == nil {
		t.Error("symlink must be rejected")
	}
	// Directory is not a regular file.
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSMTP(dir); err == nil {
		t.Error("directory must be rejected")
	}
	if _, err := LoadSMTP(filepath.Join(t.TempDir(), "missing.env")); err == nil {
		t.Error("missing file must be rejected")
	}
}

func TestLoadSMTPOwnerMustBeCurrentUser(t *testing.T) {
	// checkOwner is the uid comparison used by LoadSMTP; a foreign uid fails.
	if err := checkOwner(uint32(os.Getuid()) + 1); err == nil {
		t.Fatal("foreign owner must be rejected")
	}
	if err := checkOwner(uint32(os.Getuid())); err != nil {
		t.Fatalf("own uid rejected: %v", err)
	}
}

func TestLoadSMTPFieldValidation(t *testing.T) {
	cases := map[string]string{
		"port 25":        strings.Replace(goodEnv, "SMTP_PORT=587", "SMTP_PORT=25", 1),
		"port text":      strings.Replace(goodEnv, "SMTP_PORT=587", "SMTP_PORT=abc", 1),
		"host bad":       strings.Replace(goodEnv, "SMTP_HOST=smtp.example.com", "SMTP_HOST=smtp.example.com/x", 1),
		"host empty":     strings.Replace(goodEnv, "SMTP_HOST=smtp.example.com", "SMTP_HOST=", 1),
		"from display":   strings.Replace(goodEnv, `SMTP_FROM="markr@example.com"`, `SMTP_FROM="Markr <markr@example.com>"`, 1),
		"from invalid":   strings.Replace(goodEnv, `SMTP_FROM="markr@example.com"`, `SMTP_FROM=markr`, 1),
		"missing user":   strings.Replace(goodEnv, "SMTP_USER=fixture@example.com\n", "", 1),
		"missing pass":   strings.Replace(goodEnv, "SMTP_PASSWORD='fixture special # value'\n", "", 1),
		"bad line":       goodEnv + "not a pair\n",
		"user with CRLF": strings.Replace(goodEnv, "SMTP_USER=fixture@example.com", "SMTP_USER=a\rb", 1),
	}
	for name, content := range cases {
		_, err := LoadSMTP(writeFile(t, content, 0o600))
		if err == nil {
			t.Errorf("%s: want error", name)
			continue
		}
		if strings.Contains(err.Error(), "fixture special") {
			t.Errorf("%s: error leaks password: %v", name, err)
		}
	}
}

func TestBuildMessage(t *testing.T) {
	url := "https://markr.example/login#verify=" + strings.Repeat("A", 43)
	raw, err := buildMessage("markr@example.com", Message{To: "a@b.co", URL: url}, time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	head, body, ok := strings.Cut(string(raw), "\r\n\r\n")
	if !ok {
		t.Fatal("no header/body separator")
	}
	for _, h := range []string{"From: markr@example.com", "To: a@b.co", "Subject: =?UTF-8?b?", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "MIME-Version: 1.0"} {
		if !strings.Contains(head, h) {
			t.Errorf("missing header %q in %q", h, head)
		}
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(body, "\r\n", ""))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(decoded), url) || !strings.Contains(string(decoded), "30 分钟内有效") {
		t.Fatalf("body missing url or validity: %q", decoded)
	}
	if !strings.Contains(head, "=?UTF-8?b?"+base64.StdEncoding.EncodeToString([]byte("Markr 邮箱验证"))+"?=") {
		t.Errorf("subject not encoded as expected: %q", head)
	}
	for _, bad := range []Message{{To: "a@b.co\r\nBcc: x@y.z", URL: url}, {To: "a@b.co", URL: url + "\r\nX: y"}} {
		if _, err := buildMessage("markr@example.com", bad, time.Now()); err == nil {
			t.Errorf("header injection accepted: %+v", bad)
		}
	}
}

func TestSenderFunc(t *testing.T) {
	var got Message
	var s Sender = SenderFunc(func(m Message) error { got = m; return nil })
	if err := s.Send(Message{To: "a@b.co", URL: "u"}); err != nil || got.To != "a@b.co" {
		t.Fatalf("SenderFunc did not forward: %+v %v", got, err)
	}
	if NewSMTP(Settings{Host: "smtp.example.com", Port: 465, User: "u", Password: "p", From: "a@b.co"}) == nil {
		t.Fatal("NewSMTP returned nil")
	}
}

// fakeSMTP speaks just enough SMTP over conn. replies overrides the response
// for a command verb (e.g. "QUIT").
func fakeSMTP(t *testing.T, conn net.Conn, replies map[string]string) {
	t.Helper()
	go func() {
		defer conn.Close()
		tp := textproto.NewConn(conn)
		reply := func(verb, def string) bool {
			if r, ok := replies[verb]; ok {
				def = r
			}
			return tp.PrintfLine("%s", def) == nil
		}
		reply("GREETING", "220 localhost ESMTP")
		for {
			line, err := tp.ReadLine()
			if err != nil {
				return
			}
			verb := strings.ToUpper(strings.Fields(line + " x")[0])
			switch verb {
			case "EHLO":
				reply(verb, "250-localhost\r\n250 AUTH PLAIN")
			case "AUTH":
				reply(verb, "235 ok")
			case "MAIL", "RCPT":
				reply(verb, "250 ok")
			case "DATA":
				if !reply(verb, "354 go") {
					return
				}
				if _, err := tp.ReadDotBytes(); err != nil {
					return
				}
				reply("END", "250 queued")
			case "QUIT":
				reply(verb, "221 bye")
				return
			default:
				reply(verb, "502 no")
			}
		}
	}()
}

func pipeClient(t *testing.T, replies map[string]string) *smtp.Client {
	t.Helper()
	server, client := net.Pipe()
	fakeSMTP(t, server, replies)
	c, err := smtp.NewClient(client, "localhost")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

var testSettings = Settings{Host: "localhost", Port: 587, User: "u", Password: "p", From: "markr@example.com"}

func TestDeliverIgnoresQuitErrorAfterAcceptance(t *testing.T) {
	c := pipeClient(t, map[string]string{"QUIT": "421 secret server text"})
	if err := deliver(c, testSettings, Message{To: "a@b.co", URL: "https://x/login#verify=t"}); err != nil {
		t.Fatalf("accepted message reported as failure: %v", err)
	}
}

func TestDeliverRejectionHasNoServerText(t *testing.T) {
	c := pipeClient(t, map[string]string{"RCPT": "550 secret server text"})
	err := deliver(c, testSettings, Message{To: "a@b.co", URL: "https://x/login#verify=t"})
	if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "550") {
		t.Fatalf("want sanitized error, got %v", err)
	}
}

func TestSendRefusesUnsupportedPort(t *testing.T) {
	s := testSettings
	s.Port = 25
	if err := NewSMTP(s).Send(Message{To: "a@b.co", URL: "u"}); err == nil {
		t.Fatal("port 25 must be refused before dialing")
	}
}

func TestLoadSMTPRejectsFIFOWithoutBlocking(t *testing.T) {
	p := filepath.Join(t.TempDir(), "smtp.fifo")
	if err := syscall.Mkfifo(p, 0o600); err != nil {
		t.Skipf("mkfifo unsupported: %v", err)
	}
	done := make(chan error, 1)
	go func() { _, err := LoadSMTP(p); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("FIFO must be rejected")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LoadSMTP blocked opening a FIFO")
	}
}
