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
// vite.config.js
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

### 1. 部署失败
- 检查GitHub Actions工作流日志
- 确认工作流权限设置正确
- 验证package.json中的构建脚本

### 2. 页面404错误
- 确认GitHub Pages源设置为 **GitHub Actions**
- 检查仓库名称与base路径是否匹配
- 验证dist目录中是否包含index.html

### 3. 资源加载失败
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