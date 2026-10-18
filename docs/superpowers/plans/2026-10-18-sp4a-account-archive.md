# SP4a 账户与归档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authors can sign in, upload, browse and prune their archive, list their collections, and set upload preferences and profile.

**Architecture:** Small Go changes (dev log mailer, CSP connect-src for direct S3 PUT, a `taken_offset_min` column, owner-only `status`/`visibility` on cards). The frontend adds a session/CSRF module, a write client, and lazy `/login`, `/me`, `/me/collections` and `/me/settings` routes under `web/src/me/`.

**Tech Stack:** Go (chi, SQLite, embedded forward-only migrations), Vue 3.5 + vue-router 4.6, TypeScript, vitest + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-sp4a-account-archive-design.md` (parent: `docs/superpowers/specs/2026-10-13-markr-redesign-design.md` §5, §5.1, §6, §7, §10)

## Global Constraints

- No new npm or Go dependencies.
- Visual: darkroom palette (`--bg-wall`, `--fg`, `--fg-muted`, `--accent`, `--line`), radius 0, no shadows. Focus is `outline: 2px solid var(--accent); outline-offset: 4px` on `:focus-visible`. Touch targets ≥ 44px. Every form control has a visible `<label>`.
- Copy: Chinese. The workspace may say 「合集」. Visitor pages still never do. Show backend error messages (`{"error": "..."}`) as-is.
- Storage access always in try/catch. Failures are silent.
- Never log, store or keep in the URL a verification token or password.
- Bundle: `/c/:id` and `/` critical paths ≤ 80 KB gz each. `web/src/me/**` must not be statically imported by wall or viewer code.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Frontend verification: `cd web && npx vitest run && npx vue-tsc --noEmit && npm run build && npm run check:bundle`. Go: `go test ./internal/... ./cmd/... && go vet ./... && test -z "$(gofmt -l .)"`. Integration tests that need MinIO: see `.superpowers/HANDOFF.md` 本地环境.

## Review Focus

1. CSRF: every non-GET request sends `X-CSRF-Token`. After a login or verify, the token returned by that response replaces the old one. A stale token is retried once after `refresh()`, never in a loop. (Task 2)
2. Identity change must clear `markr:wallCache:*` and `markr:lastViewed:*` on login, verify, logout, and when a different user appears on boot. Otherwise an owner's draft cards can show to the next person in the tab. (Task 2)
3. The verify token is removed from the address bar before any await, and it never enters storage or logs. (Task 4)
4. Upload queue: concurrency is 2, duplicates return immediately, failures can be retried, and polling stops at ready, failed, 2 min, or unmount. No orphaned XHR or timers survive unmount. (Task 6)
5. Owner-only card fields (`status`, `visibility`) must never reach a visitor or anonymous viewer, on any of square, user wall, album or neighbor strip. (Task 1)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `internal/mail/mail.go` | `LogSender` (dev only) |
| `cmd/markr/serve.go` | pick the log sender in dev without SMTP; pass S3 hosts as connect hosts |
| `internal/webui/webui.go` | `Options.ConnectHosts` → `connect-src` |
| `internal/db/migrations/0002_taken_offset.sql` | `photo_exif.taken_offset_min` |
| `internal/media/exif.go` | `EXIF.TakenOffsetMin *int64` |
| `internal/worker/worker.go` | write the offset |
| `internal/api/uploads.go`, `read.go` | `exifView.TakenOffsetMinutes`; owner-only card fields |
| `ops/` or `DEPLOY.md` | bucket CORS note |
| `web/src/api/types.ts` | `ExifOffset`, `OwnerPhoto`, `Archive*`, `UploadPrefs`, `Profile` input, `Card.status?/visibility?` |
| `web/src/api/write.ts` | `send<T>(method, url, body?)` with CSRF + one refresh retry |
| `web/src/api/session.ts` | reactive session; login/register/verify/logout/logoutAll; identity cache clearing |
| `web/src/api/me.ts` | archive, photo, delete, uploads, prefs, profile calls |
| `web/src/viewer/format.ts` | `formatDate(ms, offsetMinutes?)` |
| `web/src/me/MeNav.vue` | 归档 · 合集 · 偏好 · 我的主页 · 登出 |
| `web/src/me/guard.ts` | `requireUser` route guard + `safeNext()` |
| `web/src/me/LoginRoute.vue` | login / register / verify |
| `web/src/me/ArchiveRoute.vue`, `ArchiveFilters.vue`, `ArchiveGrid.vue`, `PhotoPanel.vue`, `ConfirmDialog.vue` | archive |
| `web/src/me/uploadQueue.ts`, `sha256.ts`, `UploadTray.vue` | upload |
| `web/src/me/CollectionsRoute.vue` | owner collection list |
| `web/src/me/SettingsRoute.vue`, `PrefsForm.vue`, `ProfileForm.vue` | settings |
| `web/src/walls/WallCard.vue`, `WallNav.vue` | owner badge; 我的 link by session |
| `web/e2e/mock.ts`, `web/e2e/me.spec.ts` | mock auth/archive/uploads/prefs; acceptance |
| `web/scripts/check-bundle.mjs` | unchanged limits; confirm `/me` is not on the two critical paths |

---

### Task 1: Backend — dev mailer, CSP connect-src, taken offset, owner card fields

**Files:**
- Create: `internal/db/migrations/0002_taken_offset.sql`
- Modify: `internal/mail/mail.go`, `cmd/markr/serve.go`, `internal/webui/webui.go`, `internal/media/exif.go`, `internal/worker/worker.go`, `internal/api/uploads.go`, `internal/api/read.go`, `DEPLOY.md`
- Test: `internal/mail/mail_test.go`, `cmd/markr/serve_test.go`, `internal/webui/webui_test.go`, `internal/media/exif_test.go`, `internal/worker/worker_test.go`, `internal/api/read_test.go`, `internal/db/db_test.go`

**Interfaces:**
- `mail.LogSender{Log func(format string, args ...any)}` implements `Sender`. `Send` logs `"仅开发模式：验证链接 %s → %s"` with To and URL.
- `webui.Options.ConnectHosts []string` produces `connect-src 'self' <hosts...>`.
- `media.EXIF.TakenOffsetMin *int64` is set only when `parseOffset` succeeds, in minutes (−840…840).
- JSON `exif.takenOffsetMinutes` (omitempty) appears everywhere `takenAt` does: owner photo view and public photo view. The public view includes it only when `taken_date` is public, the same gate as `takenAt`.
- `cardView` gains `Status *string \`json:"status,omitempty"\`` and `Visibility *string \`json:"visibility,omitempty"\``, set only when the card builder's viewer equals the card owner.

- [ ] **Step 1: Failing tests.**
  - mail: `LogSender.Send` calls Log with a string containing the URL and 仅开发模式.
  - serve: with `MARKR_DEV=1` and no `MARKR_SMTP_CONFIG_FILE`, `/api/auth/register` returns 2xx and the log contains `/login#verify=`. Without `MARKR_DEV`, it returns 503 「验证邮件服务暂不可用。」. Read the existing serve_test helpers and adapt; if spinning a server is heavy, unit-test the selector function `pickMailer(cfg, logf) (identity.Mailer, error)` instead.
  - webui: CSP contains `connect-src 'self' http://127.0.0.1:9000` when ConnectHosts is given, and stays `connect-src 'self'` when it is empty.
  - db: after Migrate, `photo_exif` has `taken_offset_min`. `CHECK (taken_offset_min IS NULL OR taken_offset_min BETWEEN -840 AND 840)`.
  - exif: `+08:00` → 480, `-05:30` → −330, invalid or missing → nil. takenAt is unchanged.
  - worker: upsert writes and updates the offset (reuse an existing worker EXIF test fixture).
  - api: a photo with offset 480 returns `takenOffsetMinutes: 480` in the owner view and in the public view when `taken_date` is public. When `taken_date` is hidden, both fields are absent.
  - api: the owner calling `/api/u/{self}` gets `status` and `visibility` on each card. Anonymous callers and another user get neither key. The same check applies to `/api/square`, `/api/albums/{id}` and neighbors (owner calling it on their own collection).
- [ ] **Step 2: Run** `go test ./internal/... ./cmd/...` and expect FAIL.
- [ ] **Step 3: Implement.** Migration:

```sql
ALTER TABLE photo_exif ADD COLUMN taken_offset_min INTEGER NULL
    CHECK (taken_offset_min IS NULL OR taken_offset_min BETWEEN -840 AND 840);
```

`serve.go`: when `role` is api or all and SMTP is not configured and `cfg.Dev`, use `mail.LogSender{Log: log.Warn-adapter}`. Pass `ConnectHosts: imgHosts(cfg)` to `webui.Options` (rename the helper to `s3Hosts` and update its comment to cover both directives). `cardBuilder` gets a `viewer string` field, set by every caller from `identity.User(ctx)`. Set the two pointers in `card()` when `b.viewer != "" && b.viewer == c.OwnerID`.
`DEPLOY.md`: add a "存储桶 CORS" section giving a JSON example for the originals bucket: AllowedOrigins [MARKR_ORIGIN], AllowedMethods [PUT], AllowedHeaders [Content-Type, x-amz-*], MaxAgeSeconds 3000.
- [ ] **Step 4: Run** the full Go verification and expect PASS.
- [ ] **Step 5: Commit** `feat(api): dev log mailer, S3 connect-src, taken offset and owner card fields`. Splitting it into 2–3 commits is fine.

---

### Task 2: Frontend session, CSRF write client, identity cache clearing

**Files:**
- Create: `web/src/api/write.ts`, `web/src/api/session.ts`, `web/src/api/me.ts`, and a `.test.ts` beside each
- Modify: `web/src/api/types.ts`

**Interfaces:**

```ts
// types.ts additions
export interface Exif { /* …existing… */ takenOffsetMinutes?: number }
export interface Card { /* …existing… */ status?: 'draft' | 'published'; visibility?: 'private' | 'unlisted' | 'public' }
export type PhotoStatus = 'uploading' | 'processing' | 'ready' | 'failed'
export interface OwnerPhoto {
  id: string; status: PhotoStatus; error: string | null; title: string; caption: string
  width: number | null; height: number | null; format: string; createdAt: number
  publicFields: string[]; histogramPublic: boolean; originalDownload: boolean
  exif: Exif | null; media: Media | null
}
export interface ArchiveFacets { years: { year: number; count: number }[]; cameras: { name: string; count: number }[]; lenses: { name: string; count: number }[] }
export interface ArchivePage { items: OwnerPhoto[]; nextCursor: string | null; facets: ArchiveFacets }
export interface ArchiveQuery { year?: number; camera?: string; lens?: string; focalMin?: number; focalMax?: number; inCollection?: boolean; status?: PhotoStatus }
export interface Watermark { text: string; position: 'br' | 'bl' | 'tr' | 'tl' | 'center'; opacity: number; scale: number }
export interface UploadPrefs {
  publicFields: string[]; histogramPublic: boolean; originalDownload: boolean; watermark: Watermark | null
  defaultLicense: string | null; defaultAiDeclaration: string | null; locationMode: 'off' | 'archive'; updatedAt: number | null
}
export interface ProfileInput { name: string; bio: string; wallLayout: 'salon' | 'grid' }
export interface UploadInit { photoId: string; upload: { url: string; method: string; headers: Record<string, string> }; expiresAt: number }

