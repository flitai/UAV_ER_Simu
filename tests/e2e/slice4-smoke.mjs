// 切片 ④a「典型链路跑通」的端到端验收（06 备忘录 §9E、§9G C-2 / C-6 / C-7；设计见 10 报告）。
//
// 核心判据有三条：
//   ① 框图页默认就是典型链路视图，九个环节都在，用户只改参数（D-051 ①）；
//   ② 拆开天线与接收机之后，**S1 的读数仍等于链路预算**，S2 的底噪等于 −174 + nf + 10·log10 fs
//      ——这是 C-2 把一个乘法拆成四个组件的正确性判据，不是「跑得起来」就算数；
//   ③ 框图能存能再开（C-6），存下去的字节与规范序列化逐字节相同。
//
// 跑法（先起服务：cd server && npm run build && node dist/index.js；引擎已构建；web/dist 为最新）：
//     node tests/e2e/slice4-smoke.mjs [--url http://127.0.0.1:8080/]

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchChrome, Page } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(Boolean))
const BASE = (args.url ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }
// 页面里的同步表达式用 evaluate；带 fetch 的异步表达式必须用 evaluateAsync
// （evaluate 会把表达式塞进 JSON.stringify(...)，里面写 await 是语法错）
const evalJson = async (page, expr) => page.evaluate(expr)
const setSelect = (sel, value) => `(() => {
  const el = document.querySelector('${sel}');
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, '${value}');
  el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`

// React 的受控组件记着自己的 value，直接赋值不会触发 onChange，必须走原型上的原生 setter；
// 且 React 的 onBlur 实际监听的是 **focusout**，只派发 blur 事件不会触发（这条踩过一次）。
const setInput = (sel, value) => `(() => {
  const el = document.querySelector('${sel}');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '${value}');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('focusout', { bubbles: true }));
  return true })()`

/** dB 域比较：|a − b| ≤ tol */
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol

let chrome, page, dir
const pageErrors = []
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-slice4-'))
  chrome = await launchChrome({ userDataDir: dir, windowSize: '1920,1200' })
  page = await Page.open(chrome.port, 'about:blank')
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0]))
  await page.send('Page.navigate', { url: `${BASE}#/diagram` })
  await page.waitFor((s) => s.ready && s.app?.view === 'diagram', { label: '框图页', timeoutMs: 90000 })
  await sleep(800)

  // ---------- ① 框图页默认是典型链路视图 ----------
  let st = await page.waitFor((s) => s.app?.chain?.template === 'chain-v1', { label: '典型链路载入' })
  check('框图页默认是典型链路视图，不是自由画布', st.app.chain.template === 'chain-v1' && st.app.chain.canvas === false,
    `template ${st.app.chain.template}，canvas ${st.app.chain.canvas}`)
  check('缺省是全合成模式并绑定 demo-01 的单站单机', st.app.chain.mode === 'synthetic'
    && st.app.chain.scenarioId === 'demo-01' && st.app.chain.siteId === 'site-1' && st.app.chain.emitterId === 'uav-1',
    `${st.app.chain.mode} / ${st.app.chain.scenarioId} / ${st.app.chain.siteId} / ${st.app.chain.emitterId}`)

  const cards = await evalJson(page, "Array.from(document.querySelectorAll('[data-slot]')).map(e => e.dataset.slot)")
  check('九个环节都画出来（04 §5.1 的端到端对象）',
    JSON.stringify(cards) === JSON.stringify(['tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'ddc', 'chan', 'det']),
    cards.join(' → '))

  const states = await evalJson(page, "Object.fromEntries(Array.from(document.querySelectorAll('[data-slot]')).map(e => [e.dataset.slot, e.dataset.slotState]))")
  check('DDC 与信道化标未实现而不是隐藏（M-2 / M-3 未到）',
    states.ddc === 'unavailable' && states.chan === 'unavailable', JSON.stringify(states))
  check('其余七个环节是启用态', ['tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'det'].every((k) => states[k] === 'active'),
    JSON.stringify(states))
  const note = await page.evaluate("document.querySelector('[data-slot=ddc] [data-slot-note]')?.textContent ?? ''")
  check('未实现的环节给出理由，不是空着', /M-2/.test(note), note.slice(0, 40))

  // 画布不出现：没有组件库、没有连线操作
  const palette = await page.evaluate("document.querySelectorAll('[data-palette-group]').length")
  check('典型链路视图没有组件库（用户不增删节点）', palette === 0, `${palette} 个分组`)

  // ---------- 频率计划的六项检查 ----------
  const plan = await evalJson(page, "Object.fromEntries(Array.from(document.querySelectorAll('[data-check]')).map(e => [e.dataset.check, e.dataset.ok]))")
  check('频率计划六项检查全过（04 §9.3）', Object.values(plan).every((v) => v === '1'), JSON.stringify(plan))
  check('检查项含 ADC 量化噪声那一条（实测逼出来的）', 'adc_floor' in plan, Object.keys(plan).join(','))

  // ---------- ② 改一个参数，看它进框图 ----------
  await page.evaluate("(document.querySelector('[data-slot=rx_fe]').click(), true)")
  await sleep(200)
  await page.evaluate(setInput('[data-form=slot] [data-field=nf_dB]', '4'))
  await sleep(300)
  const dirty = await page.waitFor((s) => s.app?.diagram?.dirty === true, { label: '改参数后置脏' })
  check('改参数即进框图并置脏（撤销栈沿用 U-2 的那一套）', dirty.app.diagram.dirty === true)
  // 改回去
  await page.evaluate(setInput('[data-form=slot] [data-field=nf_dB]', '6'))
  await sleep(300)

  // ---------- 勾上 S1 与 S2，缩短时长，跑一次 ----------
  // 勾上而不是切换：上一次运行保存的框图可能已经勾着，切换会把它关掉。
  // 端到端用例必须对「服务端上一次留下的状态」免疫，否则第二次跑就红。
  for (const t of ['s1', 's2']) {
    await page.evaluate(`(() => { const el = document.querySelector('[data-tap-toggle=${t}]');
      if (el && !el.checked) el.click(); return true })()`)
    await sleep(150)
  }
  await page.evaluate(setInput('[data-form=chain-setup] [data-field=duration_s]', '6'))
  await sleep(400)
  st = await page.waitFor((s) => (s.app?.chain?.taps ?? []).includes('s1') && (s.app?.chain?.taps ?? []).includes('s2'), { label: '观测点勾上' })
  check('S1 与 S2 观测点可勾选', st.app.chain.taps.join(',').includes('s1') && st.app.chain.taps.includes('s2'), st.app.chain.taps.join(','))

  for (let i = 0; i < 40; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const before = st.app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await page.waitFor((s) => s.app?.context?.taskId && s.app.context.taskId !== before, { label: '任务已提交' })
  const taskId = st.app.context.taskId
  check('典型链路直接提交并通过引擎校验', !!taskId, taskId ?? '')
  st = await page.waitFor((s) => ['finished', 'failed', 'cancelled'].includes(s.app?.task?.runState), { label: '任务结束', timeoutMs: 180000 })
  check('任务跑完', st.app.task.runState === 'finished', `${st.app.task.runState} / ${st.app.task.result}`)

  // ---------- ③ 电平判据：S1 = 链路预算，S2 底噪 = −174 + nf + 10·log10 fs ----------
  const links = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/links?t0=4&t1=4.2').then(r => r.json())`)
  check('链路读数可取（G-2 的 links.jsonl）', Array.isArray(links) && links.length > 0, `${links?.length ?? 0} 条`)
  const lk = links[0]
  // 场景 demo-01：tx_power 27 dBm、发射天线 2 dBi、接收天线 3 dBi
  const wantS1 = 27 + 2 + 3 - lk.path_loss_dB
  const s1 = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/s1/spectrum?t0=4&t1=4.05&px=1024&py=1&stat=max')
    .then(async (r) => { const b = new Float32Array(await r.arrayBuffer()); let m = -Infinity;
      for (const v of b) if (v > m) m = v; return { peak: m } })`)
  // 单音落在一个 bin 上，峰值即其功率；hann 的扇贝损耗最坏 1.42 dB（D-049 ⑪）
  check('S1 读数等于链路预算（拆开天线之后仍然成立，C-2 的核心判据）',
    near(s1.peak, wantS1, 1.5), `实测 ${s1.peak.toFixed(2)} dBm，链路预算 ${wantS1.toFixed(2)} dBm（距离 ${lk.distance_m.toFixed(1)} m）`)

  const s2 = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/s2/spectrum?t0=4&t1=4.05&px=1024&py=1&stat=mean')
    .then(async (r) => { const b = Array.from(new Float32Array(await r.arrayBuffer())); b.sort((x, y) => x - y);
      return { median: b[Math.floor(b.length / 2)] } })`)
  // 前端增益 20 dB、噪声系数 6 dB、fs 500 kS/s、nfft 1024、hann 等效噪声带宽 1.5。
  // `stat=mean` 已经在时间窗内把几十帧平均过了，所以逐 bin 的值已经是**均值**；
  // 再取跨 bin 的中位数只是挑一个代表，不必再补指数分布的中位数修正（−1.59 dB）。
  const wantS2 = -174 + 6 + 10 * Math.log10(500000) + 20 - 10 * Math.log10(1024) + 10 * Math.log10(1.5)
  check('S2 底噪等于 −174 + nf + 10·log10 fs + 增益（噪声由噪声系数生成，D-050 ②）',
    near(s2.median, wantS2, 0.5), `实测 ${s2.median.toFixed(2)} dBm，解析 ${wantS2.toFixed(2)} dBm`)

  const idx = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/s4/spectrum/index').then(r => r.json())`)
  check('S4 索引带 dBm 标度与削顶计数（D-047、D-051）', idx.scale === 'dBm' && typeof idx.clipped_samples === 'number',
    `scale ${idx.scale}，削顶 ${idx.clipped_samples}`)
  check('本次运行没有削顶（满量程留了余量）', idx.clipped_samples === 0, String(idx.clipped_samples))

  // ---------- ③ 框图能存能再开 ----------
  await page.evaluate("(document.querySelector('[data-action=chain-save]').click(), true)")
  st = await page.waitFor((s) => s.app?.unsaved?.diagram === false, { label: '保存完成', timeoutMs: 30000 })
  check('保存到服务端后不再是脏的（C-6）', st.app.unsaved.diagram === false)

  const saved = await page.evaluateAsync(`fetch('/api/v1/diagrams').then(r => r.json())`)
  check('保存的框图出现在清单里并带 template_ref 摘要',
    saved.diagrams.some((d) => d.template_id === 'chain-v1' && d.mode === 'synthetic'),
    JSON.stringify(saved.diagrams.map((d) => d.diagram_id)))

  const onDisk = await page.evaluateAsync(`fetch('/api/v1/diagrams/${saved.diagrams[0].diagram_id}').then(r => r.text())`)
  const inPage = await page.evaluate('window.__cuav?.diagramText?.() ?? null')
  if (inPage !== null) {
    check('盘上字节与页面里的规范文本逐字节相同', onDisk === inPage)
  } else {
    check('盘上的框图能解析且是典型链路', /"template_id": "chain-v1"/.test(onDisk))
  }

  // 刷新后仍然回到典型链路视图，且载入的是刚存的那份
  await page.send('Page.navigate', { url: `${BASE}#/diagram` })
  st = await page.waitFor((s) => s.ready && s.app?.chain?.template === 'chain-v1', { label: '刷新后仍是典型链路', timeoutMs: 90000 })
  check('刷新后载入已保存的框图，仍在典型链路视图', st.app.chain.template === 'chain-v1' && st.app.chain.canvas === false)

  // 收尾删掉本次存的框图：不给下一次运行留状态，也不往仓库里塞测试产物
  const del = await page.evaluateAsync(`fetch('/api/v1/diagrams/${saved.diagrams[0].diagram_id}', { method: 'DELETE' }).then(r => r.status)`)
  check('测试不留副作用：保存的框图已删除', del === 200, String(del))

  // ---------- 自由画布仍在，只是降为高级模式 ----------
  await page.send('Page.navigate', { url: `${BASE}#/diagram/canvas` })
  await page.waitFor((s) => s.app?.view === 'diagram', { label: '自由画布' })
  await sleep(600)
  const paletteGroups = await page.evaluate("document.querySelectorAll('[data-palette-group]').length")
  check('自由画布仍可用（降为高级模式，不是删掉）', paletteGroups === 6, `${paletteGroups} 个分组`)

  check('全程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
} catch (e) {
  check('端到端流程未抛异常', false, String(e).slice(0, 300))
} finally {
  if (page && chrome) await page.close(chrome.port)
  if (chrome) chrome.proc.kill()
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

let bad = 0
for (const c of checks) {
  console.log(`${c.ok ? '通过' : '失败'}  ${c.name}${c.detail ? `  —— ${c.detail}` : ''}`)
  if (!c.ok) bad++
}
console.log(`\n共 ${checks.length} 项，失败 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
