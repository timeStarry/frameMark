# ADR：本地图像工具重构

2026-10-01，设计已选定，待实现与浏览器验证。仅改两大工具及必要工程配置，不迁移平台后端/认证/数据。

## 选型

1. 保留Vue3/Vite，工具使用script setup lang=ts与严格TypeScript。增加vue-tsc noEmit检查；既有平台JS暂不迁移，通过allowJs边界导入。Vite只转译，不能代替类型检查。相比全站React重写，复用现有路由/设计变量并缩小回归范围；相比继续动态JS，类型化文档、任务消息和几何结果更易校验。
2. Canvas2D确定性渲染，不引入Fabric/Konva/WebGL。需求是照片合成和文字而非自由矢量编辑，直接Canvas足够且依赖较小。引擎只接收DocumentSnapshot+资源+目标尺寸；布局纯函数产生逻辑坐标，预览和导出用同一绘制函数，比例缩放字号、模糊与圆角。浏览器色彩转换和字体栅格化仍可能跨设备不同，不承诺专业色彩管理或像素完全一致。
3. Vue composable管理每路由独立编辑session，不加全局Pinia。Document为可序列化设置+素材id引用，AssetRepository拥有File/URL/位图，UI拥有zoom/selection，JobController拥有任务id与Abort状态。资源不进深度响应式或历史；命令式commit支持滑块事务，50步有界历史。
4. 首先实现共享主线程Canvas基线（串行解码、预览降采样、让出事件循环）；Worker/OffscreenCanvas能力路径按需加入。不能为了显示“取消”就假装主线程编码可中断。Worker作为优化阶段，只有在消息契约与字体加载一致、完整路径能力测试通过后启用；不强制浏览器支持，不替换平台配置或要求隔离安全头。若性能测试证明基线阻塞严重，必须在交付前加Worker而非忽略问题。
5. createImageBitmap(File,{imageOrientation:'from-image',resizeQuality:'high'})优先，必要时本地objectURL+HTMLImageElement.decode回退；不二次手动旋转，使用解码后真实尺寸。每种路径通过EXIF1–8 fixture验证。预览长边<=1600，导出串行加载到目标需要的分辨率；不长期缓存所有原尺寸位图。缓存预算有界，淘汰close，URL删除/路由卸载revoke；取消不能遗留迟到bitmap。初次生成缩略后释放临时大位图。
6. 保留exifr但按字段白名单读取（不能spread全部元数据）；Canvas重新编码不复制源EXIF，绘制的参数文本仅用户选定字段。源File不变、不上传、不写回。移除file-saver并用共享Blob下载函数（点击后延迟回收URL且卸载兜底），移除远程字体管理。删除旧实现前全仓引用审计，保留第三方许可证。

## 模块职责

src/tools/core：typed document/assets/history/jobs/limits/geometry；src/tools/engine：decode/render/encode与资源清理；src/tools/components：ToolWorkspace、AssetList、CanvasViewport、InspectorGroup、NumberControl、ExportPanel、TaskStatus；src/tools/watermark与collage：默认文档/布局/属性表单/预设；新路由直接指向新工具，无旧实现兼容壳。公共组件通过props+events或明确session接口沟通；不读后端store，不依赖login guard。

## 官方依据与兼容性（2026-10-01查阅）

- [Vue TypeScript](https://vuejs.org/guide/typescript/overview.html)：推荐vue-tsc进行SFC类型检查，构建转译与检查分开。
- [TypeScript allowJs](https://www.typescriptlang.org/tsconfig/allowJs.html)：支持局部工具迁移，不要求旧平台一并重写。
- [createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)：EXIF方向from-image为默认；支持缩放选项，但部分选项兼容性有差异，需fixture和能力回退。
- [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)：可以在Worker绘图，整体功能跨浏览器普遍可用不表示所有组合能力一致。
- [convertToBlob](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob)：异步返回Blob，编码无细粒度进度；Worker环境可用。
- [Canvas toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)：不支持请求类型会退回PNG，回调可能null；需检查Blob真实类型并提示。
- [ImageBitmap close](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap/close)：主动释放位图图形资源，不能只移除JS引用。

这些资料支持架构选择，不能作为本机浏览器功能已测的证据。本期按运行时能力探测及真实测试结果公布支持情况。

## 风险与实施门槛

Canvas输出大小受浏览器/设备约束，16MP/8192和256MiB预算只是保守产品配置，不是硬件保证；超大图必须在头部尺寸预检后拒绝，未知尺寸解码可能占额外内存。字体只采用系统通用族，文字测量须在绘制前完成；不宣称字体无版权风险。Canvas色域/ICC转换受浏览器实现影响。Worker无法直接复用DOM和未经加载的字体，故能力路径必须独立验证。通过纯函数/生命周期单元测试后仍需要本机浏览器文件导出验收；不足明确记录。

## 当前实施状态

本设计commit只新增两份Markdown，没有安装依赖、修改旧业务代码、部署新工具或声明其已可用。后续实现commit必须附测试/类型检查/构建、CI终态及部署版本记录；server DNS异常时先完成代码和CI，保留当前运行实例。
