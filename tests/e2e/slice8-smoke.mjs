// 切片 ⑧「一屏讲清楚」的端到端验收（06 备忘录 §9E、§9J；设计见 13 报告 §11；决策 D-061）。
//
// V-1（本文件首版）：
//   ① 场景页右栏不点选就有目标列表与三张目标卡、三张站点卡；
//   ② 卡上每站一行的距离 / 方位 / 路损与 links 端点里该链路的最后一行逐值相等，接收电平等于
//      发射功率 + 两端天线增益 − 路损、信噪比等于电平 − (−174 + nf + 10·log10 fs)（13 §3.2）；
//   ③ 测向行与 bearings 端点的最后一行相等，定位行与 positions 端点相等；
//   ④ 点目标行即选中该辐射源，表单叠在栈顶，「返回卡片」清掉选中；
//   ⑤ 刷新后场景跟着最近任务（demo-03），不落到清单第一项（13 §6.1）；链路线渲染出要素（13 §6.2）。
// V-2（告警区与叠加加重）：
//   ⑥ 场景里有告警区 z-east，地图上画出圈与高度立柱，十三个态势图层齐全；跑 70 s 后 uav-2 在圈内
//      （13 报告 §4.3 的几何判定）：卡片带徽标、列表行带徽标、图标换红环变体，其余两架不在；
//   ⑦ 对象树有告警区行，点开是告警区表单；图层弹层可关掉告警区与立柱。
// V-3 的断言随该步骤追加。
//
// 跑法（先起服务：cd server && npm run build && node dist/index.js；引擎已构建；web/dist 为最新）：
//     node tests/e2e/slice8-smoke.mjs [--url http://127.0.0.1:8080/]

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchChrome, Page } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(Boolean))
const BASE = (args.url ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }
/** 排障用：CUAV_E2E_TRACE=1 时把走到哪一步打到 stderr（本文件曾在一处无超时的调试协议调用上挂死）。 */
const trace = (m) => { if (process.env.CUAV_E2E_TRACE) console.error(`[slice8 ${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`) }
const T0 = Date.now()
const evalJson = async (page, expr) => page.evaluate(expr)
const setSelect = (sel, value) => `(() => {
  const el = document.querySelector('${sel}');
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, '${value}');
  el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`
const setInput = (sel, value) => `(() => {
  const el = document.querySelector('${sel}');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '${value}');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('focusout', { bubbles: true }));
  return true })()`
const waitDom = async (page, expr, want, ms = 6000) => {
  const t0 = Date.now()
  let got
  do {
    got = await page.evaluate(expr)
    if (got === want) return got
    await sleep(100)
  } while (Date.now() - t0 < ms)
  return got
}
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
/** 每个键的最后一行（t_s 最大者）。 */
const lastByKey = (rows, keyOf) => {
  const m = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    const cur = m.get(k)
    if (!cur || r.t_s > cur.t_s) m.set(k, r)
  }
  return m
}