// write.ts
export type WriteResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; message: string }
export function send<T>(method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<WriteResult<T>>
// Reads the token from session.csrfToken. On 403 whose body.error is the CSRF message, await refresh() and retry once.
// status 0 = network error. message = body.error, or for status 0 「网络连接出了问题」.

// session.ts
export interface SessionState { ready: boolean; user: string | null; csrfToken: string | null; registrationOpen: boolean }
export const session: Readonly<SessionState>        // reactive()
export function refresh(): Promise<void>
export function login(email: string, password: string): Promise<WriteResult<{ user: string }>>
export function register(email: string): Promise<WriteResult<unknown>>
export function verify(token: string, password: string): Promise<WriteResult<{ user: string }>>
export function logout(): Promise<WriteResult<unknown>>
export function logoutAll(): Promise<WriteResult<unknown>>
export function clearViewerCaches(): void          // removes markr:wallCache:* and markr:lastViewed:* from sessionStorage

// me.ts (GET via the existing getJSON pattern; writes via send)
export function getArchive(q: ArchiveQuery, cursor: string | null, signal?: AbortSignal): Promise<Result<ArchivePage>>
export function getPhoto(id: string, signal?: AbortSignal): Promise<Result<OwnerPhoto>>
export function deletePhoto(id: string): Promise<WriteResult<unknown>>
export function createUpload(f: { filename: string; bytes: number; sha256: string; contentType: string }): Promise<WriteResult<UploadInit | OwnerPhoto>>
export function completeUpload(id: string): Promise<WriteResult<OwnerPhoto>>
export function getPrefs(signal?: AbortSignal): Promise<Result<UploadPrefs>>
export function putPrefs(p: Omit<UploadPrefs, 'updatedAt'>): Promise<WriteResult<UploadPrefs>>
export function putProfile(p: ProfileInput): Promise<WriteResult<unknown>>
```

Archive query params map as follows: year, camera, lens, focal_min, focal_max, in_collection (`true`/`false`), status. Read `internal/api/archive.go` to confirm every name and the status values, and adapt if they differ. `createUpload` returns 201 with `UploadInit`, or 200 with `OwnerPhoto` for a duplicate. Distinguish them by status code.

Identity tracking: `refresh()`, and every successful login, verify and logout, compares the new user with `sessionStorage['markr:identity']`. If they differ (null counts as a value), it calls `clearViewerCaches()` and stores the new value. On login, verify and logout it clears unconditionally. Expose `getJSON` from client.ts (rename it to an exported `getJSON`) instead of duplicating it.

- [ ] **Step 1: Failing tests.**
  - write sends `X-CSRF-Token` and `Content-Type: application/json`, and serializes the body.
  - A CSRF 403 calls refresh once, then retries with the new token. A second 403 is returned and not retried.
  - Other 4xx errors come back with the server message.
  - A network error returns status 0 with 「网络连接出了问题」.
  - login replaces the csrfToken with the one in the response.
  - Login, verify and logout each clear the caches: seed `markr:wallCache:square`, `markr:lastViewed:user:u1`, and an unrelated `other` key, then assert the first two are gone and `other` remains.
  - `refresh()` run with a different user than the stored identity clears the caches. Run with the same user, it leaves them.
  - A throwing sessionStorage causes no throw.
  - me.ts builds the archive query string (encoded, with omitted fields left out) and handles the duplicate-upload 200 vs 201.
- [ ] **Step 2–4:** Implement, then run the frontend verification and expect PASS.
- [ ] **Step 5: Commit** `feat(web): add session, CSRF write client and owner API`.

---

### Task 3: Taken-date offset in the viewer

**Files:** Modify `web/src/viewer/format.ts`, `format.test.ts`, every caller of `formatDate` (grep), and `docs/superpowers/specs/2026-10-15-sp2-viewer-design.md` (add one line to the I7 note: 已在 SP4a 修复，需重新处理旧照片).

- `formatDate(ms: number, offsetMinutes?: number): string` formats `"YYYY.MM.DD"` from `new Date(ms + (offsetMinutes ?? 0) * 60000)` using its UTC fields. Update the doc comment and remove the "Known limitation" paragraph.
- Callers pass `exif.takenOffsetMinutes`.
- Tests: `Date.UTC(2026,4,3,17)` with offset 480 gives `2026.05.04`. The same instant with no offset gives `2026.05.03`. Offset −330 is also tested.
- Commit `fix(viewer): show the taken date in the photo's own time zone`.

---

### Task 4: Login route, `/me` guard, nav

**Files:**
- Create: `web/src/me/LoginRoute.vue`, `web/src/me/guard.ts`, `web/src/me/MeNav.vue`, `web/src/me/MeLayout.vue` (MeNav + `<RouterView>`), and tests
- Modify: `web/src/router.ts`, `web/src/router.test.ts`, `web/src/walls/WallNav.vue`, `web/src/main.ts` (call `refresh()` once at boot, without blocking mount)

**Interfaces:**
- Routes (all lazy): `/login` `login`; `/me` → `MeLayout` with children `''` `archive`, `collections` `me-collections`, and `settings` `me-settings`, all with `meta: { requiresUser: true }`. Remove the old `/me` placeholder.
- `guard.ts`: `export function safeNext(v: unknown): string`. It returns v only if v is a string that starts with `/me` and has no `//` or `\`; otherwise it returns `/me`. `export function installGuard(router)` registers a `beforeEach` that awaits `session.ready` (`refresh()` if not ready). For `requiresUser` routes without a user it redirects to `{ name: 'login', query: { next: to.fullPath } }`. For `login` with a user it redirects to `safeNext(to.query.next)`.
- `LoginRoute`:
  - It has two tabs, 登录 and 注册, as `role="tablist"` buttons. If `location.hash` starts with `#verify=`, it reads the token and immediately calls `history.replaceState(null, '', location.pathname + location.search)`, then shows a 设置密码 form.
  - After a successful login or verify it calls `router.replace(safeNext(route.query.next))`.
  - The register tab shows the server message on success. If `!session.registrationOpen` it shows 「注册尚未开放。」 with no form.
  - Password inputs have a 显示/隐藏 toggle with `aria-pressed`. A client check allows ≥ 15 characters and shows the hint 「至少 15 个字符」. Errors use `role="alert"`.
- `WallNav`: 我的 → `/me` when `session.user`, otherwise `/login`.
- `MeNav` items: 归档 `/me`, 合集 `/me/collections`, 偏好 `/me/settings`, 我的主页 `/u/{session.user}`, and a 登出 button. 登出 calls `logout()` and then `router.replace('/')`. The active item has `aria-current="page"`.

- [ ] Tests: safeNext cases (`/me/settings` ok; `https://x`, `//x`, `/\x`, `/u/1`, non-string → `/me`); guard redirects and the next round trip; the verify hash is removed before the verify request is sent (assert replaceState was called before fetch); the token is never written to storage (spy on setItem); the register-closed state; the login error message is shown; WallNav links by session; logout clears caches and navigates home.
- [ ] Commit `feat(web): add login, verify and the /me guard`.

---

### Task 5: Archive — filters, grid, detail panel, delete

**Files:**
- Create: `web/src/me/ArchiveRoute.vue`, `ArchiveFilters.vue`, `ArchiveGrid.vue`, `PhotoPanel.vue`, `ConfirmDialog.vue`, `archiveQuery.ts` (URL ⇄ ArchiveQuery, pure), and tests

**Behaviour:**
- `archiveQuery.ts`: `fromRoute(query): ArchiveQuery` validates and ignores bad values. `toQuery(q): Record<string,string>`. They round-trip.
- Filters change → `router.replace({ query })` → reload from the first page. The previous request is aborted.
- Grid: CSS grid `repeat(auto-fill, minmax(160px, 1fr))`, 3 columns under 600px. Each tile is a `<button>` with `aria-label="{title}，{日期或「未知日期」}"`. It shows a square `Cover` (reuse `walls/Cover.vue` with aspect 1). Status overlays: 处理中 / 处理失败.
- Infinite: a 「载入更多」 button plus an IntersectionObserver. Same as the square: they share one `more()` with an in-flight guard.
- PhotoPanel: on desktop, `<aside>` on the right. Under 768px it is a bottom sheet. It contains the large image, title, `exifTable` from viewer/format.ts (owner sees all fields), 公开字段 as read-only chips, 「在 N 个合集中」 (count from `GET /api/photos/{id}` if present; otherwise omit), and a 删除 button. Esc closes it, and focus returns to the tile.
- ConfirmDialog: native `<dialog>` with `showModal()`, a title, body text, 取消 / 确认 buttons, and focus on 取消 at open. Its props are `{ title, body, confirmLabel }` and it emits `confirm` / `cancel`. Delete body: 「会从 N 个合集中移除；已发布的合集会立刻不再显示这张照片。」 (when N is unknown: 「如果它在已发布的合集中，访客会立刻看不到。」).
- After a delete succeeds, remove the item, close the panel, and move focus to the next tile, or to the grid if none is left. On failure, show the server message in the dialog.
- Empty state: 「还没有照片」 + the 上传 button (wired in Task 6; render a disabled placeholder slot here).
- Error state: the shared `WallStatus` component with retry.

- [ ] Tests: archiveQuery round trip and rejection of bad values; filter change replaces the query and aborts the old request; paging append; panel open/close focus return; delete flow (confirm → request → removal → focus moves on) and the failure message; status overlays; aria-labels.
- [ ] Commit `feat(web): add the archive with filters, detail and delete`.

---

### Task 6: Upload queue and tray

**Files:**
- Create: `web/src/me/sha256.ts`, `web/src/me/uploadQueue.ts`, `web/src/me/UploadTray.vue`, and tests
- Modify: `web/src/me/ArchiveRoute.vue` (上传 button, hidden `<input type=file multiple accept>`, page-level drop zone, prepend finished photos)

**Interfaces:**

```ts
export const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'] as const
export const MAX_BYTES = 60 * 1024 * 1024
export type ItemState = 'queued' | 'hashing' | 'uploading' | 'processing' | 'done' | 'duplicate' | 'failed' | 'rejected'
export interface QueueItem { key: string; file: File; state: ItemState; progress: number; message: string; photo: OwnerPhoto | null }
export interface UploadDeps {
  hash(file: File): Promise<string>
  create: typeof createUpload; complete: typeof completeUpload; get: typeof getPhoto
  put(url: string, method: string, headers: Record<string, string>, file: File, onProgress: (p: number) => void, signal: AbortSignal): Promise<number> // resolves HTTP status
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
}
export function createQueue(deps: UploadDeps, opts?: { concurrency?: number; pollMs?: number; pollMaxMs?: number }): {
  items: Readonly<QueueItem[]>          // reactive
  add(files: Iterable<File>): void
  retry(key: string): void
  dispose(): void                        // aborts everything
  onDone(cb: (p: OwnerPhoto) => void): void
}
```

- `rejected` (not retryable) covers a type outside ACCEPT (message: 「不支持此格式（仅 JPEG、PNG、WebP）」) and a file over MAX_BYTES (message: 「文件超过 60 MB」). `failed` is retryable and shows the server or network message.
- `sha256.ts`: `crypto.subtle.digest('SHA-256', await file.arrayBuffer())` → lowercase hex.
- The default `put` uses XMLHttpRequest with `upload.onprogress`. It sends exactly the given headers and treats any 2xx as success.
- Poll `get` every `pollMs` (2000) until the status is ready or failed, or `pollMaxMs` (120000) has passed. On timeout the state is `processing` and the message reads 「仍在处理，稍后刷新归档查看」, and it counts as done for the queue.
- UploadTray: a list of items with file name, state label, a progress bar (`<progress>`), and a 重试 button for failed items. A summary in `aria-live="polite"` reads e.g. 「3 张完成，1 张失败」. A 清除已完成 button. Attach `beforeunload` while any item is unfinished.
- Drop zone: on `dragenter`/`dragover` of files on the archive page, show an overlay 「松开以上传」. Drop → `add`.

- [ ] Tests (fake deps, fake timers): concurrency never exceeds 2; the duplicate path (create returns status 200 → `duplicate`, no put); the reject paths; a put failure followed by retry succeeding; the poll stops at ready, at failed, and at the timeout; dispose aborts the in-flight put and the sleep and leaves no pending timers; onDone fires once per finished photo; the sha256 hex output for a known input (`'abc'` → `ba7816bf…`); the tray summary text and that beforeunload is set and unset.
- [ ] Commit `feat(web): add uploads with hashing, direct PUT and processing status`.

---

### Task 7: My collections and owner badges on walls

**Files:**
- Create: `web/src/me/CollectionsRoute.vue`, test
- Modify: `web/src/walls/WallCard.vue` (badge), `WallCard.test.ts`

- CollectionsRoute: `getUser(session.user)` renders a list (not a wall). Each row shows the cover (Cover, aspect 1.5, width 120px), title, 「N 张」, and a status label: 草稿 when status is draft; otherwise 公开 / 仅链接 / 私密 by visibility. The row links to `/c/{id}?wall=user:{me}` with push state `{ fromWall: true, viewerDepth: 0 }` (reuse the WallCard click logic or extract `openCollection(router, id, wall)` into `walls/open.ts` and use it in both). A note line reads 「编排和发布在策展台中进行（即将推出）」. Empty: 「还没有合集」.
- WallCard: when `card.status === 'draft'` show the badge 草稿; else when visibility is `unlisted` show 仅链接, or `private` show 私密. The badge goes in the caption line, in `--fg-muted` with a 1px border. It is included in the aria-label. Public published cards show no badge, and neither do cards without these fields (visitors).
- [ ] Tests: labels for each combination; visitor card (no fields) has no badge; list ordering is preserved; the link carries the wall query and push state.
- [ ] Commit `feat(web): list my collections and mark non-public cards for the owner`.

---

### Task 8: Settings — upload prefs, profile, sign-out-all

**Files:**
- Create: `web/src/me/SettingsRoute.vue`, `PrefsForm.vue`, `ProfileForm.vue`, tests

- PrefsForm loads `getPrefs()`. A lead line reads 「修改只影响之后上传的照片。已上传的照片在合集中逐张调整。」
  - Public field checkboxes, in order with these labels: 机身 camera, 镜头 lens, 焦段 focal_length, 光圈 aperture, 快门 shutter, ISO iso, 曝光补偿 exposure_bias, 拍摄日期 taken_date.
  - Switches: 直方图默认公开, 原图下载默认开启.
  - Watermark: a 关闭 / 文字 radio. With 文字: a text input (≤ 64 characters), a position select (右下 br, 左下 bl, 右上 tr, 左上 tl, 居中 center), an opacity range 0.1–0.8 step 0.05 with a live value, and a size range 0.02–0.08 step 0.005.
  - 默认许可 select: 无 plus by, by-sa, by-nd, by-nc, by-nc-sa, by-nc-nd, labelled CC BY etc.
  - AI 声明: 无 / 未使用生成式 AI (`no-generative-ai`).
  - 位置信息: radio 不提取 off / 仅自己的归档可见 archive, plus the fixed note 「位置信息永远不会公开。」
  - A 保存 button stays disabled until something changes. On success it shows 「已保存」 (`role="status"`). On failure it shows the server message. While dirty, `onBeforeRouteLeave` asks via `confirm('有未保存的修改，确定离开？')` and `beforeunload` is set.
- ProfileForm fields: 名字 (required, ≤ 60), 简介 (≤ 200), 主页布局 (错列 salon / 均匀网格 grid). Profile values come from `getUser(session.user).profile`. Saving calls `putProfile` and, on success, removes `markr:wallCache:user:{me}` (try/catch).
- Bottom: a 登出 button, and 登出全部设备 behind ConfirmDialog → `logoutAll()` → `router.replace('/')`.
- [ ] Tests: prefs load and save round trip with the exact payload; dirty tracking and the leave guard; watermark null vs object; the location note is present and no "public" option exists; profile save clears the wall cache key; logout-all confirm flow.
- [ ] Commit `feat(web): add upload preferences, profile and sign-out-all`.

---

### Task 9: Acceptance — Playwright and bundle

**Files:** Modify `web/e2e/mock.ts`. Create `web/e2e/me.spec.ts`. Modify `web/scripts/check-bundle.mjs` only if needed.

- Mock state is per test and in memory:
  - `GET /api/auth/session` returns `{user, csrfToken, registrationOpen}`.
  - login, register, verify, logout and logout-all enforce `X-CSRF-Token` on writes and rotate the token on login and verify.
  - `GET /api/archive` supports paging plus at least the year and in_collection filters, and returns facets.
  - `POST /api/uploads` returns 201 with an upload URL on the mock origin (e.g. `/mock-s3/{id}`), or 200 for a hash already seen.
  - `PUT /mock-s3/*` accepts the body.
  - complete is supported, and `GET /api/photos/{id}` turns ready on the second poll.
  - `DELETE` is supported, `GET` and `PUT` `/api/upload-prefs` are supported, and so is `PUT /api/profile`.
  - `GET /api/u/{me}` returns cards with status and visibility only when the session user equals the owner.
- Tests:
  1. Visiting `/me` while logged out lands on `/login?next=%2Fme`. After logging in, the archive shows.
  2. Upload two files via `setInputFiles`, with one hash already in the mock. One reaches 已在归档中, the other goes processing → done and appears first in the grid. The tray summary is correct.
  3. Delete via keyboard: Tab to a tile, Enter opens the panel, Tab to 删除, Enter. The dialog has focus on 取消; Tab, then Enter confirms; the tile is gone and focus is on the next tile.
  4. Filters: choosing a year updates the URL and the grid. Back restores the previous filter.
  5. `/login#verify=tok` shows the set-password form and the hash is gone from `page.url()`. Submitting lands on `/me`.
  6. Register closed shows 「注册尚未开放。」.
  7. Settings: toggle a field, try to leave (dialog accept or dismiss path), save shows 已保存, and the request payload matches.
  8. Owner badge: as owner, `/u/{me}` shows a 草稿 badge. After logout, the same page has no badge, and `sessionStorage` has no `markr:wallCache:*` left from the owner session.
  9. No horizontal scroll on `/login`, `/me`, `/me/collections` or `/me/settings` at 360/390/768/1440.
  10. A `@touch` test on webkit-mobile: the archive panel opens as a bottom sheet and closes.
- Fail-first: break the cache clearing on logout, see test 8 go red, then restore. Break the guard and see test 1 go red, then restore. Record both in the report.
- `check:bundle` must still pass with both routes ≤ 80 KB. Confirm via the manifest that no `src/me/` chunk sits on either critical path.
- Commit `test: add account and archive acceptance across Chromium and WebKit`.

---

## Self-review notes

- Spec §2 → Task 1; §3 → Task 2; §4 → Task 4; §5 → Task 5; §6 → Task 6; §7 → Task 7; §8 → Task 8; §9 → Task 3; §10 → all; §11 → each task + Task 9.
- Task 7 depends on Task 1's owner card fields and Task 2's session. Task 5 depends on Task 2. Task 6 depends on Task 5's ArchiveRoute. Tasks 3 and 4 are independent of 5–8.
