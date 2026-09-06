// 应用服务入口。
//
// 已实现：健康检查、场景数据包的只读接口、支持 Range 的静态文件服务（D1）；组件目录与任务管理
// （B-5：提交框图 → 拉起 cuav_run 子进程 → 状态机 → 任务列表，见 src/tasks/）；WebSocket 事件推送与
// 按序号补取（B-6：/ws 订阅、GET /api/v1/tasks/{id}/events、product_row 转二进制帧，见 src/ws/）。
// 视窗抽取端点（B-7）尚未实现，见 docs/api-versions.md。
//
// 依赖策略：运行时只加 ws 一个包（锁版本、进 THIRD-PARTY-NOTICES，D-032），其余只用 Node 内置模块。
//
// 环境变量：PORT、HOST；CUAV_RUN（引擎二进制，缺省 engine/build/cuav_run）；
// CUAV_MAX_CONCURRENT_TASKS（同时运行的任务数，缺省 1）。
//
// 三条硬约束：
//   1. 底图必须经 Range 下发（铁律 7）。整份全球底图 137 GB，不支持 Range 等于不可用。
//   2. 原始 IQ 不进浏览器（铁律 7）。本服务不暴露 data/iq/。
//   3. 只服务显式声明的根目录，路径穿越一律 403。

import { createServer } from 'node:http'
import { promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveWithin, sendFile, sendJson } from './static.js'
import { Engine, defaultEngineBinary } from './tasks/engine.js'
import { createTaskManager } from './tasks/manager.js'
import { handleTaskRoutes } from './tasks/routes.js'
import { WsHub } from './ws/hub.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')            // 仓库根目录
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '127.0.0.1'

/** URL 前缀到磁盘根目录的映射。**只有这里列出的目录会被暴露。** */
const ROOTS: ReadonlyArray<{ prefix: string; dir: string }> = [
  { prefix: '/data/basemap/', dir: join(ROOT, 'data', 'basemap') },
  { prefix: '/data/scene/', dir: join(ROOT, 'data', 'scene') },
]
/** 前端构建产物；开发时由 Vite 自己伺服，这里是单机模式下的成品目录。 */
const WEB_DIST = join(ROOT, 'web', 'dist')

/** 引擎与任务管理器。构造无副作用（不 spawn、不读盘），扫描与对账在 start() 里的 init() 做。 */
export const engine = new Engine({ bin: defaultEngineBinary(ROOT), cwd: ROOT })
export const tasks = createTaskManager({
  root: ROOT,
  engine,
  maxConcurrent: Number(process.env.CUAV_MAX_CONCURRENT_TASKS ?? 1) || 1,
})

async function sceneManifest(aoi: string): Promise<unknown | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(aoi)) return null
  const p = join(ROOT, 'data', 'scene', aoi, 'manifest.json')
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'))
  } catch {
    return null
  }
}

async function listScenes(): Promise<string[]> {
  try {
    const es = await fsp.readdir(join(ROOT, 'data', 'scene'), { withFileTypes: true })
    const out: string[] = []
    for (const e of es) {
      if (!e.isDirectory()) continue
      try {
        await fsp.access(join(ROOT, 'data', 'scene', e.name, 'manifest.json'))
        out.push(e.name)
      } catch {
        // 没有入口清单的目录不算一个数据包
      }
    }
    return out.sort()
  } catch {
    return []
  }
}

export const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: String(err) })
    else res.end()
  })
})

/** WebSocket 事件推送。挂在 upgrade 事件上，没有连接时不占任何句柄。 */
export const hub = new WsHub({ mgr: tasks })
hub.attach(server)

async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // 任务与组件目录路由自己管方法（POST 只在这里放行）
  if (path === '/api/v1/components' || path === '/api/v1/tasks' || path.startsWith('/api/v1/tasks/')) {
    if (await handleTaskRoutes(req, res, url, { mgr: tasks, engine })) return
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    return res.end()
  }

  if (path === '/api/v1/health') {
    const cat = await engine.cachedCatalog()
    return sendJson(res, 200, {
      status: 'ok',
      service: 'cuav-server',
      version: '0.0.0',
      engine: { available: await engine.available(), ...(cat ? { version: cat.engine_version } : {}) },
    })
  }
  if (path === '/api/v1/scenes') {
    return sendJson(res, 200, { scenes: await listScenes() })
  }
  const m = /^\/api\/v1\/scenes\/([^/]+)\/manifest$/.exec(path)
  if (m) {
    const man = await sceneManifest(decodeURIComponent(m[1]))
    return man ? sendJson(res, 200, man) : sendJson(res, 404, { error: 'not_found', scene: m[1] })
  }

  for (const { prefix, dir } of ROOTS) {
    if (!path.startsWith(prefix)) continue
    const abs = resolveWithin(dir, path.slice(prefix.length))
    if (!abs) return sendJson(res, 403, { error: 'forbidden', path })
    if (await sendFile(req, res, abs)) return
    return sendJson(res, 404, { error: 'not_found', path })
  }

  // `/data/` 与 `/api/` 下的未知路径**一律 404**，绝不回退到单页应用首页。
  // 否则请求 data/iq/（本服务不暴露原始 IQ，铁律 7）会拿到 200 与一页 HTML，
  // 既掩盖了错误，也让人误以为该路径存在。
  if (path.startsWith('/data/') || path.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'not_found', path })
  }

  const abs = resolveWithin(WEB_DIST, path === '/' ? '/index.html' : path)
  if (!abs) return sendJson(res, 403, { error: 'forbidden', path })
  if (await sendFile(req, res, abs)) return
  // 单页应用回退只对**没有扩展名**的路径生效：缺失的静态资源应当 404，
  // 而不是返回一页 HTML 让浏览器在解析 JavaScript 时才报出莫名其妙的错误。
  if (!/\.[a-z0-9]+$/i.test(path)) {
    const index = resolveWithin(WEB_DIST, '/index.html')
    if (index && (await sendFile(req, res, index))) return
  }
  return sendJson(res, 404, { error: 'not_found', path })
}

export async function start(): Promise<void> {
  await tasks.init()
  tasks.installShutdownHandlers(() => hub.close()) // 先关 WS 连接（1001）再退出
  const engineOk = await engine.available()
  server.listen(PORT, HOST, () => {
    console.log(`cuav-server 监听 http://${HOST}:${PORT}`)
    console.log(`  仓库根目录 ${ROOT}`)
    console.log(`  暴露的数据目录：${ROOTS.map((r) => r.prefix).join('  ')}`)
    console.log(`  前端产物 ${WEB_DIST}`)
    console.log(`  引擎 ${engine.cfg.bin}${engineOk ? '' : '（不存在或不可执行：任务提交将返回 503）'}`)
    console.log(`  任务目录 ${tasks.storeConfig.runsRel}，已有任务 ${tasks.list(1000).length} 个`)
    console.log(`  WebSocket ws://${HOST}:${PORT}${hub.path}（订阅 {subscribe, since}；补取 GET /api/v1/tasks/{id}/events?since）`)
  })
}

// 入口判定必须用 pathToFileURL 而不是字符串拼接：仓库根目录名里有空格，
// import.meta.url 会把它编码成 %20，直接比较字符串永远不相等，服务会静默不启动。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((e) => {
    console.error(`cuav-server 启动失败：${String(e)}`)
    process.exit(1)
  })
}
