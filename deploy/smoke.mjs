// 单机包冒烟（W-2，D-099）：用包自己的启动器起服务，跑几件演示必经的事，再停掉。
//   node deploy/smoke.mjs <包目录> [--full]
//
// 不带 --full（程序部分的包，CI 在 Windows 上跑）：
//   1. 启动器起服务、等到端口应答；
//   2. 组件目录取得到——引擎能在这台机器上起来；
//   3. 提交全合成典型链路（golden-01、E1，不要建筑集）并等到终态 finished，产品文件在；
//   4. 再双击一次：启动器认出本系统已在跑，只「开浏览器」不起第二份；
//   5. 端口被别的程序占着：启动器给出说明并以退出码 2 结束，不崩。
// 带 --full（完整包）再加：
//   6. 底图端点给出北京区域底图与全球概览，pmtiles 与建筑集支持 Range（206）；
//   7. 数据中心只列包里带的实测片段（= 裁剪后的批索引）；
//   8. 实测回放链路跑完；E3（建筑遮挡）链路跑完——建筑集在包里且哈希对得上。
//
// 跑完删掉自己建的任务目录，包目录恢复原样。任何一项不过即退出码 1。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const full = args.includes('--full')
const pkg = resolve(args.find((a) => !a.startsWith('--')) ?? '')
if (!existsSync(join(pkg, 'launch.mjs'))) {
  console.error('用法：node deploy/smoke.mjs <包目录> [--full]')
  process.exit(1)
}
// 包里带便携 Node 就用它（Windows 包），否则用当前 Node（宿主版的包）
const nodeExe = existsSync(join(pkg, 'node', 'node.exe')) ? join(pkg, 'node', 'node.exe') : process.execPath

let failures = 0
let passes = 0
function check(ok, what, detail = '') {
  if (ok) passes++
  else failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

function launch(port, label) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CUAV_NO_BROWSER: '1' }
  delete env.CUAV_RUN
  delete env.CUAV_BASEMAP
  const p = spawn(nodeExe, [join(pkg, 'launch.mjs')], { cwd: pkg, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  const tee = (b) => {
    const s = b.toString('utf8')
    out += s
    for (const line of s.split(/\r?\n/)) if (line.trim()) console.log(`    [${label}] ${line}`)
  }
  p.stdout.on('data', tee)
  p.stderr.on('data', tee)
  const exited = new Promise((r) => p.on('exit', (code) => r(code)))
  return { proc: p, exited, output: () => out }
}

async function getJson(base, path, init) {
  const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(30000) })
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, body, headers: r.headers }
}

