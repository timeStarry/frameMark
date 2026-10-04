# Markr

摄影工具、作品与摄影师主页。当前平台首期在 `feat/markr-platform-phase1` 分支开发，PR 保持 draft；主分支的旧 GitHub Pages 站点未替换。

离线工具无需账户，在浏览器中处理照片，不会自动上传。平台使用 Vue 3、Node/Express 与 SQLite；草稿、素材、作品、作品集和主页真实持久化。现有私网预览启用了明确隔离的注册试验，正式域名与 HTTPS 迁移尚未进行。

## 文档

- [产品设计与实现范围](docs/phase1-design.md)
- [全站视觉与交互设计](docs/visual-interaction-redesign.md)
- [工具工作区规范](docs/tool-workspace-spec.md)及[渲染架构](docs/tool-engine-adr.md)
- [账户与会话设计](docs/account-session-design.md)
- [部署、回滚与运维](docs/phase1-operations.md)
- [验证记录与未测边界](docs/phase1-validation.md)

## 运行

需要 Node.js 22.13 或以上版本。

```sh
npm ci
npm run build
npm start
```

服务默认监听地址和配置见 `server/index.mjs` 与运维文档。身份功能默认关闭；不能通过请求头伪造账户。启用账户请遵循账户文档，不把私网 HTTP 试验配置用于正式公网服务。

开发时可在另一个终端运行 `npm run dev`。Vite 默认使用 3000 端口，`/api` 转发至本机 18140；工具自身不依赖 API，平台功能需要后端。

## 当前能力

**边框水印：** 纯色、渐变、模糊背景、底部条幅，文字与可选拍摄参数、系统字体、历史、预览缩放以及 PNG/JPEG/WebP 导出。

**图片拼图：** 网格、横排、竖排，最多 12 张素材，按钮排序与替换、逐图 cover/contain 及焦点、间距与背景、尺寸和比例锁定。两工具都保留原文件，支持取消任务、过期导出保护与精确数字/颜色输入。

**作品平台：** JPEG/PNG/WebP 素材上传、单图/组图/文字作品、草稿/发布、作品集、摄影师主页、公开广场和沉浸观看。公开展示与广场分发独立；私密、仅链接、公开三种可见性。仅链接不是安全访问控制。展示图经过优化和元数据移除，作者另行开启原文件下载。

**连续观看：** 支持时以同一照片连接列表与观看页；超时、减少动态效果及不支持时正常导航。当前照片解码后最多预载两张相邻展示图，之后进入观看页或切图重新检查权限；不预载原文件。实现与真实浏览器验收边界见视觉设计和验证记录。

**账户：** 邮箱验证、密码与会话、CSRF、退出及全部退出。私网试验与正式数据分开；不包含密码恢复、OAuth 或账号删除。

## 检查

```sh
npm run check
npm run typecheck
npm test
npm run build
```

`check` 是服务端语法检查，项目尚未配置独立 lint 命令。`typecheck` 严格检查 TypeScript 工具目录。测试包含临时 SQLite/HTTP 集成、真实 Sharp/Skia 图像处理及 Vue/happy-dom 组件流程；这些检查不替代用户 Mac 的真实浏览器、移动布局、文件下载和流畅度验收。

## 目录

```text
src/components/   导航、摄影与编辑共享组件
src/views/        广场、作品、主页、工作台、登录与工具入口
src/tools/        TypeScript 文档、任务、资源与 Canvas 工具
src/auth/         客户端账户与会话逻辑
server/           Express API、SQLite、身份与邮件适配
tests/            API、组件、渲染与资源生命周期测试
docs/             设计、验证与运维文档
ops/              独立预览服务配置
```

只将构建后的静态资源与生产依赖部署到独立服务。不要把媒体、SQLite、SMTP 凭据或会话信息提交到仓库。现有 GitHub Actions 在 feature/PR 执行检查，Pages 部署限 main，draft PR 不部署或合并主分支。
