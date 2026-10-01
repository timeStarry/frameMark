# Markr 独立预览部署与运维

## 当前实例

仅使用已有 SSH 身份连接 `timestarry@server`，没有读取、复制或输出私钥，未使用 root。服务器 Debian，用户级 systemd 可用，`Linger=yes`。部署前检查端口 18140 未占用；没有替换其他服务、修改原域名、反向代理、防火墙或安全设置。

| 项目 | 值 |
| --- | --- |
| 服务 | `systemctl --user status markr-phase1.service` |
| 服务根目录 | `/home/timestarry/deploy/markr-phase1` |
| 发布目录 | `releases/20261001-handoff` |
| 当前版本 | `current` 软链接指向发布目录 |
| 持久化目录 | `data`，权限 0700，数据库和媒体均在此 |
| 监听 | `127.0.0.1:18140`，仅服务器回环 |
| 健康 | `http://127.0.0.1:18140/api/health` |
| Mac 验证地址 | `http://127.0.0.1:18141/`，经 SSH 转发 |

Mac 转发命令：

```sh
ssh -N -L 18141:127.0.0.1:18140 timestarry@server
```

转发会话终止后 Mac 地址失效；服务器服务仍由 systemd 管理。此实例没有公开访问域名，身份入口关闭，不可创建真实账户或上传作品。

## 发布与回滚

在独立分支执行 `npm ci`、`npm run check`、`npm test` 和 `npm run build`。将代码、锁文件和 `dist` 传至新的发布目录，服务器执行 `npm ci --omit=dev`，保持 `data` 目录不变。首次部署的 unit 位于 `ops/markr-phase1.service`。后续发布使用新的目录名，不覆盖当前版本。

切换版本时将 `current` 指向新的完整发布目录，然后执行：

```sh
systemctl --user restart markr-phase1.service
curl -fsS http://127.0.0.1:18140/api/health
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
