// 切片 ②「场景里飞起来」的端到端验收（06 备忘录 §9E）。
//
// 两条硬断言：
//   ① 三时刻位置与 tests/golden/scenario-track-demo-01.json 差 ≤ 1e-6 度；
//   ② 两时刻带内功率差与几何路损差 ≤ 0.5 dB。
//      （原文写「峰值功率差」，这里按**峰值邻域的带内功率**算：多普勒把谱线在 ±1.2 个 bin 内推来推去，
//       hann 的扇贝损耗最坏 1.42 dB，直接比单 bin 峰值守不住 0.5 dB。带内功率与扇贝无关，
//       也正是频谱仪「通道功率」的口径。口径细化记在 06 §14。）
//
// 另外覆盖：场景对象树、四个工具、布站→撤销→重做、保存场景、态势图层、链路读数、
// 界面不做「合成场景」标记（D-043）。
//
// 跑法（先起服务：cd server && npm run build && node dist/index.js；引擎已构建；web/dist 为最新）：
//     node tests/e2e/slice2-smoke.mjs [--url http://127.0.0.1:8080/]

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchChrome, Page } from './cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) =>
  v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a, []))
const BASE = (args.url ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`) }
const alt = (digit) => ({ key: String(digit), code: `Digit${digit}`, vk: 48 + digit, modifiers: 1 })
const waitApp = (page, fn, label, timeoutMs = 90000) => { console.error(`  … ${label}`); return page.waitFor((s) => s.app && fn(s.app, s), { label, timeoutMs }) }

const golden = JSON.parse(readFileSync(join(ROOT, 'tests/golden/scenario-track-demo-01.json'), 'utf8'))
const scenario = JSON.parse(readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json'), 'utf8'))

/**
 * 给一个地址加一次性查询参数，**保证它是一次真正的导航**。
 * 只改 hash 不会重载页面（浏览器视之为同文档导航），而「载入最近保存的框图」是启动时那一次的事；
 * 先 `Page.navigate` 改 hash 再 `Page.reload`，又可能在 hash 还没生效时就重载了旧地址
 * ——slice2 第一次这么写就卡在「载入切片 ② 框图」上，页面其实停在场景页。
 */
function reloadUrl(suffix) {
  const i = suffix.indexOf('#')
  const query = i < 0 ? suffix : suffix.slice(0, i)
  const hash = i < 0 ? '' : suffix.slice(i)
  const q = query.replace(/^\?/, '')
  return `${BASE}?${q ? q + '&' : ''}_reload=${Date.now()}${hash}`
}

/**
 * 把一份**手写**框图存进服务端再刷新页面，让启动时的「载入最近保存的框图」把它捡起来。
 * 自由画布（连同它的「示例框图」下拉与源码页签）已由 D-060 删掉，这是现在唯一能把
 * 非典型链路的框图送进界面的路——而且走的是公开端点，不依赖任何调试钩子。
 */
async function loadDiagramViaApi(page, relPath, hash, patch) {
  const doc = JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'))
  if (patch) patch(doc)
  const body = JSON.stringify(JSON.stringify(doc, null, 2) + '\n')
  const status = await page.evaluateAsync(
    `fetch('/api/v1/diagrams/${doc.diagram_id}', { method: 'PUT',`
    + ` headers: { 'content-type': 'application/json' }, body: ${body} }).then(r => r.status)`)
  if (status !== 200 && status !== 201) throw new Error(`存框图 ${doc.diagram_id} 失败：HTTP ${status}`)
  await page.send('Page.navigate', { url: reloadUrl(hash) })
  return doc.diagram_id
}

async function deleteDiagram(page, id) {
  return page.evaluateAsync(`fetch('/api/v1/diagrams/${id}', { method: 'DELETE' }).then(r => r.status)`)
}

let chrome, page, dir
const pageErrors = []
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-slice2-'))
  chrome = await launchChrome({ userDataDir: dir })
  console.log(`浏览器 ${chrome.browser}`)
  page = await Page.open(chrome.port, 'about:blank')
  await page.send('Network.enable')
  // 页面里的未捕获异常一律记下来：React 19 遇到渲染期异常会卸载整棵树，
  // 到那时探针也没了，只看超时信息根本不知道发生了什么。
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n').slice(0, 4).join(' | ')))
  // 点名 demo-01：自 D-061 起页面开起来跟着最近任务的场景走，盘上跑过 demo-03 就会落到三站场景
  await page.send('Page.navigate', { url: `${BASE}?scenario=demo-01#/scene` })

  let st = await page.waitFor((s) => s.ready && s.loaded && s.tilesLoaded && s.app?.scene?.status === 'ok',
    { label: '地图与场景就绪', timeoutMs: 120000 })

  // ---------- 场景对象树与图层 ----------
  check('场景已载入', st.app.scene.scenarioId === 'demo-01' && st.app.scene.sites === 1 && st.app.scene.emitters === 1 && st.app.scene.waypoints === 3,
    JSON.stringify({ id: st.app.scene.scenarioId, sites: st.app.scene.sites, wps: st.app.scene.waypoints }))
  check('场景哈希与盘上文件一致（框图 scenario_ref 用的就是它）', /^[0-9a-f]{64}$/.test(st.app.scene.scenarioSha256), st.app.scene.scenarioSha256.slice(0, 8) + '…')
  // D3-6：建筑几何 15.9 MB、浏览器 JSON.parse 要 72 ms、堆涨 41 MB（07 §2.3）。
  // **首屏一定不能付这笔钱**——MapLibre 渲染那份是在 worker 里另拉的，遮挡这份只有真要算时才取。
  // 这条是「懒加载真的懒住了」唯一的自动化证据：模块被顶层 import 拖进首屏，它就会红（07 §11 风险 8）。
  check('建筑几何没有在场景页首屏被加载（懒加载，D3-6）',
    st.app.occlusion?.status === 'idle' && st.app.occlusion?.buildings === null,
    JSON.stringify(st.app.occlusion))
  for (const id of ['cuav-zone-fill', 'cuav-zone-line', 'cuav-link-line', 'cuav-link-label', 'cuav-route-line', 'cuav-trail-line', 'cuav-waypoint-dot', 'cuav-site-dot', 'cuav-site-icon', 'cuav-target-pole', 'cuav-target-ring', 'cuav-target-icon', 'cuav-target-label']) {
    if (!st.layers.includes(id)) { check(`态势图层 ${id} 存在`, false); break }
  }
  check('十三个态势图层齐全（切片 ⑧ V-2 加六个，D-061）', ['cuav-zone-fill', 'cuav-zone-line', 'cuav-link-line', 'cuav-link-label', 'cuav-route-line', 'cuav-trail-line', 'cuav-waypoint-dot', 'cuav-site-dot', 'cuav-site-icon', 'cuav-target-pole', 'cuav-target-ring', 'cuav-target-icon', 'cuav-target-label'].every((x) => st.layers.includes(x)))
  // 场景自 D-061 起在采用最近任务之后才载入，常晚于瓦片就绪；要素要等地图把新数据画出来，轮询而不是只查一次
  let rendered = -1
  for (let i = 0; i < 25 && rendered < 4; i++) {
    rendered = await page.evaluateAsync("new Promise((r) => setTimeout(() => r(window.__map ? window.__map.queryRenderedFeatures({layers:['cuav-site-dot','cuav-waypoint-dot']}).length : -1), 200))")
  }
  check('站点与航点画在图上', rendered >= 4, `${rendered} 个要素`)
  const treeText = await page.evaluate("document.querySelector('[data-scene-tree]')?.textContent ?? ''")
  check('对象树只列站点、辐射源与告警区，不再平铺航点、活动与派生链路（D-062）', /站点 \(1\)/.test(treeText) && /辐射源 \(1\)/.test(treeText) && /告警区 \(/.test(treeText) && !/链路/.test(treeText) && !/航点 1/.test(treeText), treeText.slice(0, 120))
  check('界面不做「合成场景」标记（D-043）', !/合成/.test(treeText) && !(await page.evaluate("/合成场景/.test(document.body.textContent)")))

  // ---------- 工具：编辑场景 → 布站 → 撤销 → 重做 ----------
  const toolsBefore = await page.evaluate("Array.from(document.querySelectorAll('[data-tool]')).map(b => b.dataset.tool)")
  check('观察状态下工具条只露「测量」与「视距」，编辑工具收在「编辑场景」后面（D-062、D3-7）',
    JSON.stringify(toolsBefore) === JSON.stringify(['measure', 'los']) && (await page.evaluate("!!document.querySelector('[data-act=edit-mode]')")), JSON.stringify(toolsBefore))
  await page.evaluate("(document.querySelector('[data-act=edit-mode]').click(), true)")
  let tools = []
  for (let i = 0; i < 30 && tools.length < 7; i++) {
    tools = await page.evaluate("Array.from(document.querySelectorAll('[data-tool]')).map(b => b.dataset.tool)")
    if (tools.length < 7) await sleep(100)
  }
  check('进入编辑后工具七件齐全（测量 / 视距 / 选择 / 布站 / 布目标 / 航点 / 布告警区；布目标自 D-053 起，布告警区自 D-061 起，视距自 D3-7 起）',
    JSON.stringify(tools) === JSON.stringify(['measure', 'los', 'select', 'site', 'emitter', 'waypoint', 'zone']), JSON.stringify(tools))

  await page.evaluate("(document.querySelector('[data-tool=site]').click(), true)")
  st = await waitApp(page, (a) => a.scene.tool === 'site', '切到布站工具')
  const canvasBox = await page.evaluate("(() => { const c = document.querySelector('.scene-map canvas'); const r = c.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}) })()")
  const pt = JSON.parse(canvasBox)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: pt.x + 60, y: pt.y + 60, button: 'left', clickCount: 1 })
  }
  st = await waitApp(page, (a) => a.scene.sites === 2, '布站后站点变两个')
  check('布站：地图点击加一个站点，工具自动回到「选择」', st.app.scene.sites === 2 && st.app.scene.tool === 'select' && st.app.unsaved.scene === true)
  check('新站点自动选中，左栏出站点表单（D-062：表单归左栏）', st.app.scene.selection?.kind === 'site',
    await page.evaluate("document.querySelector('[data-form=site]') ? '有' : '无'"))

  await page.evaluate("(document.querySelector('[data-act=undo]').click(), true)")
  st = await waitApp(page, (a) => a.scene.sites === 1, '撤销')
  check('撤销回到一个站点', st.app.scene.sites === 1 && st.app.undo.scene.redo === 1)
  await page.evaluate("(document.querySelector('[data-act=redo]').click(), true)")
  st = await waitApp(page, (a) => a.scene.sites === 2, '重做')
  check('重做又回到两个站点', st.app.scene.sites === 2)
  await page.evaluate("(document.querySelector('[data-act=undo]').click(), true)")
  st = await waitApp(page, (a) => a.scene.sites === 1, '撤销回单站（后面要跑单站场景）')

  // ---------- 提交切片 ② 框图 ----------
  // 手写框图，走公开端点送进界面（自由画布与它的示例下拉已由 D-060 删掉）
  const diagId = await loadDiagramViaApi(page, 'engine/tests/diagrams/slice2_scenario_link.json',
                                         '?scenario=demo-01#/diagram')
  st = await waitApp(page, (a) => a.view === 'diagram' && a.context.diagramId === diagId, '载入切片 ② 框图')
  check('框图页载入切片 ② 示例', st.app.context.diagramId === 'slice2-scenario-link',
        st.app.context.diagramId ?? '')
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const before = (await page.waitFor((s) => !!s.app, { label: '取当前任务' })).app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await waitApp(page, (a) => a.context.taskId && a.context.taskId !== before, '任务已提交')
  const taskId = st.app.context.taskId
  check('通过界面提交场景绑定框图', !!taskId, taskId ?? '')

  st = await waitApp(page, (a) => ['finished', 'failed', 'cancelled'].includes(a.task.runState), '任务结束', 180000)
  check('任务跑完且结果有效', st.app.task.runState === 'finished' && st.app.task.result === 'valid',
    `${st.app.task.runState} / ${st.app.task.result}`)

  // ---------- 断言 ①：三时刻位置与黄金航迹 ----------
  const track = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/track?t0=0&t1=1000000000&stride=1').then(r=>r.json())`)
  check('引擎产出了航迹', Array.isArray(track) && track.length > 100, Array.isArray(track) ? `${track.length} 条` : JSON.stringify(track).slice(0, 120))
  if (!Array.isArray(track) || !track.length) throw new Error('没有航迹，后面的断言无从谈起')
  const byT = new Map(track.map((r) => [Number(r.t_s).toFixed(3), r]))
  const tol = golden.tolerance.position_deg
  const moments = [5, 15, 25]
  let worst = 0
  let matched = 0
  for (const t of moments) {
    const g = golden.samples.find((s) => Math.abs(s.t_s - t) < 1e-9 && s.id === 'uav-1')
    const r = byT.get(t.toFixed(3))
    if (!g || !r) continue
    matched++
    worst = Math.max(worst, Math.abs(r.lon - g.lon), Math.abs(r.lat - g.lat))
  }
  check(`三时刻位置与黄金航迹差 ≤ ${tol} 度`, matched === moments.length && worst < tol,
    `匹配 ${matched}/${moments.length} 个时刻，最大差 ${worst.toExponential(2)} 度`)

  // 地图上画的实体必须与航迹末条一致（图标确实是按引擎给的位置画的）
  st = await waitApp(page, (a) => a.view === 'scene' ? true : true, '取态势快照')
  await page.pressKey(alt(1))
  st = await waitApp(page, (a) => a.entities.length >= 1, '场景页出现目标', 30000)
  const shown = st.app.entities[0]
  const lastTrack = track[track.length - 1]
  check('地图上的目标位置与引擎航迹一致', Math.abs(shown.lon - lastTrack.lon) < 1e-9 && Math.abs(shown.lat - lastTrack.lat) < 1e-9,
    `图上 ${shown.lon.toFixed(6)},${shown.lat.toFixed(6)}；航迹 ${Number(lastTrack.lon).toFixed(6)},${Number(lastTrack.lat).toFixed(6)}`)
  check('链路读数已到达（视距、距离、路损、多普勒）', st.app.links.length === 1 && st.app.links[0].los === true && st.app.links[0].distance_m > 0 && st.app.links[0].pathLoss_dB > 50,
    JSON.stringify(st.app.links[0]))
  // 链路线要真画在图上（13 报告 §6.2，D-061）：此前 link_id 按最后一个连字符拆分取不到站，
  // 图层在、要素恒空，而这里只断言了数据，所以一直绿。
  let linkDrawn = -1
  for (let i = 0; i < 25 && linkDrawn < 1; i++) {
    linkDrawn = await page.evaluateAsync("new Promise((r) => setTimeout(() => r(window.__map ? window.__map.queryRenderedFeatures({layers:['cuav-link-line']}).length : -1), 200))")
  }
  check('链路线渲染出要素（link_id 按已知的站与源精确匹配）', linkDrawn >= 1, `${linkDrawn} 个要素`)

  // ---------- 断言 ②：两时刻带内功率差 vs 几何路损差 ----------
  const links = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/links?t0=0&t1=1000000000&stride=1').then(r=>r.json())`)
  const idx = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/s4/spectrum/index').then(r=>r.json())`)
  const nfft = idx.nfft, fs = idx.sample_rate_Hz, hop = idx.frame_hop_samples
  const binW = fs / nfft
  const offset = scenario.emitters[0].emission.waveform.offset_Hz
  const half = 5
  const f0 = offset - (half + 0.5) * binW
  const f1 = offset + (half + 0.5) * binW
  const rows = idx.rows_available
  const cols = 2 * half + 1
  const q = `?t0=0&t1=1000000000&f0=${f0}&f1=${f1}&px=${cols}&py=${rows}&stat=max`
  const buf = await page.evaluateAsync(
    `fetch('/api/v1/results/${taskId}/s4/spectrum${q}').then(r=>r.arrayBuffer()).then(b=>Array.from(new Float32Array(b)))`)
  check('按视窗抽取到谱矩阵', Array.isArray(buf) && buf.length === rows * cols, `${rows} × ${cols}`)

  const bandPower = (row) => {
    let lin = 0
    for (let c = 0; c < cols; c++) lin += Math.pow(10, buf[row * cols + c] / 10)
    return 10 * Math.log10(lin)
  }
  const rowOf = (t) => Math.min(rows - 1, Math.max(0, Math.round((t * fs) / hop)))
  const lossAt = (t) => {
    let best = null
    for (const l of links) if (best === null || Math.abs(l.t_s - t) < Math.abs(best.t_s - t)) best = l
    return best
  }
  const tA = 5, tB = 25
  const rA = rowOf(tA), rB = rowOf(tB)
  const tRA = (rA * hop) / fs, tRB = (rB * hop) / fs
  const pA = bandPower(rA), pB = bandPower(rB)
  const lA = lossAt(tRA), lB = lossAt(tRB)
  const measured = pA - pB
  const geometric = lB.path_loss_dB - lA.path_loss_dB
  check('两时刻带内功率差与几何路损差 ≤ 0.5 dB', Math.abs(measured - geometric) <= 0.5,
    `t=${tRA.toFixed(2)}s ${pA.toFixed(2)} dBm（${lA.distance_m.toFixed(0)} m），t=${tRB.toFixed(2)}s ${pB.toFixed(2)} dBm（${lB.distance_m.toFixed(0)} m）；` +
    `实测差 ${measured.toFixed(3)} dB，几何差 ${geometric.toFixed(3)} dB，偏差 ${Math.abs(measured - geometric).toFixed(3)} dB`)
  check('功率确实随距离下降（瀑布上看得到的那条渐暗的线）', pA > pB && geometric > 3, `衰落 ${geometric.toFixed(2)} dB`)

  // ---------- 视距探测：点选建筑两侧一致（D3-7，切片 ⑤ 的验收；07 报告 §2.4） ----------
  // 遮挡落点选了「浏览器也算一份」（D-074 ①）之后，这条验收从「布两次目标各跑一次任务」
  // 变成一次点击就能验的事。这里验的是**交互与渲染—物理同源**：楼是从渲染图层上挑的
  // （铁律 11 的同一份 GeoJSON），点是按它的轮廓算的，判定由浏览器复算给出。
  // 物理本身不在这儿验——那由 tests/golden/occlusion{,-aoi}.json 两侧各守一遍。
  if (!existsSync(join(ROOT, 'data/scene/beijing-yayuncun/buildings.geojson'))) {
    // data/** 不入 git（D-027）。**这不是通过**，是跳过（先例 D-073 ③）。
    console.error('  … 跳过视距探测：buildings.geojson 不在盘上')
  } else {
  await page.evaluate("(document.querySelector('[data-tool=los]').click(), true)")
  st = await waitApp(page, (a) => a.scene.tool === 'los', '切到视距探测')
  const cv = JSON.parse(await page.evaluate(
    "(() => { const c = document.querySelector('.scene-map canvas'); const r = c.getBoundingClientRect();"
    + " return JSON.stringify({x: r.x, y: r.y, w: r.width, h: r.height}) })()"))
  const clickAt = async (lon, lat) => {
    const px = JSON.parse(await page.evaluate(
      `(() => { const p = window.__map.project([${lon}, ${lat}]); return JSON.stringify({x: p.x, y: p.y}) })()`))
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', {
        type, x: Math.round(cv.x + px.x), y: Math.round(cv.y + px.y), button: 'left', clickCount: 1 })
    }
    return page.waitFor((x) => x.app?.losProbe?.status === 'ready'
      && Math.abs(x.app.losProbe.lon - lon) < 1e-4 && Math.abs(x.app.losProbe.lat - lat) < 1e-4,
      { label: `探测 ${lon.toFixed(5)},${lat.toFixed(5)}`, timeoutMs: 30000 })
  }

  // 第一次点会把 15.9 MB 的建筑几何取下来（懒加载，D3-6）——首屏那条断言证的就是它之前没取
  st = await clickAt(116.4075, 39.9915)
  check('第一次探测才把建筑几何取下来，取到的栋数与引擎一致（47662）',
    st.app.occlusion.status === 'ready' && st.app.occlusion.buildings === 47662,
    JSON.stringify(st.app.occlusion))
  const card = JSON.parse(await page.evaluate(
    "(() => { const el = document.querySelector('[data-form=los-probe]');"
    + " return JSON.stringify({ has: !!el, verdict: el?.querySelector('[data-los-probe-verdict]')?.dataset.losProbeVerdict ?? '',"
    + " text: el?.textContent ?? '' }) })()"))
  check('右栏出视距探测卡，摆出站、点、假设高度、距离、视距与刀口损耗',
    card.has && /视距探测/.test(card.text) && /假设目标高度/.test(card.text) && /刀口绕射损耗/.test(card.text)
    && (card.verdict === 'los' || card.verdict === 'nlos'), card.verdict)
  check('探测线画在图上，颜色跟着视距与否走（与链路线同一对色）',
    (await page.evaluateAsync("new Promise((r) => setTimeout(() => r(window.__map.queryRenderedFeatures({layers:['cuav-losprobe-line','cuav-losprobe-dot']}).length), 200))")) >= 2)

  // 假设高度固定在 40 m：站在 30 m，这条视线在楼那儿只有 30–40 m 高，
  // 60 m 以上的楼必挡得住。**固定下来是必须的**——否则下一次点击会跳回焦点目标那一档（此刻 160 m）
  await page.evaluate(`(() => {
    const el = document.querySelector('[data-field=los-height]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '40');
    el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  st = await waitApp(page, (a) => a.losProbe.height_agl_m === 40, '把假设高度固定在 40 m')
  check('假设高度是一个可改的输入，改了立即重算', st.app.losProbe.height_agl_m === 40)

  // 从**渲染图层**上挑一栋高过 60 m 的楼（铁律 11：渲染与遮挡吃的是同一份 GeoJSON），
  // 沿「站 → 楼心」在楼前楼后各取一点。
  const site = st.app.losProbe   // 站址在场景里，直接从场景文件取更稳
  const sp = scenario.sites[0].position
  const cands = JSON.parse(await page.evaluate(`(() => {
    const m = window.__map;
    const mPerDegLat = 111034.4, mPerDegLon = 111320 * Math.cos(${sp.lat} * Math.PI / 180);
    const out = [];
    for (const f of m.queryRenderedFeatures({ layers: ['aoi-buildings-3d'] })) {
      const h = f.properties && f.properties.height_m;
      if (!(h >= 60)) continue;
      const g = f.geometry; if (!g || g.type !== 'Polygon') continue;
      const ring = g.coordinates[0]; if (!ring || ring.length < 4) continue;
      let cx = 0, cy = 0; for (const p of ring) { cx += p[0]; cy += p[1]; }
      cx /= ring.length; cy /= ring.length;
      let half = 0;
      for (const p of ring) half = Math.max(half, Math.hypot((p[0]-cx)*mPerDegLon, (p[1]-cy)*mPerDegLat));
      const dx = (cx - ${sp.lon}) * mPerDegLon, dy = (cy - ${sp.lat}) * mPerDegLat;
      const r = Math.hypot(dx, dy);
      if (r < 120 || r > 700) continue;
      const near = [${sp.lon} + dx / r * (r - half - 25) / mPerDegLon, ${sp.lat} + dy / r * (r - half - 25) / mPerDegLat];
      const far  = [${sp.lon} + dx / r * (r + half + 25) / mPerDegLon, ${sp.lat} + dy / r * (r + half + 25) / mPerDegLat];
      const pf = m.project(far);
      // 两个点都得落在画布中间部分，不然点不到
      if (pf.x < m.getCanvas().clientWidth * 0.1 || pf.x > m.getCanvas().clientWidth * 0.9) continue;
      if (pf.y < m.getCanvas().clientHeight * 0.1 || pf.y > m.getCanvas().clientHeight * 0.9) continue;
      out.push({ id: String(f.properties.id), h, r, near, far });
    }
    out.sort((a, b) => a.r - b.r);
    return JSON.stringify(out.slice(0, 6));
  })()`))
  check('地图上挑得到高过 60 m 的楼（渲染与遮挡同一份 GeoJSON，铁律 11）', cands.length > 0, `${cands.length} 栋候选`)
  let picked = null
  let farAllBlocked = true
  for (const c of cands) {
    const far = (await clickAt(c.far[0], c.far[1])).app.losProbe
    if (far.line_of_sight) { farAllBlocked = false; continue }
    const near = (await clickAt(c.near[0], c.near[1])).app.losProbe
    if (near.line_of_sight) { picked = { c, near, far }; break }
  }
  check('楼后那一侧无条件非视距（视线在楼那儿只有 30–40 m，楼有 60 m 以上）', farAllBlocked)
  check('点选建筑两侧一致：楼前视距、楼后非视距且报得出刀口损耗（切片 ⑤ 验收）',
    !!picked && picked.near.line_of_sight === true && picked.far.line_of_sight === false
    && picked.far.diffraction_dB > 0 && picked.near.diffraction_dB === 0,
    picked ? `楼 ${picked.c.id}（${picked.c.h} m，${picked.c.r.toFixed(0)} m 外）：`
      + `楼前视距，楼后 ${picked.far.diffraction_dB.toFixed(1)} dB、侵入 ${picked.far.intrusion_m.toFixed(1)} m`
      : `${cands.length} 栋候选里没有一栋的楼前是开阔的`)
  await page.evaluate("(document.querySelector('[data-action=clear-los-probe]')?.click(), true)")
  await page.evaluate("(document.querySelector('[data-tool=los]').click(), true)")
  await waitApp(page, (a) => a.scene.tool === 'select', '放下视距工具')
  }

  // ---------- 链路线第一次变红：跑一条 E3 的链（D3-7） ----------
  // `line_of_sight` 从链路帧一路通到链路线着色，非视距红 #b91c1c 在 D2-4 标定过对比度，
  // 但**在 D3-5 之前一次也没画出来过**——缺的只是生产者（07 报告 §1 第 2 行）。
  // 这里跑一条 E3 的链把它画出来：demo-01 起飞头几秒被 62 m 的楼挡着（D3-5 实测 36.98 dB），
  // 所以 3 秒的窗口里全程非视距。
  const e3Id = await loadDiagramViaApi(page, 'tests/regression/diagrams/chain-demo-01-e3.json',
                                       '?scenario=demo-01#/diagram', (d) => {
    d.diagram_id = 'slice2-e3-nlos'
    d.name = 'slice2 E3 非视距（端到端用，跑完即删）'
    d.run.duration_s = 3
    for (const n of d.nodes) if (n.params && 'total_samples' in n.params) n.params.total_samples = 1500000
  })
  st = await waitApp(page, (a) => a.view === 'diagram' && a.context.diagramId === e3Id, '载入 E3 框图')
  const e3Checks = JSON.parse(await page.evaluate(
    "(() => { const out = {}; for (const el of document.querySelectorAll('[data-check]'))"
    + " out[el.dataset.check] = el.dataset.ok; return JSON.stringify(out) })()"))
  check('E3 在框图页不再置灰：档位自洽与建筑几何两项都通过（D3-7）',
    e3Checks.propagation === '1' && e3Checks.prop_scene === '1', JSON.stringify(e3Checks))
  // 卡片上只列「这一档包含哪几项」（D-058 用户拍板第 ① 条），逐项开关在右栏
  const propText = await page.evaluate(
    "(() => { const el = document.querySelector('[data-slot-effects]');"
    + " return (el?.dataset.slotEffects ?? '') + '|' + (el?.textContent ?? '') })()")
  check('传播卡片列出这一档包含哪几项，含建筑遮挡（E3 的 diffraction 每帧都声明）',
    /free_space,diffraction/.test(propText) && /E3/.test(propText) && /建筑遮挡/.test(propText), propText)

  for (let i = 0; i < 40; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const beforeE3 = (await page.waitFor((x) => !!x.app, { label: '取当前任务' })).app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await waitApp(page, (a) => a.context.taskId && a.context.taskId !== beforeE3, 'E3 任务已提交')
  const e3Task = st.app.context.taskId
  st = await waitApp(page, (a) => ['finished', 'failed', 'cancelled'].includes(a.task.runState), 'E3 任务结束', 180000)
  check('E3 任务跑完（服务端不传 --scene-root，引擎按缺省的 data/scene 找建筑）',
    st.app.task.runState === 'finished' && st.app.task.result === 'valid',
    `${st.app.task.runState} / ${st.app.task.result}`)
  await page.pressKey(alt(1))
  st = await waitApp(page, (a) => a.links.length >= 1 && a.links[0].los === false, '链路读数报非视距', 30000)
  check('链路第一次报非视距，刀口损耗算进了路损（D3-5 实测起飞处 36.98 dB）',
    st.app.links[0].los === false && st.app.links[0].pathLoss_dB > 120,
    JSON.stringify(st.app.links[0]))
  const redLine = JSON.parse(await page.evaluateAsync(
    "new Promise((r) => setTimeout(() => r(JSON.stringify(window.__map.queryRenderedFeatures({layers:['cuav-link-line']})"
    + ".map((f) => f.properties.los))), 300))"))
  check('链路线第一次画成红的（非视距色 #b91c1c，D2-4 标定过对比度却一直没有生产者）',
    redLine.length >= 1 && redLine.every((x) => x === false), JSON.stringify(redLine))
  await deleteDiagram(page, e3Id)
  // 回到切片 ② 那份框图与任务，后面的场景编辑断言接着用它
  await loadDiagramViaApi(page, 'engine/tests/diagrams/slice2_scenario_link.json', '?scenario=demo-01#/scene')
  st = await waitApp(page, (a) => a.view === 'scene', '回到场景页')

  // ---------- 表单编辑与保存场景 ----------
  // 先把前面「布站→撤销→重做→撤销」留下的未保存状态存一次：场景文件已是编辑器的规范序列化
  // （JSON.stringify(doc, null, 2) + 换行），内容没变时保存是逐字节的空操作，哈希不变。
  if (st.app.unsaved.scene) {
    await page.evaluate("(document.querySelector('[data-act=save-scenario]').click(), true)")
    st = await waitApp(page, (a) => a.unsaved.scene === false, '存回基线', 30000)
  }
  const sha0 = st.app.scene.scenarioSha256
  check('空操作保存不改变文件哈希（场景文件已是编辑器的规范形式）', sha0 === golden.scenario_sha256,
    `${sha0.slice(0, 8)}… vs 基准 ${golden.scenario_sha256.slice(0, 8)}…`)

  const treeSites = await page.evaluate("Array.from(document.querySelectorAll('[data-tree-site]')).map(b=>b.dataset.treeSite)")
  check('对象树里有站点行可点', Array.isArray(treeSites) && treeSites.length === 1, JSON.stringify(treeSites))
  await page.evaluate("(document.querySelector('[data-tree-site]').click(), true)")
  st = await waitApp(page, (a) => a.scene.selection?.kind === 'site', '选中站点')
  for (let i = 0; i < 40 && !(await page.evaluate("!!document.querySelector('[data-form=site]')")); i++) await sleep(100)
  const alt0 = await page.evaluate("document.querySelector('[data-field=\"sites.0.position.alt_m\"]')?.value ?? ''")
  check('左栏出站点表单且带离地高字段', alt0 !== '', `离地高 ${alt0}`)
  // React 把 onBlur 接在原生的 focusout 上（blur 不冒泡），派发 blur 是没用的
  const setAlt = (v) => page.evaluate(`(() => {
    const el = document.querySelector('[data-field="sites.0.position.alt_m"]');
    el.value = '${v}';
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  })()`)
  await setAlt('45')
  st = await waitApp(page, (a) => a.unsaved.scene === true, '改高度后标脏')
  check('改站点离地高即标未保存', st.app.unsaved.scene === true, `原值 ${alt0} → 45`)
  await page.evaluate("(document.querySelector('[data-act=save-scenario]').click(), true)")
  st = await waitApp(page, (a) => a.unsaved.scene === false && a.scene.scenarioSha256 !== sha0, '保存场景', 30000)
  check('保存后回到已保存，并拿到新的落盘哈希', /^[0-9a-f]{64}$/.test(st.app.scene.scenarioSha256) && st.app.scene.scenarioSha256 !== sha0,
    `${sha0.slice(0, 8)}… → ${st.app.scene.scenarioSha256.slice(0, 8)}…`)

  // 改回去：这条测试不该在仓库里留副作用
  await setAlt(alt0)
  await waitApp(page, (a) => a.unsaved.scene === true, '改回原值')
  await page.evaluate("(document.querySelector('[data-act=save-scenario]').click(), true)")
  st = await waitApp(page, (a) => a.unsaved.scene === false, '存回原样', 30000)
  check('测试不留副作用：场景已存回原样，哈希与基准一致', st.app.scene.scenarioSha256 === golden.scenario_sha256,
    `${st.app.scene.scenarioSha256.slice(0, 8)}… vs 基准 ${golden.scenario_sha256.slice(0, 8)}…`)

  await page.screenshot(join(tmpdir(), 'cuav-slice2-smoke.png'))
  console.log(`截图 ${join(tmpdir(), 'cuav-slice2-smoke.png')}`)
} catch (e) {
  console.error(`\n中断：${(e && e.message) ? e.message.slice(0, 300) : e}`)
  checks.push({ name: '端到端跑完（未中断）', ok: false, detail: String((e && e.message) || e).slice(0, 200) })
} finally {
  // 删掉本用例存进去的那份手写框图（同下面恢复场景文件，走 HTTP 不依赖页面还活着）
  await fetch(`${BASE}api/v1/diagrams/slice2-scenario-link`, { method: 'DELETE' }).catch(() => undefined)
  // 场景文件是黄金基准指向的对象，本用例中途改了它。**恢复必须在 finally 里**：
  // 用例在改完之后、存回之前被打断过一次（2026-09-07），仓库因此留着 3 个站点 6 个航点的
  // 场景文件，直到别的测试报「哈希对不上」才发现。走 HTTP 直接写回，不依赖页面还活着。
  try {
    const cur = await fetch(`${BASE}api/v1/scenarios/demo-01`)
    if (cur.ok && cur.headers.get('x-cuav-sha256') !== golden.scenario_sha256) {
      console.error(`\n场景文件与基准不符（${cur.headers.get('x-cuav-sha256')?.slice(0, 8)}… vs ${golden.scenario_sha256.slice(0, 8)}…），`
        + '本用例改过它但没能存回。请用 git 恢复 data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json')
      checks.push({ name: '测试不留副作用：场景文件与基准一致', ok: false, detail: '中途被打断，场景未存回原样' })
    }
  } catch { /* 服务不在就没法查，交给下一次单测的哈希对拍 */ }
  if (typeof pageErrors !== 'undefined' && pageErrors.length) {
    console.error('\n页面异常：')
    for (const x of pageErrors.slice(0, 5)) console.error('  ' + x)
  }
  if (page) await page.close(chrome.port).catch(() => {})
  if (chrome) chrome.proc.kill()
  // 清理失败不能掐掉结果打印：Chrome 退出后可能还在写 profile 目录，rm 会抛 ENOTEMPTY，
  // 而结果是在 finally 之后才打印的（2026-09-07 实测，scene-smoke 因此看不到断言结果）。
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

const bad = checks.filter((c) => !c.ok)
console.log(`\n共 ${checks.length} 项，失败 ${bad.length} 项`)
for (const c of bad) console.log(`  失败：${c.name}${c.detail ? `  —— ${c.detail}` : ''}`)
process.exit(bad.length ? 1 : 0)
