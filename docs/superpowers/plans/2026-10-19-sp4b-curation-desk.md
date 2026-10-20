# SP4b 策展台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authors create a collection, sequence photos from their archive into frames, set layouts and properties, autosave (with confirmation before widening exposure), and publish. Desktop is a three-column desk; phones get a simplified version.

**Architecture:** Go adds three things: a photo metadata write, optimistic concurrency (`ifUpdatedAt`/409) on the collection and frame writes, and an `exposure-check` dry run. It also prefills license and AI declaration on create and adds owner-only fields on the collection read. The frontend adds pure modules under `web/src/desk/`: sequence model, undo stack, save queue, local backup. On top of them sits the lazy route `/me/c/:id` with archive, sequence and side columns. The side column reuses the SP2 Viewer in `preview` mode.

**Tech Stack:** Go (chi, SQLite), Vue 3.5 + vue-router 4.6, TypeScript, vitest + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-19-sp4b-curation-desk-design.md` (parents: `2026-10-13-markr-redesign-design.md` §5–§7, §10; SP4a spec)

## Global Constraints

- No new npm or Go dependencies. Drag and drop uses the native HTML5 API, and every drag has a keyboard equivalent.
- Visual and a11y rules match SP4a: darkroom tokens, radius 0, `:focus-visible` outline `2px solid var(--accent)` with offset 4px, touch targets ≥ 44px, visible labels, `role="alert"` for errors and `role="status"` for save state. Workspace copy may say 「合集」.
- Show backend `{"error": "..."}` messages as-is.
- All storage access goes inside try/catch and fails silently. On identity change (`onIdentityChange` in `web/src/api/session.ts`), clear `localStorage` keys `markr:desk:*`.
- Bundle: `/` and `/c/:id` critical paths stay ≤ 80 KB gz. `web/src/desk/**` is never statically imported by wall, viewer or `/me` archive code.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Frontend verification: `cd web && npx vitest run && npx vue-tsc --noEmit && npm run build && npm run check:bundle`. Go verification: `go test ./internal/... ./cmd/... && go vet ./... && test -z "$(gofmt -l .)"`. Playwright: `NO_PROXY=127.0.0.1,localhost npx playwright test` (a local proxy runs on 127.0.0.1:7897).
- In a single worktree, implementers stage only their own files by explicit path and retry on index.lock.

## Review Focus

1. Exposure: on a published collection, no save that widens what visitors see (new photos, wider fields, histogram, original download, visibility, square) may reach the server without a confirmed exposure-check. "Undo this change" must restore the exact prior local state. (Tasks 2, 6, 8)
2. Concurrency: a 409 pauses every save queue. Neither 「载入最新版本」 nor 「用我的版本覆盖」 may lose or duplicate frames. A tab never conflicts with itself. (Tasks 2, 6, 8)
3. Owner-only read fields (`updatedAt`, per-photo `publicFields`/`histogramPublic`/override, owner media) never appear in a visitor's read. (Task 3)
4. Local backup is only offered when its `baseUpdatedAt` equals the server's `updatedAt`. It is cleared after a successful save and on identity change. (Task 6)
5. Keyboard parity: every operation in spec §4.2–§4.3 works without a mouse. (Tasks 7, 9)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `internal/api/photos.go` | `PUT /api/photos/{id}` title and caption |
| `internal/api/collections.go` | `ifUpdatedAt` + 409 on update and frames; `updatedAt` in responses; create prefill; `exposure-check` |
| `internal/api/exposure_check.go` | diff of current vs proposed exposure → `{widens, changes}` |
| `internal/api/read.go` | owner-only fields on `GET /api/collections/{id}` |
| `internal/api/server.go` | routes |
| `web/src/api/types.ts`, `web/src/api/desk.ts` | owner collection types; desk API calls |
| `web/src/desk/sequence.ts` | pure sequence model and operations |
| `web/src/desk/history.ts` | undo/redo stack |
| `web/src/desk/saveQueue.ts` | debounced, coalescing, serial write lanes with 409 pause |
| `web/src/desk/backup.ts` | localStorage backup |
| `web/src/desk/useDesk.ts` | composable that wires model + history + queues + exposure-check + conflict |
| `web/src/desk/DeskRoute.vue` | `/me/c/:id` layout, top bar, breakpoints |
| `web/src/desk/DeskArchive.vue` | left column / drawer |
| `web/src/desk/DeskSequence.vue`, `DeskFrame.vue` | middle column |
| `web/src/desk/DeskPreview.vue` | right column visitor view (Viewer preview) |
| `web/src/desk/PropsPanel.vue`, `PhotoProps.vue`, `FrameProps.vue`, `CollectionProps.vue` | property panel |
| `web/src/desk/ExposureDialog.vue`, `PublishDialog.vue`, `ConflictBanner.vue` | dialogs and banner |
| `web/src/desk/DeskMobile.vue` | <768px simplified desk |
| `web/src/me/CollectionsRoute.vue` | 新建合集 + 编排 links |
| `web/src/router.ts` | `/me/c/:id` route (child of `/me`, `requiresUser`) |
| `web/e2e/mock.ts`, `web/e2e/desk.spec.ts` | desk mocks and acceptance |

---

### Task 1: Backend — photo metadata, concurrency, prefill, owner read

**Files:** `internal/api/photos.go`, `collections.go`, `read.go`, `server.go`, and the tests beside them.

**Interfaces:**
- `PUT /api/photos/{id}` with body `{"title": string, "caption": string}`. Both are required (nil → `msgBadJSON`). title is cleaned to 0–120 runes, error 「标题不能超过 120 个字符。」. caption is 0–2000 runes with newlines kept, error 「图注不能超过 2000 个字符。」. Not found or not owned → 404 `msgPhotoAbsent`. Returns 200 with the owner `photoView`. Also bump `updated_at` on every collection that contains the photo.
- `collectionInput` gains `IfUpdatedAt *int64 \`json:"ifUpdatedAt"\``. The frames body changes from a bare array to `{"frames": frameInput[], "ifUpdatedAt"?: int64}`. Keep accepting a bare array for compatibility: decode into `json.RawMessage` and branch on the first non-space byte. A mismatch returns 409 with body `{"error":"这个合集在别处被修改过。","updatedAt":<current>}`. Write that body directly; `httperr.Fail` carries only a message, so add `httperr.FailWith(status, msg, extra map[string]any)` or the equivalent. The frames response becomes `{"frames": [...], "updatedAt": n}`. Read the current putFrames response before changing it, and update existing tests and frontend callers (grep `putFrames`/`/frames` in web/; today it is likely only the mock).
- Every write that changes a collection already sets `updated_at`; verify this for overrides, publish, unpublish, and photo delete pruning. Every collection-write response includes `updatedAt`.
- Create prefill: the INSERT sets `license` and `ai_declaration` from the `upload_prefs` row of the owner, or NULL.
- Owner read of `GET /api/collections/{id}` adds `updatedAt`. Each frame photo adds `publicFields []string`, `histogramPublic bool` (both effective, after the override), and `override {publicFields []string|null, histogramPublic bool|null} | null`. Media uses the owner `/m/…?c=` URL for photos that are ready even in a draft. The visitor read is byte-for-byte unchanged.

- [ ] Write the failing tests first. They cover:
  - metadata validation, the 404 for a non-owner, and that a public read reflects the new title;
  - ifUpdatedAt omitted, matching and stale, on both endpoints, with the 409 body shape;
  - the bare-array frames body still working;
  - prefill with and without prefs;
  - owner read fields present for the owner and the keys absent for anonymous and another user;
  - `updatedAt` advancing after an override.
- [ ] Implement, then run the Go verification.
- [ ] Commit `feat(api): photo metadata, collection concurrency, prefill and owner read`.

### Task 2: Backend — exposure-check

**Files:** create `internal/api/exposure_check.go` and `exposure_check_test.go`; modify `server.go`.

**Interface:** `POST /api/collections/{id}/exposure-check` with body `{"collection"?: collectionInput, "frames"?: frameInput[], "override"?: {"photoId": string, "publicFields": []string, "histogramPublic": bool|null}}`. It writes nothing and returns `{"widens": bool, "changes": [{"kind": string, "detail": string}]}`.
- kinds and detail copy:
  - `photos`: 「新增 N 张公开照片」
  - `fields`: 「公开<字段列表>」, using the field labels 机身/镜头/焦段/光圈/快门/ISO/曝光补偿/拍摄日期, joined with 与 for two items and 、 for more
  - `histogram`: 「公开直方图」
  - `original`: 「开放原图下载」
  - `visibility`: 「改为仅链接」 / 「改为公开」
  - `square`: 「进入广场」
- A draft always returns `widens:false, changes:[]`.
- Compute effective exposure for the current state and for the proposed state with the same functions the read path uses (`domain.EffectivePublicFields` etc.). Do not duplicate rules. Proposed frames are validated the same way as in putFrames, with the same 400 errors. Fields that are narrowing produce no change entry.

- [ ] Write the failing tests first. Cover each kind widening; narrowing gives no entries; a draft gives false; no change gives false; an invalid frames body gives 400 with the putFrames message; a non-owner gets 404; and a combined case lists entries in the order photos, fields, histogram, original, visibility, square.
- [ ] Implement, then run the Go verification.
- [ ] Commit `feat(api): add the exposure-check dry run for published collections`.

### Task 3: Frontend API and types

**Files:** `web/src/api/types.ts`, create `web/src/api/desk.ts` + test.

```ts
export interface OwnerFramePhoto extends PhotoView {
  publicFields: string[]; histogramPublic: boolean
  override: { publicFields: string[] | null; histogramPublic: boolean | null } | null
}
export interface OwnerFrame { layout: FrameLayout; matteRatio: number | null; text: string | null; photos: OwnerFramePhoto[] }
export interface OwnerCollection extends Omit<Collection, 'frames'> {
  status: 'draft' | 'published'; visibility: 'private' | 'unlisted' | 'public'; distribute: boolean
  updatedAt: number; coverPhotoId: string | null; frames: OwnerFrame[]
}
export interface CollectionFields {
  title: string; intro: string; visibility: 'private' | 'unlisted' | 'public'; distribute: boolean
  originalDownload: boolean; license: string | null; aiDeclaration: string | null; coverPhotoId: string | null
}
export interface FrameInput { layout: FrameLayout; matteRatio: number | null; text: string | null; photoIds: string[] }
export interface ExposureChange { kind: 'photos' | 'fields' | 'histogram' | 'original' | 'visibility' | 'square'; detail: string }
export interface Manifest { photos: number; publicFields: string[]; histogram: boolean; originalDownload: boolean; visibility: string; inSquare: boolean }

// desk.ts
export function getOwnerCollection(id, signal?): Promise<Result<OwnerCollection>>
export function createCollection(title: string): Promise<WriteResult<{ id: string; updatedAt: number }>>
export function putCollection(id, f: CollectionFields, ifUpdatedAt: number | null): Promise<WriteResult<{ updatedAt: number }> & { conflictAt?: number }>
export function putFrames(id, frames: FrameInput[], ifUpdatedAt: number | null): Promise<WriteResult<{ updatedAt: number }> & { conflictAt?: number }>
export function putOverride(id, photoId, o: { publicFields: string[]; histogramPublic: boolean | null }): Promise<WriteResult<{ updatedAt?: number }>>
export function putPhotoMeta(photoId, m: { title: string; caption: string }): Promise<WriteResult<OwnerPhoto>>
export function exposureCheck(id, body): Promise<WriteResult<{ widens: boolean; changes: ExposureChange[] }>>
export function publishDryRun(id): Promise<WriteResult<Manifest>>
export function publish(id): Promise<WriteResult<{ updatedAt?: number }>>
export function unpublish(id): Promise<WriteResult<{ updatedAt?: number }>>
export function deleteCollection(id): Promise<WriteResult<unknown>>
```

On a 409, `conflictAt` is set from the body's `updatedAt`. Extend `write.ts` so `send` returns the parsed error body (as an `extra` field) to callers, without breaking existing callers. Read the override, publish and delete response shapes from collections.go and match them; adjust the types if they differ, and note that in the report.

- [ ] Write tests first: URL encoding, body shapes, 409 → conflictAt, and 204 delete.
- [ ] Commit `feat(web): add the curation desk API`.

### Task 4: Sequence model and undo

**Files:** create `web/src/desk/sequence.ts`, `history.ts` + tests.

```ts
export interface DeskPhoto { id: string; title: string; media: Media | null; width: number | null; height: number | null }
export interface DeskFrame { key: string; layout: FrameLayout; matteRatio: number | null; text: string | null; photos: DeskPhoto[] }
export type Seq = readonly DeskFrame[]
export const MAX_FRAMES = 200
export function fromOwner(c: OwnerCollection): Seq                // keys are stable and generated
export function toInput(s: Seq): FrameInput[]
export function insertPhotos(s: Seq, at: number, photos: DeskPhoto[]): Seq   // one full frame each
export function insertText(s: Seq, at: number): Seq                // text frame, text '' (invalid until filled)
export function remove(s: Seq, index: number): Seq
export function move(s: Seq, from: number, to: number): Seq
export function setLayout(s: Seq, index: number, layout: FrameLayout): Seq   // full↔matted (matteRatio 0.8 default); pair only if 2–3 photos
export function setMatte(s: Seq, index: number, ratio: number): Seq          // clamped 0.5–0.95
export function setText(s: Seq, index: number, text: string): Seq
export function merge(s: Seq, from: number, into: number): Seq     // full photo into full/pair → pair (max 3); otherwise unchanged
export function split(s: Seq, index: number): Seq                  // pair → N full frames in place
export function allowedLayouts(f: DeskFrame): FrameLayout[]
export function isValid(s: Seq): { ok: true } | { ok: false; index: number; reason: string }  // empty text, >200 frames
export function photoIds(s: Seq): Set<string>
// history.ts
export function createHistory<T>(initial: T, max = 50): { current(): T; push(next: T): void; undo(): T | null; redo(): T | null; canUndo(): boolean; canRedo(): boolean; reset(v: T): void }
```

All functions are pure and never mutate their input. Out-of-range indices return the input unchanged. An invalid sequence (an empty text frame) is never sent to the server; the save queue holds it until it is valid.

- [ ] Write tests for every operation, including the edges: a merge into a pair of 3 is rejected, splitting a non-pair does nothing, a move to the same index, and the 200 limit. Test history cap, branching (a push after undo clears redo) and reset.
- [ ] Commit `feat(web): add the desk sequence model and undo history`.

### Task 5: Save queue and backup

**Files:** create `web/src/desk/saveQueue.ts`, `backup.ts` + tests.

```ts
export type LaneState = 'idle' | 'pending' | 'saving' | 'error' | 'paused'
export interface Lane<T> {
  schedule(value: T, opts?: { debounceMs?: number }): void   // keeps only the latest pending value
  flush(): Promise<void>                                     // send now; resolves once the latest value is saved or failed
  retry(): void
  pause(): void; resume(): void
  state: Readonly<Ref<LaneState>>; error: Readonly<Ref<string>>
  dispose(): void
}
export function createLane<T>(send: (v: T) => Promise<{ ok: true } | { ok: false; message: string; conflict?: boolean }>, onConflict: () => void): Lane<T>
// backup.ts
export interface Backup { baseUpdatedAt: number; savedAt: number; fields: CollectionFields; frames: FrameInput[] }
export function saveBackup(id: string, b: Backup): void
export function loadBackup(id: string): Backup | null
export function clearBackup(id: string): void
export function clearAllBackups(): void        // all markr:desk:* keys
```

- A lane sends serially. While one send is in flight, new values coalesce into a single next send.
- A conflict sets the lane to `paused` and calls onConflict once.
- An error keeps the value for `retry()`.
- `dispose` cancels timers.
- `backup.ts` registers `clearAllBackups` with `onIdentityChange` at module load.

- [ ] Tests (fake timers): debounce and coalescing; serial order; at most one in flight; error then retry; conflict pauses and onConflict fires once; resume sends the latest value; dispose leaves no timers; backup round-trip, corrupt JSON, a throwing storage, clearAll leaving other keys, and clearing on identity change.
- [ ] Commit `feat(web): add desk save lanes and local backup`.

### Task 6: useDesk composable

**Files:** create `web/src/desk/useDesk.ts` + test.

`useDesk(id: Ref<string>)` returns reactive `{ state: 'loading'|'error'|'ready'|'missing', collection, fields, seq, selected, saveState: 'saved'|'saving'|'unsaved'|'error'|'conflict', errorMessage, exposure: { open, changes, confirm(), cancel() } | null, conflict: { reload(), overwrite() } | null, backupOffer: { restore(), discard() } | null }` and actions:
- `applySeq(next, kind: 'structure')`
- `applyFields(next, kind: 'field'|'exposure')`
- `setPhotoMeta(photoId, m)`
- `setOverride(photoId, o)`
- `undo()`, `redo()`
- `publish()` → manifest, plus `confirmPublish()`
- `unpublish()`
- `remove()`

Rules:
- Three lanes: fields (debounce 800ms for text fields, 0ms for toggles and selects), frames (0ms), and photo metadata/override (800ms for text, keyed per photo).
- When the collection is published and an edit could widen exposure (any frames change; visibility, distribute or originalDownload; any override), run `exposureCheck` first. If `widens`, show `exposure`:
  - confirm → schedule
  - cancel → restore the exact previous local state (history undo for structure; previous fields otherwise)
  - If not widening → schedule.
- Each successful save updates `collection.updatedAt`, and every lane uses the latest value as `ifUpdatedAt`.
- A conflict from any lane pauses all lanes and sets `conflict`:
  - reload → refetch and reset history
  - overwrite → resend the current local fields and frames with `ifUpdatedAt=null` through the exposure check
- Back up to localStorage on every unsaved change; clear the backup when all lanes are idle.
- On load, if `loadBackup(id)?.baseUpdatedAt === collection.updatedAt` and its content differs, set `backupOffer`.

- [ ] Tests mock desk.ts and drive scenarios:
  - an edit to a draft never calls exposureCheck
  - a published add photo that widens: confirm path and cancel path, where cancel restores the exact sequence
  - a narrowing change saves without a dialog
  - 409 pauses lanes; reload and overwrite
  - the backup offer appears only on a baseUpdatedAt match
  - undo then save
  - no self-conflict when two lanes save back to back
- [ ] Commit `feat(web): wire the desk model, saving, exposure checks and conflicts`.

### Task 7: Desk UI — route, columns, keyboard

**Files:** create `DeskRoute.vue`, `DeskArchive.vue`, `DeskSequence.vue`, `DeskFrame.vue`, `DeskPreview.vue` + tests. Modify `web/src/router.ts` to add `/me/c/:id`, named `desk`, as a child of `/me`, with `requiresUser` and props. Modify `web/src/me/CollectionsRoute.vue`.

- Layout and breakpoints per spec §4.1. In the top bar the save state uses `role="status"`.
- Archive column: reuse `getArchive` and ArchiveFilters from `web/src/me/` (props-driven; filters stay local, not in the URL). Only ready photos are shown. Photos already in the sequence are dimmed with 「已在序列」. Multi-select works with Shift/⌘ click and with Space. Enter, or the 加入 button, appends. Each tile is draggable with `dataTransfer` type `application/x-markr-photo`.
- Sequence: `role="list"`. Items are focusable, with aria-label 「第 N 帧，<版式>，<标题>」.
  - `⌥↑`/`⌥↓` moves a frame, `Delete`/`Backspace` removes it, and Enter selects it.
  - Drop targets sit between frames (insert) and on frames (merge).
  - A 「＋」 menu between frames offers 文字页 and 从归档添加 (focuses the archive column).
  - Moves are announced via `aria-live`.
  - Delete shows an 8s undo toast.
- Preview: renders `Viewer` with `mode="preview"`, `neighbors=null`, `initialFrame=<selected or 1>` at 390×844 scaled to fit. The collection is built from local state with only the effective public fields (exif filtered by `publicFields`, histogram only if `histogramPublic`). Label it 「访客视角」. No URL writes and no lastViewed: confirm Viewer preview mode does neither, and guard it if it does.
- Undo/redo shortcuts work everywhere except inside text inputs.
- CollectionsRoute gets 新建合集 (a dialog with just the title) → `createCollection` → `router.push('/me/c/{id}')`. Each row gets an 「编排」 link.
- A one-line shortcut legend sits under the sequence.
- [ ] Tests: keyboard operations, drag/drop via synthetic DragEvent with a DataTransfer stub, aria labels, preview receiving filtered fields, new-collection flow, and route registration.
- [ ] Commit `feat(web): add the curation desk with archive, sequence and preview`.

### Task 8: Properties, dialogs, publish, conflict

**Files:** create `PropsPanel.vue`, `PhotoProps.vue`, `FrameProps.vue`, `CollectionProps.vue`, `ExposureDialog.vue`, `PublishDialog.vue`, `ConflictBanner.vue` + tests. Wire them into DeskRoute.

- Per spec §4.4, §4.8 and §6.
  - Photo props: title/caption (setPhotoMeta), eight field toggles showing the effective value, 恢复默认 to clear the override, and a histogram toggle.
  - Frame props: layout radios with disallowed options disabled, the matte slider with a live `<output>`, the text textarea with a counter, and 拆成单张 for pairs.
  - Collection props: title, intro, cover select (ready photos in the sequence), visibility radios with the unlisted note, distribute, license select, AI declaration, original download, and 删除合集 (type the title to confirm).
- ExposureDialog lists the `changes` with 确认并保存 / 撤销这次修改, built on `web/src/me/ConfirmDialog.vue`. PublishDialog shows the manifest lines, including 未设置许可 and 未声明 AI 使用 when those are null.
  - Example manifest: 「12 张 · 公开机身与焦段 · 原图下载关闭 · 仅链接 · 不进广场 · 许可 CC BY · 未使用生成式 AI」.
  - Unpublish confirm: 「撤回后访客将看不到这组照片，链接会失效」.
- ConflictBanner: 「这个合集在别处被修改过」 with 载入最新版本 / 用我的版本覆盖.
- A banner reads 「修改会立即对访客生效」 whenever the collection is published.
- Leave guards: beforeunload and onBeforeRouteLeave while saveState is not `saved`.
- Esc closes the panel and returns focus to the frame.
- [ ] Tests: each control maps to the right action; the dialogs' copy and focus; the leave guard; delete requiring the title.
- [ ] Commit `feat(web): add desk properties, publish and conflict handling`.

### Task 9: Mobile simplified desk

**Files:** create `DeskMobile.vue` + test. DeskRoute switches to it under 768px via `matchMedia`, reacting to changes.

- One column. Each frame row has 上移/下移/删除 buttons (≥ 44px), the layout select, and a title field for the first photo. Collection title, 发布/撤回, and the save state are always available.
- Show the note 「在电脑上添加和编排照片」. No archive and no drag.
- The property panel opens as a bottom sheet.
- [ ] Tests: the operations call the same useDesk actions, no archive is rendered, and switching breakpoints keeps state.
- [ ] Commit `feat(web): add the simplified desk for phones`.

### Task 10: Acceptance

**Files:** `web/e2e/mock.ts` (stateful desk endpoints matching Tasks 1–2, including 409 and exposure-check), create `web/e2e/desk.spec.ts`.

- Cover every scenario in spec §7 Playwright list across chromium, webkit and webkit-mobile (@touch for the phone scenarios).
- Use a second `page` in the same context for the two-tab conflict.
- Drag and drop: use `locator.dragTo` on chromium. On webkit, if native DnD isn't driveable, cover the same flow with the keyboard there and list webkit DnD as untested.
- Fail-first, recorded in the report:
  - Bypass the exposure check for published collections → the widen test goes red.
  - Drop the 409 pause → the conflict test goes red.
  - Skip clearing the backup on success → the restore-offer test goes red.
- Run `npx playwright test e2e/desk.spec.ts --repeat-each 3`; there must be no flakes.
- [ ] Commit `test: add curation desk acceptance across Chromium and WebKit`.

## Self-review notes

- Spec §3 → Tasks 1–2; §4.1–4.3 → Task 7; §4.4, §4.8, §6 → Task 8; §4.5–4.6 → Tasks 4–6; §4.7 → Task 9; §4.9 → Task 7; §5 → Tasks 7–9; §7 → each task + Task 10.
- Dependencies: Task 2 needs Task 1's validation and response shapes; Task 3 needs 1–2; Tasks 4 and 5 are independent; Task 6 needs 3–5; Tasks 7–9 need 6; Task 10 needs all.
