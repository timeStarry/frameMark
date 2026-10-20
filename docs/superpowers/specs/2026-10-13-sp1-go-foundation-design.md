# 子项目 1：Go 底座与媒体管线

日期：2026-10-13（2026-10-15 按实施裁决修订，以本文为准）　上位文档：[整体重构设计](2026-10-13-markr-redesign-design.md)（§6 隐私、§8 架构、§9 拆分）

## 1. 目标与边界

交付 `markr` Go 单二进制，提供后续子项目 2–4 需要的全部服务端能力：数据库结构、账户、上传、媒体管线、读取与权限、分发 URL，以及 Demo 种子。旧系统从未上线，**不做任何数据迁移**，新库从空开始。本子项目**不含**任何新界面。

**完成标准**
- 一个合成作者可以完成整条链路：注册 → 预签名直传 → worker 处理 → 读到 EXIF、直方图和多档衍生图 → 建合集和帧 → 发布 → 匿名读取 → 撤回 → 匿名读取被拒。
- 链路由 Go 集成测试自动跑通，存储用 MinIO，SMTP 和 EO 用 fake。
- `seed-demo` 能把 Demo 清单写入空库，并通过同一条读取链路展示。

**不在本子项目**
- 前端：子项目 2 起重写。旧 Vue 前端和 Node 服务在本子项目期间保持原样，不并行改动。
- 正式上线、EO 真实接入：子项目 6。
- 水印模板编辑 UI：子项目 5。本子项目只实现「文字水印」变体生成。

## 2. 仓库布局

```
go.mod                      module github.com/timeStarry/frameMark
cmd/markr/main.go           子命令：serve（--role=api|worker|all）、migrate、seed-demo（`reprocess` 推迟到第一次管线版本升级时实现）
internal/config             环境变量解析与校验，启动时一次性失败
internal/db                 SQLite 连接（WAL、foreign_keys、busy_timeout）、迁移执行器、嵌入的 *.sql
internal/identity           注册、验证、登录、会话、CSRF、限流
internal/mail               SMTP 适配；测试用内存 fake
internal/storage            S3 抽象：Put/Get（带大小上限）/Head/Delete/DeletePrefix/List/Copy/PresignPut/PresignGet；实现为 TOS（S3 兼容）与 MinIO，二者同一实现、不同配置
internal/cdn                Purge 接口；实现为 EO API 与 noop/fake
internal/media              libvips 管线：解码校验、EXIF、直方图、衍生、水印
internal/jobs               SQLite 队列：入队、领取、心跳、重试、死信
internal/domain             照片、合集、帧、作品集、主页的规则与权限判定（纯 Go，无 IO）
internal/exposure           「照片是否仍被公开」的共享 SQL，api 撤回与 worker 轮换共用
internal/api                HTTP 路由、JSON 编解码、错误映射、安全头
internal/worker             任务处理：process/rotate/purge/delete/replicate/cleanup
internal/seed               Demo 种子导入
internal/e2e                MinIO + libvips + HTTP 端到端测试
internal/db/migrations/     0001_init.sql …（go:embed 要求放在包内）
```

- 依赖库（版本在计划阶段锁定）：`modernc.org/sqlite`（纯 Go，免 CGO 的 SQLite）、`github.com/davidbyttow/govips/v2`（libvips 绑定，需要 CGO）、`github.com/aws/aws-sdk-go-v2/service/s3`、`golang.org/x/crypto/scrypt`、`github.com/go-chi/chi/v5`（路由与中间件分组；只用路由、子路由和 `middleware.Recoverer/RequestID`，鉴权、CSRF、限流自己写成标准 `func(http.Handler) http.Handler`，可脱离 chi 单测）。
- 系统依赖：libvips ≥ 8.15，需要带 AVIF 编码支持（libheif）。Mac 开发用 `brew install vips`，Debian 用 `apt install libvips-dev`，CI 在 ubuntu 上安装。

## 3. 配置

全部来自环境变量。启动时校验，有错误直接退出，日志不打印任何密钥。

