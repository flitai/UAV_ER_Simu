// 切片 ① 的端到端验收（09 §10，U-1 子集）：三视图壳、快捷键、地图实例不重建、通过界面提交示例框图并跑完、
// WS 断线重连序号连续、纵轴 dBm（来源只在开发者模式）、状态条基准、无外网请求。
//
// 跑法（先起服务：cd server && npm run build && node dist/index.js；引擎已构建；web/dist 为最新）：
//     node tests/e2e/slice1-smoke.mjs [--url http://127.0.0.1:8080/]

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchChrome, Page } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) =>
  v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a, []))
const BASE = (args.url ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/')
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); }
const alt = (digit) => ({ key: String(digit), code: `Digit${digit}`, vk: 48 + digit, modifiers: 1 })
const waitApp = (page, fn, label, timeoutMs = 90000) => page.waitFor((s) => s.app && fn(s.app, s), { label, timeoutMs })

let chrome, page, dir
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-'))
  chrome = await launchChrome({ userDataDir: dir })
  console.log(`浏览器 ${chrome.browser}`)

  // ---------- 页 A：开发者模式，跑一遍任务 ----------
  page = await Page.open(chrome.port, 'about:blank')
  const hosts = new Set()
  const noteHost = (u) => { try { const x = new URL(u); if (/^(https?|wss?):$/.test(x.protocol)) hosts.add(x.hostname) } catch { /* data: blob: 等无主机 */ } }
  page.on('Network.requestWillBeSent', (p) => noteHost(p.request.url))
  page.on('Network.webSocketCreated', (p) => noteHost(p.url))
  await page.send('Network.enable')
  await page.send('Page.navigate', { url: `${BASE}?dev=1#/scene` })

  let st = await page.waitFor((s) => s.ready && s.loaded && s.tilesLoaded && s.app, { label: '地图与壳就绪', timeoutMs: 120000 })
  const id0 = st.app.mapInstanceId
  check('探针带 app 子对象', !!st.app && typeof st.app.view === 'string')
  check('图层含观测区域边界 aoi-boundary', st.layers.includes('aoi-boundary'))
  check('默认视图为场景', st.app.view === 'scene')

  await page.pressKey(alt(2))
  st = await waitApp(page, (a) => a.view === 'diagram', 'Alt+2 切到框图')
  check('Alt+2 切到框图', st.app.view === 'diagram', `hash ${await page.evaluate('location.hash')}`)
  await page.pressKey(alt(4))
  st = await waitApp(page, (a) => a.view === 'data', 'Alt+4 切到数据中心')
  check('Alt+4 切到数据中心', st.app.view === 'data')
  await page.pressKey(alt(1))
  st = await page.waitFor((s) => s.app?.view === 'scene' && s.tilesLoaded, { label: '切回场景' })
  check('三视图切换不重建地图实例', st.app.mapInstanceId === id0 && st.tilesLoaded, `mapInstanceId ${id0} → ${st.app.mapInstanceId}`)

  // 提交示例框图（默认已装入切片 ① 合成链）
  await page.pressKey(alt(2))
  await waitApp(page, (a) => a.view === 'diagram', '框图页')
  const before = st.app.context.taskId
  // 等组件目录就绪（运行按钮可用）
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")
    if (ok) break
    await sleep(250)
  }
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await waitApp(page, (a) => a.context.taskId && a.context.taskId !== before && a.ws.status === 'connected', '任务已提交且 WS 连上')
  const taskId = st.app.context.taskId
  check('通过界面提交任务', !!taskId, taskId ?? '')
  const seqBefore = st.app.ws.lastSeq

  // 断线：走真实的重连与 since 补取路径（只在 ?dev=1 有这个钩子）
  const dropped = await page.evaluate('(window.__cuav && window.__cuav.ws.dropForTest())')
  check('开发者钩子可断开 WS', dropped === true)

  st = await waitApp(page, (a) => a.task.runState === 'finished' || a.task.runState === 'failed' || a.task.runState === 'cancelled', '任务结束', 120000)
  check('任务跑完且结果有效', st.app.task.runState === 'finished' && st.app.task.result === 'valid', `${st.app.task.runState} / ${st.app.task.result}`)
  st = await waitApp(page, (a) => a.ws.status === 'connected' && a.ws.reconnects >= 1, '重连成功', 30000)
  const rec = await page.evaluateAsync(`fetch('/api/v1/tasks/${taskId}').then((r) => r.json())`)
  // 补取与实时的并集必须无缺号：客户端 lastSeq 追平服务端 last_seq，日志无「缺号」
  st = await waitApp(page, (a) => a.ws.lastSeq >= rec.last_seq, '序号追平', 30000).catch(() => st)
  check('断线重连后序号连续（lastSeq 追平 last_seq）', st.app.ws.lastSeq === rec.last_seq && st.app.ws.lastSeq >= seqBefore,
    `客户端 ${st.app.ws.lastSeq}，服务端 ${rec.last_seq}，断线前 ${seqBefore}`)
  const missing = await page.evaluate("Array.from(document.querySelectorAll('.log-line')).filter((l) => /缺号/.test(l.textContent)).length")
  check('日志无「缺号」告警', missing === 0, `${missing} 条`)

  // 纵轴：dBm，来源只在探针与开发者模式
  await page.pressKey(alt(3))
  st = await waitApp(page, (a) => a.view === 'results' && a.signal.scaleLabel !== null, '结果页与索引就绪', 30000)
  check('纵轴标注以 dBm 开头', typeof st.app.signal.scaleLabel === 'string' && st.app.signal.scaleLabel.startsWith('dBm'), st.app.signal.scaleLabel)
  check('合成链标定来源为 model（探针可见）', st.app.signal.calibration?.source === 'model', JSON.stringify(st.app.signal.calibration))
  const devDom = await page.evaluate("({dev: document.querySelectorAll('[data-dev]').length, calIn: !!document.querySelector('[data-dev=calibration]'), unit: document.querySelector('[data-signal-unit]')?.textContent, basis: !!document.querySelector('[data-basis=\"WGS-84 AGL LogicalSim\"]'), rows: document.querySelector('[data-signal-rows]')?.textContent})")
  check('开发者模式：标定来源只在 [data-dev] 内，用户可见的单位文字仍是 dBm', devDom.dev >= 1 && devDom.calIn && devDom.unit === 'dBm', JSON.stringify(devDom))
  check('状态条显示坐标与时间基准', devDom.basis === true)
  check('信号页头显示行数', /\d/.test(devDom.rows ?? ''), devDom.rows ?? '')
  check('页面无外网请求', [...hosts].every((h) => LOOPBACK.has(h)), [...hosts].join(','))
  const bodyA = await page.evaluate('document.body.textContent')
  check('界面不出现服务器路径与 MATLAB 字样', !/\/Users\/|data\/runs\/|MATLAB/.test(bodyA))
  await page.close(chrome.port)

  // ---------- 页 B：默认地址，采用最近任务；无任何开发者元素 ----------
  page = await Page.open(chrome.port, `${BASE}#/results`)
  st = await waitApp(page, (a) => a.context.taskId === taskId && a.signal.scaleLabel !== null, '默认页采用最近任务', 60000)
  check('刷新后从服务端恢复最近任务', st.app.context.taskId === taskId && st.app.task.runState === 'finished')
  for (let i = 0; i < 40 && !(await page.evaluate("!!document.querySelector('[data-signal-unit]')")); i++) await sleep(250)
  const dom = await page.evaluate("({dev: document.querySelectorAll('[data-dev]').length, text: document.body.textContent, unit: document.querySelector('[data-signal-unit]')?.textContent, view: document.querySelector('[data-view=results]')?.dataset.active})")
  check('默认状态无 [data-dev] 元素', dom.dev === 0, `${dom.dev} 个`)
  check('默认 DOM 无估算 / 合成 / 标定来源文字（D-042b、D-043、D-047）', !/估算|est:|osm:|合成场景|标定：/.test(dom.text))
  check('用户看到的纵轴单位就是 dBm', dom.unit === 'dBm', JSON.stringify({ unit: dom.unit, resultsActive: dom.view }))
  check('探针轴标不带来源', st.app.signal.scaleLabel === 'dBm', st.app.signal.scaleLabel)
} catch (e) {
  check('端到端流程未抛异常', false, String(e))
} finally {
  if (page && chrome) await page.close(chrome.port)
  if (chrome) chrome.proc.kill()
  if (dir) await rm(dir, { recursive: true, force: true })
}

let bad = 0
for (const c of checks) {
  console.log(`${c.ok ? '通过' : '失败'}  ${c.name}${c.detail ? `  —— ${c.detail}` : ''}`)
  if (!c.ok) bad++
}
console.log(`\n共 ${checks.length} 项，失败 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
