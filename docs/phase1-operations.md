# Markr 独立预览部署与运维

## 当前实例

仅使用已有 SSH 身份连接 `timestarry@server`，没有读取、复制或输出私钥，未使用 root。服务器 Debian，用户级 systemd 可用，`Linger=yes`。部署前检查端口 18140 未占用；没有替换其他服务、修改原域名、反向代理、防火墙或安全设置。

| 项目 | 值 |
| --- | --- |
| 服务 | `systemctl --user status markr-phase1.service` |
| 服务根目录 | `/home/timestarry/deploy/markr-phase1` |
| 发布目录 | `releases/20261002-account-off` |
| 当前版本 | `current` 软链接指向发布目录 |
| 持久化目录 | `data`，权限 0700，数据库和媒体均在此 |
| 监听 | `100.99.0.5:18140`，仅已有 Tailscale 私有接口 |
| 健康 | `http://100.99.0.5:18140/api/health` |
| server 地址 | `http://100.99.0.5:18140/`，需要已有 Tailscale 通路；Mac curl 成功，最新用户截图确认已能打开；真实自动化UI验收未完成 |

旧 Mac 转发仅作为历史记录，不能当作最终 server 访问入口。改用 Tailscale 接口后若需诊断转发，其目标需同步为该接口：

```sh
ssh -N -L 18141:100.99.0.5:18140 timestarry@server
```

最终 server 地址不依赖 Mac 终端转发。需要设备接入用户现有 Tailscale 网络；没有修改防火墙、Tailscale ACL、公网代理或扩展权限。早期 Mac Edge 曾被客户端拦截（ERR_BLOCKED_BY_CLIENT）；最新用户截图确认已能打开 server 工具页。当前没有浏览器控制工具，交互自动化验收仍未完成。原 `markr.tsio.top` 是旧 GitHub Pages 服务，未替换。身份入口关闭，不可创建真实账户或上传作品。

## 发布与回滚

在独立分支执行 `npm ci`、`npm run typecheck`、`npm run check`、`npm test` 和 `npm run build`。将代码、锁文件和 `dist` 传至新的发布目录，服务器执行 `npm ci --omit=dev`，保持 `data` 目录不变。首次部署的 unit 位于 `ops/markr-phase1.service`。后续发布使用新的目录名，不覆盖当前版本。

切换版本时将 `current` 指向新的完整发布目录，然后执行：

```sh
systemctl --user restart markr-phase1.service
curl -fsS http://100.99.0.5:18140/api/health
```

回滚时把 `current` 指回上一目录并重启。已保留前一目录 `releases/20261001-tools-final`，可切回并重启；更早预览也未删除。需要撤销整个独立实例时，可执行 `systemctl --user disable --now markr-phase1.service` 撤销实例，保留发布目录和数据。当前只创建新 SQLite 表，没有接触现有业务数据库或执行破坏性迁移。

## 备份与容量

不要只复制运行中的 SQLite 主文件而漏掉 WAL。小实例可先停止此独立服务，备份整个 `data` 目录，再启动；恢复时同时恢复数据库与媒体。备份目录应受访问限制，因为原件可能含 GPS。当前没有自动备份、对象存储或磁盘告警。

```sh
systemctl --user stop markr-phase1.service
# 将整个 data 目录归档至访问受限的备份位置。
systemctl --user start markr-phase1.service
journalctl --user -u markr-phase1.service -n 100 --no-pager
```

部署前服务器磁盘剩余约 9.8 GB，不应沿用无限上传或长期备份假设。`MAX_UPLOAD_MB` 和 `MAX_ASSETS` 是临时可配置默认值；未来还需要全局容量与处理并发限制。

## 历史：水印检查点发布

水印重构检查点发布目录为 `20261001-tools-watermark`；前版 `20261001-design-language` 保留，可回滚。拼图尚未迁移，浏览器验收未完成。SSH在授权环境下连接正常，普通沙箱内解析失败不能推断Mac断网。持久化目录和账号配置不变。

## 两工具完整新实现发布

发布目录 `20261001-tools-final`，前版 `20261001-tools-watermark` 和 `20261001-design-language` 保留。运行服务、端口、持久化目录、身份关闭配置不变。Mac执行typecheck/check/test/build；CI新增vue-tsc。生产只装生产依赖，不装happy-dom、TypeScript或Skia测试运行时。服务器另执行平台/登录6项回归；工具像素和DOM测试在Mac/CI执行，不把server静态HTTP200称为交互验收。

最终应用代码基线为ce32d78；本次仅统一文档当前摘要/历史标识，不改变应用产物。current切向新的tools-final发布目录，前版tools-fixed可回滚。生产资源哈希已与Mac构建一致，35项Mac/CI测试与6项服务器回归分别验证，不混称浏览器验收。

## 邮箱账户代码部署（2026-10-02，身份关闭）

当前发布为 `20261002-account-off`，应用代码提交8047e10，完整文档提交以REVISION为准。新目录执行npm ci --omit=dev和15项隔离回归后切换current；旧tools-final完整保留。数据目录5156365/0700未变，生产身份表数0，没有账户迁移、真实账号或测试邮件。

新增用户级drop-in `~/.config/systemd/user/markr-phase1.service.d/30-identity-off.conf`，0600，显式IDENTITY_ENABLED=false、REGISTRATION_OPEN=false。SMTP_CONFIG_FILE引用同机Threadmark专用 `.env.smtp`，SMTP_CONFIG_PREFIX=THREADMARK_；原文件0600且timestarry拥有，原服务与凭据不改写。身份关闭时入口不会读取该文件；专用连接验证已成功，不发送邮件。详细流程/配置/安全条件见[账户方案](account-session-design.md)。

现有HTTP/Tailscale地址仍只提供身份关闭预览。开启身份要求精确HTTPS origin并需要用户确认启用范围；不以现有HTTP地址启用cookie认证、不擅自配置代理/TLS。真实验证邮件须确认收件人。SMTP复用已获授权且完成接入，不再重复要求同一接入授权。

回滚指向 `releases/20261001-tools-final` 并重启，drop-in保持身份关闭；旧版本不读取SMTP引用。未来开启身份后仅追加账户表，回滚时关闭身份并保留新表，不DROP；备份包含SQLite/WAL、媒体及受限配置引用，秘密不放入公开发布包。