async function waitUp(base, ms = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${base}/api/v1/tasks?limit=1`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return true
    } catch {
      // 还没起来
    }
    await sleep(300)
  }
  return false
}

const created = []

async function runDiagram(base, fixture, ms = 600000) {
  const body = readFileSync(join(REPO, 'tests', 'regression', 'diagrams', fixture), 'utf8')
  const r = await getJson(base, '/api/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  if (r.status !== 201 && r.status !== 200) return { ok: false, detail: `提交 ${r.status} ${JSON.stringify(r.body).slice(0, 300)}` }
  const id = r.body.task_id
  created.push(id)
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const g = await getJson(base, `/api/v1/tasks/${id}`)
    const st = g.body?.run_state
    if (['finished', 'failed', 'cancelled'].includes(st)) {
      return { ok: st === 'finished', id, rec: g.body, detail: `${st} / ${g.body.result}，${((Date.now() - t0) / 1000).toFixed(1)} s` }
    }
    await sleep(500)
  }
  return { ok: false, id, detail: '超时' }
}

const fileSize = (rel) => (existsSync(join(pkg, rel)) ? statSync(join(pkg, rel)).size : -1)

async function main() {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const srv = launch(port, '服务')
  try {
    check(await waitUp(base), '启动器起服务，端口应答')

    const comp = await getJson(base, '/api/v1/components')
    check(comp.status === 200 && Array.isArray(comp.body?.components) && comp.body.components.length > 0,
      '组件目录取得到（引擎能起）', `${comp.body?.components?.length ?? 0} 个组件`)

    const home = await fetch(`${base}/`)
    check(home.status === 200 && (await home.text()).includes('<div id="root"'), '首页取得到')

    const syn = await runDiagram(base, 'chain-synthetic.json')
    check(syn.ok, '全合成典型链路跑完', syn.detail)
    if (syn.id) {
      const ops = JSON.parse(readFileSync(join(REPO, 'tests/regression/diagrams/chain-synthetic.json'), 'utf8'))
        .observation_points.map((o) => o.id)
      const missing = ops.filter((op) => !(fileSize(`data/runs/${syn.id}/${op}/spectrum.f32`) > 0))
      check(ops.length > 0 && missing.length === 0, '每个观测点的频谱产品都已落盘', `${ops.join(' ')}${missing.length ? `，缺 ${missing.join(' ')}` : ''}`)
      check(fileSize(`data/runs/${syn.id}/metrics.json`) > 0, '评价指标已落盘')
    }

    // 再双击一次 start.bat：同一端口上已是本系统，只开浏览器、不起第二份
    const again = launch(port, '再启动')
    const code2 = await Promise.race([again.exited, sleep(30000).then(() => 'timeout')])
    check(code2 === 0 && again.output().includes('已经在端口'), '服务已在运行时再启动只开浏览器', `退出码 ${code2}`)

    // 端口被别的程序占着：说明并以退出码 2 结束
    const foreign = createServer((_, res) => {
      res.writeHead(404)
      res.end()
    })
    const fport = await freePort()
    await new Promise((r) => foreign.listen(fport, '127.0.0.1', r))
    const clash = launch(fport, '端口冲突')
    const code3 = await Promise.race([clash.exited, sleep(60000).then(() => 'timeout')])
    foreign.close()
    check(code3 === 2 && clash.output().includes('已被其他程序占用'), '端口被别的程序占用时给出说明、不崩', `退出码 ${code3}`)

    if (full) {
      const bm = await getJson(base, '/api/v1/basemap')
      check(bm.status === 200 && bm.body.id === 'beijing' && bm.body.overview_url, '底图：北京区域底图 + 全球概览', JSON.stringify(bm.body).slice(0, 120))
      for (const url of [bm.body.pmtiles_url, bm.body.overview_url, '/data/scene/beijing-yayuncun/buildings.geojson']) {
        const r = await fetch(base + url, { headers: { range: 'bytes=0-15' } })
        const b = Buffer.from(await r.arrayBuffer())
        check(r.status === 206 && b.length === 16, `Range 取 ${url}`, `${r.status}，${b.length} 字节`)
      }
      const idx = JSON.parse(readFileSync(join(pkg, 'data/iq/measured/dronerfb/index.manifest.json'), 'utf8'))
      const ds = await getJson(base, '/api/v1/datasets?limit=1000')
      check(ds.status === 200 && ds.body.total === idx.product_count && idx.subset_of?.product_count > idx.product_count,
        '数据中心只列包里带的实测片段', `列出 ${ds.body.total}，裁剪自 ${idx.subset_of?.product_count}`)
      const rep = await runDiagram(base, 'chain-replay.json')
      check(rep.ok, '实测回放链路跑完', rep.detail)
      const e3 = await runDiagram(base, 'chain-golden-01-e3.json')
      check(e3.ok, 'E3 建筑遮挡链路跑完（建筑集在包里）', e3.detail)
    }
  } finally {
    srv.proc.kill()
    await Promise.race([srv.exited, sleep(10000)])
    for (const id of created) rmSync(join(pkg, 'data', 'runs', id), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  console.log(`\n冒烟 ${passes} 项通过，${failures} 项失败`)
  return failures ? 1 : 0
}

process.exit(await main())
