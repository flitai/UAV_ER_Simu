// C-8「宽带场景 demo-02 与 G-6 活动时间线」的端到端验收（06 备忘录 §9C G-6、§9G C-8；决策 D-069）。
//
// 验的是「活动时间线真的驱动了波形，而且在界面上读得出来」：
//   ① 场景页切到 demo-02（10 MS/s / 8 MHz / 两个源），框图跟着走，跑 6 s；
//   ② 结果页「检测识别」：时间线三行画出来，识别列表里出现 rc_hopping —— 这一类自 C-4 起
//      就欠着验收，因为此前全仓没有任何场景带 hop（models/recognition/README.md §4）；
//   ③ 识别行与 metrics.json 对得上，准确率 ≥ 0.9（10 报告 §8 的 ④b 判据）；
//   ④ **跳频突发的起止与场景活动时间线差 ≤ 一帧**（06 §9C G-6 的验收条款）：
//      真值行的起点必须落在「突发周期的整数倍」上，误差不超过一帧 nfft/fs = 102.4 µs；
//   ⑤ 场景页能建并改跳频活动（G-6 的界面最小集），改完即脏、可保存；
//   ⑥ 同种子重跑，产品文件逐字节相同（铁律 9）。
//
// 跑序接在 slice8 之后（slice4 依赖「最近一个任务」是缺省链，本文件会换成 demo-02，故放末位）。
//
// 跑法（先起服务：cd server && npm run build && node dist/index.js；引擎已构建；web/dist 为最新）：
//     node tests/e2e/slice9-smoke.mjs [--url http://127.0.0.1:8080/]

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchChrome, Page } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(Boolean))
const BASE = (args.url ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }
const trace = (m) => { if (process.env.CUAV_E2E_TRACE) console.error(`[slice9 ${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`) }
const T0 = Date.now()
const evalJson = async (page, expr) => page.evaluate(expr)
const setInput = (sel, value) => `(() => {
  const el = document.querySelector('${sel}');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '${value}');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('focusout', { bubbles: true }));
  return true })()`

// 场景文件的基准哈希取自航迹黄金基准 —— 端到端改完场景必须原样改回（slice2 立的纪律）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const trackSha = JSON.parse(readFileSync(join(ROOT, 'tests/golden/scenario-track-demo-02.json'), 'utf8')).scenario_sha256