| 变量 | 说明 |
| --- | --- |
| `MARKR_DATA_DIR` | SQLite 所在目录，权限 0700 |
| `MARKR_LISTEN` | 例如 `127.0.0.1:18150`。新端口，不占用旧服务的 18140 |
| `MARKR_ORIGIN` | 精确站点 origin。必须是 HTTPS；只有 `MARKR_DEV=1` 时允许 `http://localhost` 或 `127.0.0.1` |
| `MARKR_DEV` | `1` 时允许 `http://localhost`/`127.0.0.1` origin，cookie 名为 `markr_dev_session` |
| `MARKR_IDENTITY_ENABLED` / `MARKR_REGISTRATION_OPEN` | 默认关闭；布尔值写 `true` |
| `MARKR_S3_PATH_STYLE` / `MARKR_REPLICA_PATH_STYLE` | 默认 `false`（TOS 用虚拟主机风格，MinIO 设 `true`） |
| `MARKR_SMTP_CONFIG_FILE` | dotenv 格式，字段 `SMTP_HOST/PORT/USER/PASSWORD/FROM`；以 O_NOFOLLOW 打开，必须是常规文件、属主为当前用户、权限无组和其他位 |
| `MARKR_S3_ENDPOINT` `_REGION` `_ACCESS_KEY` `_SECRET_KEY` | 主存储（火山 TOS） |
| `MARKR_BUCKET_ORIGINALS` / `MARKR_BUCKET_DERIVED` | 两个私有桶 |
| `MARKR_REPLICA_*` | 可选，自建 MinIO 副本；不配置则不复制 |
| `MARKR_CDN_BASE` | 例如 `https://img.markr.tsio.top`；为空时公开图也走预签名 |
| `MARKR_EO_*` | EO purge API 凭据；为空时使用 noop，并在日志中警告 |
| `MARKR_UPLOAD_MAX_MB`（默认 60）、`MARKR_MAX_PIXELS`（默认 60M，每个 worker 峰值内存约为解码尺寸的 2.5 倍）、`MARKR_QUOTA_PHOTOS`（默认 2000）、`MARKR_WORKERS`（默认 2） | 资源上限 |

私网 HTTP 试验模式**不移植**。新服务只接受 HTTPS origin，开发环境除外。

## 4. 数据库

单个 SQLite 文件，开启 WAL。迁移通过 `PRAGMA user_version` 记版本，每次迁移在一个事务内执行，只前进，不回退；回滚依靠整库备份（子项目 6 定义）。所有 ID 都是 UUIDv7，可按时间排序，适合作为游标。时间统一存 Unix 毫秒。

