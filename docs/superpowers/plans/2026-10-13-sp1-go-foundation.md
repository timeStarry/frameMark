# 子项目 1 实施计划：Go 底座与媒体管线

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `markr` Go 单二进制：SQLite 结构、账户、TOS 预签名直传、libvips 媒体管线、SQLite 任务队列、读取与权限、EO purge、Demo 种子、端到端验收。

**Architecture:** 单二进制两角色（`--role=api|worker|all`），API 用 chi 路由加自写中间件；SQLite（modernc.org/sqlite）同时做数据与队列；图片处理经 govips；S3 抽象一套实现同时指向火山 TOS 与 MinIO；CDN purge 为接口 + EO/fake 实现。

**Tech Stack:** Go 1.27（本机已装 1.27.0）；chi v5.4.0；modernc.org/sqlite v1.60.1；govips v2.19.0（libvips ≥ 8.15，需先 `brew install vips`）；aws-sdk-go-v2（s3 v1.114.3、credentials v1.20.9）；tencentcloud-sdk-go teo v1.3.186；rwcarlsen/goexif；google/uuid v1.6.0；golang.org/x/crypto v0.58.0。

**Spec:** `docs/superpowers/specs/2026-10-13-sp1-go-foundation-design.md`（上位：`2026-10-13-markr-redesign-design.md`）。执行者必须同时读两份；规格与本计划冲突时以规格为准并停下来报告。

## Global Constraints

- Go ≥ 1.24；全部代码 `gofmt` 干净；`go vet ./...` 无输出。
- 模块路径 `github.com/timeStarry/frameMark`；所有包在 `internal/` 或 `cmd/` 下。
- ID 一律 UUIDv7：`uuid.Must(uuid.NewV7())`（github.com/google/uuid）。时间一律 Unix 毫秒；测试一律用注入时钟，不用 `time.Now` 直接值。
- 环境变量以 `MARKR_` 前缀，全部经 `internal/config` 解析；启动失败时退出，不写部分初始化状态。
- 日志不打印任何密钥、URL 签名部分或原图字节；只打 job id、photo id、错误类别。
- 任何 JSON 响应不得出现 `latitude`、`longitude`、`gps` 键或 `o/` 对象键前缀（任务 16 统一断言）。
- 水印字体用 pango 字体族名 `sans`（依赖系统 fontconfig），不嵌入字体文件；水印尺寸按短边比例。
- 每个任务结尾必须 `go test ./...` 全绿（媒体测试需要 libvips 时以 `t.Skip` 兜底并注明）。
- 提交信息遵循仓库惯例（英文类型前缀，中文可正文），附 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 本计划只改/新增 Go 侧文件与 `.github/workflows/`；不触碰 `src/`、`server/`、`package.json`。

## Review Focus

（以下五类输入/失败模式最容易咬人；每条已落到对应任务的测试里。）

1. **动图伪装**：动画 WebP / APNG 是「多页」而非多帧，必须被 `process_photo` 拒绝并标 failed，而不是被截成第一页 —— 任务 10 断言 `pages>1` 被拒。
2. **GPS 泄漏**：`location_mode=off` 时 EXIF 里的 GPS 既不进库也不进衍生图 —— 任务 9/10（含 GPS 的合成图）与任务 16（响应扫描）双层断言。
3. **撤回后 CDN 残留**：合集撤回公开后，旧 `derived_hash` 必须失效、新 URL 必须指向新对象 —— 任务 13/16 断言 hash 变化且 purge 被调用。
4. **预签名错位**：`complete` 对 sha256 不符的对象必须判 failed 且不入队 —— 任务 11 断言；E2E 走真实 MinIO 再验一次。
5. **仅链接合集混入广场**：`visibility=unlisted` 的合集必须不出现在 `/api/square` —— 任务 4（domain 表驱动）与任务 13（`/api/square` 实际查询）覆盖所有可见性组合。

---

### Task 1: 模块骨架与配置

**Files:**
- Create: `go.mod`, `internal/config/config.go`, `internal/config/config_test.go`
- Create: `cmd/markr/main.go`（先打印版本，占位）

**Interfaces:**
- Produces: `config.Config`（见下）、`config.Load(environ []string) (Config, error)`、`Config.Redacted() map[string]string`。
- Consumes: 无。

- [ ] **Step 1: 初始化模块并拉依赖**

```bash
cd /Users/timestarry/project/frameMark
go mod init github.com/timeStarry/frameMark
GOFLAGS=-mod=mod go get \
  github.com/go-chi/chi/v5@v5.4.0 \
  modernc.org/sqlite@v1.60.1 \
  github.com/google/uuid@v1.6.0 \
  golang.org/x/crypto@v0.58.0 \
  github.com/aws/aws-sdk-go-v2/service/s3@v1.114.3 \
  github.com/aws/aws-sdk-go-v2/credentials@v1.20.9 \
  github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/teo@v1.3.186 \
  github.com/rwcarlsen/goexif@latest \
  github.com/davidbyttow/govips/v2@v2.19.0
```

预期：依赖写入 `go.mod`，无冲突。

- [ ] **Step 2: 写失败测试 `internal/config/config_test.go`**