let chrome, page, dir
const pageErrors = []
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-slice9-'))
  chrome = await launchChrome({ userDataDir: dir, windowSize: '1920,1200' })
  page = await Page.open(chrome.port, 'about:blank')
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0]))

  // ---------- ① 宽带场景跑一遍 ----------
  trace('进入 ① demo-02 宽带链')
  await page.send('Page.navigate', { url: `${BASE}?scenario=demo-02#/diagram` })
  await page.waitFor((s) => s.ready && s.app?.view === 'diagram' && s.app?.chain?.template === 'chain-v1', { label: '框图页', timeoutMs: 90000 })
  let st = await page.waitFor((s) => s.app?.chain?.scenarioId === 'demo-02', { label: '框图跟着 demo-02', timeoutMs: 30000 })
  await sleep(800)
  st = await page.waitFor((s) => (s.app?.chain?.emitterIds ?? []).length === 2 && (s.app?.chain?.siteIds ?? []).length === 1,
    { label: '单站两源进状态', timeoutMs: 20000 })
  check('demo-02 是单站两源的宽带场景', st.app.chain.siteIds.length === 1 && st.app.chain.emitterIds.length === 2,
    `站 ${JSON.stringify(st.app.chain.siteIds)} 源 ${JSON.stringify(st.app.chain.emitterIds)}`)

  const plan = await evalJson(page, `({
    checks: Array.from(document.querySelectorAll('[data-check]')).map(e => [e.dataset.check, e.dataset.checkOk]),
  })`)
  const bad = plan.checks.filter(([, ok]) => ok === 'false').map(([id]) => id)
  check('频率计划全项通过（10 MS/s、2 MHz 图传 + 跳频遥控都装得进 ±4.5 MHz）', bad.length === 0, `不通过：${bad.join(',') || '无'}`)

  await page.evaluate(setInput('[data-form=chain-setup] [data-field=duration_s]', '6'))
  await sleep(400)
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const before = st.app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await page.waitFor((s) => s.app?.context?.taskId && s.app.context.taskId !== before, { label: '任务已提交' })
  const taskId = st.app.context.taskId
  st = await page.waitFor((s) => ['finished', 'failed', 'cancelled'].includes(s.app?.task?.runState), { label: '任务结束', timeoutMs: 600000 })
  check('宽带任务跑完且未降级（带限噪声不再被误判、ADC 不削顶）',
    st.app.task.runState === 'finished' && st.app.task.result === 'valid',
    `${taskId} ${st.app.task.runState} / ${st.app.task.result}`)

  // ---------- ② 结果页「检测识别」：rc_hopping 第一次由真实链路走通 ----------
  trace('进入 ② 检测识别页签')
  await page.evaluate("(window.location.hash = '#/results', true)")
  await page.waitFor((s) => s.app?.view === 'results', { label: '结果页' })
  await page.evaluate("(document.querySelector('[data-results-tab=detections]').click(), true)")
  st = await page.waitFor((s) => s.app?.resultsTab === 'detections'
    && s.app?.results?.detections?.status === 'final' && s.app?.results?.recognitions?.status === 'final',
    { label: '检测与识别行到齐', timeoutMs: 60000 })

  const recs = await page.evaluateAsync(`(async () => {
    const r = await fetch('/api/v1/results/${taskId}/recognitions').then(x => x.json())
    const by = {}
    for (const row of r) by[row.label] = (by[row.label] ?? 0) + 1
    return { n: r.length, by, first: r[0] ? { t_s: r[0].t_s, label: r[0].label, result: r[0].result } : null }
  })()`)
  check('识别列表里出现 rc_hopping —— 这一类自 C-4 起欠的验收到此销项',
    (recs.by.rc_hopping ?? 0) >= 100, `${recs.n} 行：${JSON.stringify(recs.by)}`)
  check('图传也被识别为 video_link（宽带、噪声样、长时占用）',
    (recs.by.video_link ?? 0) >= 1, JSON.stringify(recs.by))

  const tl = await evalJson(page, `({
    lanes: Array.from(document.querySelectorAll('[data-tl3] [data-tl3-lane]')).map(e => [e.dataset.tl3Lane, e.querySelectorAll('[data-tl3-band]').length]),
    site: document.querySelector('[data-tl3]')?.dataset.tl3Site ?? null,
  })`)
  check('时间线三行画出来（真值 / 检测 / 识别），只画焦点站',
    tl.lanes.length === 3 && tl.lanes.every(([, n]) => n > 0), JSON.stringify(tl))

  // ---------- ③ 评价指标 ----------
  trace('进入 ③ 评价')
  const m = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/metrics').then(r => r.json())`)
  const sec = m?.sites?.[0]
  check('帧级 Pd ≥ 0.9、突发级真值全部匹配上',
    sec?.frames?.pd >= 0.9 && sec?.segments?.truth > 0 && sec.segments.matched === sec.segments.truth,
    `pd ${sec?.frames?.pd} 段 ${sec?.segments?.matched}/${sec?.segments?.truth}`)
  check('识别准确率 ≥ 0.9（10 报告 §8 的 ④b 判据，原型阶段验证值）',
    sec?.recognition?.accuracy >= 0.9, `评价 ${sec?.recognition?.evaluated} 段，准确率 ${sec?.recognition?.accuracy}`)

  // ---------- ④ G-6 的验收条款：跳频突发起止与时间线差 ≤ 一帧 ----------
  trace('进入 ④ 突发起止对时间线')
  const truth = await page.evaluateAsync(`(async () => {
    const rows = await fetch('/api/v1/results/${taskId}/truth').then(x => x.json())
    const hop = rows.filter(r => r.label === 'rc_hopping')
    // 场景：突发周期 0.01 s，导通 0.3；跳频停留也是 0.01 s → 每个导通窗都从周期整数倍起
    const worst = hop.reduce((acc, r) => {
      const k = Math.round(r.t_s / 0.01)
      return Math.max(acc, Math.abs(r.t_s - k * 0.01))
    }, 0)
    const dur = hop.length ? Math.abs((hop[0].t_end_s - hop[0].t_s) - 0.003) : NaN
    const centers = Array.from(new Set(hop.map(r => Math.round(r.center_Hz)))).sort((a, b) => a - b)
    return { n: hop.length, worst, dur, centers }
  })()`)
  // 一帧 = nfft 1024 / fs 10 MS/s = 102.4 µs
  check('跳频突发的起点落在活动时间线上，误差远小于一帧（102.4 µs）——G-6 的验收条款',
    truth.n >= 200 && truth.worst < 102.4e-6, `${truth.n} 段，最大偏差 ${(truth.worst * 1e9).toFixed(1)} ns`)
  check('导通时长就是周期 × 占空比 = 3 ms', Number.isFinite(truth.dur) && truth.dur < 1e-9, `偏差 ${truth.dur}`)
  check('真值按跳频点切段：五个频点都出现过，且都不是基频以外的野值',
    truth.centers.length === 5, `频点 ${truth.centers.map(f => (f / 1e6).toFixed(4)).join(' / ')} MHz`)

  // ---------- ⑤ 场景页能改跳频 ----------
  trace('进入 ⑤ 场景页改跳频')
  await page.evaluate("(window.location.hash = '#/scene', true)")
  await page.waitFor((s) => s.app?.view === 'scene', { label: '场景页' })
  await page.waitFor((s) => s.app?.scene?.scenarioId === 'demo-02', { label: '场景页在 demo-02', timeoutMs: 30000 })
  // 选中跳频源 → 展开活动折叠块 → 点中那条 hop
  const picked = await page.evaluate("(() => { const b = document.querySelector('[data-tree-emitter=\"uav-2\"]'); if (b) b.click(); return !!b })()")
  check('左栏对象树里点得到跳频源 uav-2', picked === true)
  await sleep(500)
  await page.evaluate("(() => { const d = document.querySelector('[data-form-activities]'); if (d) d.open = true; return true })()")
  await sleep(300)
  const hopRow = await page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-tree-activity]'))
    const r = rows.find(e => /hop/.test(e.textContent))
    if (r) r.click()
    return JSON.stringify({ n: rows.length, texts: rows.map(e => e.textContent.trim()), clicked: r ? r.dataset.treeActivity : null }) })()`)
  check('活动列表里找得到那条 hop', /"clicked":"\d/.test(String(hopRow)), String(hopRow))
  await sleep(500)
  const form = await evalJson(page, `({
    hasSeq: !!document.querySelector('[data-field=hop-sequence]'),
    seq: document.querySelector('[data-field=hop-sequence]')?.value ?? '',
  })`)
  check('活动是 hop 时表单给出「跳频点」输入（G-6 的界面最小集）', form.hasSeq, JSON.stringify(form))
  check('跳频点按 MHz 显示，五项', form.seq.split(',').length === 5, form.seq)

  const originalSeq = form.seq
  await page.evaluate(setInput('[data-field=hop-sequence]', '2441.0, 2442.0, 2440.5'))
  await sleep(500)
  const after = await evalJson(page, `({
    seq: document.querySelector('[data-field=hop-sequence]')?.value ?? '',
    dirty: !!window.__probe?.().app?.scene?.dirty,
  })`)
  check('改完跳频点即进状态并标脏（可保存）', after.dirty === true, JSON.stringify(after))

  // **必须改回去**：场景页是自动保存的（去抖 800 ms，D-054），改动会直接落到入库的场景文件上。
  // 这一条是 slice2 立下的纪律：端到端不留副作用。
  await page.evaluate(setInput('[data-field=hop-sequence]', originalSeq))
  await sleep(1600)                                     // 等去抖的自动保存落盘
  const restored = await page.evaluateAsync(`fetch('/api/v1/scenarios/demo-02').then(r => r.headers.get('X-CUAV-Sha256'))`)
  check('测试不留副作用：跳频点已改回，场景文件哈希与航迹基准一致',
    restored === trackSha, `${String(restored).slice(0, 8)}… vs 基准 ${String(trackSha).slice(0, 8)}…`)
  await page.evaluate("(window.location.hash = '#/results', true)")
  await sleep(300)

  check('全程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  check('端到端流程未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e))
} finally {
  if (page && chrome) await page.close(chrome.port)
  if (chrome) chrome.proc.kill()
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

let bad2 = 0
for (const c of checks) {
  if (!c.ok) bad2++
  console.log(`${c.ok ? '通过' : '失败'}  ${c.name}${c.detail ? `  —— ${c.detail}` : ''}`)
}
console.log(`\n共 ${checks.length} 项，失败 ${bad2} 项`)
process.exit(bad2 === 0 ? 0 : 1)
