# 子项目 1：Go 底座与媒体管线

日期：2026-10-13　上位文档：[整体重构设计](2026-10-13-markr-redesign-design.md)（§6 隐私、§8 架构、§9 拆分）

## 1. 目标与边界

交付 `markr` Go 单二进制，提供后续子项目 2–4 需要的全部服务端能力：数据库结构、账户、上传、媒体管线、读取与权限、分发 URL，以及旧数据迁移。本子项目**不含**任何新界面。

**完成标准**
- 一个合成作者可以完成整条链路：注册 → 预签名直传 → worker 处理 → 读到 EXIF、直方图和多档衍生图 → 建合集和帧 → 发布 → 匿名读取 → 撤回 → 匿名读取被拒。
- 链路由 Go 集成测试自动跑通，存储用 MinIO，SMTP 和 EO 用 fake。
- 迁移脚本能把旧 `records` 测试库和 Demo 种子完整转入新库。

**不在本子项目**
- 前端：子项目 2 起重写。旧 Vue 前端和 Node 服务在本子项目期间保持原样，不并行改动。
- 正式切换、EO 真实接入、停机迁移：子项目 6。
- 水印模板编辑 UI：子项目 5。本子项目只实现「文字水印」变体生成。

## 2. 仓库布局

```
go.mod                      module github.com/timeStarry/frameMark
cmd/markr/main.go           子命令：serve（--role=api|worker|all）、migrate、import-legacy、seed-demo
internal/config             环境变量解析与校验，启动时一次性失败
internal/db                 SQLite 连接（WAL、foreign_keys、busy_timeout）、迁移执行器、嵌入的 *.sql
internal/identity           注册、验证、登录、会话、CSRF、限流
internal/mail               SMTP 适配；测试用内存 fake
internal/storage            S3 抽象：Put/Get/Delete/Presign；实现为 TOS（S3 兼容）与 MinIO，二者同一实现、不同配置
internal/cdn                Purge 接口；实现为 EO API 与 noop/fake
internal/media              libvips 管线：解码校验、EXIF、直方图、衍生、水印
internal/jobs               SQLite 队列：入队、领取、心跳、重试、死信
internal/domain             照片、合集、帧、作品集、主页的规则与权限判定（纯 Go，无 IO）
internal/api                HTTP 路由、JSON 编解码、错误映射、安全头
internal/legacy             旧 records 表读取与映射
migrations/                 0001_init.sql …
```

- 依赖库（版本在计划阶段锁定）：`modernc.org/sqlite`（纯 Go，免 CGO 的 SQLite）、`github.com/davidbyttow/govips/v2`（libvips 绑定，需要 CGO）、`github.com/aws/aws-sdk-go-v2/service/s3`、`golang.org/x/crypto/scrypt`。HTTP 用标准库 `net/http`（Go 1.22+ 路由），不引入 Web 框架。
- 系统依赖：libvips ≥ 8.15，需要带 AVIF 编码支持（libheif）。Mac 开发用 `brew install vips`，Debian 用 `apt install libvips-dev`，CI 在 ubuntu 上安装。

## 3. 配置

全部来自环境变量。启动时校验，有错误直接退出，日志不打印任何密钥。

| 变量 | 说明 |
| --- | --- |
| `MARKR_DATA_DIR` | SQLite 所在目录，权限 0700 |
| `MARKR_LISTEN` | 例如 `127.0.0.1:18150`。新端口，不占用旧服务的 18140 |
| `MARKR_ORIGIN` | 精确站点 origin。必须是 HTTPS；只有 `MARKR_DEV=1` 时允许 `http://localhost` 或 `127.0.0.1` |
| `MARKR_IDENTITY_ENABLED` / `MARKR_REGISTRATION_OPEN` | 默认关闭 |
| `MARKR_SMTP_CONFIG_FILE` | 与旧服务相同的安全读取规则（O_NOFOLLOW、属主本人、权限 0600）及相同字段 |
| `MARKR_S3_ENDPOINT` `_REGION` `_ACCESS_KEY` `_SECRET_KEY` | 主存储（火山 TOS） |
| `MARKR_BUCKET_ORIGINALS` / `MARKR_BUCKET_DERIVED` | 两个私有桶 |
| `MARKR_REPLICA_*` | 可选，自建 MinIO 副本；不配置则不复制 |
| `MARKR_CDN_BASE` | 例如 `https://img.markr.tsio.top`；为空时公开图也走预签名 |
| `MARKR_EO_*` | EO purge API 凭据；为空时使用 noop，并在日志中警告 |
| `MARKR_UPLOAD_MAX_MB`（默认 60）、`MARKR_MAX_PIXELS`（默认 100M）、`MARKR_QUOTA_PHOTOS`（默认 2000）、`MARKR_WORKERS`（默认 2） | 资源上限 |

私网 HTTP 试验模式**不移植**。新服务只接受 HTTPS origin，开发环境除外。旧试验仍由旧 Node 服务承载，直到子项目 6。

## 4. 数据库

