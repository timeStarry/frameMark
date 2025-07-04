import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { writeFileSync } from 'fs'
import packageJson from './package.json'

export default defineConfig({
  plugins: [
    vue(),
    // 自动创建.nojekyll文件用于GitHub Pages部署
    {
      name: 'generate-nojekyll',
      writeBundle() {
        if (process.env.NODE_ENV === 'production') {
          writeFileSync('dist/.nojekyll', '')
        }
      }
    }
  ],
  // 定义全局变量
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  // GitHub Pages部署配置
  base: process.env.NODE_ENV === 'production' ? '/frameMark/' : '/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild', // 使用esbuild替代terser，构建更快
    assetsDir: 'assets'
  }
}) 