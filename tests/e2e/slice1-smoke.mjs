// 切片 ① 的端到端验收（09 §10，U-1 + U-3）：三视图壳、快捷键、地图实例不重建、通过界面提交示例框图并跑完、
// WS 断线重连序号连续、纵轴 dBm（来源只在开发者模式）、状态条基准、无外网请求；
// 信号视图：隐藏期累积显示时补画、单音峰值 ≤ 1 bin、频谱与瀑布列对齐、缩放重取行数 = py、marker 与游标键、
// 二次运行回到跟随且无 > 50 ms 长任务、CSV 导出、刷新后已结束任务进回看。
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
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${name}`) }
const alt = (digit) => ({ key: String(digit), code: `Digit${digit}`, vk: 48 + digit, modifiers: 1 })
const waitApp = (page, fn, label, timeoutMs = 90000) => { console.error(`  … ${label}`); return page.waitFor((s) => s.app && fn(s.app, s), { label, timeoutMs }) }

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

  // ---------- U-3 信号视图 ----------
  // 任务在框图页跑完，行帧一直在环里累积；切到结果页时先从环补画（liveFrames ≥ 1），
  // 随后因任务已结束、索引已收尾而自动转回看，从文件重取同一窗口（尾部被丢的行帧由此补齐）
  st = await waitApp(page, (a) => a.signal.liveFrames > 0 && a.signal.geom, '信号页从环里补画', 30000)
  check('隐藏期累积、显示时从环补画（跟随模式画过至少一帧）', st.app.signal.liveFrames >= 1 && st.app.signal.drawnRows > 0, `liveFrames ${st.app.signal.liveFrames}，drawnRows ${st.app.signal.drawnRows}`)
  st = await waitApp(page, (a) => a.signal.mode === 'browse' && a.signal.lastFetch && a.signal.fetchStatus === 'idle', '结束后转回看', 30000)
  const geom = st.app.signal.geom
  check('任务结束后自动转回看，窗口尾部到数据末尾（丢帧从文件补齐）', st.app.signal.follow === false && Math.abs(st.app.signal.lastFetch.t1 - st.app.task.duration_s) <= 2 * geom.dt && st.app.signal.hatchedRows === 0,
    `t1 ${st.app.signal.lastFetch.t1} / 时长 ${st.app.task.duration_s}`)
  const expectBin = geom.nfft / 2 + 1e5 / geom.bw
  check('单音峰值频率误差 ≤ 1 bin', Math.abs(st.app.signal.peakBin - expectBin) <= 1, `peakBin ${st.app.signal.peakBin}，期望 ${expectBin.toFixed(1)}`)
  const m1 = st.app.signal.markers.find((m) => m.id === 'M1')
  check('M1 自动峰值在 2.4401 GHz（±1 RBW）且电平为 dBm 量级', !!m1 && Math.abs(m1.freq_Hz - 2.4401e9) <= geom.bw && m1.level_dB < -60 && m1.level_dB > -80, JSON.stringify(m1))
  const b = st.app.signal.bounds
  check('频谱与瀑布画布左右边界像素相同，瀑布最新行在顶', !!b.spectrum && !!b.waterfall && b.spectrum[0] === b.waterfall[0] && b.spectrum[1] === b.waterfall[1] && st.app.signal.waterfallNewestRow === 'top', JSON.stringify(b))
  st = await waitApp(page, (a) => a.signal.envelopeRows > 0, '包络索引到达', 20000).catch(() => st)
  check('包络索引一并轮询到（envelope 行数 > 0）', st.app.signal.envelopeRows > 0, `${st.app.signal.envelopeRows} 行`)

  // 缩放回看：开发者钩子等价于框选，走 B-7 抽取
  await page.evaluate('(window.__cuav.signal.zoomTo({ t0: 0.4, t1: 1.6, f0: -2e5, f1: 2e5 }), true)')
  // 等的必须是缩放后的那一次抽取（t0 ≈ 0.4），不能被结束收口的窗口（t0 ≈ 1.09）提前满足
  st = await waitApp(page, (a) => a.signal.mode === 'browse' && a.signal.lastFetch && a.signal.fetchStatus === 'idle' && a.signal.lastFetch.t0 >= 0.39 && a.signal.lastFetch.t0 <= 0.41, '回看抽取完成', 30000)
  const lf = st.app.signal.lastFetch
  const colsInWindow = Math.round(4e5 / geom.bw) + 1
  check('缩放后重取行数 = py，列数 = min(px, 窗内列数)，统计 max', lf.rows === lf.py && lf.cols === Math.min(lf.px, colsInWindow) && lf.stat === 'max' && lf.rows === st.app.signal.canvas.H,
    `rows ${lf.rows} / py ${lf.py} / H ${st.app.signal.canvas.H}，cols ${lf.cols} / px ${lf.px} / 窗内 ${colsInWindow}`)
  check('回看窗口覆盖请求的时间窗（相对量）', lf.t0 <= 0.4 + geom.dt && lf.t1 >= 1.6 - geom.dt && lf.t1 <= 1.6 + geom.dt, `t ${lf.t0}–${lf.t1}`)

  // 键：←→ 游标一帧、M 放 M2、Delete 删
  await page.pressKey({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 })
  st = await waitApp(page, (a) => a.signal.cursor_t_s !== null, '游标出现', 10000)
  const c1 = st.app.signal.cursor_t_s
  await page.pressKey({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 })
  st = await waitApp(page, (a) => a.signal.cursor_t_s !== null && a.signal.cursor_t_s < c1, '游标前移一帧', 10000)
  check('← 把时间游标前移一帧', Math.abs((c1 - st.app.signal.cursor_t_s) - geom.dt) < 1e-9, `${c1} → ${st.app.signal.cursor_t_s}，dt ${geom.dt}`)
  await page.pressKey({ key: 'm', code: 'KeyM', vk: 77 })
  st = await waitApp(page, (a) => a.signal.markers.length === 2, 'M 放置 M2', 10000)
  check('M 键放置 M2（落在 M1 处）', st.app.signal.markers.length === 2 && Math.abs(st.app.signal.markers[1].freq_Hz - m1.freq_Hz) <= geom.bw, JSON.stringify(st.app.signal.markers[1]))
  await page.pressKey({ key: 'Delete', code: 'Delete', vk: 46 })
  st = await waitApp(page, (a) => a.signal.markers.length === 1, 'Delete 删 M2', 10000)
  check('Delete 删除 M2', st.app.signal.markers.length === 1)

  // CSV：当前视窗的抽取数据
  // CSV 有几 MB，不经调试协议整份拉回，只在页面里取摘要
  const csv = await page.evaluate("(() => { const c = window.__cuav.signal.csv(); return c && { name: c.name, bytes: c.text.length, dataLines: c.text.split('\\n').filter((l) => l && !l.startsWith('#')).length } })()")
  check('导出 CSV：文件名含任务、观测点与时间窗，数据行数 = rows + 列头（+ 包络段）', !!csv && csv.name.includes(taskId) && csv.name.includes('s4') && /\d\.\d{3}s-\d\.\d{3}s\.csv$/.test(csv.name) && csv.dataLines >= lf.rows + 1,
    csv ? `${csv.name}，${csv.bytes} 字节，${csv.dataLines} 行` : 'null')

  // 二次运行：新任务回到跟随，实时追加；主线程无 > 50 ms 长任务（先确认地图已空闲，瓦片入库本身就是长任务）
  await page.waitFor((s) => s.tilesLoaded && s.loaded, { label: '地图空闲', timeoutMs: 60000 })
  await sleep(1500)
  await page.evaluate('(window.__cuav.perf.reset(), true)')
  const prevTask = st.app.context.taskId
  const framesBefore = st.app.signal.liveFrames        // 必须在点击之前读：示例任务 0.14 s 就跑完
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await waitApp(page, (a) => a.context.taskId && a.context.taskId !== prevTask, '第二个任务已提交')
  const taskId2 = st.app.context.taskId
  st = await waitApp(page, (a) => a.task.runState === 'finished' && a.signal.mode === 'browse' && a.signal.lastFetch && a.signal.fetchStatus === 'idle', '第二个任务跑完、实时画过并收口', 120000)
  await sleep(500)
  st = await page.waitFor((s) => s.app, { label: '读探针' })
  check('新任务开始后回到跟随并实时画出（liveFrames 增加），结束后收口为回看', st.app.signal.liveFrames > framesBefore && st.app.signal.follow === false && st.app.signal.drawnRows > 0,
    `liveFrames ${framesBefore} → ${st.app.signal.liveFrames}，drawnRows ${st.app.signal.drawnRows}`)
  check('运行期间主线程无 > 50 ms 长任务', !!st.app.perf && st.app.perf.longTasks && st.app.perf.longTasks.count === 0, JSON.stringify(st.app.perf))
  check('页面无外网请求', [...hosts].every((h) => LOOPBACK.has(h)), [...hosts].join(','))
  const bodyA = await page.evaluate('document.body.textContent')
  check('界面不出现服务器路径与 MATLAB 字样', !/\/Users\/|data\/runs\/|MATLAB/.test(bodyA))
  await page.close(chrome.port)

  // ---------- 页 B：默认地址，采用最近任务；无任何开发者元素 ----------
  page = await Page.open(chrome.port, `${BASE}#/results`)
  st = await waitApp(page, (a) => a.context.taskId === taskId2 && a.signal.scaleLabel !== null, '默认页采用最近任务', 60000)
  check('刷新后从服务端恢复最近任务（页 A 的第二个）', st.app.context.taskId === taskId2 && st.app.task.runState === 'finished')
  for (let i = 0; i < 40 && !(await page.evaluate("!!document.querySelector('[data-signal-unit]')")); i++) await sleep(250)
  const dom = await page.evaluate("({dev: document.querySelectorAll('[data-dev]').length, text: document.body.textContent, unit: document.querySelector('[data-signal-unit]')?.textContent, view: document.querySelector('[data-view=results]')?.dataset.active})")
  check('默认状态无 [data-dev] 元素', dom.dev === 0, `${dom.dev} 个`)
  check('默认 DOM 无估算 / 合成 / 标定来源文字（D-042b、D-043、D-047）', !/估算|est:|osm:|合成场景|标定：/.test(dom.text))
  check('用户看到的纵轴单位就是 dBm', dom.unit === 'dBm', JSON.stringify({ unit: dom.unit, resultsActive: dom.view }))
  check('探针轴标不带来源', st.app.signal.scaleLabel === 'dBm', st.app.signal.scaleLabel)
  st = await waitApp(page, (a) => a.signal.mode === 'browse' && a.signal.lastFetch && a.signal.drawnRows > 0, '已结束任务进回看并画出', 30000)
  check('刷新后采用已结束任务：直接回看全窗（跟随无实时行可用）', st.app.signal.mode === 'browse' && st.app.signal.follow === false && st.app.signal.lastFetch.t0 === 0 && st.app.signal.drawnRows > 0,
    `mode ${st.app.signal.mode}，窗 ${st.app.signal.lastFetch.t0}–${st.app.signal.lastFetch.t1}`)
  check('默认状态探针不含 perf（长任务计数只在开发者模式）', st.app.perf === null)
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