```sql
users(id PK, email UNIQUE NOT NULL, password NOT NULL, created_at)
sessions(hash PK, user_id NULL REFERENCES users, csrf, expires_at, touched_at)   -- user_id NULL = 匿名 CSRF 会话
pending_verifications(email PK, hash UNIQUE, expires_at)
rate_limits(key PK, count, expires_at)

profiles(user_id PK REFERENCES users, name, bio, wall_layout CHECK IN ('salon','grid') DEFAULT 'salon', updated_at)
upload_prefs(user_id PK REFERENCES users, public_fields JSON NOT NULL, histogram_public BOOL,
             original_download BOOL DEFAULT 0, watermark JSON NULL, default_license NULL,
             default_ai_declaration NULL, location_mode CHECK IN ('off','archive') DEFAULT 'off', updated_at)

photos(id PK, owner_id REFERENCES users, status CHECK IN ('uploading','processing','ready','failed'),
       original_key, original_sha256, original_bytes, format, width, height,       -- 转正后的尺寸
       derived_hash NULL, derived_salt TEXT NOT NULL DEFAULT '',
       title, caption,
       public_fields JSON NOT NULL, histogram_public BOOL, original_download BOOL, -- 入库时的偏好快照
       latitude NULL, longitude NULL,                                             -- 仅 location_mode=archive 时写入
       error NULL, created_at, updated_at)
  INDEX(owner_id, created_at)  UNIQUE(owner_id, original_sha256)                 -- 同作者重复上传直接返回已有照片
photo_exif(photo_id PK REFERENCES photos ON DELETE CASCADE,
           camera_make, camera_model, lens_model, focal_length_mm REAL, focal_length_35mm REAL,
           aperture REAL, exposure_time TEXT, exposure_seconds REAL, iso INT, exposure_bias REAL, taken_at INT)
  INDEX(camera_model), INDEX(lens_model), INDEX(focal_length_mm), INDEX(taken_at)
photo_histograms(photo_id PK, bins BLOB)                                         -- 4×64 个 uint16：亮度 R G B，按最大值归一到 0–65535

collections(id PK, owner_id, title, intro, status CHECK IN ('draft','published'),
            visibility CHECK IN ('private','unlisted','public'), distribute BOOL DEFAULT 1,
            original_download BOOL DEFAULT 0, license NULL, ai_declaration NULL,
            cover_photo_id NULL REFERENCES photos, featured_rank INT NULL,
            wall_rank INT NOT NULL,                                              -- 作者主页排序
            published_at NULL, created_at, updated_at)
frames(id PK, collection_id REFERENCES collections ON DELETE CASCADE, position INT,
       layout CHECK IN ('full','matted','pair','text'), matte_ratio REAL NULL,   -- matted 时画面占比 0.5–0.95
       text NULL, UNIQUE(collection_id, position))
frame_photos(frame_id REFERENCES frames ON DELETE CASCADE, slot INT, photo_id REFERENCES photos,
             PRIMARY KEY(frame_id, slot))                                        -- full/matted 1 张，pair 2–3 张，text 0 张
photo_overrides(collection_id, photo_id, public_fields JSON NULL, histogram_public BOOL NULL,
                PRIMARY KEY(collection_id, photo_id))                            -- 「在合集中修改」的覆盖
albums(id PK, owner_id, title, intro, visibility, created_at, updated_at)
album_items(album_id, position, collection_id, PRIMARY KEY(album_id, position))
attributions(photo_id PK, source JSON)                                           -- Demo 等第三方来源与许可

jobs(id PK, kind, payload JSON, state CHECK IN ('queued','running','done','dead'),
     attempts INT DEFAULT 0, run_after INT, lease_until INT NULL, last_error NULL, created_at)
  INDEX(state, run_after)  INDEX(state, lease_until)
-- 实施补充：jobs 另有 lease_token（领取时随机生成，Heartbeat/Done/Fail 均按 id+token 围栏）和 finished_at；
-- sessions/rate_limits/pending_verifications 有过期索引；所有子表对父表 ON DELETE CASCADE，
-- collections.cover_photo_id 为 ON DELETE SET NULL。以 internal/db/migrations/0001_init.sql 为准。
```

- `public_fields` 的取值为以下键的子集：`camera`、`lens`、`focal_length`、`aperture`、`shutter`、`iso`、`exposure_bias`、`taken_date`。
- 照片在某个合集中**实际公开的字段** = 照片快照 → 被 `photo_overrides` 覆盖后的结果。`domain` 包统一提供这个判定，API 层不得自行拼装。
- 位置信息：没有任何 API 序列化 `latitude`/`longitude`，作者自己的归档接口也不返回（地图视图后置）。测试会扫描所有响应，断言其中不出现这两个键。
- 许可只允许 6 种 CC 4.0 代码 `by`、`by-sa`、`by-nd`、`by-nc`、`by-nc-sa`、`by-nc-nd`；AI 声明只允许 `no-generative-ai`。

## 5. 账户

安全机制沿用旧 `server/identity.mjs` 已验证的设计，用 Go 重新实现：

- 密码哈希格式沿用 `scrypt-v1$salt$hash`，参数 N=131072、r=8、p=1、64 字节，salt 为 16 字节随机数的 hex。同时进行的哈希计算最多 2 个，超出返回 503。
- HTTPS 下会话 cookie 为 `__Host-markr_session`（`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`）。`MARKR_DEV=1` 时 cookie 名为 `markr_dev_session`，不设 `Secure`（localhost HTTP 无法使用 `__Host-` 前缀）。数据库只存 SHA-256 哈希，绝对有效期 7 天，空闲超时 24 小时。
- 所有写请求都检查：Origin 精确匹配、`Sec-Fetch-Site` 不是 `cross-site`、`X-CSRF-Token` 与会话值做常量时间比较。
- 限流：15 分钟窗口，计数持久化。`register-ip` 5、`register-email` 3、`verify-ip` 10、`auth-ip` 10、`account` 10、匿名会话 `bootstrap` 60。
- 接口：`GET /api/auth/session`、`POST /api/auth/register|verify|login|logout|logout-all`，密码长度 15 个字符到 256 字节；验证令牌 30 分钟有效、一次性。
- 未知邮箱登录时用一个固定的假哈希做校验，避免通过响应时间判断邮箱是否存在。注册接口无论邮箱是否已存在都返回同样的 202。

## 6. 上传与媒体管线

