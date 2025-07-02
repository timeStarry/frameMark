# Markr - 图片工具箱

一个优雅的纯前端图片处理方案，提供便捷的边框水印和图片拼图功能。


![Version](https://img.shields.io/badge/version-Beta%200.0.1-a18875?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-a18875?style=flat-square)
![Vue](https://img.shields.io/badge/Vue-3.0-a18875?style=flat-square)

## 🚀 快速开始

### 📱 在线体验
访问 **[Markr 在线版](https://timestarry.github.io/frameMark/)** 立即体验所有功能！

### 💻 本地运行
```bash
# 克隆项目
git clone https://github.com/timeStarry/frameMark.git

# 进入目录
cd frameMark

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 🚀 自动部署
项目已配置GitHub Actions自动部署：
- 推送到`main`分支自动触发构建和部署
- 部署到GitHub Pages，访问地址：`https://timestarry.github.io/frameMark/`


## 🌟 功能特性

### 🖼️ 边框水印
- **4种边框**：毛玻璃模糊、纯色边框、渐变边框、底部条纹
- **智能适配**：百分比自适应，确保跨分辨率一致效果
- **模糊边框**：三层模糊结构，智能分级处理
- **字体系统**：集成Google Fonts，支持签名体、艺术体、衬线体等
- **EXIF信息**：智能提取相机参数，可选显示光圈、快门、ISO、焦距等
- **所见即所得**：实时预览，支持缩放拖拽查看细节
- **水印定制**：支持文字内容、字体、大小、颜色、透明度、位置调节

### 🧩 图片拼图  
- **4种布局模式**：网格布局、水平拼接、垂直拼接、瀑布流
- **智能排版**：自动计算最佳布局，支持自定义网格列数
- **拖拽排序**：可视化调整图片顺序，实时预览效果
- **灵活配置**：图片间隔、背景颜色、圆角大小任意调节  
- **多种输出**：正方形、竖屏、横屏预设及自定义尺寸
- **高质量生成**：保持原图画质，支持高分辨率输出

## 🛠️ 技术栈

- **前端框架**：Vue 3 + Composition API
- **构建工具**：Vite 
- **路由管理**：Vue Router 4
- **样式预处理**：Sass/SCSS
- **图片处理**：HTML5 Canvas API
- **EXIF解析**：exifr
- **字体系统**：Google Fonts CDN
- **文件操作**：File API + Blob
- **部署方案**：GitHub Actions + GitHub Pages

## 📦 安装和运行

### 环境要求
- Node.js 16+ 
- npm 或 yarn

### 安装依赖
```bash
npm install
# 或
yarn install
```

### 开发模式
```bash
npm run dev
# 或
yarn dev
```

访问 http://localhost:3000 查看应用

### 构建生产版本
```bash
npm run build
# 或
yarn build
```

### 预览生产版本
```bash
npm run preview
# 或
yarn preview
```

## 📁 项目结构

```
frameMark/
├── src/
│   ├── components/         # 业务组件
│   │   └── layout/        # 布局组件 (Header, Footer)
│   ├── router/            # 路由配置
│   ├── styles/            # 全局样式 (SCSS)
│   ├── utils/             # 工具函数 (EXIF, 文件处理)
│   ├── views/             # 页面组件
│   │   ├── Home.vue      # 首页
│   │   ├── FrameWatermark.vue  # 边框水印
│   │   └── ImageCollage.vue    # 图片拼图
│   ├── App.vue           # 根组件
│   └── main.js           # 入口文件
├── index.html            # HTML模板
├── package.json          # 项目配置
├── vite.config.js        # Vite配置
└── README.md            # 项目说明
```


## 🔧 核心功能实现

### 🎯 百分比适配算法
自主研发的百分比适配系统，确保不同分辨率图片效果一致：
- **边框宽度**：图片尺寸的8%（可调3%-15%）
- **圆角大小**：图片尺寸的1.5%（可调0%-5%）  
- **字体大小**：图片高度的2.5%（可调1%-8%）
- **智能缩放**：自动适配超高分辨率图片

### 📷 EXIF信息处理  
基于 `exifr` 库的智能元数据处理：
- **常用参数**：默认选中光圈、快门、ISO、焦距
- **横排布局**：网格式展示，节省空间
- **字体优化**：等宽字体确保数字对齐美观
- **相机信息**：品牌型号、镜头、拍摄时间等
