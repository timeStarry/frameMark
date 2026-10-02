# Markr 邮箱账户与会话

## 本轮交付与生产边界

默认登录方式为邮箱＋密码。代码已实现注册邮件申请、邮箱验证后设置密码、登录、当前会话退出、全部会话撤销，以及用户与素材/作品/作品集/主页 owner 的联动。现网身份与注册继续关闭；实现完成不等于已开放生产账户。测试只使用临时数据库、一次性 fixture 与内存 outbox，没有创建生产账户或发送真实邮件。

## 用户流程

1. 在登录页选择创建账户，填写邮箱，申请验证邮件。响应统一，不暴露已注册邮箱；重复申请会替换旧链接。
2. 30 分钟内打开验证链接，在本站设置并确认密码。验证 token 放在 URL fragment，页面读取后立即从地址栏移除，不作为 HTTP 查询参数或自动提交。验证仅在明确提交表单时完成。
3. 后端原子消费 token 并创建已验证用户；随后轮换会话并进入工作台。链接过期、已使用或被新邮件替代均拒绝。
4. 后续以邮箱＋密码登录。错误消息统一为邮箱或密码不正确；失败可重试，重复点击不会并发提交。
5. 工作台可退出当前会话或所有会话；过期写入返回登录页。登录 returnTo 只接受已知站内路径，外部地址、未知路径和登录循环回落工作台。

邮箱使用 validator 检查，去首尾空白、NFC、大小写不敏感；国际域名统一为 ASCII IDN。不限定提供商；保留点号和加号别名，不使用 Gmail 等提供商特定合并规则。数据库唯一约束使用规范化邮箱；对大小写敏感的罕见邮箱，此处是明确产品约定。邮箱与密码哈希不出现在公开作品 API；公开作者标识仍是随机用户 ID。

## 存储与安全机制

沿用单体 Express、Node 22 内置 SQLite；新增 identity_users、identity_pending、identity_sessions、identity_rates。原 records/media 与 owner 不改写。未验证申请只存邮箱、随机 token 的 SHA-256 哈希和过期时间，不提前占用正式用户，也不存待验证密码。正式用户只存 scrypt 哈希、随机用户 ID 与创建时间。

密码至少 15 个 Unicode 字符、最多 256 UTF-8 字节；不截断、不强制字符类别、不做密码归一化。使用 Node 官方异步 scrypt（N=2^17、r=8、p=1、128 MiB 主工作区，maxmem=160 MiB）和每密码 16 字节随机盐；64 字节派生值使用 timingSafeEqual 比较。未知邮箱同样执行 scrypt，不自创认证密码学。哈希参数带版本；当前不提供密码修改、恢复、OAuth、MFA 或账号删除。

会话和邮件验证 token 使用 randomBytes(32)，不依赖浏览器随机 API。数据库只存会话 token 哈希；CSRF 使用服务器会话中的独立随机 token。正式会话默认绝对 7 天、空闲 24 小时；匿名 CSRF 会话 15 分钟。登录/验证轮换，旧会话失效；退出删除，全部退出按用户删除；过期记录按请求清理。重启不丢失会话撤销和限流状态。

生产 cookie 为 __Host-markr_session，Secure、HttpOnly、SameSite=Lax、Path=/，没有 Domain。所有 API 写入（含注册/验证/登录/退出、multipart 上传）先要求精确 Origin、非 cross-site Fetch Metadata 与同步 CSRF token，再解析或处理内容。不开放跨域 CORS，不接受身份请求头。客户端每次写入先读取当前 CSRF 会话；不自动重发不确定是否成功的写操作。

保守默认：登录/验证每 IP 10 次/15 分钟，登录每邮箱 10 次/15 分钟，邮件申请每 IP 5 次/15 分钟、每邮箱 3 次/15 分钟，匿名会话创建每 IP 60 次/15 分钟；数据库存哈希限流键并持久化。哈希与发送共同最多并发 2 项，满时 503。代码参数可配置用于测试或后续调优，当前生产入口使用上述默认。不信任任意 X-Forwarded-For；未来 HTTPS 代理若多个用户共用代理 IP，会共享 IP 限额，需按实际可信代理范围单独配置和验收，不能直接信任全部代理。