### 6.1 上传流程

1. `POST /api/uploads` `{filename, bytes, sha256, contentType}`
   - 前置校验：已登录；`contentType` 为 JPEG、PNG、WebP 之一；大小不超过上限；未超出配额。
   - 如果该作者已有相同 sha256 的照片，返回 `200` 和照片对象本身（不包一层），不再上传。
   - 否则创建 `photos(status=uploading)`，返回 `201 {photoId, upload: {url, method, headers}, expiresAt}`。`upload.url` 是预签名 PUT，有效期 15 分钟，绑定 `Content-Type` 和 `x-amz-checksum-sha256`。
2. 浏览器把文件直接 PUT 到 TOS 的 `o/{owner}/{photoId}`。
3. `POST /api/uploads/{photoId}/complete`
   - 服务端对对象执行 HEAD，确认大小和 checksum 与声明一致，不一致时状态置为 `failed`。
   - 一致则状态置为 `processing`，入队 `process_photo`，返回 `202`。
4. 客户端轮询 `GET /api/photos/{id}`，直到状态变为 `ready` 或 `failed`。SSE 推送放到后续再做。

`updated_at` 超过 1 小时仍处于 `uploading`、或超过 24 小时处于 `failed` 的照片，由每小时一次的 `cleanup_uploads` 清理，连同对象一起删除。年龄按 `updated_at` 判断，重新上传复用的行不会被误删。

### 6.2 `process_photo` 任务

1. 读取原图后用 libvips 加载，设置像素上限，只接受单帧；动画 WebP 和 APNG 一律拒绝。
2. 读取 EXIF 白名单字段，按 §4 写入 `photo_exif`。只有 `location_mode=archive` 时才解析 GPS 并写入 `photos.latitude`/`photos.longitude`，否则完全不读取 GPS IFD。
3. 按 EXIF 方向转正，从嵌入的 ICC 转换到 sRGB（没有 ICC 时按 sRGB 处理），记录转正后的宽高。
4. 直方图：在长边 512px 的缩略图上统计亮度（Rec.709 系数）和 R、G、B，各 64 档，保存到 `photo_histograms`。
5. 衍生图：档位为 `w480 / w1280 / w2400 / w3840`，只缩小、不放大，长边小于档位宽度时以原尺寸输出该档；格式为 AVIF（q50）、WebP（q80）、JPEG（q85，渐进式）。所有输出都是 sRGB 像素且不含任何元数据（包括 ICC），浏览器按 sRGB 解释。
6. `derived_hash` = sha256(原图 sha256 + 管线版本 `MEDIA_PIPELINE_V1` + `derived_salt`) 的十六进制前 16 位。新照片在创建时就获得随机 16 字节 hex 的 `derived_salt`，哈希无法由原图 sha 推算。轮换见 §7 撤回。对象写到派生桶的 `d/{photoId}/{derived_hash}/{tier}.{ext}`，并设置 `Cache-Control: public, max-age=31536000, immutable`。
7. 如果上传偏好开启了水印，生成 `w2400` 规格的带水印 JPEG 变体，写到 `d/{photoId}/{derived_hash}-wm{watermark_hash}/w2400.jpg`。水印配置为 `{text, position: br|bl|tr|tl|center, opacity 0.1–0.8, scale 0.02–0.08}`，按文字高度相对于短边的比例计算大小，字体使用系统 fontconfig 的 `sans` 族，不嵌入字体文件（字体选择留给子项目 5）；文字必须含可见字形，渲染失败时跳过水印变体、照片照常 ready。
8. 所有对象写入成功后，在一个事务里写入 EXIF、直方图、宽高和 `derived_hash`，并把状态置为 `ready`。
9. 如果配置了副本，再入队 `replicate_original`。

**失败处理**
- 解码错误、格式不支持、像素超限：属于永久失败，状态置为 `failed` 并记录 `error`（面向用户的中文文案），不重试。
- 存储或网络错误：最多重试 5 次，退避间隔 30s × 2^n，用完后标记为 `dead`，状态置为 `failed`。
- 每个任务都是幂等的：对象 key 是确定的，重新执行会覆盖写入。

### 6.3 队列

