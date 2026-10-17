# 子项目 3：展墙

日期：2026-10-17　上位文档：`2026-10-13-markr-redesign-design.md` §4、§7、§10；SP2 规格 §6.4。

## 1. 范围

交付三面墙和它们与观看器的往返：

| 路由 | 页面 | 数据 | wall 值 |
| --- | --- | --- | --- |
| `/` | 广场 | `GET /api/square`（游标分页） | `square` |
| `/u/:id` | 摄影师主页 | `GET /api/u/{id}` | `user:{id}` |
| `/a/:id` | 作品集 | `GET /api/albums/{id}` | `album:{id}` |

另含：一条细线导航、扫看、触屏张数小点、返回墙时恢复位置与焦点、`/tools` `/me` 占位页。

不在范围：策展台、归档、上传偏好 UI（SP4）；水印、拼图（SP5）；精选管理。

## 2. 后端改动（Go，`internal/api/read.go`）

1. `cardView` 增加 `previews: []mediaView`：组内按帧序（`f.position, fp.slot`）去重后的前 5 张照片的 media，不含不可用照片（与 cover 使用同一可用性规则）。所有返回卡片的接口（广场、主页、作品集、邻居条）都带上。为空时返回 `[]`，不返回 null。
2. 新 wall 值 `user:{userId}`。`readNeighbors` 接受 `user`（旧值）和 `user:{id}`；只要 id 等于当前合集作者就按作者主页解析，否则回退。返回的 `wall` 一律是 `user:{ownerId}`，不再返回裸 `user`。
3. 测试：`read_test.go` 覆盖 previews 的顺序、去重、上限 5、空合集；neighbors 的 `user`、`user:{owner}`、`user:{别人}` 三种输入都返回 `user:{owner}`。

## 3. 前端结构

```
web/src/api/      types.ts（Card.previews、SquarePage、UserWall、Album）、client.ts（getSquare/getUser/getAlbum）
web/src/walls/
  layout.ts       纯函数：卡片 → 错列栏位置；均匀网格
  wallCache.ts    sessionStorage 读写，30 分钟过期
  restore.ts      根据 lastViewed 找卡片、滚动、聚焦
  WallNav.vue     Markr · 工具 · 我的
  Wall.vue        渲染一组卡片（layout: 'salon' | 'grid'），接收 wall 值
  WallCard.vue    封面、扫看、触屏小点、一行文字
  Cover.vue       <picture> 封面，复用 viewer/media.ts 的 srcset
web/src/routes/   SquareRoute.vue、UserRoute.vue、AlbumRoute.vue、Placeholder.vue
```

`viewer/lastViewed.ts` 保持现状并被墙复用。墙代码不得被 `/c/:id` 关键路径静态引用（包体检查）。

## 4. 布局

### 4.1 错列多栏（salon，广场默认）

- 栏数：宽 < 600px 一栏，< 1100px 两栏，否则三栏。栏间距和行距取 `clamp(24px, 4vw, 64px)`，四周至少 16px 边距。
- 依次放入当前最短的一栏（masonry），保持大致的时间顺序。DOM 顺序就是输入顺序，Tab 顺序与之一致。
- 卡片宽度占栏宽的比例 w ∈ [0.70, 1.00]，由确定性哈希（合集 id 的 FNV-1a）决定基准值，再按封面比例和张数调整：竖图 −0.08，全景（宽高比 > 2）+0.10，张数 ≥ 12 时 +0.05，精选取 1.00，结果夹到区间内。剩余宽度决定水平偏移：靠左、居中或靠右，同样由哈希决定。单栏时 w 下限提高到 0.85。
- 高度由封面比例决定（无封面按 3:2）；全景封面的显示比例夹到最多 2.4:1（`object-fit: cover`）。
- 实现：`layout.ts` 只输出每张卡片的 `{ column, widthPct, align }`。栏用 flex 列，宽度用百分比，所以响应式不必重新测量；栏数随断点变化时（`matchMedia`）重新计算。

### 4.2 均匀网格（grid，主页可选）

CSS grid，`repeat(auto-fill, minmax(260px, 1fr))`，封面统一 4:5 `object-fit: cover`，手机两栏。

### 4.3 广场

精选（首页最多 6 组）排在最前面，略微放大（w = 1.00）。精选同时出现在最新列表中时，在最新里去重。底部哨兵 `IntersectionObserver`（rootMargin 800px）触发下一页；加载中显示一行「载入中」，失败显示「重试」按钮，没有下一页时什么都不显示。

### 4.4 主页 / 作品集