let chrome, page, dir
const pageErrors = []
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-slice8-'))
  chrome = await launchChrome({ userDataDir: dir, windowSize: '1920,1200' })
  page = await Page.open(chrome.port, 'about:blank')
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0]))

  // ---------- ① 在框图页把 demo-03 三站三源跑一遍（测向与多站定位都开） ----------
  trace('进入 ① 在框图页把 demo-03 三站三源跑一遍（测向与多站定位都开）')
  await page.send('Page.navigate', { url: `${BASE}?scenario=demo-03#/diagram` })
  trace('已发 Page.navigate')
  await page.waitFor((s) => s.ready && s.app?.view === 'diagram' && s.app?.chain?.template === 'chain-v1', { label: '框图页', timeoutMs: 90000 })
  trace('过了 框图页')
  await sleep(800)
  await page.evaluate(setSelect('[data-form=chain-setup] [data-field=scenario]', 'demo-03'))
  await sleep(1500)
  await waitDom(page, "document.querySelectorAll('[data-multi=site] input').length", 3)
  await waitDom(page,
    "Array.from(document.querySelectorAll('[data-multi=site] input, [data-multi=emitter] input')).every(e => e.checked)", true)
  let st = await page.waitFor((s) => (s.app?.chain?.siteIds ?? []).length === 3 && (s.app?.chain?.emitterIds ?? []).length === 3,
    { label: '三站三源进状态' })
  for (const slot of ['df', 'loc']) {
    await page.evaluate(`(() => { const el = document.querySelector('[data-slot-bypass=${slot}]'); if (el && el.checked) el.click(); return true })()`)
    await sleep(300)
  }
  // 70 s：uav-2 在 t ≈ 58 s 拐上东侧腿，t = 70 s 时离 z-east 圆心约 250 m，在圈内；uav-1 与 uav-3 在圈外
  await page.evaluate(setInput('[data-form=chain-setup] [data-field=duration_s]', '70'))
  await sleep(400)
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const before = st.app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  st = await page.waitFor((s) => s.app?.context?.taskId && s.app.context.taskId !== before, { label: '任务已提交' })
  trace('过了 任务已提交')
  const taskId = st.app.context.taskId
  st = await page.waitFor((s) => ['finished', 'failed', 'cancelled'].includes(s.app?.task?.runState), { label: '任务结束', timeoutMs: 300000 })
  trace('过了 任务结束')
  check('demo-03 三站三源任务跑完（70 s）', st.app.task.runState === 'finished', `${taskId} ${st.app.task.runState} / ${st.app.task.result}`)

  // ---------- ② 场景页：右栏不点选就有卡 ----------
  trace('进入 ② 场景页：右栏不点选就有卡')
  await page.evaluate("(window.location.hash = '#/scene', true)")
  await page.waitFor((s) => s.app?.view === 'scene', { label: '场景页' })
  trace('过了 场景页')
  st = await page.waitFor((s) => (s.app?.links ?? []).length === 9 && (s.app?.bearings ?? []).length === 9, { label: '回看数据补齐', timeoutMs: 30000 })
  trace('过了 回看数据补齐')
  await sleep(600)   // 卡片按 4 Hz 定频重算
  st = await page.waitFor((s) => (s.app?.cards ?? []).length === 3 && s.app.cards.every((c) => c.sites.every((r) => r.source === 'link')), { label: '卡片按链路帧算好' })
  trace('过了 卡片按链路帧算好')
  check('探针里三张目标卡、每张三站行且都来自链路帧', st.app.cards.length === 3 && st.app.cards.every((c) => c.sites.length === 3))
  check('三张站点卡', (st.app.siteCards ?? []).length === 3, JSON.stringify(st.app.siteCards))
  const dom = await evalJson(page, `({
    stack: document.querySelectorAll('[data-card-stack]').length,
    rows: document.querySelectorAll('[data-target-row]').length,
    cards: document.querySelectorAll('[data-card]').length,
    open: document.querySelectorAll('[data-card-open]').length,
    siteRows: document.querySelectorAll('[data-card-open] [data-card-site]').length,
    dials: document.querySelectorAll('[data-card-open] svg.dial').length,
    fixes: document.querySelectorAll('[data-card-open] [data-card-fix]').length,
    siteCards: document.querySelectorAll('[data-site-card]').length,
    selBar: document.querySelectorAll('[data-selection-bar]').length,
    placeholder: /在左栏或地图上选一个对象/.test(document.body.textContent),
  })`)
  check('右栏不点选即有目标列表 3 行、3 张卡（1 张展开）、站点卡 3 张，没有空态提示',
    dom.stack === 1 && dom.rows === 3 && dom.cards === 3 && dom.open === 1 && dom.siteCards === 3 && dom.selBar === 0 && !dom.placeholder,
    JSON.stringify(dom))
  check('展开的卡里每站一行、每行一个方位盘、有定位块', dom.siteRows === 3 && dom.dials === 3 && dom.fixes >= 1, JSON.stringify(dom))

  // ---------- ③ 卡上的数 = 端点行 ----------
  trace('进入 ③ 卡上的数 = 端点行')
  // 只取末尾半秒：卡片比的是每键的最后一行。整段取回是几 MB 的 JSON，经调试协议回传会把套接字撑断，
  // 第一次这么写就在这里挂死（cdp.mjs 现在会把挂起的调用拒掉，但没必要搬那么多）
  const tEnd = st.app.task.t_s
  const tail = (kind) => page.evaluateAsync(`fetch('/api/v1/results/${taskId}/${kind}?t0=${Math.max(0, tEnd - 0.5)}&t1=1e9&stride=1').then(r => r.json())`)
  const links = await tail('links')
  const bearings = await tail('bearings')
  const positions = await tail('positions')
  trace(`取回末尾 links ${links.length} / bearings ${bearings.length} / positions ${positions.length}`)
  const scn = (await page.evaluateAsync("fetch('/api/v1/scenarios/demo-03').then(r => r.json())"))
  const lastLink = lastByKey(links, (r) => r.link_id)
  const lastBearing = lastByKey(bearings, (r) => r.link_id)
  const lastPos = lastByKey(positions, (r) => `${r.emitter_id}:${r.method}`)
  const siteOf = Object.fromEntries(scn.sites.map((s) => [s.id, s]))
  const emOf = Object.fromEntries(scn.emitters.map((e) => [e.id, e]))
  let geomOk = 0, geomN = 0, rxOk = 0, bOk = 0, bN = 0
  const bad = []
  for (const c of st.app.cards) {
    for (const r of c.sites) {
      const l = lastLink.get(`${r.site_id}-${c.id}`)
      geomN++
      if (l && near(r.distance_m, l.distance_m, 1e-6) && near(r.azimuth_deg, l.azimuth_deg, 1e-6) && near(r.path_loss_dB, l.path_loss_dB, 1e-6)) geomOk++
      else bad.push(`${r.site_id}-${c.id} 几何`)
      const em = emOf[c.id], s = siteOf[r.site_id]
      const rx = em.emission.tx_power_dBm + em.emission.antenna_gain_dBi + s.antenna.gain_dBi - (l?.path_loss_dB ?? NaN)
      const snr = rx - (-174 + s.receiver.nf_dB + 10 * Math.log10(s.receiver.fs_Hz))
      if (near(r.rx_dBm, rx, 1e-6) && near(r.snr_dB, snr, 1e-6)) rxOk++
      else bad.push(`${r.site_id}-${c.id} 电平 ${r.rx_dBm} vs ${rx}`)
      const b = lastBearing.get(`${r.site_id}-${c.id}`)
      if (b) {
        bN++
        if (near(r.bearing_deg, b.bearing_deg, 1e-6) && near(r.sigma_deg, b.bearing_std_deg, 1e-6) && r.df_quality === b.df_quality) bOk++
        else bad.push(`${r.site_id}-${c.id} 测向`)
      }
    }
  }
  check('9 行的距离 / 方位 / 路损与 links 端点的最后一行逐值相等', geomN === 9 && geomOk === 9, bad.join('；') || `${geomOk}/${geomN}`)
  check('9 行的接收电平 = 发射功率 + 两端天线增益 − 路损，信噪比 = 电平 − 带内噪声', rxOk === 9, bad.join('；') || `${rxOk}/9`)
  check('9 行的测向方位 / σ / 质量档与 bearings 端点的最后一行相等', bN === 9 && bOk === 9, bad.join('；') || `${bOk}/${bN}`)
  let fixOk = 0, fixN = 0
  for (const c of st.app.cards) for (const f of c.fixes) {
    fixN++
    const p = lastPos.get(`${c.id}:${f.method}`)
    if (p && near(f.cep_m, p.cep_m, 1e-6)) fixOk++
  }
  check('定位行的 CEP 与 positions 端点相等', fixN >= 3 && fixOk === fixN, `${fixOk}/${fixN}`)

  // ---------- ⑥ V-2：告警区、立柱、图层、入圈 ----------
  trace('进入 ⑥ V-2：告警区、立柱、图层、入圈')
  const LAYERS = ['cuav-zone-fill', 'cuav-zone-line', 'cuav-link-line', 'cuav-link-label', 'cuav-route-line', 'cuav-trail-line',
    'cuav-waypoint-dot', 'cuav-site-dot', 'cuav-site-icon', 'cuav-target-pole', 'cuav-target-ring', 'cuav-target-icon', 'cuav-target-label']
  check('十三个态势图层齐全', LAYERS.every((x) => st.layers.includes(x)), LAYERS.filter((x) => !st.layers.includes(x)).join(','))
  check('场景里有告警区 z-east', (st.app.scene.zones ?? []).length === 1 && st.app.scene.zones[0].id === 'z-east', JSON.stringify(st.app.scene.zones))
  const rendered = async (layer) => {
    let n = -1
    for (let i = 0; i < 25 && n < 1; i++) {
      n = await page.evaluateAsync(`new Promise((r) => setTimeout(() => r(window.__map ? window.__map.queryRenderedFeatures({layers:['${layer}']}).length : -1), 200))`)
    }
    return n
  }
  check('告警圈画在图上', (await rendered('cuav-zone-fill')) >= 1)
  check('高度立柱画在图上', (await rendered('cuav-target-pole')) >= 1)
  check('链路距离标注画在图上', (await rendered('cuav-link-label')) >= 1)
  const inZone = Object.fromEntries(st.app.cards.map((c) => [c.id, c.inZone]))
  check('70 s 末尾只有 uav-2 在 z-east 圈内（几何判定）', inZone['uav-2'] === 'z-east' && inZone['uav-1'] === null && inZone['uav-3'] === null, JSON.stringify(inZone))
  const zoneDom = await evalJson(page, `({
    cardBadge: document.querySelector('[data-card="uav-2"] [data-card-zone]')?.dataset.cardZone ?? null,
    rowBadge: document.querySelector('[data-target-row="uav-2"] [data-row-zone]')?.dataset.rowZone ?? null,
    others: document.querySelectorAll('[data-card="uav-1"] [data-card-zone], [data-card="uav-3"] [data-card-zone]').length,
  })`)
  check('入圈目标的卡片与列表行带「告警区」徽标，其余没有', zoneDom.cardBadge === 'z-east' && zoneDom.rowBadge === 'z-east' && zoneDom.others === 0, JSON.stringify(zoneDom))
  const iconFeat = await page.evaluateAsync(`new Promise((r) => setTimeout(() => r(window.__map ? window.__map.queryRenderedFeatures({layers:['cuav-target-icon']}).map((f) => [f.properties.id, f.properties.alert]) : []), 200))`)
  const alertMap = Object.fromEntries(iconFeat)
  check('入圈目标的图标换红环变体（alert 属性），其余不换', alertMap['uav-2'] === true && alertMap['uav-1'] === false && alertMap['uav-3'] === false
    && (await evalJson(page, "window.__map ? window.__map.hasImage('cuav-drone-alert') : false")) === true, JSON.stringify(alertMap))

  // ---------- ⑦ V-2：对象树、表单、图层弹层 ----------
  trace('进入 ⑦ V-2：对象树、表单、图层弹层')
  await page.evaluate("(document.querySelector('[data-tree-zone=\"z-east\"]').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  st = await page.waitFor((s) => s.app?.scene?.selection?.kind === 'zone', { label: '选中告警区' })
  trace('过了 选中告警区')
  const zoneForm = await waitDom(page, "document.querySelectorAll('[data-form=zone]').length", 1)
  check('对象树有告警区行，点开是告警区表单', zoneForm === 1 && st.app.scene.selection.id === 'z-east')
  await page.evaluate("(document.querySelector('[data-action=clear-selection]').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  await page.waitFor((s) => s.app?.scene?.selection === null, { label: '取消选中' })
  trace('过了 取消选中')
  await page.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((e) => e.textContent.includes('图层'));
    if (b) b.click(); return true })()`)
  const toggles = await waitDom(page, "document.querySelectorAll('[data-layer=zones], [data-layer=poles]').length", 2)
  check('图层弹层里有「告警区」与「高度立柱」开关', toggles === 2, `${toggles} 个`)
  await page.evaluate("(document.querySelector('[data-layer=zones] input').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  const vis = await waitDom(page, "window.__map ? window.__map.getLayoutProperty('cuav-zone-fill', 'visibility') : ''", 'none')
  check('关掉「告警区」后圈层隐藏', vis === 'none', String(vis))
  await page.evaluate("(document.querySelector('[data-layer=zones] input').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  await waitDom(page, "window.__map ? window.__map.getLayoutProperty('cuav-zone-fill', 'visibility') : ''", 'visible')
  await page.evaluate("(document.body.click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.body.click(), true)')

  // ---------- ④ 选中：点行 → 表单叠在栈顶 → 返回卡片 ----------
  trace('进入 ④ 选中：点行 → 表单叠在栈顶 → 返回卡片')
  await page.evaluate("(document.querySelector('[data-target-row=\"uav-2\"]').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  const selKind = await waitDom(page, "document.querySelectorAll('[data-selection-bar]').length", 1)
  st = await page.waitFor((s) => s.app?.scene?.selection?.kind === 'emitter', { label: '选中辐射源' })
  trace('过了 选中辐射源')
  const formDom = await evalJson(page, `({
    form: document.querySelectorAll('[data-form=emitter]').length,
    stack: document.querySelectorAll('[data-card-stack]').length,
    open: Array.from(document.querySelectorAll('[data-card-open]')).map((e) => e.dataset.card),
    selRow: document.querySelector('[data-target-row].sel')?.dataset.targetRow ?? null,
  })`)
  check('点目标行即选中该辐射源，表单叠在卡片栈之上，栈仍在，展开的卡跟着选中走',
    selKind === 1 && st.app.scene.selection.id === 'uav-2' && formDom.form === 1 && formDom.stack === 1
    && formDom.open.length === 1 && formDom.open[0] === 'uav-2' && formDom.selRow === 'uav-2', JSON.stringify(formDom))
  const ring = await rendered('cuav-target-ring')
  check('选中的目标在图上有选中环', ring >= 1, `${ring} 个要素`)
  await page.evaluate("(document.querySelector('[data-action=clear-selection]').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  st = await page.waitFor((s) => s.app?.scene?.selection === null, { label: '取消选中' })
  trace('过了 取消选中')
  const barGone = await waitDom(page, "document.querySelectorAll('[data-selection-bar]').length", 0)
  check('「返回卡片」清掉选中，表单收起', barGone === 0 && st.app.scene.selection === null)

  // ---------- ⑤ 刷新：场景跟着最近任务；链路线画在图上 ----------
  trace('进入 ⑤ 刷新：场景跟着最近任务；链路线画在图上')
  await page.send('Page.navigate', { url: `${BASE}?_reload=${Date.now()}#/scene` })
  trace('已发 Page.navigate')
  st = await page.waitFor((s) => s.ready && s.loaded && s.app?.scene?.status === 'ok' && !!s.app?.context?.taskId, { label: '刷新后就绪', timeoutMs: 120000 })
  trace('过了 刷新后就绪')
  check('刷新后场景跟着最近任务（demo-03），不落到清单第一项', st.app.scene.scenarioId === 'demo-03' && st.app.context.taskId === taskId,
    `${st.app.scene.scenarioId} / ${st.app.context.taskId}`)
  st = await page.waitFor((s) => (s.app?.cards ?? []).length === 3 && s.app.cards.every((c) => c.sites.every((r) => r.source === 'link')), { label: '刷新后卡片重算', timeoutMs: 30000 })
  trace('过了 刷新后卡片重算')
  check('刷新后三张卡仍按链路帧算好', st.app.cards.length === 3)
  let linkDrawn = -1
  for (let i = 0; i < 25 && linkDrawn < 1; i++) {
    linkDrawn = await page.evaluateAsync("new Promise((r) => setTimeout(() => r(window.__map ? window.__map.queryRenderedFeatures({layers:['cuav-link-line']}).length : -1), 200))")
  }
  check('链路线渲染出要素', linkDrawn >= 1, `${linkDrawn} 个要素`)
  check('默认 DOM 里没有开发者模式元素', (await evalJson(page, "document.querySelectorAll('[data-dev]').length")) === 0)
  check('全程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  check('端到端流程未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e))
} finally {
  if (page && chrome) await page.close(chrome.port)
  if (chrome) chrome.proc.kill()
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

let bad = 0
for (const c of checks) {
  if (!c.ok) bad++
  console.log(`${c.ok ? '通过' : '失败'}  ${c.name}${c.detail ? `  —— ${c.detail}` : ''}`)
}
console.log(`\n共 ${checks.length} 项，失败 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
