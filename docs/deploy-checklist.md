# Markr 交付部署清单

分支 `feat/markr-platform-phase1`，HEAD `f05987b`，草稿 PR #4，CI 全绿。

---

## 一、构建

### Go 服务

```bash
cd /path/to/frameMark
CGO_ENABLED=1 go build -o markr ./cmd/markr
```

需要系统安装 libvips-dev + libheif-dev + libheif-plugin-aomenc（AVIF 编码）。CI 的 ubuntu 步骤可参考 `.github/workflows/platform-ci.yml`。

### 前端

```bash
cd web
npm ci
npm run build        # 产物在 internal/webui/dist/
```

前端构建嵌入 Go 二进制里（`internal/webui/webui.go` 用 `embed.FS` 读 `dist/`），所以 **先构建前端，再构建 Go**。

---

## 二、环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `MARKR_DATA_DIR` | ✅ | SQLite 数据库所在目录，需要可写 |
| `MARKR_ORIGIN` | ✅ | 站点的精确 origin，如 `https://markr.example.com`。必须 https（本地 http 仅在 `MARKR_DEV=1` 时允许） |
| `MARKR_LISTEN` | | 监听地址，默认 `127.0.0.1:18150` |
| `MARKR_S3_ENDPOINT` | ✅ | S3 兼容存储的端点 |
| `MARKR_S3_REGION` | | 区域 |
| `MARKR_S3_ACCESS_KEY` | ✅ | |
| `MARKR_S3_SECRET_KEY` | ✅ | |
| `MARKR_BUCKET_ORIGINALS` | ✅ | 原图桶 |
| `MARKR_BUCKET_DERIVED` | ✅ | 衍生图桶 |
| `MARKR_S3_PATH_STYLE` | | `true` 用路径风格寻址（MinIO、本地测试） |
| `MARKR_CDN_BASE` | | CDN 前缀，如 `https://cdn.markr.example`。空则所有媒体走 `/m/` 重定向 |
| `MARKR_IDENTITY_ENABLED` | | `true` 开启账户系统 |
| `MARKR_REGISTRATION_OPEN` | | `true` 允许注册 |
| `MARKR_SMTP_CONFIG_FILE` | | SMTP 配置文件路径（验证邮件）。不填则注册返回 503。生产环境**不要**设 `MARKR_DEV=1` |
| `MARKR_WORKERS` | | 后台处理线程数，默认 2 |
| `MARKR_UPLOAD_MAX_MB` | | 单文件上限，默认 60 |
| `MARKR_QUOTA_PHOTOS` | | 每人照片上限，默认 2000 |
| `MARKR_MAX_PIXELS` | | 原图像素上限，默认 60000000 |
| `MARKR_EO_SECRET_ID` | | EdgeOne / CDN 刷新凭据（可选） |
| `MARKR_EO_SECRET_KEY` | | |
| `MARKR_EO_ZONE_ID` | | |
| `MARKR_REPLICA_*` | | 异地备份桶（可选，格式同主桶） |

---

## 三、数据库迁移

```bash
./markr migrate
```

从空库自动应用 `0001_init.sql` → `0002_taken_offset.sql` → `0003_tool_output.sql`。已有数据时只跑未应用的迁移。迁移是前向的、不可逆的。**先备份再跑**。

---

## 四、存储桶

### 创建

两个桶：originals 和 derived。ACL 私有。

### CORS（originals 桶）

```json
[
  {
    "AllowedOrigins": ["<MARKR_ORIGIN>"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type", "x-amz-*"],
    "MaxAgeSeconds": 3000
  }
]
```

- `PUT`：作者从浏览器直传原图。
- `GET`：工具页从浏览器读取归档原图。
- `AllowedOrigins` 必须和 `MARKR_ORIGIN` 完全一致（协议、主机、端口）。

derived 桶不需要 CORS 规则。

### CDN（可选）

如果设了 `MARKR_CDN_BASE`，衍生图通过 CDN 访问（只有已发布的公开合集）。CDN 回源到 derived 桶。unpublish 或更改照片后，Go 服务会轮换衍生图前缀（`rotate_derived`），旧 URL 自动失效。

---

## 五、启动

```bash
./markr serve --role=all
```