```go
package config_test

import (
	"strings"
	"testing"

	"github.com/timeStarry/frameMark/internal/config"
)

func TestLoad_RequiresOriginHTTPS(t *testing.T) {
	_, err := config.Load([]string{
		"MARKR_ORIGIN=http://example.com",
		"MARKR_DATA_DIR=/tmp/x",
	})
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("expected https enforcement, got %v", err)
	}
}

func TestLoad_DevAllowsLocalhostHTTP(t *testing.T) {
	cfg, err := config.Load([]string{
		"MARKR_ORIGIN=http://127.0.0.1:18150",
		"MARKR_DATA_DIR=/tmp/x",
		"MARKR_DEV=1",
	})
	if err != nil {
		t.Fatalf("dev origin should be accepted: %v", err)
	}
	if cfg.Origin != "http://127.0.0.1:18150" || !cfg.Dev {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
}
```

- [ ] **Step 3: 跑测试确认失败**

`go test ./internal/config` 预期：编译失败（包不存在）。

- [ ] **Step 4: 实现 `internal/config/config.go`**

```go
package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

type Config struct {
	Origin     string
	DataDir    string
	Listen     string
	Dev        bool
	IdentityOn bool
	RegOpen    bool

	SMTPConfigFile string

	S3Endpoint, S3Region, S3AccessKey, S3SecretKey string
	BucketOriginals, BucketDerived                  string

	ReplicaEndpoint, ReplicaRegion, ReplicaAccessKey, ReplicaSecretKey, ReplicaBucket string

	CDNBase                           string
	EOSecretID, EOSecretKey, EOZoneID string

	UploadMaxMB int   // 默认 60
	MaxPixels   int64 // 默认 100_000_000
	QuotaPhotos int   // 默认 2000
	Workers     int   // 默认 2
}

func Load(environ []string) (Config, error) {
	env := map[string]string{}
	for _, kv := range environ {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	cfg := Config{
		Origin:  env["MARKR_ORIGIN"],
		DataDir: env["MARKR_DATA_DIR"],
		Listen:  defaultStr(env["MARKR_LISTEN"], "127.0.0.1:18150"),
		Dev:     env["MARKR_DEV"] == "1",
	}
	if cfg.Origin == "" {
		return cfg, fmt.Errorf("MARKR_ORIGIN is required")
	}
	u, perr := url.Parse(cfg.Origin)
	if perr != nil || u.Host == "" {
		return cfg, fmt.Errorf("MARKR_ORIGIN invalid")
	}
	if u.Scheme != "https" {
		allowed := cfg.Dev && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")
		if !allowed {
			return cfg, fmt.Errorf("MARKR_ORIGIN must use https (dev localhost http allowed with MARKR_DEV=1)")
		}
	}
	if cfg.DataDir == "" {
		return cfg, fmt.Errorf("MARKR_DATA_DIR is required")
	}
	cfg.IdentityOn = env["MARKR_IDENTITY_ENABLED"] == "true"
	cfg.RegOpen = env["MARKR_REGISTRATION_OPEN"] == "true"
	cfg.SMTPConfigFile = env["MARKR_SMTP_CONFIG_FILE"]
	cfg.S3Endpoint, cfg.S3Region = env["MARKR_S3_ENDPOINT"], env["MARKR_S3_REGION"]
	cfg.S3AccessKey, cfg.S3SecretKey = env["MARKR_S3_ACCESS_KEY"], env["MARKR_S3_SECRET_KEY"]
	cfg.BucketOriginals, cfg.BucketDerived = env["MARKR_BUCKET_ORIGINALS"], env["MARKR_BUCKET_DERIVED"]
	cfg.ReplicaEndpoint, cfg.ReplicaRegion = env["MARKR_REPLICA_ENDPOINT"], env["MARKR_REPLICA_REGION"]
	cfg.ReplicaAccessKey, cfg.ReplicaSecretKey = env["MARKR_REPLICA_ACCESS_KEY"], env["MARKR_REPLICA_SECRET_KEY"]
	cfg.ReplicaBucket = env["MARKR_REPLICA_BUCKET"]
	cfg.CDNBase = strings.TrimRight(env["MARKR_CDN_BASE"], "/")
	cfg.EOSecretID, cfg.EOSecretKey, cfg.EOZoneID = env["MARKR_EO_SECRET_ID"], env["MARKR_EO_SECRET_KEY"], env["MARKR_EO_ZONE_ID"]
	var err error
	if cfg.Workers, err = intOr(env["MARKR_WORKERS"], 2); err != nil {
		return cfg, err
	}
	if cfg.UploadMaxMB, err = intOr(env["MARKR_UPLOAD_MAX_MB"], 60); err != nil {
		return cfg, err
	}
	if cfg.QuotaPhotos, err = intOr(env["MARKR_QUOTA_PHOTOS"], 2000); err != nil {
		return cfg, err
	}
	mp, err := intOr(env["MARKR_MAX_PIXELS"], 100_000_000)
	if err != nil {
		return cfg, err
	}
	cfg.MaxPixels = int64(mp)
	return cfg, nil
}

func intOr(v string, d int) (int, error) {
	if v == "" {
		return d, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid positive integer %q", v)
	}
	return n, nil
}

func defaultStr(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func (c Config) Redacted() map[string]string {
	return map[string]string{"origin": c.Origin, "listen": c.Listen, "dev": strconv.FormatBool(c.Dev)}
}
```