- worker 用 `UPDATE … RETURNING` 原子领取任务，同时设置 `lease_until = now + 2min`，处理期间每 30s 续租一次。
- 租约过期的任务会被其他 worker 重新领取。
- 并发数由 `MARKR_WORKERS` 控制，libvips 使用的线程和内存在启动时一并限制。
- 管线版本升级时的批量重处理命令（`markr reprocess --all`）推迟到第一次升级时实现。
- 同一张照片的 `rotate_derived` 与 `purge_derived` 串行：冲突时用 `jobs.Defer` 延后重试，不消耗重试次数。

## 7. 读取 API 与权限

所有判定都集中在 `domain` 包里，并有纯函数测试覆盖。

- **照片可读**：满足下列之一：
  - 读者是作者本人；
  - 照片属于某个对读者可读的合集。

  对照片来说，所属合集里只要有一个可读，它就可读；但**每次具体读取时，只按发起请求的那个合集的上下文**决定公开哪些字段。
- **合集可读**：读者是作者本人，或者合集已发布且可见性为 `unlisted` 或 `public`。
- **进入广场**：合集已发布，且可见性为 `public`，且 `distribute = 1`。
- **作品集**：每个成员单独按上面的规则过滤，作品集本身不提升任何成员的权限。

| 接口 | 说明 |
| --- | --- |
| `GET /api/square?cursor&limit≤48` | 广场合集，按 `published_at DESC, id DESC` 排序，游标为不透明字符串。精选单独放在 `featured` 字段里，按 `featured_rank` 排序 |
| `GET /api/u/{userId}` | 作者主页信息，以及该作者的公开合集（按 `wall_rank`）和公开作品集 |
| `GET /api/collections/{id}` | 合集详情，含帧序列。每张照片带 `media`、`exif`（已按公开字段过滤）、`histogram`（仅在公开时返回）、`attribution` |
| `GET /api/collections/{id}/neighbors?wall=square|user|album:{id}&cursor` | 指定墙上的相邻合集，用于观看器的横向切换和封面带。`wall` 不合法或不可读时，回退为 `user` |
| `GET /api/albums/{id}` | 作品集详情，成员已过滤 |
| `GET /api/archive?year&camera&lens&focal_min&focal_max&in_collection&status&cursor` | 作者本人的全部照片，以及可用于筛选的取值汇总 |
| `GET /api/photos/{id}` | 作者本人：完整信息（不含位置） |
| `GET /api/photos/{id}/original?collection={cid}` | 前提是该合集允许原图下载，或请求者是作者本人。返回 302 到 5 分钟有效的预签名 GET，带 `Content-Disposition: attachment` |
| `POST/PUT/DELETE` 合集、帧（整序列替换 `PUT /api/collections/{id}/frames`）、作品集、主页、上传偏好 | 只有作者本人可写。校验与旧服务相同：文本长度、引用必须属于本人、序列最多 200 帧 |
| `POST /api/collections/{id}/publish` | 返回或执行发布清单，见下 |

**发布清单**：`POST …/publish?dry_run=1` 返回本次发布将要公开的内容，包括张数、实际公开字段的并集、直方图、原图下载、可见性和是否进入广场。前端（子项目 4）展示给作者确认后，再不带 `dry_run` 调用一次，正式发布。

**媒体 URL**：API 返回的每张照片都带 `media: {width, height, tiers: {w480: {avif, webp, jpeg}, …}}`，URL 由服务端生成：

- 合集公开且已发布，并且配置了 `MARKR_CDN_BASE`：返回 `{CDN_BASE}/d/{photoId}/{hash}/{tier}.{ext}`，这是固定 URL。
- 其他情况：返回同源地址 `/m/{photoId}/{hash}/{tier}.{ext}?c={collectionId}`；作者归档视图没有合集上下文，用 `?c=`（空），只对作者本人有效。Go 每次收到请求都重新鉴权，然后 302 到有效期 5 分钟的预签名地址，响应带 `Cache-Control: private, no-store`。
- 所有 JSON API 响应都带 `Cache-Control: private, no-store`。

**撤回**：照片有两种暴露。CDN 暴露 = 在某个已发布的公开合集中；链接暴露 = 在某个已发布的公开或仅链接合集中（持有链接的人已经拿到过哈希）。任何写操作（改可见性、取消发布、删除合集、替换帧、删除照片）使照片离开其中任一集合时：

