# Markr 独立预览部署与运维

## 当前实例

仅使用已有 SSH 身份连接 `timestarry@server`，没有读取、复制或输出私钥，未使用 root。服务器 Debian，用户级 systemd 可用，`Linger=yes`。部署前检查端口 18140 未占用；没有替换其他服务、修改原域名、反向代理、防火墙或安全设置。

| 项目 | 值 |
| --- | --- |
| 服务 | `systemctl --user status markr-phase1.service` |
| 服务根目录 | `/home/timestarry/deploy/markr-phase1` |
| 发布目录 | `releases/20261001-tools-watermark` |
| 当前版本 | `current` 软链接指向发布目录 |
| 持久化目录 | `data`，权限 0700，数据库和媒体均在此 |
| 监听 | `100.99.0.5:18140`，仅已有 Tailscale 私有接口 |
| 健康 | `http://100.99.0.5:18140/api/health` |
| server 地址 | `http://100.99.0.5:18140/`，需要已有 Tailscale 通路；Mac curl 成功，Edge 客户端拦截尚未解除 |

旧 Mac 转发仅作为历史记录，不能当作最终 server 访问入口。改用 Tailscale 接口后若需诊断转发，其目标需同步为该接口：

```sh
ssh -N -L 18141:100.99.0.5:18140 timestarry@server
```

最终 server 地址不依赖 Mac 终端转发。需要设备接入用户现有 Tailscale 网络；没有修改防火墙、Tailscale ACL、公网代理或扩展权限。Mac Edge 实际访问被客户端拦截（ERR_BLOCKED_BY_CLIENT），尚不能声称浏览器入口已可用。原 `markr.tsio.top` 是旧 GitHub Pages 服务，未替换。身份入口关闭，不可创建真实账户或上传作品。

## 发布与回滚

在独立分支执行 `npm ci`、`npm run typecheck`、`npm run check`、`npm test` 和 `npm run build`。将代码、锁文件和 `dist` 传至新的发布目录，服务器执行 `npm ci --omit=dev`，保持 `data` 目录不变。首次部署的 unit 位于 `ops/markr-phase1.service`。后续发布使用新的目录名，不覆盖当前版本。

切换版本时将 `current` 指向新的完整发布目录，然后执行：

```sh
systemctl --user restart markr-phase1.service
curl -fsS http://100.99.0.5:18140/api/health
```

回滚时把 `current` 指回上一目录并重启。已保留前一预览目录 `releases/20261001-preview`，可切回并重启。需要撤销整个独立实例时，可执行 `systemctl --user disable --now markr-phase1.service` 撤销实例，保留发布目录和数据。当前只创建新 SQLite 表，没有接触现有业务数据库或执行破坏性迁移。

## 备份与容量

不要只复制运行中的 SQLite 主文件而漏掉 WAL。小实例可先停止此独立服务，备份整个 `data` 目录，再启动；恢复时同时恢复数据库与媒体。备份目录应受访问限制，因为原件可能含 GPS。当前没有自动备份、对象存储或磁盘告警。

```sh
systemctl --user stop markr-phase1.service
# 将整个 data 目录归档至访问受限的备份位置。
systemctl --user start markr-phase1.service
journalctl --user -u markr-phase1.service -n 100 --no-pager
```

部署前服务器磁盘剩余约 9.8 GB，不应沿用无限上传或长期备份假设。`MAX_UPLOAD_MB` 和 `MAX_ASSETS` 是临时可配置默认值；未来还需要全局容量与处理并发限制。

## 工具检查点发布

水印重构检查点发布目录为 `20261001-tools-watermark`；前版 `20261001-design-language` 保留，可回滚。拼图尚未迁移，浏览器验收未完成。SSH在授权环境下连接正常，普通沙箱内解析失败不能推断Mac断网。持久化目录和账号配置不变。