所有密钥只在 `Config` 内部，不进 `Redacted()`。再加一条测试：`MARKR_WORKERS=abc` 必须返回错误。

- [ ] **Step 5: 跑测试确认通过**

`go test ./internal/config -v` 预期：PASS。

- [ ] **Step 6: 提交**

```bash
git add go.mod go.sum internal/config cmd/markr/main.go
git commit -m "feat: add Go module skeleton with strict env config"
```

---

### Task 2: 时钟与错误类型

**Files:**
- Create: `internal/clock/clock.go`
- Create: `internal/httperr/httperr.go`

**Interfaces:**
- Produces: `clock.Now func() int64`（Unix ms）、`httperr.Fail(status int, msg string)`、`httperr.Write(w, err)`。
- Consumes: 无。

- [ ] **Step 1: 写失败测试 `internal/httperr/httperr_test.go`**

```go
package httperr_test

import (
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/timeStarry/frameMark/internal/httperr"
)

func TestFailMapsStatus(t *testing.T) {
	err := httperr.Fail(403, "会话校验失败")
	w := httptest.NewRecorder()
	httperr.Write(w, err)
	if w.Code != 403 {
		t.Fatalf("want 403, got %d", w.Code)
	}
}

func TestWriteUnknownErrorIs500(t *testing.T) {
	w := httptest.NewRecorder()
	httperr.Write(w, errors.New("boom"))
	if w.Code != 500 {
		t.Fatalf("want 500, got %d", w.Code)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/httperr` 预期：编译失败。

- [ ] **Step 3: 实现**

```go
package httperr

import (
	"encoding/json"
	"errors"
	"net/http"
)

type StatusError struct {
	Status int
	Msg    string
}

func (e *StatusError) Error() string { return e.Msg }

func Fail(status int, msg string) *StatusError { return &StatusError{Status: status, Msg: msg} }

func Write(w http.ResponseWriter, err error) {
	var se *StatusError
	if errors.As(err, &se) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(se.Status)
		json.NewEncoder(w).Encode(map[string]string{"error": se.Msg})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	json.NewEncoder(w).Encode(map[string]string{"error": "处理失败，请稍后重试"})
}
```

`internal/clock/clock.go`：

```go
package clock

import "time"

// 默认真实时间；测试经各包 Deps.Now 注入，不改这个全局量。
var Now = func() int64 { return time.Now().UnixMilli() }
```

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/httperr -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/httperr internal/clock
git commit -m "feat: add clock and typed http error helpers"
```

---

### Task 3: SQLite 连接与迁移执行器

**Files:**
- Create: `internal/db/db.go`, `internal/db/db_test.go`, `internal/db/migrations/0001_init.sql`（`go:embed` 不能引用包目录外的文件，SQL 放在包内；spec §2 的 `migrations/` 以此为准）

**Interfaces:**
- Produces: `db.Open(path string) (*sql.DB, error)`、`db.Migrate(db *sql.DB) error`。
- Consumes: `internal/clock`。

- [ ] **Step 1: 写失败测试 `internal/db/db_test.go`**

```go
package db_test

import (
	"path/filepath"
	"testing"

	"github.com/timeStarry/frameMark/internal/db"
)

