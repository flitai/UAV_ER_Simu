// 切片 ⑧「一屏讲清楚」的端到端验收（06 备忘录 §9E、§9J；设计见 13 报告 §11；决策 D-061）。
//
// D-062（场景页信息分层，13 报告 §13）：左栏 = 配置（对象树 7 行 + 选中对象的表单），右栏 = 观察（焦点卡一张 +
//   目标列表 + 站点行）；地图只给焦点目标画全套叠加；编辑工具收在「编辑场景」后面。本文件的 DOM 断言按此改写。
// V-1（本文件首版）：
//   ① 场景页右栏不点选就有焦点卡（第一个目标）、目标列表与三行站点；
//   ② 卡上每站一行的距离 / 方位 / 路损与 links 端点里该链路的最后一行逐值相等，接收电平等于
//      发射功率 + 两端天线增益 − 路损、信噪比等于电平 − (−174 + nf + 10·log10 fs)（13 §3.2）；
//   ③ 测向行与 bearings 端点的最后一行相等，定位行与 positions 端点相等；
//   ④ 点目标行即选中该辐射源，表单叠在栈顶，「返回卡片」清掉选中；
//   ⑤ 刷新后场景跟着最近任务（demo-03），不落到清单第一项（13 §6.1）；链路线渲染出要素（13 §6.2）。
// V-2（告警区与叠加加重）：
//   ⑥ 场景里有告警区 z-east，地图上画出圈与高度立柱，十三个态势图层齐全；跑 70 s 后 uav-2 在圈内
//      （13 报告 §4.3 的几何判定）：卡片带徽标、列表行带徽标、图标换红环变体，其余两架不在；
//   ⑦ 对象树有告警区行，点开是告警区表单；图层弹层可关掉告警区与立柱。
// V-3（全宽时间轴与回放缓冲，13 报告 §5）：
//   ⑧ 场景页有时间轴条（live、活动标记、左端计数）；拖到 30 s 进回放：t 与指针一致、信号页游标同步为 t − t0_s，
//      图上三架机的位置 = track 文件里该时刻前的最后一行、卡片的距离 = links 文件里该时刻前的最后一行；
//   ⑨ 空格播放（t 单调增）、再按暂停；Home 回 0；「跟随实时」两边一起回 live；
//   ⑩ 结果页也有时间轴，信号页按 → 改游标时时间轴跟到 t0_s + 游标；框图页没有时间轴。
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
  // 地址带 ?scenario=demo-03 已把场景页切到 demo-03，框图跟着走（2026-09-13），不再需要在框图页选
  await page.waitFor((s) => s.app?.chain?.scenarioId === 'demo-03', { label: '框图跟着 demo-03', timeoutMs: 30000 })
  await sleep(800)
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
    panel: document.querySelectorAll('[data-situation]').length,
    focus: document.querySelector('[data-focus-card]')?.dataset.focusCard ?? null,
    rows: document.querySelectorAll('[data-target-row]').length,
    siteRows: document.querySelectorAll('[data-focus-card] [data-card-site]').length,
    fixes: document.querySelectorAll('[data-focus-card] [data-card-fix]').length,
    identityOpen: document.querySelector('[data-focus-identity]')?.open ?? null,
    siteCards: document.querySelectorAll('[data-site-card]').length,
    selBar: document.querySelectorAll('[data-selection-bar]').length,
    placeholder: /在左栏或地图上选一个对象/.test(document.body.textContent),
    // 左栏顶部的场景选择器（D-065）是配置入口不是对象表单，不计
    leftForms: document.querySelector('[data-scene-tree]')?.closest('.col-body')?.querySelectorAll('[data-form]:not([data-form=scene-pick])').length ?? -1,
    treeRows: document.querySelectorAll('[data-scene-tree] .tree-row').length,
    pkgOpen: document.querySelector('[data-scene-package]')?.open ?? null,
    topbarTime: document.querySelectorAll('.run-time').length,
    tools: Array.from(document.querySelectorAll('[data-tool]')).map((b) => b.dataset.tool),
  })`)
  check('右栏不点选即有焦点卡（第一个目标 uav-1）、目标列表 3 行、站点 3 行；没有表单、没有空态提示（D-062）',
    dom.panel === 1 && dom.focus === 'uav-1' && dom.rows === 3 && dom.siteCards === 3 && dom.selBar === 0 && !dom.placeholder && dom.leftForms === 0 && st.app.scene.focus === 'uav-1',
    JSON.stringify(dom))
  check('焦点卡里每站一行、有定位行、身份默认折叠；左栏对象树只有 7 行（3 站 + 3 源 + 1 区），数据包折叠；顶栏无时间读数；工具条只露「测量」',
    dom.siteRows === 3 && dom.fixes >= 1 && dom.identityOpen === false && dom.treeRows === 7 && dom.pkgOpen === false && dom.topbarTime === 0 && JSON.stringify(dom.tools) === '["measure"]',
    JSON.stringify(dom))

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
    rowBadge: document.querySelector('[data-target-row="uav-2"] [data-row-zone]')?.dataset.rowZone ?? null,
    others: document.querySelectorAll('[data-target-row="uav-1"] [data-row-zone], [data-target-row="uav-3"] [data-row-zone]').length,
    focusBadge: document.querySelectorAll('[data-focus-card="uav-1"] [data-card-zone]').length,
  })`)
  check('入圈目标的列表行带「告警区」徽标，其余行没有，焦点卡（uav-1）也没有', zoneDom.rowBadge === 'z-east' && zoneDom.others === 0 && zoneDom.focusBadge === 0, JSON.stringify(zoneDom))
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

  // ---------- ④ 选中：点行 → 焦点卡换人、表单出现在左栏、地图只给它画全套 → 取消选择 ----------
  trace('进入 ④ 选中：点行 → 焦点卡换人、表单出现在左栏 → 取消选择')
  await page.evaluate("(document.querySelector('[data-target-row=\"uav-2\"]').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  const selKind = await waitDom(page, "document.querySelectorAll('[data-selection-bar]').length", 1)
  st = await page.waitFor((s) => s.app?.scene?.selection?.kind === 'emitter', { label: '选中辐射源' })
  trace('过了 选中辐射源')
  const formDom = await evalJson(page, `({
    form: document.querySelectorAll('[data-form=emitter]').length,
    formInLeft: !!document.querySelector('[data-scene-tree]')?.closest('.col-body')?.querySelector('[data-form=emitter]'),
    focus: document.querySelector('[data-focus-card]')?.dataset.focusCard ?? null,
    focusBadge: document.querySelector('[data-focus-card] [data-card-zone]')?.dataset.cardZone ?? null,
    selRow: document.querySelector('[data-target-row].sel')?.dataset.targetRow ?? null,
    routeOpen: document.querySelector('[data-form-route]')?.open ?? null,
    waypointRows: document.querySelectorAll('[data-form-route] [data-tree-waypoint]').length,
    actsOpen: document.querySelector('[data-form-activities]')?.open ?? null,
  })`)
  check('点目标行即选中该辐射源：表单出现在左栏、焦点卡换成它并带告警区徽标、列表行高亮；表单里航线（7 航点）与活动默认收起',
    selKind === 1 && st.app.scene.selection.id === 'uav-2' && st.app.scene.focus === 'uav-2' && formDom.form === 1 && formDom.formInLeft
    && formDom.focus === 'uav-2' && formDom.focusBadge === 'z-east' && formDom.selRow === 'uav-2'
    && formDom.routeOpen === false && formDom.waypointRows === 7 && formDom.actsOpen === false, JSON.stringify(formDom))
  const ring = await rendered('cuav-target-ring')
  check('选中的目标在图上有选中环', ring >= 1, `${ring} 个要素`)
  const labelFeat = await page.evaluateAsync(`new Promise((r) => setTimeout(() => r(window.__map ? window.__map.queryRenderedFeatures({layers:['cuav-link-label']}).map((f) => f.properties.link_id) : []), 400))`)
  check('地图只给焦点目标标距离：渲染出的距离标注全属于 uav-2', labelFeat.length >= 1 && labelFeat.every((id) => id.endsWith('-uav-2')), JSON.stringify(labelFeat))
  const lineFeat = await page.evaluateAsync(`new Promise((r) => setTimeout(() => r(window.__map ? window.__map.queryRenderedFeatures({layers:['cuav-link-line']}).map((f) => [f.properties.link_id, f.properties.focus]) : []), 200))`)
  check('链路线：焦点目标的三条按焦点画，其余按背景画（D-062）',
    lineFeat.some(([, f]) => f) && lineFeat.filter(([, f]) => f).every(([id]) => id.endsWith('-uav-2')) && lineFeat.some(([, f]) => !f), JSON.stringify(lineFeat))
  await page.evaluate("(document.querySelector('[data-action=clear-selection]').click(), true)")
  trace('点了 ' + 'await page.evaluate("(document.querySelector(\'[dat')
  st = await page.waitFor((s) => s.app?.scene?.selection === null, { label: '取消选中' })
  trace('过了 取消选中')
  const barGone = await waitDom(page, "document.querySelectorAll('[data-selection-bar]').length", 0)
  const focusBack = await waitDom(page, "document.querySelector('[data-focus-card]')?.dataset.focusCard ?? null", 'uav-1')
  check('「取消选择」清掉选中，表单收起，焦点回到第一个目标', barGone === 0 && st.app.scene.selection === null && focusBack === 'uav-1' && st.app.scene.focus === 'uav-1')

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

  // ---------- ⑥ V-3 全宽时间轴：拖动回放、与信号游标联动、播放与快捷键 ----------
  trace('进入 ⑥ V-3 全宽时间轴')
  const tlDom = () => evalJson(page, `(() => { const el = document.querySelector('[data-timeline]'); if (!el) return null
    return { hidden: el.hidden, mode: el.dataset.timelineMode, marks: el.querySelectorAll('[data-timeline-mark]').length,
             counts: el.querySelector('[data-timeline-counts]').textContent, t: el.querySelector('[data-timeline-t]').textContent,
             follow: el.querySelector('[data-field=tl-follow]').checked } })()`)
  const tl0 = await tlDom()
  check('场景页有全宽时间轴条：live、活动标记与探针一致、计数写着目标 3 · 站 3 · 告警 1',
    !!tl0 && !tl0.hidden && tl0.mode === 'live' && tl0.follow && tl0.marks === st.app.timeline.markers && tl0.marks >= 1
      && /目标 3/.test(tl0.counts) && /站 3/.test(tl0.counts) && /告警 1/.test(tl0.counts), JSON.stringify(tl0))
  const dur = st.app.task.duration_s
  const rect = await evalJson(page, "(() => { const r = document.querySelector('[data-timeline-track]').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()")
  const xAt = (t) => rect.left + rect.width * (t / dur)
  const yTrack = rect.top + rect.height / 2
  const tWant = 30
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xAt(10), y: yTrack, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xAt(20), y: yTrack, button: 'left' })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xAt(tWant), y: yTrack, button: 'left' })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xAt(tWant), y: yTrack, button: 'left', clickCount: 1 })
  trace('拖完时间轴')
  st = await page.waitFor((s) => s.app?.timeline?.mode === 'replay' && !s.app.timeline.playing && s.app.signal.cursor_t_s !== null, { label: '拖后进回放', timeoutMs: 10000 })
  const tGot = st.app.timeline.t
  const pxTol = (dur / rect.width) * 1.5
  check('拖时间轴到 30 s：进回放，t 与指针位置一致（1.5 px 内），画面来自历史快照', near(tGot, tWant, pxTol) && st.app.timeline.source === 'replay', `t=${tGot} 容差 ${pxTol.toFixed(3)} source=${st.app.timeline.source}`)
  const t0s = st.app.signal.geom?.t0_s ?? 0
  check('信号页游标同步为 t − t0_s 并转回看', near(st.app.signal.cursor_t_s, tGot - t0s, 1e-6) && st.app.signal.follow === false, `${st.app.signal.cursor_t_s} vs ${tGot} − ${t0s}`)
  const trackAt = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/track?t0=${Math.max(0, tGot - 1)}&t1=${tGot}&stride=1').then(r => r.json())`)
  const lastTrack = lastByKey(trackAt.filter((r) => r.t_s <= tGot), (r) => r.id)
  const entBad = []
  for (const e of st.app.entities) {
    const row = lastTrack.get(e.id)
    if (!(row && near(e.t_s, row.t_s, 1e-9) && near(e.lon, row.lon, 1e-9) && near(e.lat, row.lat, 1e-9) && near(e.alt_m, row.alt_m, 1e-6))) entBad.push(`${e.id}: ${e.t_s}/${e.lon} vs ${row?.t_s}/${row?.lon}`)
  }
  check('回放时刻图上三架机的位置 = track 文件里该时刻前的最后一行', st.app.entities.length === 3 && entBad.length === 0, entBad.join('；'))
  const linksAt = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/links?t0=${Math.max(0, tGot - 1)}&t1=${tGot}&stride=1').then(r => r.json())`)
  const lastLinkAt = lastByKey(linksAt.filter((r) => r.t_s <= tGot), (r) => r.link_id)
  const cardsFollow = (s) => (s.app?.cards ?? []).length === 3 && s.app.cards.every((c) => c.sites.length === 3 && c.sites.every((r) => {
    const row = lastLinkAt.get(`${r.site_id}-${c.id}`); return !!row && Math.abs(r.distance_m - row.distance_m) <= 1e-6 }))
  st = await page.waitFor(cardsFollow, { label: '卡片跟到回放时刻', timeoutMs: 5000 }).catch(() => st)
  check('卡片 9 行的距离 = links 文件里该时刻前的最后一行（卡片与地图同一帧）', cardsFollow(st))
  const tlR = await tlDom()
  check('时间轴读数写着回放时刻、「跟随实时」未勾', !!tlR && tlR.mode === 'replay' && !tlR.follow && tlR.t.startsWith(`t ${Math.floor(tGot)}`), JSON.stringify(tlR))
  // 空格播放：t 单调增；再按暂停
  await page.pressKey({ key: ' ', code: 'Space', vk: 32 })
  st = await page.waitFor((s) => s.app?.timeline?.playing === true, { label: '空格播放', timeoutMs: 5000 })
  const tPlay1 = st.app.timeline.t
  await sleep(600)
  st = await page.evaluate('window.__probe()')
  const tPlay2 = st.app.timeline.t
  await page.pressKey({ key: ' ', code: 'Space', vk: 32 })
  st = await page.waitFor((s) => s.app?.timeline?.playing === false, { label: '空格暂停', timeoutMs: 5000 })
  check('空格播放：t 单调增（0.6 s 墙钟内前进 ≥ 0.3 s）；再按空格暂停，暂停时刻同步到信号游标', tPlay2 - tPlay1 >= 0.3 && st.app.timeline.mode === 'replay' && near(st.app.signal.cursor_t_s, st.app.timeline.t - t0s, 1e-6),
    `${tPlay1} → ${tPlay2}；暂停于 ${st.app.timeline.t}，游标 ${st.app.signal.cursor_t_s}`)
  await page.pressKey({ key: 'Home', code: 'Home', vk: 36 })
  st = await page.waitFor((s) => s.app?.timeline?.t === 0, { label: 'Home 回 0', timeoutMs: 5000 })
  check('Home 回到 0 s，游标 = −t0_s 处', st.app.timeline.t === 0 && near(st.app.signal.cursor_t_s, -t0s, 1e-6))
  await page.evaluate("(document.querySelector('[data-field=tl-follow]').click(), true)")
  st = await page.waitFor((s) => s.app?.timeline?.mode === 'live' && s.app.signal.follow === true, { label: '跟随实时', timeoutMs: 5000 })
  // 最新一帧 = track 文件的最后一行（10 Hz 航迹最后一行是 69.9 s，不是任务时长 70 s）
  const trackTail = await tail('track')
  const tLast = Math.max(...trackTail.map((r) => r.t_s))
  check('勾「跟随实时」：时间轴回 live、信号页回跟随且游标清掉、图上回到最新一帧', st.app.timeline.t === null && st.app.signal.cursor_t_s === null && st.app.timeline.source === 'live'
    && st.app.entities.length === 3 && st.app.entities.every((e) => near(e.t_s, tLast, 1e-9)), `t=${st.app.timeline.t} cursor=${st.app.signal.cursor_t_s} entities t_s=${st.app.entities.map((e) => e.t_s).join(',')} 最后一行 ${tLast}`)
  // 结果页：时间轴仍在；信号页按 → 改游标，时间轴跟过去
  await page.evaluate("(window.location.hash = '#/results', true)")
  st = await page.waitFor((s) => s.app?.view === 'results' && !!s.app?.signal?.geom, { label: '结果页信号几何就绪', timeoutMs: 30000 })
  const tlRes = await tlDom()
  check('结果页也有时间轴条', !!tlRes && !tlRes.hidden, JSON.stringify(tlRes))
  await page.pressKey({ key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
  st = await page.waitFor((s) => s.app?.signal?.cursor_t_s !== null && s.app?.timeline?.mode === 'replay', { label: '→ 后时间轴跟游标', timeoutMs: 5000 })
  const t0r = st.app.signal.geom?.t0_s ?? 0
  check('信号页按 → 改游标：时间轴跟到 t0_s + 游标', near(st.app.timeline.t, t0r + st.app.signal.cursor_t_s, 1e-6) && !st.app.timeline.playing, `${st.app.timeline.t} vs ${t0r} + ${st.app.signal.cursor_t_s}`)
  await page.evaluate("(window.location.hash = '#/diagram', true)")
  st = await page.waitFor((s) => s.app?.view === 'diagram', { label: '框图页', timeoutMs: 10000 })
  const tlDia = await tlDom()
  check('框图页没有时间轴条', !!tlDia && tlDia.hidden === true, JSON.stringify(tlDia))
  await page.evaluate("(window.location.hash = '#/scene', true)")
  await page.waitFor((s) => s.app?.view === 'scene', { label: '回场景页', timeoutMs: 10000 })
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
