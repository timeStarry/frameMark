# 部署到GitHub Pages指南

本项目已配置了完整的GitHub Actions自动部署流程，只需要简单的设置即可实现自动部署。

## 🔧 GitHub Pages设置步骤

### 1. 启用GitHub Pages
1. 进入GitHub仓库页面
2. 点击 **Settings** 选项卡
3. 在左侧导航中找到 **Pages** 选项
4. 在 **Source** 部分选择 **GitHub Actions**

### 2. 验证工作流权限
1. 在仓库的 **Settings** 页面
2. 点击左侧的 **Actions** → **General**
3. 在 **Workflow permissions** 部分
4. 选择 **Read and write permissions**
5. 勾选 **Allow GitHub Actions to create and approve pull requests**

### 3. 触发首次部署
1. 推送代码到 `main` 分支，或者
2. 在 **Actions** 选项卡中手动触发 **Deploy to GitHub Pages** 工作流

## 🚀 自动部署流程

- **触发条件**：推送到 `main` 分支
- **构建环境**：Ubuntu Latest + Node.js 18
- **构建步骤**：
  1. 检出代码
  2. 设置Node.js环境
  3. 安装依赖 (`npm ci`)
  4. 构建项目 (`npm run build`)
  5. 上传构建产物
  6. 部署到GitHub Pages

## 📝 部署配置说明

### Vite配置调整
```javascript
// (已删除，旧版 vite 配置)
export default defineConfig({
  // 设置base路径用于GitHub Pages
  base: process.env.NODE_ENV === 'production' ? '/frameMark/' : '/',
  
  // 构建时自动创建.nojekyll文件
  plugins: [
    vue(),
    {
      name: 'generate-nojekyll',
      writeBundle() {
        if (process.env.NODE_ENV === 'production') {
          writeFileSync('dist/.nojekyll', '')
        }
      }
    }
  ]
})
```

### 访问地址
部署成功后，项目将可通过以下地址访问：
```
https://timestarry.github.io/frameMark/
```

## 🔍 故障排除

### 1. 构建失败
- **terser not found**: 项目已配置使用esbuild代替terser，速度更快
- **Sass legacy API警告**: 已更新到sass v1.80+解决兼容性问题
- **依赖缺失**: 运行`npm ci`确保依赖正确安装

### 2. 部署失败
- 检查GitHub Actions工作流日志
- 确认工作流权限设置正确
- 验证package.json中的构建脚本

### 3. 页面404错误
- 确认GitHub Pages源设置为 **GitHub Actions**
- 检查仓库名称与base路径是否匹配
- 前端构建在 web/ 目录下：cd web && npm ci && npm run build

### 4. 资源加载失败
- 确认base路径配置正确
- 检查相对路径引用
- 验证.nojekyll文件是否存在

## 📋 部署清单

- [x] GitHub Actions工作流配置 (`.github/workflows/deploy.yml`)
- [x] Vite配置调整 (`base` 路径设置)
- [x] 自动生成 `.nojekyll` 文件
- [x] GitHub Pages设置
- [x] 工作流权限配置

完成以上设置后，每次推送代码到main分支都会自动触发构建和部署流程！🎉 
## 存储桶 CORS

Markr 作者工作区用预签名 URL 从浏览器直接 `PUT` 原图到 originals 存储桶；工具页还会用预签名 `GET` 读取归档原图。CSP 的 `connect-src` 已包含 S3 源（与 `img-src` 使用同一个主机列表），存储桶还需要允许 `MARKR_ORIGIN` 跨域上传和读取。以 `MARKR_ORIGIN=https://markr.example.com` 为例：

```json
[
  {
    "AllowedOrigins": ["https://markr.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type", "x-amz-*"],
    "MaxAgeSeconds": 3000
  }
]
```

`AllowedOrigins` 必须与 `MARKR_ORIGIN` 完全一致（协议、主机、端口）。`x-amz-*` 覆盖预签名请求里出现的 `x-amz-checksum-sha256` 等头。derived 存储桶不需要这条规则。