1. 同一事务内入队 `rotate_derived`。
2. worker 若发现照片仍在已发布的公开合集中则跳过；否则写入新的随机 `derived_salt`，重算 `derived_hash`，重写衍生对象，并在同一事务里入队 `purge_derived`。
3. `purge_derived` 运行时列出 `d/{photoId}/`，把所有不是当前哈希的前缀（含 `-wm` 变体）删除并调用 EO purge。

同源 `/m/` 只接受当前 `derived_hash`，旧哈希立即 404。

在这个过程完成之前，旧 CDN URL 可能还能访问几分钟，这一点在发布清单和撤回提示中写明。

## 8. Demo 种子

`markr seed-demo --manifest ops/demo/manifest.json [--apply]` 沿用现有清单格式和 sha256 校验，图片目录用必填的 `--images DIR` 给出（命令从不下载），作者为不可登录的 `markr-demo` 用户（password 字段为不可能匹配的值）。每张图片走与用户上传相同的 `process_photo` 管线，来源写入 `attributions`；每个清单里的 collection 成为一个合集，帧为满屏。可重复执行：照片、合集和作者都用基于清单 seed 的确定性 UUIDv5，同 id 同 sha 记为 unchanged，同 id 不同 sha 记为冲突并整体拒绝。

## 9. 测试

- **domain**：权限、公开字段合成、广场判定、作品集过滤，用表驱动测试覆盖全部组合。
- **identity**：CSRF、Origin、限流、令牌重放、并发验证、会话过期与空闲超时、logout-all。
- **media**：用真实 libvips 处理一组仓库内的合成测试图，覆盖：方向 1–8、带 Display P3 ICC、带 GPS、带完整 EXIF、全景、16 位 PNG、动画 WebP（必须被拒）、超像素（必须被拒）。断言包括：
  - 衍生图中**没有任何 EXIF 或 GPS**；
  - 尺寸已转正；
  - 直方图总和正确；
  - `location_mode=off` 时数据库中没有位置。
- **storage**：通过 `MARKR_TEST_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY` 指向本地或 CI 的 MinIO 跑真实 S3 流程（未设置时跳过），包括预签名 PUT、checksum 不一致、HEAD、删除。
- **端到端**：§1 完成标准中的整条链路，使用 MinIO、fake SMTP 和 fake CDN，并断言撤回时调用了 purge、新的匿名请求返回 404。
- **隐私扫描**：一个辅助函数收集测试期间所有 JSON 响应，断言其中不出现 `latitude`、`longitude`、`gps` 等键，也不出现存储 key 前缀 `o/`。
- **CI**：新增 Go job，内容为 `go vet`、`go test ./...`、安装 libvips、启动 MinIO service。原有 Node job 保留，直到子项目 2 删除旧前端为止。

## 10. 风险与取舍

- **libvips 的 CGO 依赖**：二进制需要动态链接 libvips，所以无法完全静态部署。替代方案是纯 Go 图像库，但它们缺少 AVIF 编码、ICC 转换和高效缩放，代价太大。服务器上安装 `libvips42` 即可。
- **SQLite 写锁**：worker 和 api 共用一个文件。所有写事务都保持很短，设置 `busy_timeout=5s`。图像处理在事务之外进行，事务只写结果。
- **撤回的残留窗口**：CDN 上已缓存的公开图无法立刻收回，按上位设计的约定，在产品中明确告知。
- **HEIC**：上位设计把 RAW/HEIC 列在范围外，本子项目不接受 HEIC 上传。AVIF 编码同样依赖 libheif，因此启动自检要求 libvips 具备 AVIF 编码能力，缺失时拒绝启动；以后开放 HEIC 只需放开类型白名单。

## 11. 上线前核对（子项目 6）

本地 MinIO 无法验证、需在火山 TOS 与腾讯云 EO 上实测的项目：

- 预签名 PUT 的 `x-amz-checksum-sha256` 是否被 TOS 真正校验，HEAD 是否回显 checksum（空值按未校验处理并拒绝）。
- `DeleteObjects` 在 TOS 上能否接受 SDK 默认的 CRC32 校验头；不行则用 `DeleteMode=single`。
- 跨桶 `Copy` 的 `ChecksumAlgorithm` 支持情况。
- EO 回源限制为白名单或签名回源，使未发布前缀无法经 CDN 取回。
- 若 `MARKR_S3_ENDPOINT` 是内网地址，补 `MARKR_S3_PUBLIC_ENDPOINT` 供浏览器使用的预签名 URL。

