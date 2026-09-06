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
    // 开发时数据与接口由 server/ 提供（它实现了 PMTiles 需要的 HTTP Range）。
    // 单机模式下前端产物由同一个服务伺服，届时不需要代理。
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/data': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true, changeOrigin: false },
    },
  },
})