- `--role=api`：只跑 HTTP 服务，不跑后台处理。
- `--role=worker`：只跑后台处理（衍生图生成、轮换、清理）。
- `--role=all`：两者都跑（单机部署用）。

用 systemd 示例：`ops/markr-phase1.service`。

---

## 六、SMTP（验证邮件）

配置文件路径写在 `MARKR_SMTP_CONFIG_FILE`。格式是一个 `.env`：

```
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=markr@example.com
SMTP_PASS=...
SMTP_FROM=Markr <markr@example.com>
```

没有 SMTP 时注册返回「验证邮件服务暂不可用。」。

⚠️ **不要在生产环境设 `MARKR_DEV=1`**。本地开发模式下如果没有 SMTP，验证链接会打到服务日志里；生产环境误开了会让能读日志的人接管任意邮箱。

---

## 七、Demo 种子（可选）

```bash
./markr seed-demo --manifest <file> --images <dir> --apply
```

不带 `--apply` 是只读模式，打印计划但不写入。种子数据在 `data/` 目录的清单文件里。

---

## 八、反向代理

在服务前面放 nginx / Caddy / 云负载均衡。要求：

- HTTPS 终止。
- 将所有路径转发到 `MARKR_LISTEN`。
- `X-Forwarded-For` 和 `X-Real-IP`（Go 服务读它做限速）。
- WebSocket 不需要。
- 上传上限至少 `MARKR_UPLOAD_MAX_MB`（默认 60 MB）。
- 不缓存 `/api/` 和 `/m/` 响应；静态资源（`/assets/`）可以长缓存（文件名带哈希）。

---

## 九、上线前检查

| # | 检查项 | 怎么验证 |
|---|---|---|
| 1 | 数据库迁移跑过且无报错 | `./markr migrate` 输出 |
| 2 | 存储桶 CORS 配置好 | 浏览器打开上传页，选一张图上传，DevTools Network 看到 PUT 请求成功 |
| 3 | SMTP 可达 | 注册一个测试邮箱，收到验证邮件 |
| 4 | `MARKR_DEV` **没有设** | `env | grep MARKR_DEV` 为空 |
| 5 | HTTPS 正常 | 浏览器访问 `MARKR_ORIGIN`，证书有效 |
| 6 | 首页加载 | 打开首页，能看到导航和空广场 |
| 7 | 注册 → 登录 → 上传 → 处理完成 | 照片出现在归档里，缩略图正常 |
| 8 | 策展台 → 加入照片 → 发布 | 广场或作者主页出现这组照片 |
| 9 | 观看器 → 键盘翻页 → 信息层 → 返回墙 | 焦点回到那张卡片 |
| 10 | 工具 → 加框 → 下载 | 下载的图没有 EXIF |
| 11 | 工具 → 从归档选 → 存入 | 归档出现成品，参数来自原片 |
| 12 | 登出 → 再访问作者主页 | 看不到草稿和私密合集 |
| 13 | CDN 回源（如果配了 CDN） | 已发布公开合集的图片走 CDN 域名 |
| 14 | 手机上打开首页、观看器、策展台 | 没有横向滚动，触控能用 |
| 15 | iOS Safari 底部上滑区 | 从底部上滑能打开信息层，不和 home 指示条冲突（需真机） |

---

## 十、已知待办

| 项 | 说明 | 优先级 |
|---|---|---|
| SP5 Playwright 验收 | 工具有单测，缺 e2e 浏览器覆盖 | 中 |
| SP1 终审 Minor M2–M5 | 账本里记着 | 低 |
| SP2 挂起 | M1/M5/M11/M12、邻组封面预取 N3 | 低 |
| SP3 各任务 deferred Minor | 账本里记着 | 低 |
| SP4a/4b deferred Minor | 见各自 progress.md | 低 |
| iOS 底部手势区冲突 | 需真机验证 | 上线前 |
| reprocess --all | 旧照片补时区偏移和来源 EXIF | 上线后 |
| 找回密码、删号 | 总设计标为不做 | 后续 |

---

## 十一、回滚

- 数据库迁移不可逆。如果必须回滚，恢复迁移前的数据库备份。
- Go 二进制回滚到旧版即可；前端嵌在二进制里，一起回滚。
- 存储桶里的照片不需要回滚。
