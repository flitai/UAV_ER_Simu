// 应用服务入口。骨架占位：目前只提供健康检查端点。
//
// 尚未实现，见 docs/api-versions.md：
//   - 项目、试验、任务、审计的 REST 端点
//   - WebSocket 事件推送（事件必须带序号，断线后可按序号补取，04 §8.6）
//   - 支持 HTTP Range 的文件服务（PMTiles 依赖，见 src/range.ts）
//
// 依赖策略：目前零运行时依赖，只用 Node 内置模块。Web 框架选型尚未决定，
// 推迟到 P2 阶段的框图平台设计报告一并定。

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '127.0.0.1'

const server = createServer((req, res) => {
  if (req.url === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'ok', service: 'cuav-server', version: '0.0.0' }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'not_found', path: req.url ?? '' }))
})

export function start(): void {
  server.listen(PORT, HOST, () => {
    console.log(`cuav-server 监听 http://${HOST}:${PORT}`)
  })
}

start()

export { server }