func TestMigrateCreatesTables(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users','photos','collections','frames','jobs')`).Scan(&n); err != nil || n != 5 {
		t.Fatalf("expected 5 tables, got %d err=%v", n, err)
	}
	var uv int
	if err := d.QueryRow(`PRAGMA user_version`).Scan(&uv); err != nil || uv != 1 {
		t.Fatalf("expected user_version 1, got %d", uv)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/db` 预期：编译失败。

- [ ] **Step 3: 实现 `internal/db/db.go` 与 `migrations/0001_init.sql`**

```go
package db

import (
	"database/sql"
	"embed"
	"fmt"

	_ "modernc.org/sqlite"
)

//go:embed migrations/0001_init.sql
var initFS embed.FS

func Open(path string) (*sql.DB, error) {
	d, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(1) // SQLite 单写者
	return d, nil
}

func Migrate(d *sql.DB) error {
	var version int
	if err := d.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version >= 1 {
		return nil
	}
	body, err := initFS.ReadFile("migrations/0001_init.sql")
	if err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(string(body)); err != nil {
		return fmt.Errorf("migration 0001: %w", err)
	}
	if _, err := tx.Exec(`PRAGMA user_version = 1`); err != nil {
		return err
	}
	return tx.Commit()
}
```

`internal/db/migrations/0001_init.sql` 逐表照 spec §4 的 SQL 逐字写入（含全部 CHECK、UNIQUE、INDEX、外键）。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/db -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/db
git commit -m "feat: add SQLite schema and forward-only migration runner"
```

---

### Task 4: domain 权限与公开字段

**Files:**
- Create: `internal/domain/domain.go`, `internal/domain/domain_test.go`

**Interfaces:**
- Produces: `CanReadCollection(coll Collection, viewer string) bool`、`CollectionInSquare(coll Collection) bool`、`EffectivePublicFields(photo Photo, override *PhotoOverride) map[string]bool`（键为 spec §4 字段名外加 `"histogram"`）、`CanDownloadOriginal(photo Photo, coll Collection, viewer string) bool`、`UsesCDN(coll Collection, cdnBase string) bool`。
- Consumes: spec §6、§7。

- [ ] **Step 1: 写失败测试**

```go
package domain_test

import (
	"testing"

	"github.com/timeStarry/frameMark/internal/domain"
)

func TestCollectionInSquare(t *testing.T) {
	cases := []struct {
		name string
		c    domain.Collection
		want bool
	}{
		{"published public distribute", domain.Collection{Status: "published", Visibility: "public", Distribute: true}, true},
		{"unlisted not in square", domain.Collection{Status: "published", Visibility: "unlisted", Distribute: true}, false},
		{"private not in square", domain.Collection{Status: "published", Visibility: "private", Distribute: true}, false},
		{"draft not in square", domain.Collection{Status: "draft", Visibility: "public", Distribute: true}, false},
		{"public but distribute false", domain.Collection{Status: "published", Visibility: "public", Distribute: false}, false},
	}
	for _, tc := range cases {
		if got := domain.CollectionInSquare(tc.c); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestEffectivePublicFields(t *testing.T) {
	photo := domain.Photo{PublicFields: []string{"camera", "iso"}}
	override := &domain.PhotoOverride{PublicFields: []string{"camera"}, HistogramPublic: boolPtr(true)}
	got := domain.EffectivePublicFields(photo, override)
	if !got["camera"] || got["iso"] || !got["histogram"] {
		t.Fatalf("unexpected fields: %v", got)
	}
	// PublicFields 为 nil = 不覆盖，继承快照；空切片 = 全部隐藏
	got = domain.EffectivePublicFields(photo, &domain.PhotoOverride{HistogramPublic: boolPtr(true)})
	if !got["camera"] || !got["iso"] {
		t.Fatalf("nil override must inherit: %v", got)
	}
	got = domain.EffectivePublicFields(photo, &domain.PhotoOverride{PublicFields: []string{}})
	if got["camera"] || got["iso"] {
		t.Fatalf("empty override must hide all: %v", got)
	}
}

func TestReadAndDownload(t *testing.T) {
	c := domain.Collection{OwnerID: "u1", Status: "published", Visibility: "private"}
	if domain.CanReadCollection(c, "u2") || domain.CanReadCollection(c, "") || !domain.CanReadCollection(c, "u1") {
		t.Fatal("private: owner only")
	}
	c.Visibility = "unlisted"
	p := domain.Photo{OwnerID: "u1"}
	if domain.CanDownloadOriginal(p, c, "u2") {
		t.Fatal("download requires AllowOriginal")
	}
	c.AllowOriginal = true
	if !domain.CanDownloadOriginal(p, c, "u2") {
		t.Fatal("readable + allowed should download")
	}
}

func boolPtr(b bool) *bool { return &b }
```

（结构体定义先写在 `domain.go` 里，测试再引用。）

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/domain` 预期：编译失败。

- [ ] **Step 3: 实现 `internal/domain/domain.go`**

```go
package domain

type Collection struct {
	ID           string
	OwnerID      string
	Status       string
	Visibility   string
	Distribute   bool
	AllowOriginal bool
}

type Photo struct {
	ID              string
	OwnerID         string
	PublicFields    []string
	HistogramPublic bool
	AllowOriginal   bool
}

type PhotoOverride struct {
	PublicFields    []string
	HistogramPublic *bool
}

func CanReadCollection(c Collection, viewer string) bool {
	if viewer != "" && c.OwnerID == viewer {
		return true
	}
	return c.Status == "published" && (c.Visibility == "public" || c.Visibility == "unlisted")
}

func CollectionInSquare(c Collection) bool {
	return c.Status == "published" && c.Visibility == "public" && c.Distribute
}

func EffectivePublicFields(p Photo, o *PhotoOverride) map[string]bool {
	src := p.PublicFields
	if o != nil && o.PublicFields != nil {
		src = o.PublicFields
	}
	fields := map[string]bool{}
	for _, f := range src {
		fields[f] = true
	}
	fields["histogram"] = p.HistogramPublic
	if o != nil && o.HistogramPublic != nil {
		fields["histogram"] = *o.HistogramPublic
	}
	return fields
}

func CanDownloadOriginal(p Photo, c Collection, viewer string) bool {
	if viewer != "" && p.OwnerID == viewer {
		return true
	}
	return CanReadCollection(c, viewer) && c.AllowOriginal
}

// UsesCDN：仅已发布的公开合集且配置了 CDN 时用固定 CDN URL；其余走同源 /m/ 鉴权跳转。
func UsesCDN(c Collection, cdnBase string) bool {
	return cdnBase != "" && c.Status == "published" && c.Visibility == "public"
}
```

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/domain -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/domain
git commit -m "feat: add domain permission and public-field rules"
```

---

### Task 5: 邮箱、SMTP 与身份

**Files:**
- Create: `internal/mail/mail.go`, `internal/mail/mail_test.go`
- Create: `internal/identity/identity.go`, `internal/identity/identity_test.go`

**Interfaces:**
- Produces: `identity.New(db *sql.DB, deps Deps) *Service`；`Deps{Origin string; Dev bool; RegistrationOpen bool; Now func() int64; Mailer Mailer}`；`Mailer` 接口 `Send(Mail) error` 与适配器 `MailerFunc`；`Mail{To, URL string}`；`(*Service).Middleware(http.Handler) http.Handler`；`(*Service).Routes(chi.Router)`；`(*Service).Handler() http.Handler`（测试用）；`identity.User(ctx) string`（未登录为空串）。
- Consumes: `internal/db`、`internal/httperr`、`internal/clock`、`internal/mail`。

- [ ] **Step 1: 写失败测试（身份）**

```go
package identity_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/timeStarry/frameMark/internal/identity"
)

func newDB(t *testing.T) *sql.DB {
	d, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`
		CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL);
		CREATE TABLE sessions(hash TEXT PRIMARY KEY, user_id TEXT, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, touched_at INTEGER NOT NULL);
		CREATE TABLE pending_verifications(email TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL);
		CREATE TABLE rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
	`); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestRegisterSendsVerification(t *testing.T) {
	d := newDB(t)
	defer d.Close()
	sent := false
	svc := identity.New(d, identity.Deps{
		Origin:           "https://example.com",
		RegistrationOpen: true,
		Now:              func() int64 { return 1_700_000_000_000 },
		Mailer: identity.MailerFunc(func(m identity.Mail) error {
			sent = true
			if !strings.Contains(m.URL, "verify=") {
				t.Errorf("verification url missing token")
			}
			return nil
		}),
	})
	h := svc.Handler() // Middleware + /api/auth/* 路由

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/auth/session", nil))
	var boot struct {
		CSRFToken string `json:"csrfToken"`
	}
	json.NewDecoder(w.Body).Decode(&boot)
	cookie := w.Result().Cookies()[0]

	post := func(origin, token string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{"email":"a@b.co"}`))
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", token)
		req.AddCookie(cookie)
		rw := httptest.NewRecorder()
		h.ServeHTTP(rw, req)
		return rw.Code
	}
	if code := post("https://evil.example", boot.CSRFToken); code != 403 {
		t.Fatalf("foreign origin must be 403, got %d", code)
	}
	if code := post("https://example.com", "wrong"); code != 403 {
		t.Fatalf("bad csrf must be 403, got %d", code)
	}
	if code := post("https://example.com", boot.CSRFToken); code != 202 || !sent {
		t.Fatalf("want 202 and mail sent, got %d sent=%v", code, sent)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/identity` 预期：编译失败。

- [ ] **Step 3: 实现身份服务**

- scrypt：N=131072, r=8, p=1, keyLen=64，salt 16 字节 hex；格式 `scrypt-v1$salt$hash`。
- 会话：cookie 名 HTTPS 下 `__Host-markr_session`，dev 下 `markr_dev_session`；`HttpOnly`、`Secure`（HTTPS 时）、`SameSite=Lax`、`Path=/`。DB 只存 sha256(cookie 值)。绝对有效期 7 天，空闲超时 24 小时。
- CSRF：写请求要求 `Origin` 精确等于配置 origin、`Sec-Fetch-Site != cross-site`、`X-CSRF-Token` 与会话 csrf 常量时间相等。
- 限流：15 分钟窗口，key 前缀与次数按 spec §5。
- 接口：`GET /api/auth/session`（无会话则建匿名会话并发 CSRF）、`POST /api/auth/register|verify|login|logout|logout-all`。
- 未登录或限流时错误用 `httperr`。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/identity -v` 预期：PASS。

- [ ] **Step 5: SMTP 读取**

实现 `internal/mail/mail.go`：以 `O_NOFOLLOW` 打开 `MARKR_SMTP_CONFIG_FILE`，校验属主与 0600，解析 `SMTP_HOST/PORT/USER/PASSWORD/FROM`。测试用 fake。

- [ ] **Step 6: 提交**

```bash
git add internal/identity internal/mail
git commit -m "feat: add scrypt identity, sessions, CSRF, rate limits, SMTP"
```

---

### Task 6: S3 抽象与预签名

**Files:**
- Create: `internal/storage/storage.go`, `internal/storage/storage_test.go`

**Interfaces:**
- Produces: `storage.Client`（`PutObject(ctx, bucket, key, body []byte, contentType string) error`、`HeadObject(...) (size int64, sha256 string, err error)`、`DeleteObject(...)`、`PresignPut(ctx, bucket, key, contentType, sha256 string, ttl time.Duration) (url string, headers map[string]string, err error)`、`PresignGet(...) (string, error)`）。
- Consumes: aws-sdk-go-v2。

- [ ] **Step 1: 写失败测试**

测试用 fake S3（内存 map），断言 `PresignPut` 返回的 URL 含 `X-Amz-Signature` 且 `SignedHeader` 包含 `content-type` 与 `x-amz-checksum-sha256`。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/storage` 预期：编译失败。

- [ ] **Step 3: 实现**

```go
package storage

type Client struct{ /* s3 client + presigner */ }

func (c *Client) PresignPut(ctx context.Context, bucket, key, contentType, sha256 string, ttl time.Duration) (string, map[string]string, error) {
	req, err := c.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:         aws.String(bucket),
		Key:            aws.String(key),
		ContentType:    aws.String(contentType),
		ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(mustDecodeHex(sha256))),
	}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", nil, err
	}
	return req.URL, flattenSignedHeaders(req.SignedHeader), nil
}
```

（其余 Put/Head/Delete/PresignGet 按同文件实现，测试先行。）

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/storage -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/storage
git commit -m "feat: add S3 abstraction with presigned put/get"
```

