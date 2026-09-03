import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 交付环境不联网（CLAUDE.md 铁律 6）。底图、字形、精灵图、字体一律随包，
// 构建产物中不得出现内容分发网络（CDN）、在线字体或在线地图的地址。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
})