单个 SQLite 文件，开启 WAL。迁移通过 `PRAGMA user_version` 记版本，每次迁移在一个事务内执行，只前进，不回退；回滚依靠子项目 6 的整库备份。所有 ID 都是 UUIDv7，可按时间排序，适合作为游标；旧数据迁移时保留原 UUID。时间统一存 Unix 毫秒。

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
       derived_hash NULL, title, caption,
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
  INDEX(state, run_after)
```

- `public_fields` 的取值为以下键的子集：`camera`、`lens`、`focal_length`、`aperture`、`shutter`、`iso`、`exposure_bias`、`taken_date`。
- 照片在某个合集中**实际公开的字段** = 照片快照 → 被 `photo_overrides` 覆盖后的结果。`domain` 包统一提供这个判定，API 层不得自行拼装。
- 位置信息：没有任何 API 序列化 `latitude`/`longitude`，作者自己的归档接口也不返回（地图视图后置）。测试会扫描所有响应，断言其中不出现这两个键。
- 许可只允许旧白名单里的 6 种 CC 4.0 代码，AI 声明只允许 `no-generative-ai`，与旧服务一致。

## 5. 账户

行为与旧 `server/identity.mjs` 一一对应，以便旧用户迁移后可以直接登录：

- 密码哈希格式沿用 `scrypt-v1$salt$hash`，参数 N=131072、r=8、p=1、64 字节；旧哈希原样导入即可校验。同时进行的哈希计算最多 2 个。
- 会话 cookie 为 `__Host-markr_session`，`HttpOnly`、`Secure`、`SameSite=Lax`。数据库只存 SHA-256 哈希，绝对有效期 7 天，空闲超时 24 小时。
- 所有写请求都检查：Origin 精确匹配、`Sec-Fetch-Site` 不是 `cross-site`、`X-CSRF-Token` 与会话值做常量时间比较。
- 限流规则（键名与次数）沿用旧实现，计数持久化。
- 接口：`GET /api/auth/session`、`POST /api/auth/register|verify|login|logout|logout-all`，请求和响应结构与旧服务保持一致。
- 未知邮箱登录时用一个固定的假哈希做校验，避免通过响应时间判断邮箱是否存在。注册接口无论邮箱是否已存在都返回同样的 202。

## 6. 上传与媒体管线

### 6.1 上传流程

1. `POST /api/uploads` `{filename, bytes, sha256, contentType}`
   - 前置校验：已登录；`contentType` 为 JPEG、PNG、WebP 之一；大小不超过上限；未超出配额。
   - 如果该作者已有相同 sha256 的照片，返回 `200 {photo}`，不再上传。
   - 否则创建 `photos(status=uploading)`，返回 `201 {photoId, putUrl, headers}`。`putUrl` 是预签名 PUT，有效期 15 分钟，绑定 `Content-Type` 和 `x-amz-checksum-sha256`。
2. 浏览器把文件直接 PUT 到 TOS 的 `o/{owner}/{photoId}`。
3. `POST /api/uploads/{photoId}/complete`
   - 服务端对对象执行 HEAD，确认大小和 checksum 与声明一致，不一致时状态置为 `failed`。
   - 一致则状态置为 `processing`，入队 `process_photo`，返回 `202`。
4. 客户端轮询 `GET /api/photos/{id}`，直到状态变为 `ready` 或 `failed`。SSE 推送放到后续再做。

超过 1 小时仍处于 `uploading` 的照片，由定时任务清理，连同对象一起删除。

### 6.2 `process_photo` 任务

1. 读取原图后用 libvips 加载，设置像素上限，只接受单帧；动画 WebP 和 APNG 一律拒绝。
2. 读取 EXIF 白名单字段，按 §4 写入 `photo_exif`。只有 `location_mode=archive` 时才解析 GPS 并写入 `photos.latitude`/`photos.longitude`，否则完全不读取 GPS IFD。
3. 按 EXIF 方向转正，从嵌入的 ICC 转换到 sRGB（没有 ICC 时按 sRGB 处理），记录转正后的宽高。
4. 直方图：在长边 512px 的缩略图上统计亮度（Rec.709 系数）和 R、G、B，各 64 档，保存到 `photo_histograms`。
5. 衍生图：档位为 `w480 / w1280 / w2400 / w3840`，只缩小、不放大，长边小于档位宽度时以原尺寸输出该档；格式为 AVIF（q50）、WebP（q80）、JPEG（q85，渐进式）。所有输出都去除元数据，只嵌入 sRGB 标记。
6. `derived_hash` = sha256(原图 sha256 + 管线版本 `MEDIA_PIPELINE_V1`)，取前 16 位。对象写到派生桶的 `d/{photoId}/{derived_hash}/{tier}.{ext}`，并设置 `Cache-Control: public, max-age=31536000, immutable`。
7. 如果上传偏好开启了水印，生成 `w2400` 规格的带水印 JPEG 变体，写到 `d/{photoId}/{derived_hash}-wm{watermark_hash}/w2400.jpg`。水印配置为 `{text, position: br|bl|tr|tl|center, opacity 0.1–0.8, scale 0.02–0.08}`，按文字高度相对于短边的比例计算大小，字体使用随二进制嵌入的一款开源无衬线字体（具体字体在计划中选定）。
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
- 管线版本升级时，用 `markr reprocess --all` 批量入队重新处理。

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
- 其他情况：返回同源地址 `/m/{photoId}/{hash}/{tier}.{ext}?c={collectionId}`。Go 每次收到请求都重新鉴权，然后 302 到有效期 5 分钟的预签名地址，响应带 `Cache-Control: private, no-store`。
- 所有 JSON API 响应都带 `Cache-Control: private, no-store`。

**撤回**：合集从公开改为其他状态、被删除，或者某张照片被移出合集时，对**不再属于任何公开合集**的照片执行以下步骤：

1. 入队 `rotate_derived`。
2. 用新的 `derived_hash` 盐值重新生成衍生对象，并删除旧对象。
3. 对旧的 URL 前缀调用 EO purge。

在这个过程完成之前，旧 CDN URL 可能还能访问几分钟，这一点在发布清单和撤回提示中写明。

## 8. 旧数据迁移

`markr import-legacy --from <旧 data 目录> [--apply]`。不带 `--apply` 时只做演练：打印映射统计和冲突，不做任何写入。

| 旧 | 新 |
| --- | --- |
| `identity_users` | `users`（哈希原样保留）；旧会话不迁移，用户需要重新登录 |
| asset | photo：上传 `.original` 到 TOS，随后入队 `process_photo`。EXIF 从原图重新提取，`public_fields` 使用默认偏好（只公开曝光三要素和焦段） |
| work（有图） | collection：每个素材对应一个 `full` 帧；如果有正文，作为第 1 帧，类型为 `text` |
| work（纯文字） | 只含一个 `text` 帧的合集 |
| collection | album：成员为由对应 work 迁移而来的合集 |
| profile | profile：`layout` 中的 grid 和 column 都映射为 `salon`；`accent`、`modules` 和封面不再使用 |
| `featuredRank`、`license`、`aiDeclaration`、`allowOriginal`、visibility、distribute、status | 对应字段原样迁移 |
| work 的 `attributions` | 按照片写入 `attributions` |

- 所有 ID 保持原值。导入可重复执行：已存在的 ID 跳过，最后打印「新增 / 跳过 / 失败」三项统计。
- `tags` 字段目前没有 UI，也没有数据，不迁移，只在报告中列出数量。

Demo：`markr seed-demo --manifest ops/demo/manifest.json [--apply]` 沿用现有清单格式和 sha256 校验，作者为不可登录的 `markr-demo` 用户（password 字段为不可能匹配的值）。

## 9. 测试

- **domain**：权限、公开字段合成、广场判定、作品集过滤，用表驱动测试覆盖全部组合。
- **identity**：迁移旧 Node 测试用例的语义，包括 CSRF、Origin、限流、令牌重放、并发验证、旧哈希兼容（用旧实现生成的固定向量）。
- **media**：用真实 libvips 处理一组仓库内的合成测试图，覆盖：方向 1–8、带 Display P3 ICC、带 GPS、带完整 EXIF、全景、16 位 PNG、动画 WebP（必须被拒）、超像素（必须被拒）。断言包括：
  - 衍生图中**没有任何 EXIF 或 GPS**；
  - 尺寸已转正；
  - 直方图总和正确；
  - `location_mode=off` 时数据库中没有位置。
- **storage**：用 `testcontainers` 或 CI service 启动的 MinIO 跑真实 S3 流程，包括预签名 PUT、checksum 不一致、HEAD、删除。
- **端到端**：§1 完成标准中的整条链路，使用 MinIO、fake SMTP 和 fake CDN，并断言撤回时调用了 purge、新的匿名请求返回 404。
- **隐私扫描**：一个辅助函数收集测试期间所有 JSON 响应，断言其中不出现 `latitude`、`longitude`、`gps` 等键，也不出现存储 key 前缀 `o/`。
- **迁移**：用旧 Node 测试生成的 fixture 库（含组图、纯文字作品、作品集、私密和仅链接内容）执行导入，检查数量、权限和字段与预期一致。
- **CI**：新增 Go job，内容为 `go vet`、`go test ./...`、安装 libvips、启动 MinIO service。原有 Node job 保留，直到子项目 2 删除旧前端为止。

## 10. 风险与取舍

- **libvips 的 CGO 依赖**：二进制需要动态链接 libvips，所以无法完全静态部署。替代方案是纯 Go 图像库，但它们缺少 AVIF 编码、ICC 转换和高效缩放，代价太大。服务器上安装 `libvips42` 即可。
- **SQLite 写锁**：worker 和 api 共用一个文件。所有写事务都保持很短，设置 `busy_timeout=5s`。图像处理在事务之外进行，事务只写结果。
- **撤回的残留窗口**：CDN 上已缓存的公开图无法立刻收回，按上位设计的约定，在产品中明确告知。
- **HEIC**：上位设计把 RAW/HEIC 列在范围外，本子项目不接受 HEIC 上传。AVIF 编码同样依赖 libheif，因此启动自检要求 libvips 具备 AVIF 编码能力，缺失时拒绝启动；以后开放 HEIC 只需放开类型白名单。