---

### Task 7: CDN purge

**Files:**
- Create: `internal/cdn/cdn.go`, `internal/cdn/cdn_test.go`

**Interfaces:**
- Produces: `cdn.Purger`（`PurgeURLs(ctx, urls []string) error`）。
- Consumes: tencentcloud teo SDK（fake 在测试注入）。

- [ ] **Step 1: 写失败测试**：fake 记录调用，断言 URL 列表按前缀去重。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/cdn` 预期：编译失败。

- [ ] **Step 3: 实现**：`PurgeURLs` 调 `CreatePurgeTaskRequest{ZoneId, Type: "purge_url", Method: "invalidate", Targets: urls}`；EO 未配置时返回 nil 并记日志。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/cdn -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/cdn
git commit -m "feat: add EO purge adapter with noop fallback"
```

---

### Task 8: SQLite 任务队列

**Files:**
- Create: `internal/jobs/jobs.go`, `internal/jobs/jobs_test.go`

**Interfaces:**
- Produces: `jobs.Queue`（`Enqueue(ctx, kind string, payload any) error`、`Claim(ctx, workerID string) (*Job, error)`、`Heartbeat(ctx, jobID string) error`、`Done(ctx, jobID string) error`、`Fail(ctx, jobID string, permanent bool, err error) error`）。
- Consumes: `internal/db`、`internal/clock`。

