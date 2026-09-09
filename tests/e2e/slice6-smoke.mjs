// 切片 ⑥「多源多站测向定位」的端到端验收（06 备忘录 §9E、§9H；设计见 11 报告 §9.2；决策 D-053）。
//
// 核心判据四条：
//   ① 多源在**接收天线之后**叠加成一路，S1 上的合成功率等于各链路预算的线性和（§2.2）；
//   ② 多站是**站点维度**：接收侧每环节一站一份，每站的 S1 各自等于该站的链路预算；
//   ③ 测向是 M2 效应模型，散布必须与它自己声称的 σ 对得上——|误差| ≤ 3σ 的占比与归一化
//      误差的样本方差都要落在范围内。这不是「跑得起来」，是 01 §8 的跨层一致性；
//   ④ 界面：站与源是复选、卡片带实例角标、地图上有测向线叠加层。
//
// 跑法（先起服务：cd server && npm run build && node dist/index.js；引擎已构建；web/dist 为最新）：
//     node tests/e2e/slice6-smoke.mjs [--url http://127.0.0.1:8080/]

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchChrome, Page } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(Boolean))
const BASE = (args.url ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }
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
/** 轮询 DOM 本身，不是 store 探针——探针先于 React 重绘（2026-09-08 的竞态）。 */
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
/** hann 窗的等效噪声带宽：邻域线性求和得到的是 1.5 倍单音功率（D-049 ⑪）。 */
const ENBW_dB = 10 * Math.log10(1.5)