## 邮件接入

使用 Nodemailer SMTP；只允许 465/TLS 或 587/强制 STARTTLS，TLS 至少 1.2、校验证书；禁止文件/URL 内容源、关闭协议与凭据日志，连接/问候 10 秒、socket 20 秒超时。接口 sendVerification 可注入；隔离测试用内存 outbox。verifyConnection 只测试连接/认证，不发送邮件；真实收件人未确认前不做外发测试。

环境变量支持 SMTP_HOST、SMTP_PORT、SMTP_USER、SMTP_PASSWORD、SMTP_FROM。服务器也可通过 SMTP_CONFIG_FILE 引用已有专用 .env，SMTP_CONFIG_PREFIX=THREADMARK_ 映射现有 THREADMARK_SMTP_* 字段。解析采用 dotenv.parse，不注入全局环境、不执行 shell；文件必须普通文件、当前运行用户拥有、组/其他无权限，拒绝符号链接；只返回 SMTP 白名单字段，不输出密码。引用不会改变原服务或凭据。身份关闭时入口不会读取 SMTP 文件。

已只读定位 server 的 Threadmark 专用配置 `/home/timestarry/threadmark/.env.smtp`（0600、timestarry）和公开示例；没有读取 Docker 全部环境。早期 Docker 环境名称检查两次被自动审批拒绝，因为会先加载不相关秘密；后续采用专用文件引用作为更小范围方案，实际连接结果见验证文档。不得将此文件材料放入 Git、聊天或 Mac 工作区。

## 启用与回滚

IDENTITY_ENABLED 默认 false；REGISTRATION_OPEN 默认 false。启用需要 IDENTITY_ORIGIN 为精确 HTTPS origin（无路径、末尾斜杠或查询）。HTTP 仅隔离测试显式 testTransport 且 localhost/127.0.0.1 可用；生产入口不暴露该绕过选项。现有私网 HTTP:18140 不满足启用条件，不修改反代、TLS、证书或防火墙。

待用户明确确认 HTTPS 地址、启用范围和真实邮件收件人后，再配置独立服务私有环境与注册策略。复用现有 SMTP 已获授权，无需再次授权同一接入。公开注册与创建实际账户未授权，因此不能以 SMTP 连接成功代替启用审批。

迁移仅新增表与 user_version=1，身份关闭时不执行。启用前备份整个 SQLite/WAL 与媒体；旧发布会忽略新增表，回滚时切回旧 current 并关闭身份，保留账户数据，不 DROP 或重写记录。身份验证产生的 owner 是用户 ID；历史测试 owner 不自动认领。测试验证旧 records 在新版本与重新打开后保持不变。后续改 schema 时需版本迁移，不能直接套用首期建表方案。

## 依据与验证

- [Node 22 crypto 官方文档](https://nodejs.org/docs/latest-v22.x/api/crypto.html)
- [OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)：选择官方 scrypt 及建议工作因子。
- [OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[CSRF 防护](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)：服务器会话、cookie 属性、轮换与同步 token。
- [Nodemailer SMTP](https://nodemailer.com/smtp)、[validator](https://github.com/validatorjs/validator.js)、[dotenv](https://github.com/motdotla/dotenv)：使用公开库 API，不手写 SMTP 或 .env 密码解析。

自动测试区分真实 HTTP/SQLite/Sharp 权限闭环、Vue+Router+happy-dom 页面状态与真实浏览器。浏览器工具当前未暴露，因此 Mac 原生 cookie/邮件链接、真实下载和桌面/移动视觉均未验收。生产服务保持身份关闭，真实账户端到端未验收。
