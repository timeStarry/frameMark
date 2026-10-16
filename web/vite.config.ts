import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const outDir = fileURLToPath(new URL('../internal/webui/dist', import.meta.url))

// emptyOutDir wipes the committed .gitkeep; put it back once the bundle is written.
function keepGitkeep(): Plugin {
  return {
    name: 'markr-keep-gitkeep',
    apply: 'build',
    closeBundle() {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(resolve(outDir, '.gitkeep'), '')
    },
  }
}

export default defineConfig({
  plugins: [vue(), keepGitkeep()],
  build: {
    outDir,
    emptyOutDir: true,
    manifest: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:18150',
      '/m': 'http://127.0.0.1:18150',
    },
  },
})