- [ ] **Step 1: 写失败测试**

覆盖：入队 → 领取 → 心跳续租 → 完成；领取并发安全（两个 worker 只一个拿到）；失败重试 5 次后 dead；租约过期可被其他 worker 重新领取。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/jobs` 预期：编译失败。

- [ ] **Step 3: 实现**

`Claim` 用单事务：`UPDATE jobs SET state='running', lease_until=? WHERE id=(SELECT id FROM jobs WHERE state='queued' AND run_after<=? ORDER BY run_after LIMIT 1) RETURNING *`。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/jobs -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/jobs
git commit -m "feat: add SQLite-backed job queue with leases"
```

---

### Task 9: EXIF、GPS 与直方图

**Files:**
- Create: `internal/media/exif.go`, `internal/media/exif_test.go`
- Create: `internal/media/histogram.go`, `internal/media/histogram_test.go`

**Interfaces:**
- Produces: `media.ExtractEXIF(raw []byte, locationMode string) (EXIF, error)`、`media.Histogram(pix []byte, width, height int) [4][64]uint16`。
- Consumes: goexif、govips（只用于解码）。

- [ ] **Step 1: 写失败测试**

合成一张带 EXIF/GPS 的 JPEG（用 `exiftool` 或预生成 fixture 提交到 `testdata/`），断言：
- `location_mode=off` 时 `EXIF.Location == nil`；
- 白名单字段正确解析；
- 直方图 4×64 总和等于像素数。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/media` 预期：编译失败。

- [ ] **Step 3: 实现**

EXIF 白名单：`Make, Model, LensModel, FocalLength, FNumber, ExposureTime, ISOSpeedRatings, ExposureBiasValue, DateTimeOriginal`。GPS 仅在 `location_mode=archive` 时读 GPS IFD，其余情况跳过。

直方图：输入为长边 512 的 sRGB RGB 像素（RGB 三个 uint8），亮度用 Rec.709：`Y = 0.2126R + 0.7152G + 0.0722B`，各 64 档。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/media -v` 预期：PASS（需要 libvips 时先 `brew install vips`）。

- [ ] **Step 5: 提交**

```bash
git add internal/media testdata
git commit -m "feat: add EXIF whitelist extraction and histogram"
```

---

### Task 10: 媒体管线

**Files:**
- Create: `internal/media/pipeline.go`, `internal/media/pipeline_test.go`

**Interfaces:**
- Produces: `media.Process(ctx, storage storage.Client, bucketOrig, bucketDerived string, photo PhotoRow, watermark *Watermark) (Result, error)`。
- Consumes: `internal/storage`、`internal/media/exif.go`、`internal/media/histogram.go`、govips。

- [ ] **Step 1: 写失败测试**