let chrome, page, dir
const pageErrors = []
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-slice6-'))
  chrome = await launchChrome({ userDataDir: dir, windowSize: '1920,1200' })
  page = await Page.open(chrome.port, 'about:blank')
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0]))
  await page.send('Page.navigate', { url: `${BASE}#/diagram` })
  await page.waitFor((s) => s.ready && s.app?.view === 'diagram', { label: '框图页', timeoutMs: 90000 })
  await sleep(800)

  // ---------- ① 缺省仍是单源单站，退化路径没被破坏 ----------
  let st = await page.waitFor((s) => s.app?.chain?.template === 'chain-v1', { label: '典型链路载入' })
  check('缺省链仍是 1 站 1 源，测向与多站定位都不参与',
    (st.app.chain.siteIds ?? []).length === 1 && (st.app.chain.emitterIds ?? []).length === 1
    && st.app.chain.slots.df !== 'active' && st.app.chain.slots.loc !== 'active',
    `${(st.app.chain.siteIds ?? []).join()} × ${(st.app.chain.emitterIds ?? []).join()}，df ${st.app.chain.slots.df} / loc ${st.app.chain.slots.loc}`)

  const noBadge = await evalJson(page, "document.querySelectorAll('[data-slot-count]').length")
  check('单源单站时不显示实例角标（画面与多站之前一模一样）', noBadge === 0, `${noBadge} 个角标`)

  // ---------- ② 切到 demo-03：三站三源，缺省全选 ----------
  await page.evaluate(setSelect('[data-form=chain-setup] [data-field=scenario]', 'demo-03'))
  await sleep(1500)
  const nSite = await waitDom(page, "document.querySelectorAll('[data-multi=site] input').length", 3)
  const nEm = await waitDom(page, "document.querySelectorAll('[data-multi=emitter] input').length", 3)
  check('切到 demo-03 后站与源各有三个复选框', nSite === 3 && nEm === 3, `站 ${nSite} / 源 ${nEm}`)
  const allChecked = await waitDom(page,
    "Array.from(document.querySelectorAll('[data-multi=site] input, [data-multi=emitter] input')).every(e => e.checked)", true)
  check('选场景后缺省全选（不用逐个去勾）', allChecked === true)

  st = await page.waitFor((s) => (s.app?.chain?.siteIds ?? []).length === 3 && (s.app?.chain?.emitterIds ?? []).length === 3,
    { label: '三站三源进状态' })
  check('缺省全选写回了文档，不只是界面上装作全选',
    st.app.chain.siteIds.length === 3 && st.app.chain.emitterIds.length === 3,
    `${st.app.chain.siteIds.join()} × ${st.app.chain.emitterIds.join()}`)

  // ---------- ③ 实例角标 ----------
  const badges = await evalJson(page,
    "Object.fromEntries(Array.from(document.querySelectorAll('[data-slot-count]')).map(e => [e.dataset.slotCount, e.textContent.trim()]))")
  check('辐射源按源实例化：×3', badges.tx === '×3', JSON.stringify(badges.tx))
  check('传播信道按链路实例化：×9（3 源 × 3 站）', badges.ch === '×9', String(badges.ch))
  check('接收机前端按站实例化：×3', badges.rx_fe === '×3', String(badges.rx_fe))
  check('多站定位是单例，写「3 站」而不是 ×3', badges.loc === '3 站', String(badges.loc))

  // ---------- ③b 逐实体与按型号配参数（D-054）----------
  // 三个站在 demo-03 里都没写型号，先给 site-3 标一个，才能看出「同型号」这一档的边界
  await page.evaluate("(document.querySelector('[data-slot=rx_fe]').click(), true)")
  await sleep(250)
  const focusSite = async (id) => {
    await page.evaluate(`(() => { const el = document.querySelector('[data-field=focus-site]');
      el.value = ${JSON.stringify(id)};
      el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await sleep(250)
  }
  await focusSite('site-3')
  await page.evaluate(setInput('[data-form=entity-device] [data-field="sites.2.equipment_model"]', '窄带站-B'))
  await page.waitFor((x) => x.app?.scene?.dirty === false, { label: 'site-3 型号已存', timeoutMs: 30000 })
  const modelText = await page.evaluate(
    "document.querySelector('[data-field=focus-site]')?.selectedOptions[0]?.textContent ?? ''")
  check('设备型号可在本页设定，选择框上随即写出来', String(modelText).includes('窄带站-B'), String(modelText))

  // 「单独」：只改当前这个站
  await focusSite('site-2')
  await page.evaluate(`(() => { const el = document.querySelector('[data-param-scope=gain_dB]');
    el.value = 'entity'; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await sleep(250)
  await page.evaluate(setInput('[data-form=slot] [data-field=gain_dB]', '30'))
  await sleep(400)
  let scoped = await page.waitFor((x) => !!x.app?.chain?.byEntity?.rx_fe, { label: '单独设置写进框图' })
  const one0 = scoped.app.chain.effective.rx_fe
  check('「单独」只改选中的那个站',
    one0['site-2'].gain_dB === 30 && one0['site-1'].gain_dB === 20 && one0['site-3'].gain_dB === 20,
    JSON.stringify({ 'site-1': one0['site-1'].gain_dB, 'site-2': one0['site-2'].gain_dB, 'site-3': one0['site-3'].gain_dB }))

  // 「同型号」：site-1 与 site-2 都没标型号，归一组；site-3 标了「窄带站-B」，不跟着变
  await page.evaluate(`(() => { const el = document.querySelector('[data-param-scope=gain_dB]');
    el.value = 'model'; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await sleep(250)
  await page.evaluate(setInput('[data-form=slot] [data-field=gain_dB]', '26'))
  await sleep(400)
  // 断言对着**有效值**写，不对着 byEntity：后者是归约后的形式（底值取众数、只留偏离者），
  // 三个站 26 / 26 / 20 时 byEntity 里躺着的是 site-3 而不是 site-1 与 site-2
  scoped = await page.waitFor((x) => {
    const e = x.app?.chain?.effective?.rx_fe ?? {}
    return e['site-1']?.gain_dB === 26 && e['site-2']?.gain_dB === 26
  }, { label: '同型号一起改' })
  const eff = scoped.app.chain.effective.rx_fe
  check('「同型号」把同一型号的站一起改，别的型号不动',
    eff['site-1'].gain_dB === 26 && eff['site-2'].gain_dB === 26 && eff['site-3'].gain_dB === 20,
    JSON.stringify({ 'site-1': eff['site-1'].gain_dB, 'site-2': eff['site-2'].gain_dB, 'site-3': eff['site-3'].gain_dB }))

  // 收回「共用」：覆盖清空，框图回到一套参数
  await page.evaluate(`(() => { const el = document.querySelector('[data-param-scope=gain_dB]');
    el.value = 'shared'; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await sleep(400)
  const back = await page.waitFor((x) => x.app?.chain?.byEntity?.rx_fe === undefined,
    { label: '收回共用后覆盖清空' })
  const effBack = back.app.chain.effective.rx_fe
  check('收回「共用」把逐实体覆盖清干净、三个站回到一套参数',
    back.app.chain.byEntity?.rx_fe === undefined
    && effBack['site-1'].gain_dB === effBack['site-3'].gain_dB,
    JSON.stringify({ byEntity: back.app.chain.byEntity?.rx_fe ?? null, gain: effBack['site-1'].gain_dB }))
  await page.evaluate(setInput('[data-form=slot] [data-field=gain_dB]', '20'))
  await sleep(300)

  // 传播信道不随实体选择变化（用户明确要求）
  await page.evaluate("(document.querySelector('[data-slot=ch]').click(), true)")
  await sleep(200)
  const chOwner = await page.evaluate("document.querySelector('[data-slot-owner]')?.dataset.slotOwner ?? ''")
  check('传播信道标为全图共用，不随无人机与侦测站的选择变化', chOwner === 'shared', chOwner)
  const chScope = await page.evaluate("!!document.querySelector('[data-param-scope=delay_mode]')")
  check('共用槽位不给「单独设置」的入口，避免造出解释不了的状态', chScope === false)

  // 把 site-3 的型号删掉，不给后面的断言与仓库留副作用
  await page.evaluate("(document.querySelector('[data-slot=rx_fe]').click(), true)")
  await sleep(200)
  await focusSite('site-3')
  await page.evaluate(setInput('[data-form=entity-device] [data-field="sites.2.equipment_model"]', ''))
  await page.waitFor((x) => x.app?.scene?.dirty === false, { label: 'site-3 型号已清', timeoutMs: 30000 })
  await focusSite('site-1')

  // 版式：十一个环节按每行四张、蛇形排成 4 + 4 + 3，不横向溢出，仍在中栏里纵向居中
  const snake = await evalJson(page, `(() => {
    const cells = Array.from(document.querySelectorAll('.chain-cell'));
    const info = cells.map((c) => {
      const card = c.querySelector('[data-slot]');
      const r = card.getBoundingClientRect();
      const conn = c.querySelector('.chain-conn');
      return { slot: card.dataset.slot, pos: c.dataset.chainPos,
        cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
        dir: conn ? (conn.classList.contains('to-right') ? 'right' : 'left')
                  : (c.querySelector('[data-chain-turn]') ? 'down' : 'end') };
    });
    const byRow = {};
    for (const x of info) (byRow[x.pos.split(':')[0]] ||= []).push(x);
    const rows = Object.keys(byRow).sort((a, b) => Number(a) - Number(b)).map((k) => byRow[k]);
    const body = document.querySelector('.chain-body');
    const strip = document.querySelector('.chain-strip').getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const tap = document.querySelector('.tap-row')?.getBoundingClientRect();
    return { rows, ovx: body.scrollWidth - body.clientWidth,
      above: Math.round(strip.top - b.top), below: Math.round(b.bottom - (tap?.bottom ?? b.bottom)) };
  })()`)
  check('十一个环节按每行四张排成 4 + 4 + 3',
    snake.rows.length === 3 && snake.rows[0].length === 4 && snake.rows[1].length === 4 && snake.rows[2].length === 3,
    snake.rows.map((r) => `${r.length} 个`).join(' / '))
  // 蛇形：奇数行从左往右、偶数行从右往左，行末向下转折，且转折点与下一行首张卡片同列
  const snakeOk = snake.rows.every((row, r) => {
    const ltr = r % 2 === 0
    const xs = row.map((c) => c.cx)
    const monotonic = xs.every((x, i) => i === 0 || (ltr ? x > xs[i - 1] : x < xs[i - 1]))
    const inner = row.slice(0, -1).every((c) => c.dir === (ltr ? 'right' : 'left'))
    const tail = row[row.length - 1].dir
    return monotonic && inner && (r === snake.rows.length - 1 ? tail === 'end' : tail === 'down')
  })
  check('蛇形排布：单数行从左往右、双数行从右往左，行末向下转折',
    snakeOk, snake.rows.map((row, r) => `${r % 2 === 0 ? '→' : '←'} ${row.map((c) => c.slot).join(' ')}`).join('  |  '))
  check('转折处上下同列：一行读到头，下一张卡片就在正下方',
    snake.rows.slice(0, -1).every((row, r) => row[row.length - 1].cx === snake.rows[r + 1][0].cx),
    snake.rows.slice(0, -1).map((row, r) => `${row[row.length - 1].cx} vs ${snake.rows[r + 1][0].cx}`).join('，'))
  check('四列不把中栏撑出横向滚动条', snake.ovx === 0, `溢出 ${snake.ovx} px`)
  check('链条仍在中栏里纵向居中', Math.abs(snake.above - snake.below) <= 24, `上 ${snake.above} / 下 ${snake.below}`)

  // ---------- ④ 打开测向、勾 S1、缩短时长、跑 ----------
  await page.evaluate("(() => { const el = document.querySelector('[data-slot-bypass=df]'); if (el && el.checked) el.click(); return true })()")
  await sleep(300)
  const dfActive = await waitDom(page, "document.querySelector('[data-slot=df]')?.dataset.slotState", 'active')
  check('取消旁路后测向环节转为启用态', dfActive === 'active', String(dfActive))

  await page.evaluate("(() => { const el = document.querySelector('[data-slot-bypass=loc]'); if (el && el.checked) el.click(); return true })()")
  await sleep(300)
  const locActive = await waitDom(page, "document.querySelector('[data-slot=loc]')?.dataset.slotState", 'active')
  check('取消旁路后多站定位环节转为启用态', locActive === 'active', String(locActive))

  await page.evaluate(`(() => { const el = document.querySelector('[data-tap-toggle=s1]'); if (el && !el.checked) el.click(); return true })()`)
  await sleep(200)
  await page.evaluate(setInput('[data-form=chain-setup] [data-field=duration_s]', '20'))
  await sleep(400)

  const plan = await evalJson(page, "Object.fromEntries(Array.from(document.querySelectorAll('[data-check]')).map(e => [e.dataset.check, e.dataset.ok]))")
  check('频率计划全过，且含多源多站两项新检查', Object.values(plan).every((v) => v === '1')
    && 'stations' in plan && 'sites_consistent' in plan, JSON.stringify(plan))

  for (let i = 0; i < 60; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const before = st.app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await page.waitFor((s) => s.app?.context?.taskId && s.app.context.taskId !== before, { label: '任务已提交' })
  const taskId = st.app.context.taskId
  check('3 源 × 3 站的框图通过引擎校验并提交', !!taskId, taskId ?? '')
  st = await page.waitFor((s) => ['finished', 'failed', 'cancelled'].includes(s.app?.task?.runState),
    { label: '任务结束', timeoutMs: 300000 })
  check('任务跑完', st.app.task.runState === 'finished', `${st.app.task.runState} / ${st.app.task.result}`)

  // ---------- ⑤ 产品：链路 9 条、测向覆盖 9 个 (站, 源) ----------
  const links = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/links?t0=0&t1=1e9&stride=1').then(r => r.json())`)
  const linkIds = [...new Set(links.map((l) => l.link_id))].sort()
  check('links.jsonl 覆盖 9 条链路（3 站 × 3 源全交叉）', linkIds.length === 9, linkIds.join(' '))

  const bearings = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/bearings?t0=0&t1=1e9&stride=1').then(r => r.json())`)
  const bKeys = [...new Set(bearings.map((b) => `${b.site_id}|${b.emitter_id}`))].sort()
  check('bearings.jsonl 覆盖 9 个 (站, 源) 组合', bKeys.length === 9, `${bearings.length} 行 / ${bKeys.length} 组`)
  check('每一行都声明取用了真值（M2 效应模型的强制声明，11 §1.3）',
    bearings.length > 0 && bearings.every((b) => b.truth_consumed === true),
    `truth_consumed 全为真：${bearings.every((b) => b.truth_consumed === true)}`)
  check('溯源写明 M2 / E2 / V2，不冒充 M3 的被测算法',
    bearings.every((b) => b.trace?.model_layer === 'M2' && b.trace?.model_level === 'E2' && b.trace?.credibility === 'V2'),
    JSON.stringify(bearings[0]?.trace ?? {}).slice(0, 80))

  // 按站过滤：端点的等值过滤生效
  const one = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/bearings?site_id=site-2').then(r => r.json())`)
  check('测向端点支持按站过滤', one.length > 0 && one.every((b) => b.site_id === 'site-2'), `${one.length} 行`)

  // ---------- ⑥ 统计判据：散布必须与声称的 σ 对得上 ----------
  const truth = new Map()
  for (const l of links) truth.set(`${l.t_s.toFixed(6)}|${l.link_id}`, l.azimuth_deg)
  const zs = []
  for (const b of bearings) {
    if (b.df_result_state === 'invalid') continue
    const a = truth.get(`${b.t_s.toFixed(6)}|${b.link_id}`)
    if (a === undefined || !(b.bearing_std_deg > 0)) continue
    let d = b.bearing_deg - a
    while (d > 180) d -= 360
    while (d < -180) d += 360
    zs.push(d / b.bearing_std_deg)
  }
  const within3 = zs.filter((z) => Math.abs(z) <= 3).length / (zs.length || 1)
  const mean = zs.reduce((a, b) => a + b, 0) / (zs.length || 1)
  const varz = zs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (zs.length - 1 || 1)
  check('测向误差有真值可对（用同时刻 links 的方位）', zs.length > 200, `${zs.length} 个样本`)
  check('|误差| ≤ 3σ 的占比 ≥ 99%', within3 >= 0.99, `${(within3 * 100).toFixed(2)} %`)
  check('归一化误差的样本方差落在 [0.9, 1.1]（抽样散布与预算 σ 一致）',
    varz >= 0.9 && varz <= 1.1, varz.toFixed(4))
  check('归一化误差无系统偏差（|均值| ≤ 3/√n）',
    Math.abs(mean) <= 3 / Math.sqrt(zs.length || 1), `${mean.toFixed(4)}（线 ±${(3 / Math.sqrt(zs.length || 1)).toFixed(4)}）`)

  // ---------- ⑦ 同频混叠：至少出现一次，且被判低权重 ----------
  const mixed = bearings.filter((b) => b.mixture === true)
  check('同频多源在近站出现混叠标记并降为低权重',
    mixed.length > 0 && mixed.every((b) => b.use_policy === 'low_weight'),
    `${mixed.length} 行混叠，全部 low_weight：${mixed.every((b) => b.use_policy === 'low_weight')}`)
  check('混叠不是全体：电平差得远的那些没有被算进去',
    mixed.length < bearings.length, `${mixed.length} / ${bearings.length}`)
  check('混叠行的 σ 明显大于非混叠行（加了混叠分量）',
    (() => {
      const m = mixed.map((b) => b.bearing_std_deg)
      const n = bearings.filter((b) => !b.mixture).map((b) => b.bearing_std_deg)
      return m.length && n.length && Math.min(...m) > Math.max(...n)
    })(),
    `混叠 σ 最小 ${Math.min(...mixed.map((b) => b.bearing_std_deg)).toFixed(2)}°`)

  // ---------- ⑧ 每站的 S1 = 该站三条链路预算的线性和 ----------
  const plByLink = new Map()
  for (const l of links) {
    if (l.t_s < 4 || l.t_s > 16) continue
    if (!plByLink.has(l.link_id)) plByLink.set(l.link_id, [])
    plByLink.get(l.link_id).push(l.path_loss_dB)
  }
  // demo-03：tx_power 27 / 24 / 20 dBm，接收天线 3 dBi；uav-3 是 20% 占空比的突发。
  // 发射天线增益**逐源取场景值**（D-054）：uav-3 是竞速机，场景里写的是 0 dBi 而不是 2。
  // 在 D-054 之前典型链路强制三架机共用一个 2 dBi，这里也就跟着写死了 2——
  // 那时候实测与预算能对上，只是两边错得一样。
  const TX = { 'uav-1': 27, 'uav-2': 24, 'uav-3': 20 }
  const TX_ANT = { 'uav-1': 2, 'uav-2': 2, 'uav-3': 0 }
  const DUTY = { 'uav-1': 1, 'uav-2': 1, 'uav-3': 0.2 }
  for (const site of ['site-1', 'site-2', 'site-3']) {
    const buf = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/s1__${site}/spectrum?t0=4&t1=16&px=1024&py=1&stat=mean')
      .then(async (r) => Array.from(new Float32Array(await r.arrayBuffer())))`)
    const total = 10 * Math.log10(buf.reduce((a, v) => a + Math.pow(10, v / 10), 0)) - ENBW_dB
    let lin = 0
    for (const em of ['uav-1', 'uav-2', 'uav-3']) {
      const pls = plByLink.get(`${site}-${em}`) ?? []
      if (!pls.length) continue
      const p = pls.reduce((a, x) => a + Math.pow(10, (TX[em] + TX_ANT[em] + 3 - x) / 10), 0) / pls.length
      lin += p * DUTY[em]
    }
    const want = 10 * Math.log10(lin)
    check(`${site} 的 S1 总功率 = 该站三条链路预算的线性和`, near(total, want, 0.05),
      `实测 ${total.toFixed(3)} dBm，预算和 ${want.toFixed(3)} dBm，差 ${(total - want).toFixed(3)} dB`)
  }

  // ---------- ⑧b 多站定位：真值落 2σ 椭圆内的比例应接近 86.5%（二维，不是一维的 95%）
  const positions = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/positions?t0=0&t1=1e9&stride=1').then(r => r.json())`)
  check('positions.jsonl 覆盖三个目标，方法都是 aoa', positions.length > 0
    && new Set(positions.map((p) => p.emitter_id)).size === 3 && positions.every((p) => p.method === 'aoa'),
    `${positions.length} 行 / ${new Set(positions.map((p) => p.emitter_id)).size} 个目标`)
  check('每行显式写出 2σ 与二维包含概率 86.5%（不是一维的 95%）',
    positions.every((p) => p.ellipse?.scale === '2sigma' && Math.abs(p.ellipse.confidence - 0.8646647167633873) < 1e-12),
    JSON.stringify(positions[0]?.ellipse ?? {}))
  check('定位行同样声明取用了真值，溯源写 M2 / E2 / V2',
    positions.every((p) => p.truth_consumed === true && p.trace?.model_layer === 'M2' && p.trace?.credibility === 'V2'))
  check('坐标产物带 crs / coord_version / enu_origin（05 §6.2.3）',
    positions.every((p) => p.crs === 'EPSG:4326' && !!p.coord_version && typeof p.enu_origin?.lon === 'number'))

  // 真值取同时刻的 track；误差在 enu_origin 的站心平面里比，与椭圆的旋转角同一基准
  const trk = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/track?t0=0&t1=1e9&stride=1').then(r => r.json())`)
  const tmap = new Map()
  for (const e of trk) tmap.set(`${e.t_s.toFixed(6)}|${e.id}`, e)
  const A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F)
  const ecef = (lon, lat, alt) => {
    const lo = lon * Math.PI / 180, la = lat * Math.PI / 180
    const n = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2)
    return [(n + alt) * Math.cos(la) * Math.cos(lo), (n + alt) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + alt) * Math.sin(la)]
  }
  const enu = (p, o) => {
    const po = ecef(o.lon, o.lat, o.alt_m)
    const d = [p[0] - po[0], p[1] - po[1], p[2] - po[2]]
    const slon = Math.sin(o.lon * Math.PI / 180), clon = Math.cos(o.lon * Math.PI / 180)
    const slat = Math.sin(o.lat * Math.PI / 180), clat = Math.cos(o.lat * Math.PI / 180)
    return [-slon * d[0] + clon * d[1], -slat * clon * d[0] - slat * slon * d[1] + clat * d[2]]
  }
  // 有效档：最小交会角 ≥ 15° 且没有低权重站参与。降级档另算，见下一条。
  let inA = 0, nA = 0, inB = 0, nB = 0
  const rA = [], cA = []
  for (const p of positions) {
    if (p.state === 'invalid') continue
    const t = tmap.get(`${p.t_s.toFixed(6)}|${p.emitter_id}`)
    if (!t) continue
    const o = p.enu_origin
    const tv = enu(ecef(t.lon, t.lat, 0), o)
    const fv = enu(ecef(p.lon, p.lat, 0), o)
    const dx = tv[0] - fv[0], dy = tv[1] - fv[1]
    const rot = p.ellipse.rotation_deg * Math.PI / 180
    const u = dx * Math.cos(rot) + dy * Math.sin(rot)
    const v = -dx * Math.sin(rot) + dy * Math.cos(rot)
    const ok = (u / p.ellipse.semi_major_m) ** 2 + (v / p.ellipse.semi_minor_m) ** 2 <= 1
    const clean = p.min_crossing_angle_deg >= 15 && !(p.reasons ?? []).some((r) => String(r).startsWith('low_weight'))
    if (clean) { nA++; if (ok) inA++; rA.push(Math.hypot(dx, dy)); cA.push(p.cep_m) }
    else { nB++; if (ok) inB++ }
  }
  check('有效档（最小交会角 ≥ 15° 且无低权重站）真值落 2σ 椭圆内 ∈ [0.80, 0.93]',
    nA > 100 && inA / nA >= 0.80 && inA / nA <= 0.93,
    `${inA}/${nA} = ${(inA / nA * 100).toFixed(1)} %（理论 86.5%）`)
  rA.sort((a, b) => a - b); cA.sort((a, b) => a - b)
  const ratio = rA[Math.floor(rA.length / 2)] / cA[Math.floor(cA.length / 2)]
  check('有效档的经验 50% 半径 / CEP ∈ [0.85, 1.15]', ratio >= 0.85 && ratio <= 1.15, ratio.toFixed(3))
  // 降级档的覆盖率确实更低——这是伪线性估计器在近简并几何下的已知局限，
  // 记录不掩盖（铁律 10）；系统的责任是把它标成 degraded，而不是让它看起来达标
  // 降级判据用的是组件参数 min_crossing_angle_deg 的缺省值 10°；上面「有效档」按 15° 划得更严，
  // 是为了留一条缓冲带，两者不是同一个数
  const belowThr = positions.filter((p) => p.min_crossing_angle_deg < 10 && p.state !== 'invalid')
  check('降级档确实更差，且交会角低于门限的每一行都写明了原因', nB > 0 && inB / nB < inA / nA
    && belowThr.length > 0 && belowThr.every((p) => (p.reasons ?? []).includes('crossing_angle_below_min')),
    `降级档 ${inB}/${nB} = ${(inB / nB * 100).toFixed(1)} %，低于门限 ${belowThr.length} 行全部写明原因`)

  const snapP = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/positions?method=aoa&emitter_id=uav-2').then(r => r.json())`)
  check('定位端点支持按目标与方法过滤',
    snapP.length > 0 && snapP.every((p) => p.emitter_id === 'uav-2' && p.method === 'aoa'), `${snapP.length} 行`)

  // uav-2 在 30 s 关、40 s 开：本次只跑 20 s，所以 tx_on 应当全程为真
  check('20 s 窗口内三个源都在发射（uav-2 的关断在 30 s 之后）',
    bearings.every((b) => !(b.reasons ?? []).includes('tx_off')), '无 tx_off 行')

  // ---------- ⑨ 切到时差定位重跑：站钟、时统档与系统偏差 ----------
  await page.evaluate("(document.querySelector('[data-slot=loc]').click(), true)")
  await sleep(300)
  await page.evaluate(setSelect('[data-form=slot] [data-field=method]', 'tdoa'))
  await sleep(500)
  const locMethod = await page.waitFor((s) => s.app?.chain?.locMethod === 'tdoa', { label: '切到时差定位' })
  check('多站定位可切到时差档', locMethod.app.chain.locMethod === 'tdoa', String(locMethod.app.chain.locMethod))

  for (let i = 0; i < 60; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const before2 = locMethod.app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  let st2 = await page.waitFor((s) => s.app?.context?.taskId && s.app.context.taskId !== before2, { label: '时差任务已提交' })
  const task2 = st2.app.context.taskId
  st2 = await page.waitFor((s) => ['finished', 'failed', 'cancelled'].includes(s.app?.task?.runState),
    { label: '时差任务结束', timeoutMs: 300000 })
  check('时差定位的框图跑得完（隐含的到达时间节点由编译器自动接上）',
    st2.app.task.runState === 'finished', `${st2.app.task.runState} / ${st2.app.task.result}`)

  const tpos = await page.evaluateAsync(`fetch('/api/v1/results/${task2}/positions?t0=0&t1=1e9&stride=1').then(r => r.json())`)
  check('时差解带非空的时统质量（交叉定位那一档是 null）',
    tpos.length > 0 && tpos.every((p) => p.method === 'tdoa')
    && tpos.every((p) => typeof p.time_quality === 'string' && p.time_quality.startsWith('TQ-')),
    `${tpos.length} 行，时统档 ${[...new Set(tpos.map((p) => p.time_quality))].join('/')}`)
  check('时差解写明了参考站（信噪比最高的那一站）',
    tpos.every((p) => typeof p.reference_site === 'string' && p.participating_sites.includes(p.reference_site)),
    `参考站 ${[...new Set(tpos.map((p) => p.reference_site))].sort().join('/')}`)
  check('demo-03 的站钟不完美，因此没有一行是 TQ-1（site-2 5 ns、site-3 10 ns 保持态）',
    tpos.every((p) => p.time_quality !== 'TQ-1'), [...new Set(tpos.map((p) => p.time_quality))].join('/'))

  // 时差定位在 2.2 km 基线、纳秒级站钟下应当比交叉定位准两个量级
  const trk2 = await page.evaluateAsync(`fetch('/api/v1/results/${task2}/track?t0=0&t1=1e9&stride=1').then(r => r.json())`)
  const tmap2 = new Map()
  for (const e of trk2) tmap2.set(`${e.t_s.toFixed(6)}|${e.id}`, e)
  const errs = []
  const good = []
  for (const p of tpos) {
    if (p.state === 'invalid') continue
    const t = tmap2.get(`${p.t_s.toFixed(6)}|${p.emitter_id}`)
    if (!t) continue
    const o = p.enu_origin
    const tv = enu(ecef(t.lon, t.lat, 0), o)
    const fv = enu(ecef(p.lon, p.lat, 0), o)
    const d = [tv[0] - fv[0], tv[1] - fv[1]]
    errs.push(Math.hypot(d[0], d[1]))
    if (p.geometry_quality === 'good') good.push({ d, p })
  }
  errs.sort((a, b) => a - b)
  const med = errs[Math.floor(errs.length / 2)]
  check('时差定位的中位误差在 2.2 km 基线上是米级（交叉定位是百米级）', med < 30, `${med.toFixed(2)} m`)

  // site-3 的固定钟差 20 ns（= 6 m 距离差）会造成**系统偏差**，协方差表达不了它——
  // 这正是场景里 bias_ns 存在的意义。扣掉系统偏差后 2σ 覆盖才回到 86.5% 附近。
  const mu = [good.reduce((a, g) => a + g.d[0], 0) / good.length,
              good.reduce((a, g) => a + g.d[1], 0) / good.length]
  const biasNorm = Math.hypot(mu[0], mu[1])
  check('未标定的站钟固定偏差造成可见的系统偏差（20 ns ≈ 6 m 距离差）',
    biasNorm > 1 && biasNorm < 20, `${biasNorm.toFixed(2)} m`)
  let inG = 0
  for (const g of good) {
    const dx = g.d[0] - mu[0], dy = g.d[1] - mu[1]
    const rot = g.p.ellipse.rotation_deg * Math.PI / 180
    const u = dx * Math.cos(rot) + dy * Math.sin(rot)
    const v = -dx * Math.sin(rot) + dy * Math.cos(rot)
    if ((u / g.p.ellipse.semi_major_m) ** 2 + (v / g.p.ellipse.semi_minor_m) ** 2 <= 1) inG++
  }
  check('几何良好且扣掉系统偏差后，真值落 2σ 椭圆内 ∈ [0.80, 0.93]',
    good.length > 100 && inG / good.length >= 0.80 && inG / good.length <= 0.93,
    `${inG}/${good.length} = ${(inG / good.length * 100).toFixed(1)} %（理论 86.5%）`)

  // ---------- ⑩ 界面：地图叠加层与读数 ----------
  await page.evaluate("(window.location.hash = '#/scene', true)")
  await page.waitFor((s) => s.app?.view === 'scene', { label: '场景页' })
  await sleep(2500)
  const overlay = await evalJson(page, "document.querySelectorAll('canvas.cuav-fix-overlay').length")
  check('场景页有测向与定位的 Canvas 叠加层', overlay === 1, `${overlay} 块画布`)

  // 态势快照摊在 app 一层上（AppShell 里 `...situationSnapshot()`），不是 app.situation
  const nb = await page.waitFor((s) => (s.app?.bearings ?? []).length === 9, { label: '测向读数进 store' })
  check('探针里能看到 9 条测向读数（结束后从 bearings.jsonl 整批补齐）',
    (nb.app.bearings ?? []).length === 9, `${(nb.app.bearings ?? []).length} 条`)
  const oneB = (nb.app.bearings ?? [])[0] ?? {}
  check('读数带质量分档与 σ', typeof oneB.sigma_deg === 'number' && typeof oneB.quality === 'string',
    `${oneB.id} σ ${oneB.sigma_deg} ${oneB.quality}`)
  const np2 = await page.waitFor((s) => (s.app?.positions ?? []).length === 3, { label: '定位解进 store' })
  check('探针里能看到三个目标各一个定位解', (np2.app.positions ?? []).length === 3,
    (np2.app.positions ?? []).map((p) => `${p.id} CEP ${Math.round(p.cep_m)} m`).join('，'))

  await page.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((e) => e.textContent.includes('图层'));
    if (b) b.click(); return true })()`)
  // 弹层是 React 渲染的，点完要等一帧
  const layerToggle = await waitDom(page, "document.querySelectorAll('[data-layer=fix]').length", 1)
  check('图层弹层里有「测向线与定位椭圆」开关', layerToggle === 1, `${layerToggle} 个`)

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
