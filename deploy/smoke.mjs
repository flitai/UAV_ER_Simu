// 单机包冒烟（W-2，D-099）：用包自己的启动器起服务，跑几件演示必经的事，再停掉。
//   node deploy/smoke.mjs <包目录> [--full]
//
// 不带 --full（程序部分的包，CI 在 Windows 上跑）：
//   1. 启动器起服务、等到端口应答；
//   2. 组件目录取得到——引擎能在这台机器上起来；
//   3. 提交全合成典型链路（golden-01、E1，不要建筑集）并等到终态 finished，产品文件在；
//   4. 再双击一次：启动器认出本系统已在跑，只「开浏览器」不起第二份；
//   5. 端口被别的程序占着：启动器给出说明并以退出码 2 结束，不崩；
// 包里带 Electron 外壳（D-111）时再加：
//   6. 服务已在运行时打开外壳：直接用这一份，界面加载得出，退出外壳后服务照常在跑；
//   7. 空闲端口上打开外壳：外壳自己起服务、界面加载得出，退出外壳时服务随之停掉。
// 带 --full（完整包）再加：
//   8. 底图端点给出北京区域底图与全球概览，pmtiles 与建筑集支持 Range（206）；
//   9. 数据中心只列包里带的实测片段（= 裁剪后的批索引）；
//  10. 实测回放链路跑完；E3（建筑遮挡）链路跑完——建筑集在包里且哈希对得上。
//
// 程序形式的包（--layout app，D-112；给包目录或 Mac 的 .dmg，后者只读挂载后从卷上直接打开程序）先做三件：
//   a. 用外壳把运行环境装到临时目录（CUAV_RUNTIME_DIR）、起服务、加载界面、退出时停服务；
//   b. 再开一次外壳：认出已经装好、直接复用；
//   c. 对装好的目录跑上面全部检查（起服务用程序自带的 Node）。
//
// 跑完删掉自己建的任务目录，包目录恢复原样（程序形式删掉临时装的运行环境、卸下 DMG）。任何一项不过即退出码 1。

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const full = args.includes('--full')
const given = resolve(args.find((a) => !a.startsWith('--')) ?? '')

// DMG：只读挂载，从卷上直接打开程序（用户不拖进「应用程序」时就是这样运行的）
let mounted = null
let target = given
if (given.endsWith('.dmg')) {
  mounted = mkdtempSync(join(tmpdir(), 'cuav-dmg-'))
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mounted, given], { stdio: 'ignore' })
  target = mounted
}
const appPayload = [join(target, 'resources', 'payload'), join(target, 'CuavDemo.app', 'Contents', 'Resources', 'payload')]
  .find((d) => existsSync(join(d, 'launch.mjs')) && existsSync(join(d, 'payload.json')))
const appLayout = Boolean(appPayload)
if (!appLayout && !existsSync(join(target, 'launch.mjs'))) {
  console.error('用法：node deploy/smoke.mjs <包目录 | Mac 的 .dmg> [--full]')
  process.exit(1)
}
const MAC_ELECTRON = join(target, 'CuavDemo.app', 'Contents', 'MacOS', 'Electron')
const WIN_SHELL = [join(target, 'app', 'CuavDemo.exe'), join(target, 'CuavDemo.exe')].find((p) => existsSync(p))
const shellExe = WIN_SHELL ?? (existsSync(MAC_ELECTRON) ? MAC_ELECTRON : null)
// 程序形式：运行环境装到临时目录，之后的检查都对装好的目录做
const runtimeDir = appLayout ? mkdtempSync(join(tmpdir(), 'cuav-runtime-')) : null
const payloadName = appLayout ? JSON.parse(readFileSync(join(appPayload, 'payload.json'), 'utf8')).name : null
let pkg = appLayout ? join(runtimeDir, payloadName) : target
// 起服务用哪个 Node：Windows 目录形式带便携 Node（start.bat 用它）；Mac 包与程序形式用程序自带的 Node
// （start.command 用它，ELECTRON_RUN_AS_NODE）；宿主版的包用当前 Node。
const nodeExe = existsSync(join(target, 'node', 'node.exe')) ? join(target, 'node', 'node.exe')
  : shellExe ?? process.execPath

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
  if (nodeExe === shellExe) env.ELECTRON_RUN_AS_NODE = '1'
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