测试覆盖：方向转正、衍生档位、衍生图无 EXIF、动画 WebP 被拒、超像素被拒、`derived_hash` 稳定、`location_mode=off` 时衍生图无 GPS。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/media` 预期：编译失败。

- [ ] **Step 3: 实现**

管线顺序：
1. `storage.GetObject` 原图到内存。
2. govips `LoadImageFromBuffer`（`FailOnError: true`），`Pages()==1` 校验，像素上限校验。
3. `AutoRotate`；有嵌入 ICC 时 `TransformICCProfile(vips.SRGBIEC6196621ICCProfilePath)`，没有时 `ToColorSpace(InterpretationSRGB)`；有 alpha 时 `Flatten` 到黑底。
4. 记录转正后宽高。
5. 长边 512 缩略 → `ExportNative` → 直方图。
6. 每档 `ThumbnailWithSize(tier, tier, InterestingNone, SizeDown)` → `RemoveMetadata` → `ExportAvif/Webp/Jpeg`（`StripMetadata: true`）。
7. 计算 `derived_hash = sha256hex(origSHA + "MEDIA_PIPELINE_V1" + salt)[:16]`。
8. `PutObject` 到派生桶，key `d/{id}/{hash}/{tier}.{ext}`，`Cache-Control: public, max-age=31536000, immutable`。
9. 若 `watermark != nil`：w2400 档加 `Label`（`Font: "sans 12"`，尺寸按短边比例，位置映射）→ 导出 `w2400.jpg` 到 `d/{id}/{hash}-wm{wmHash}/w2400.jpg`。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/media -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/media
git commit -m "feat: add libvips pipeline with derived tiers and watermark"
```

---

### Task 11: 上传 API

**Files:**
- Create: `internal/api/uploads.go`, `internal/api/uploads_test.go`

**Interfaces:**
- Produces: `POST /api/uploads`、`POST /api/uploads/{id}/complete`、`GET /api/photos/{id}`。
- Consumes: `internal/db`、`internal/storage`、`internal/jobs`、`internal/identity` 中间件。

- [ ] **Step 1: 写失败测试**

