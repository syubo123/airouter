// 前端构建配置：React + Vite，产物输出到 dist/（Worker 静态资源目录）
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // React JSX 支持
  plugins: [react()],
  build: {
    // 输出目录，与 wrangler.jsonc 的 assets.directory 对应
    outDir: 'dist',
  },
  server: {
    // 本地开发时把 API 请求代理到 wrangler dev（8787 端口），前端走 Vite 热更新
    proxy: {
      '/v1': 'http://localhost:8787',
      '/admin': 'http://localhost:8787',
    },
  },
})