/** 以冒烟模式打开 Electron 外壳（CUAV_SHELL_SMOKE=1）：页面加载完即自检、退出，最后一行是 SHELL-SMOKE <JSON>。 */
async function runShell(port, label) {
  const env = { ...process.env, PORT: String(port), CUAV_SHELL_SMOKE: '1' }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'CUAV_RUN', 'CUAV_BASEMAP', 'CUAV_ROOT', 'CUAV_RUNTIME_DIR']) delete env[k]
  if (runtimeDir) env.CUAV_RUNTIME_DIR = runtimeDir
  const p = spawn(shellExe, [], { cwd: target, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  const tee = (b) => {
    const t = b.toString('utf8')
    out += t
    for (const line of t.split(/\r?\n/)) if (line.trim() && !line.startsWith('SHELL-SMOKE')) console.log(`    [${label}] ${line}`)
  }
  p.stdout.on('data', tee)
  p.stderr.on('data', tee)
  const code = await Promise.race([new Promise((r) => p.on('exit', (c) => r(c))), sleep(180000).then(() => 'timeout')])
  if (code === 'timeout') p.kill()
  const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('SHELL-SMOKE '))
  let res = null
  try { res = line ? JSON.parse(line.slice('SHELL-SMOKE '.length)) : null } catch { /* 坏行 */ }
  return { code, res }
}

async function answers(base) {
  try {
    const r = await fetch(`${base}/api/v1/tasks?limit=1`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
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

/** 程序形式：先装运行环境、再确认复用（第 a、b 件）。 */
async function installChecks() {
  const p1 = await freePort()
  const a = await runShell(p1, '外壳·首次运行')
  check(a.code === 0 && a.res?.ok && a.res.layout === 'app' && a.res.install === 'copied' && a.res.owned === true,
    '程序形式首次运行：装好运行环境、起服务、界面加载得出',
    `退出码 ${a.code}，装到 ${a.res?.root ?? '—'}，${a.res?.install_s?.toFixed?.(1) ?? '—'} s${a.res?.error ? `，${a.res.error}` : ''}`)
  check(a.res?.server_exit !== null && a.res?.server_exit !== undefined && !(await answers(`http://127.0.0.1:${p1}`)),
    '退出程序时服务随之停止', `服务退出码 ${a.res?.server_exit}`)
  check(existsSync(join(pkg, 'launch.mjs')) && existsSync(join(pkg, '.installed.json')), '运行环境装在用户目录（这里是临时目录）里')
  const b = await runShell(await freePort(), '外壳·再次运行')
  check(b.code === 0 && b.res?.ok && b.res.install === 'reused', '再次运行时直接复用已装好的运行环境', `退出码 ${b.code}`)
  return a.code === 0
}

async function main() {
  if (appLayout && !(await installChecks())) {
    console.log(`\n冒烟 ${passes} 项通过，${failures} 项失败（程序形式首次运行没有成功，其余检查不做）`)
    return 1
  }
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

    if (shellExe) {
      // 服务已在运行：外壳直接用这一份，退出时不去停它
      const a = await runShell(port, '外壳·已有服务')
      check(a.code === 0 && a.res?.ok && a.res.owned === false, '服务已在运行时打开程序窗口：直接使用、界面加载得出',
        `退出码 ${a.code}，${JSON.stringify(a.res?.page ?? a.res?.error ?? null)}`)
      check(await answers(base), '退出程序窗口后，原来那份服务照常在跑')

      // 空闲端口：外壳自己起服务，退出时停掉
      const sport = await freePort()
      const logRel = 'data/tmp/server.log'
      const hadLog = existsSync(join(pkg, logRel))
      const b = await runShell(sport, '外壳·自起服务')
      check(b.code === 0 && b.res?.ok && b.res.owned === true, '程序窗口自己起服务、界面加载得出',
        `退出码 ${b.code}，视口 ${b.res?.page?.innerWidth}，缩放 ${b.res?.zoom}${b.res?.error ? `，${b.res.error}` : ''}`)
      check(b.res?.server_exit !== null && b.res?.server_exit !== undefined && !(await answers(`http://127.0.0.1:${sport}`)),
        '退出程序窗口时服务随之停止', `服务退出码 ${b.res?.server_exit}`)
      if (!hadLog) rmSync(join(pkg, logRel), { force: true })
    }

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

let code = 1
try {
  code = await main()
} finally {
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  if (mounted) {
    try { execFileSync('hdiutil', ['detach', mounted, '-force'], { stdio: 'ignore' }) } catch { /* 已卸下 */ }
    rmSync(mounted, { recursive: true, force: true })
  }
}
process.exit(code)