覆盖：未登录 401；sha256 重复返回 200；contentType 非法 400；complete 时 HEAD 校验失败标 failed；complete 成功入队。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/api` 预期：编译失败。

- [ ] **Step 3: 实现**

```go
func (s *Server) createUpload(w http.ResponseWriter, r *http.Request) {
	user := identity.User(r.Context())
	if user == "" {
		httperr.Write(w, httperr.Fail(401, "请先登录"))
		return
	}
	var in struct {
		Filename    string `json:"filename"`
		Bytes       int64  `json:"bytes"`
		SHA256      string `json:"sha256"`
		ContentType string `json:"contentType"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httperr.Write(w, httperr.Fail(400, "请求格式无效"))
		return
	}
	// ... 校验 contentType、大小、配额、sha256 去重、创建 photos 行、预签名、入队
}
```

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/api -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/api
git commit -m "feat: add presigned upload initiation and completion"
```

---

### Task 12: 写路径（合集、帧、偏好、主页、作品集）

**Files:**
- Create: `internal/api/write.go`, `internal/api/write_test.go`

**Interfaces:**
- Produces: `POST/PUT/DELETE /api/collections`、`PUT /api/collections/{id}/frames`、`POST/PUT/DELETE /api/albums`、`PUT /api/profile`、`PUT /api/upload-prefs`。
- Consumes: `internal/db`、`internal/domain`、`internal/identity`。

- [ ] **Step 1: 写失败测试**

覆盖：非作者写 403；帧序列越界 400；frame_photos 引用他人照片 400；序列最多 200 帧；`pair` 帧只有 1 张或 `text` 帧带照片 400；`matted` 的 `matte_ratio` 不在 0.5–0.95 时 400；发布前 dry_run 返回清单；公开合集改为 private 后，不再属于任何公开合集的照片各入队一个 `rotate_derived`。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/api` 预期：编译失败。

- [ ] **Step 3: 实现**

每个 handler 先取 `identity.User`，再 `domain` 校验归属与可见性，最后事务写库。帧替换用整序列 `PUT`：删除旧帧 → 插入新帧 → 更新 `cover_photo_id`。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/api -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/api
git commit -m "feat: add collection, frame, album, profile, prefs write API"
```

---

### Task 13: 读路径与媒体 URL

**Files:**
- Create: `internal/api/read.go`, `internal/api/read_test.go`

**Interfaces:**
- Produces: `GET /api/square`、`GET /api/u/{userId}`、`GET /api/collections/{id}`、`GET /api/collections/{id}/neighbors`、`GET /api/albums/{id}`、`GET /api/archive`、`GET /api/photos/{id}`、`GET /api/photos/{id}/original`、`GET /m/{photoId}/{hash}/{file}`。
- Consumes: `internal/db`、`internal/domain`、`internal/storage`、`internal/cdn`。

- [ ] **Step 1: 写失败测试**

覆盖：广场排序与游标；未公开合集 404；unlisted 可直链但不出广场；neighbors 回退 user；archive 只作者可见；original 仅作者或允许下载的合集；`/m/...` 302 且带 `Cache-Control: private, no-store`。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/api` 预期：编译失败。

- [ ] **Step 3: 实现**

`GET /m/{photoId}/{hash}/{file}`：每次请求都重新鉴权，通过后 `storage.PresignGet`（5 分钟）302 跳转。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/api -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/api
git commit -m "feat: add read API and authorized media redirect"
```

---

### Task 14: worker 主循环

**Files:**
- Create: `cmd/markr/serve.go`（或扩展 `main.go`）、`internal/worker/worker.go`, `internal/worker/worker_test.go`

**Interfaces:**
- Produces: `worker.Run(ctx, cfg config.Config, db *sql.DB, storage storage.Client, cdn cdn.Purger)`。
- Consumes: `internal/jobs`、`internal/media`、`internal/storage`、`internal/cdn`。

- [ ] **Step 1: 写失败测试**

用 fake storage + fake cdn，入队 `process_photo` 后断言：任务完成、photos 表更新、衍生对象写入、`replicate_original` 在配置时入队。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/worker` 预期：编译失败。

- [ ] **Step 3: 实现**

worker 循环：`jobs.Claim` → 按 kind 分发 → `Done/Fail`；心跳 goroutine 每 30s 续租；`--role=api|worker|all` 在 `cmd/markr` 里解析。

必须处理的 kind：
- `process_photo`：调用 `media.Process`，事务写入结果；永久错误 `Fail(permanent=true)`。
- `rotate_derived`：生成新 `derived_salt`，重跑衍生输出到新哈希前缀，删除旧前缀对象，`cdn.PurgeURLs` 旧前缀。由任务 12 的撤回路径（合集取消公开、删除、照片移出合集后不再属于任何公开合集）入队。测试断言 `derived_hash` 变化、旧对象被删、purge 被调用。
- `replicate_original`：配置副本时把原图复制到 MinIO。
- `cleanup_uploads`：worker 启动后每小时入队一次，删除超过 1 小时仍为 `uploading` 的照片行及其对象。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/worker -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add cmd/markr internal/worker
git commit -m "feat: add worker loop and role-based serve command"
```

---

### Task 15: Demo 种子

**Files:**
- Create: `internal/seed/seed.go`, `internal/seed/seed_test.go`
- Create: `ops/demo/manifest.json`（复用现有文件，不动）

**Interfaces:**
- Produces: `seed.Run(ctx, cfg config.Config, db *sql.DB, storage storage.Client, manifestPath, imagesDir string, apply bool) error`。
- Consumes: `internal/media`、`internal/storage`、`internal/db`。

- [ ] **Step 1: 写失败测试**

用 fake storage + 本地 fixture 图，断言：照片入库、EXIF 写入、合集与帧创建、attributions 写入、重复执行幂等。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/seed` 预期：编译失败。

- [ ] **Step 3: 实现**

`seed-demo` 子命令：读 manifest，逐图 `Process` 管线，创建 `markr-demo` 用户（password 为不可能匹配的 `!` 前缀字符串），按 manifest.collections 建合集与满屏帧，`apply=false` 时只打印计划。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/seed -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/seed
git commit -m "feat: add demo seed with attributed photos and collections"
```

---

### Task 16: 端到端验收

**Files:**
- Create: `internal/e2e/e2e_test.go`
- Create: `scripts/test-fixtures/`（合成图，已有则复用）

**Interfaces:**
- Produces: 一条 `TestFullJourney`。
- Consumes: 以上全部。

- [ ] **Step 1: 写失败测试**

`TestFullJourney`：注册 → 上传 → 处理 → 建合集 → 发布 → 匿名读 → 撤回 → 匿名 404；同时跑隐私扫描（响应不含 `latitude|longitude|gps|o/`）。

- [ ] **Step 2: 跑测试确认失败**

`go test ./internal/e2e` 预期：编译失败。

- [ ] **Step 3: 实现**

用 `httptest.NewServer` 起完整 API + worker goroutine，MinIO 用 `testcontainers` 或环境变量 `MARKR_TEST_S3_ENDPOINT` 指向本地 Docker MinIO。

- [ ] **Step 4: 跑测试确认通过**

`go test ./internal/e2e -v` 预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/e2e scripts/test-fixtures
git commit -m "feat: add end-to-end journey and privacy scan tests"
```

---

### Task 17: CI

**Files:**
- Modify: `.github/workflows/platform-ci.yml`

**Interfaces:**
- Produces: Go job。
- Consumes: 无。

- [ ] **Step 1: 改 workflow**

新增 `go` job：ubuntu-latest，安装 `libvips-dev` 与 MinIO service，`go vet ./...`、`go test ./...`。Node job 保留。

- [ ] **Step 2: 本地验证**

`go vet ./... && go test ./...` 全绿。

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/platform-ci.yml
git commit -m "ci: add Go build, test, and MinIO service"
```

---

## 执行提示

- 任务 6–16 写到接口、测试场景和关键实现，没有逐行代码：它们依赖真实 SDK（S3、TEO、govips）的返回结构，执行时按测试先行落地。每个任务仍须先写出列出的测试、看到失败，再实现。

- 每个任务结束前必须 `go test ./...` 全绿，且 `git status` 干净。
- 媒体任务需要 `brew install vips`；若环境缺 libvips，先安装再继续，不要用 mock 跳过管线测试。
- 测试夹具图片（含 EXIF、GPS、ICC、动画 WebP）提交到 `testdata/`，不要运行时生成。
- 任何任务发现 spec 与本计划冲突，停下来报告，不要自行取舍。