主页：顶部名字（标题字体）和一句简介，下面是合集墙（按 `wallLayout`），再下面如果有作品集，显示一行「作品集」小标题和均匀网格卡片（标题 · N 组），链到 `/a/:id`。无合集时显示「还没有公开的照片」。

作品集：标题、简介、作者（链到主页），下面是成员墙（salon）。404 显示与观看器同样措辞的错误页。

## 5. 卡片

- 封面下一行：标题 · 作者 · 「N 张」。作者名在主页墙上省略。墙上不显示参数。
- 整张卡片是一个 `<a href="/c/:id?wall=…">`，通过 `router.push` 进入，`state: { fromWall: true, viewerDepth: 0 }`。可访问名称为「标题，作者，N 张」。
- 扫看（`pointerType === 'mouse'` 且设备支持 hover）：指针在封面上横向移动时，把封面宽度均分成 `previews.length` 段，显示对应的预览图；离开时恢复封面。预览图使用 w480/w1280 档，首次进入卡片时才加载。键盘聚焦不触发扫看。
- 触屏（`(hover: none)`）：封面右下角显示 `min(count, 5)` 个 2px 小点，表示张数，`aria-hidden`。
- 封面懒加载（前 4 张 eager、`fetchpriority=high` 给第 1 张）。断图显示占位底色和标题，不留空洞。
- 视觉：`--bg-wall`，无卡片、无阴影、无悬停放大、圆角 0；焦点环使用 `--accent` 2px outline，偏移 4px。

## 6. 位置恢复

- 离开墙（路由离开前）：`wallCache.save(wall, { cards, featured, nextCursor, savedAt })`，键 `markr:wallCache:{wall}`。只有广场需要缓存分页；主页和作品集存整页响应，供即时渲染。
- 进入墙：有未过期缓存就先同步渲染缓存，然后后台请求第一页：广场只把缓存中没有的新卡片插在最前面，已有卡片不重排；主页和作品集用新数据整体替换（顺序由作者决定，替换不改变恢复目标）。
- 恢复：读 `markr:lastViewed:{wall}`，找到卡片后 `scrollIntoView({ block: 'center' })` 并 `focus({ preventScroll: true })`；减少动态效果下无平滑滚动（本来就不平滑）。找不到就保持顶部。恢复后清除 lastViewed，避免之后的普通访问也跳转。
- 浏览器自身的 `scrollRestoration` 设为 `manual`，由墙控制。

## 7. 观看器联动

- `CollectionRoute.onExit`：`fromWall` 时照旧 `router.go(-(depth+1))`；否则按当前 wall 导航：`square` → `/`，`user:{id}` → `/u/{id}`，`album:{id}` → `/a/{id}`，其他 → 作者主页。
- 结尾帧和菜单里的「作者主页」改用 RouterLink。
- `remember(wall, id)` 已使用服务器返回的 wall，`user:{id}` 自动生效。

## 8. 错误与边界

- 网络失败：墙显示「网络连接出了问题」和「重试」。缓存渲染时后台刷新失败不提示。
- 用户不存在：错误页「这位摄影师不存在」。
- 卡片没有封面：显示比例 3:2 的占位块和标题。
- sessionStorage 不可用：缓存和恢复静默失效，墙正常工作。

## 9. 测试

- 单元（vitest）：`layout.ts`（确定性、宽度区间、最短栏放置、断点栏数、精选 1.00）、`wallCache`（过期、损坏 JSON、存储抛错）、`restore`、扫看分段函数、三个路由的加载/错误/分页/去重/缓存插入、`onExit` 的路由映射。
- Go：§2.3。
- Playwright（chromium、webkit、webkit-mobile）：360/390/768/1440 宽度无横向滚动；广场滚到第二页 → 进入一组 → 返回，焦点在那张卡片上且它在视口内；主页同样的往返；键盘 Tab 到卡片 → Enter 进入 → Esc 返回并聚焦；扫看在桌面 chromium 上切换图片；触屏有小点无扫看；断图有占位；`prefers-reduced-motion`；慢网络（第二页延迟 2s）显示「载入中」。
- 包体：`/c/:id` 关键路径仍 ≤ 80 KB gz；另加 `/` 关键路径 ≤ 80 KB gz。

## 10. 决定记录

- 扫看数据：卡片带 `previews`（选项 A），一次响应拿全，代价是广场响应变大。
- 广场排法：错列多栏，键盘顺序与视觉顺序一致。
- 位置恢复：缓存已加载页 30 分钟 + 后台刷新第一页，只在前面插入新卡片。
- `user` 墙改为 `user:{id}`，修正 lastViewed 在不同作者主页之间串用的问题。
