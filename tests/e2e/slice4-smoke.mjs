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

/**
 * 轮询 DOM 直到表达式取到期望值。
 * `page.waitFor` 轮询的是 store 探针，它先于 React 重绘——先等探针再立刻读 DOM 会偶发读到上一帧
 * （2026-09-08 见过两次单项偶发失败）。凡是「状态变了，看界面是否跟着变」的断言都走这个。
 */
const waitDom = async (page, expr, want, ms = 4000) => {
  const t0 = Date.now()
  let got
  do {
    got = await page.evaluate(expr)
    if (got === want) return got
    await sleep(100)
  } while (Date.now() - t0 < ms)
  return got
}

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
  // 04 §5.1 的九个环节，加 D-053 在尾部补的测向与多站定位共十一个
  check('十一个环节都画出来（04 §5.1 九环节 + D-053 的测向与多站定位）',
    JSON.stringify(cards) === JSON.stringify(['tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'ddc', 'chan', 'det', 'df', 'loc']),
    cards.join(' → '))

  const states = await evalJson(page, "Object.fromEntries(Array.from(document.querySelectorAll('[data-slot]')).map(e => [e.dataset.slot, e.dataset.slotState]))")
  check('DDC 与信道化标未实现而不是隐藏（M-2 / M-3 未到）',
    states.ddc === 'unavailable' && states.chan === 'unavailable', JSON.stringify(states))
  // 两个新槽位都缺省旁路：测向在单站演示里没有增量，多站定位至少要两个站（D-053 §2.4）
  check('测向与多站定位缺省都旁路，单站的缺省链因此逐字节不变（D-053）',
    states.df === 'bypass' && states.loc === 'bypass', `df ${states.df} / loc ${states.loc}`)
  check('其余七个环节是启用态', ['tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'det'].every((k) => states[k] === 'active'),
    JSON.stringify(states))
  const note = await page.evaluate("document.querySelector('[data-slot=ddc] [data-slot-note]')?.textContent ?? ''")
  check('未实现的环节给出理由，不是空着', /M-2/.test(note), note.slice(0, 40))

  // 观测点一行写全名，不是只写 S0…S5 让人去悬停（2026-09-08 用户反馈）
  const tapLabels = await evalJson(page, "Array.from(document.querySelectorAll('.tap-row [data-tap]')).map((e) => e.textContent.trim())")
  check('观测点写全名而不只写编号',
    JSON.stringify(tapLabels) === JSON.stringify(['S0 辐射源输出', 'S1 接收天线端', 'S2 前端输出', 'S3 量化后', 'S4 主产品', 'S5 子信道']),
    tapLabels.join(' | '))
  const tapLines = await evalJson(page, `(() => { const es = Array.from(document.querySelectorAll('.tap-row [data-tap]'));
    return [...new Set(es.map((e) => Math.round(e.getBoundingClientRect().y)))].length })()`)
  check('六个全名在 2K 基线下仍是一行', tapLines === 1, `${tapLines} 行`)

  // 链条块占满工具条以下的高度并纵向居中，不把一行卡片吊在顶上留一大片空白
  const fill = await evalJson(page, `(() => { const b = document.querySelector('.chain-body').getBoundingClientRect();
    const m = document.querySelector('.chain-main').getBoundingClientRect();
    const s = document.querySelector('.chain-strip').getBoundingClientRect();
    return { bodyBottomGap: Math.round(m.bottom - b.bottom),
      above: Math.round(s.top - b.top), below: Math.round(b.bottom - document.querySelector('.tap-row').getBoundingClientRect().bottom) } })()`)
  check('链条区占满中栏高度（下方不再是裸露的空白）', fill.bodyBottomGap <= 12, `底部余 ${fill.bodyBottomGap} px`)
  check('链条在区内纵向居中', Math.abs(fill.above - fill.below) <= 24, `上 ${fill.above} px / 下 ${fill.below} px`)

  // 环节按**每行四张、蛇形**排（2026-09-09 用户指定）：单数行从左往右、双数行从右往左，
  // 行末向下转折。十一个槽位排成 4 + 4 + 3。
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
  check('环节按每行四张排，十一个排成 4 + 4 + 3',
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
  await page.evaluate(setInput('[data-form=slot] [data-field=gain_dB]', '24'))
  await sleep(300)
  const dirty = await page.waitFor((s) => s.app?.diagram?.dirty === true, { label: '改参数后置脏' })
  check('改参数即进框图并置脏（撤销栈沿用 U-2 的那一套）', dirty.app.diagram.dirty === true)
  // 改回去
  await page.evaluate(setInput('[data-form=slot] [data-field=gain_dB]', '20'))
  await sleep(300)

  // ---------- ②b 实体选择器与场景里的设备参数（D-054）----------
  const bar = await page.evaluate("!!document.querySelector('[data-chain-entity-bar]')")
  check('面板上方有无人机与侦测站两个选择框', bar === true)
  const picks = await evalJson(page, `(() => {
    const e = document.querySelector('[data-field=focus-emitter]')
    const s = document.querySelector('[data-field=focus-site]')
    return { em: e && e.value, site: s && s.value,
             emText: e && e.selectedOptions[0] && e.selectedOptions[0].textContent }
  })()`)
  check('缺省焦点落在参与运行的第一架无人机与第一个站',
    picks.em === 'uav-1' && picks.site === 'site-1', JSON.stringify(picks))
  check('条目写得出是哪一台（id · 名称 · 型号）',
    String(picks.emText).includes('uav-1') && String(picks.emText).includes('multirotor'), String(picks.emText))

  // 噪声系数改为由场景带出：组件参数行只说明来源，值在「设备参数 · 来自场景」那组里改
  const nfFrom = await page.evaluate("!!document.querySelector('[data-param-from-scene=nf_dB]')")
  check('噪声系数标为来自场景，不再是框图里的第二份真理源', nfFrom === true)
  const sceneField = '[data-form=entity-device] [data-field="sites.0.receiver.nf_dB"]'
  check('场景设备参数在本页可编辑', await page.evaluate(`!!document.querySelector('${sceneField}')`))

  await page.evaluate(setInput(sceneField, '4'))
  const sceneDirty = await page.waitFor((s) => s.app?.scene?.dirty === true, { label: '改场景字段后置脏' })
  check('改场景设备参数标的是场景脏，不是框图脏', sceneDirty.app.scene.dirty === true)
  // 自动保存：不点任何按钮，等它自己存下去（D-054）
  const autoSaved = await page.waitFor((s) => s.app?.scene?.dirty === false, { label: '场景自动保存', timeoutMs: 30000 })
  check('改完自动存场景，不用点保存', autoSaved.app.scene.dirty === false)
  // 存回原值，不给后面的断言与仓库留副作用
  await page.evaluate(setInput(sceneField, '6'))
  await page.waitFor((s) => s.app?.scene?.dirty === false, { label: '场景存回原值', timeoutMs: 30000 })

  // 传播信道不随实体选择变化（用户明确要求）
  await page.evaluate("(document.querySelector('[data-slot=ch]').click(), true)")
  await sleep(200)
  const chOwner = await page.evaluate("document.querySelector('[data-slot-owner]')?.dataset.slotOwner ?? ''")
  check('传播信道标为全图共用，不随实体选择变化', chOwner === 'shared', chOwner)
  await page.evaluate("(document.querySelector('[data-slot=rx_fe]').click(), true)")
  await sleep(150)

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

  // 勾选只改框图，产品要下次运行才有——不说清楚会让人以为勾了没生效（2026-09-08 用户反馈）
  // 有在先的任务时才有「不一致」可言：第一次跑这套用例时页面上还没有任务，此时不该提示
  // 探针读的是 store、提示读的是 DOM，React 重绘落后一帧，两边可能短暂不一致
  // （2026-09-08 修过同一个竞态，这一处当时漏了；只等一个方向仍会在另一个方向上红）。
  // 轮询到两者自洽再断言：有任务就该有提示，没任务就不该有。
  // 判据是「提示出现 ⟺ 勾选与在跑的那个任务不一致」。不能只看「有没有任务」：
  // 上一个任务的观测点恰好与现在相同时，本来就不该提示（切片 ⑥b 留下别的任务后才发现
  // 这条断言原来读的是恒为 undefined 的 app.task.id，等于一直没生效）。
  // 在跑的观测点从任务端点取，去掉多站的实例后缀再比（D-053 §2.6）。
  const hadTask = await evalJson(page, 'window.__probe().app.context.taskId')
  const wantTaps = (await evalJson(page, 'window.__probe().app.chain.taps')) ?? []
  let ranBases = []
  if (hadTask) {
    const rec = await page.evaluateAsync(`fetch('/api/v1/tasks/${hadTask}').then(r => r.ok ? r.json() : null)`)
    ranBases = [...new Set((rec?.observation_points ?? []).map((o) => String(o.op_id).split('__')[0]))]
  }
  const shouldWarn = !!hadTask && JSON.stringify(wantTaps) !== JSON.stringify(ranBases)
  const stale = await waitDom(page,
    "document.querySelector('[data-chain-taps-stale]') !== null", shouldWarn)
  check('观测点与当前任务不一致时才提示要重新运行，一致时不提示',
    stale === shouldWarn,
    `在跑 ${ranBases.join('/') || '（无任务）'}，勾选 ${wantTaps.join('/')}，应提示 ${shouldWarn}`)

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

  // ---------- 结果页：观测点分得开、切得动，默认仍是主产品 S4 ----------
  await page.send('Page.navigate', { url: `${BASE}#/results` })
  await page.waitFor((s) => s.ready && s.app?.view === 'results', { label: '结果页', timeoutMs: 60000 })
  await sleep(1200)
  const opTabs = await evalJson(page, "Array.from(document.querySelectorAll('[data-op-tab]')).map((e) => e.textContent)")
  check('结果页中栏有观测点页签，且写的是名字不是 op_id',
    opTabs.length === 3 && opTabs[2] === 'S4 主产品', opTabs.join(' | '))
  check('默认选中主产品 S4，勾了中间观测点也不把默认视图挪走',
    (await page.evaluate("document.querySelector('[data-op-tab].on')?.dataset.opTab")) === 's4')

  // 左栏收起后仍换得动观测点——原来这份列表只在左栏，收着栏就没法切（2026-09-08 用户反馈）
  await page.evaluate("(document.querySelector('.col.left .rail').click(), true)")
  await sleep(300)
  check('左栏收起后观测点页签还在', (await page.evaluate("document.querySelectorAll('[data-op-tab]').length")) === 3)
  await page.evaluate("(document.querySelector('[data-op-tab=s1]').click(), true)")
  st = await page.waitFor((s) => s.app?.signal?.opId === 's1', { label: '切到 S1', timeoutMs: 20000 })
  const headOp = await waitDom(page, "document.querySelector('[data-signal-op]')?.textContent", 'S1 接收天线端')
  check('点页签能换观测点，页头随之改', st.app.signal.opId === 's1' && headOp === 'S1 接收天线端', headOp)

  // S1 与 S2 读数确实不同：拆开天线与前端之后，中间点看得出 20 dB 增益差
  const twoOps = {}
  for (const op of ['s1', 's2']) {
    twoOps[op] = await page.evaluateAsync(`fetch('/api/v1/results/${taskId}/${op}/spectrum?t0=4&t1=4.05&px=512&py=1&stat=max')
      .then(async (r) => { const b = new Float32Array(await r.arrayBuffer()); let m = -Infinity; for (const v of b) if (v > m) m = v; return m })`)
  }
  check('勾上的中间观测点读数确实不同（S2 − S1 = 前端增益 20 dB）',
    near(twoOps.s2 - twoOps.s1, 20, 1.5), `S1 ${twoOps.s1.toFixed(2)} dBm，S2 ${twoOps.s2.toFixed(2)} dBm，差 ${(twoOps.s2 - twoOps.s1).toFixed(2)} dB`)

  await page.evaluate("(document.querySelector('.col.left .rail').click(), true)")
  await page.send('Page.navigate', { url: `${BASE}#/diagram` })
  await page.waitFor((s) => s.ready && s.app?.chain?.template === 'chain-v1', { label: '回框图页', timeoutMs: 60000 })
  await sleep(600)

  // 正向分支：刚跑完时不该提示；取消一个观测点，立刻提示要重新运行
  check('刚跑完、观测点没动过时不提示',
    (await page.evaluate("document.querySelector('[data-chain-taps-stale]') === null")) === true)
  await page.evaluate("(document.querySelector('[data-tap-toggle=s2]').click(), true)")
  await waitDom(page, "document.querySelector('[data-chain-taps-stale]') !== null", true)
  const staleNow = await page.evaluate("document.querySelector('[data-chain-taps-stale]')?.textContent ?? ''")
  check('取消一个观测点后，工具条当场说明要重新运行才生效',
    /重新运行后生效/.test(staleNow) && /S1/.test(staleNow) && /S4/.test(staleNow),
    staleNow.replace(/\s+/g, ' ').trim().slice(0, 48))
  await page.evaluate("(document.querySelector('[data-tap-toggle=s2]').click(), true)")
  check('勾回去之后提示消失',
    (await waitDom(page, "document.querySelector('[data-chain-taps-stale]') === null", true)) === true)

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

  // ---------- ④ 画布 ↔ 典型链路能往返（2026-09-08 用户实测发现的导航缺口） ----------
  // 缺口是：进了画布之后 Alt+2 与顶栏「框图」都只切视图不改子形态，回不去。
  // 下面分别验证三条修法，且必须**从画布里出发**，不是刷新地址栏。
  st = await page.waitFor((s) => s.app?.diagram?.canvas === true, { label: '已在自由画布' })
  check('画布里探针报子形态为画布', st.app.diagram.canvas === true)

  const hasBack = await page.evaluate("!!document.querySelector('[data-action=open-chain]')")
  check('画布工具条有「回到典型链路」（与「展开为自由画布」对称）', hasBack === true)

  // 此刻文档还是那条典型链路（前面刷新后载入的就是它），所以按下应当直接回去、不问
  await page.evaluate("(document.querySelector('[data-action=open-chain]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.canvas === false, { label: '回到典型链路', timeoutMs: 20000 })
  const hash1 = await page.evaluate('location.hash')
  check('解得开就直接回，不弹确认', st.app.diagram.canvas === false
    && st.app.chain?.template === 'chain-v1' && hash1 === '#/diagram', `hash ${hash1}`)

  // 顶栏「框图」按钮：先回画布，再点它
  await page.evaluate("(document.querySelector('[data-action=open-canvas]').click(), true)")
  await page.waitFor((s) => s.app?.diagram?.canvas === true, { label: '再进画布' })
  await sleep(400)
  await page.evaluate("(document.querySelector('[data-view-btn=diagram]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.canvas === false, { label: '顶栏「框图」回默认形态', timeoutMs: 20000 })
  check('顶栏「框图」按钮从画布回到默认形态（典型链路）',
    st.app.diagram.canvas === false && (await page.evaluate('location.hash')) === '#/diagram')

  // Alt+2：同样先回画布再按
  await page.evaluate("(document.querySelector('[data-action=open-canvas]').click(), true)")
  await page.waitFor((s) => s.app?.diagram?.canvas === true, { label: '第三次进画布' })
  await sleep(400)
  await page.pressKey({ key: '2', code: 'Digit2', vk: 50, modifiers: 1 })
  st = await page.waitFor((s) => s.app?.diagram?.canvas === false, { label: 'Alt+2 回默认形态', timeoutMs: 20000 })
  check('Alt+2 从画布回到默认形态（典型链路）',
    st.app.diagram.canvas === false && (await page.evaluate('location.hash')) === '#/diagram')

  // ---------- 解不开的那条路：不得静默丢改动（铁律 15） ----------
  // 注意判据：**删**节点仍解得开（缺席的槽位按旁路或缺省处理），**加**一个模板之外的节点才解不开
  // （`parseChain` 的 `if (!hit) return null`）。所以这里从组件库点一个新节点进去。
  await page.evaluate("(document.querySelector('[data-action=open-canvas]').click(), true)")
  await page.waitFor((s) => s.app?.diagram?.canvas === true, { label: '第四次进画布' })
  await sleep(700)
  const nodes0 = await evalJson(page, 'window.__probe().app.diagram.nodes')
  await page.evaluate("(document.querySelector('[data-palette-item=NoiseSource]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.nodes === nodes0 + 1, { label: '画布里加一个节点', timeoutMs: 20000 })
  check('画布里加一个模板之外的节点后，框图不再是典型链路',
    st.app.chain?.template === null, `${nodes0} → ${st.app.diagram.nodes} 节点，template ${st.app.chain?.template}`)

  await page.evaluate("(document.querySelector('[data-action=open-chain]').click(), true)")
  await sleep(400)
  const asked = await page.evaluate("document.querySelector('[data-chain-back-ask]')?.textContent ?? ''")
  const stillCanvas = await evalJson(page, 'window.__probe().app.diagram.canvas')
  check('解不开时先说清楚再问，按一下不走人也不丢改动',
    /不是典型链路的形状/.test(asked) && /会丢/.test(asked) && stillCanvas === true, asked.replace(/\s+/g, ' ').slice(0, 46))

  await page.evaluate("(document.querySelector('[data-action=open-chain-cancel]').click(), true)")
  await sleep(300)
  const afterCancel = await evalJson(page, 'window.__probe().app.diagram')
  check('选「留在画布」后改动原样还在', afterCancel.nodes === nodes0 + 1 && afterCancel.canvas === true,
    `${afterCancel.nodes} 节点，canvas ${afterCancel.canvas}`)

  await page.evaluate("(document.querySelector('[data-action=open-chain]').click(), true)")
  await sleep(300)
  await page.evaluate("(document.querySelector('[data-action=open-chain-confirm]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.canvas === false, { label: '确认后回到框图页默认形态', timeoutMs: 20000 })
  const foreign = await page.evaluate("!!document.querySelector('[data-chain-foreign]')")
  check('确认后回到框图页，给出「新建一条链」的出路，且改动到此仍未丢（铁律 15）',
    foreign === true && st.app.diagram.nodes === nodes0 + 1 && st.app.chain?.template === null,
    `${st.app.diagram.nodes} 节点，foreign ${foreign}`)

  // ---------- 辐射源换成实测片段回放（2026-09-09 用户实测的报错）----------
  // 先从画布留下的「不是本模板」状态新建一条干净的链
  await page.evaluate("(document.querySelector('[data-action=chain-new]').click(), true)")
  await page.waitFor((s) => s.app?.chain?.template === 'chain-v1', { label: '新建一条干净的典型链路' })
  await sleep(400)
  // 新建的链是空的，先把 ADC 满量程填上——待会儿要验它转一圈还在不在
  await page.evaluate("(document.querySelector('[data-slot=adc]').click(), true)")
  await sleep(250)
  await page.evaluate(setInput('[data-form=slot] [data-field=full_scale_dBm]', '-20'))
  await sleep(300)

  // ---------- ②c 辐射源换成实测片段回放（2026-09-09 用户实测的报错）----------
  // 曾经的毛病：变体与模式各管各的，切成回放源后模式仍是「全合成」，上一个变体的
  // center_frequency_Hz 照样写进 FileReplaySource，运行时报「[param] 未知参数」；
  // 同时回放源不绑场景，emitterIds 反解成空，整条链的场景绑定静默消失
  await page.evaluate("(document.querySelector('[data-slot=tx]').click(), true)")
  await sleep(200)
  await page.evaluate(`(() => { const el = document.querySelector('[data-slot-variant=tx]');
    el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  const rp = await page.waitFor((s) => s.app?.chain?.mode === 'replay', { label: '切回放源即进回放模式' })
  check('辐射源选「实测片段回放」即切到实测回放模式，不留下「全合成 + 回放源」', rp.app.chain.mode === 'replay')
  const txErr = await page.evaluate("document.querySelector('[data-slot=tx] [data-slot-error]')?.textContent ?? ''")
  check('辐射源卡片上不再报未知参数', !txErr.includes('未知参数'), txErr || '（无错误）')
  const txPending = await page.evaluate("document.querySelector('[data-form=slot] [data-pending]')?.textContent ?? ''")
  check('改为提示回放源真正缺的那一项（数据标识）', txPending.includes('data_id'), txPending)

  // ---------- 从下拉里挑一段录音（D-056）----------
  // 此前这里是个空文本框，要用户背标识；现在是挑单，服务端按机型分组抽样
  const picker = await waitDom(page,
    "document.querySelector('[data-form=data-id] [data-field=data_id]')?.tagName === 'SELECT'", true)
  check('回放源给的是挑单不是空文本框', picker === true)
  const opts = await evalJson(page, `(() => {
    const el = document.querySelector('[data-form=data-id] [data-field=data_id]')
    return { n: el.options.length, note: document.querySelector('[data-datasets-note]')?.textContent ?? '' }
  })()`)
  check('挑单里列出了录音，并如实说明共多少段',
    opts.n > 1 && /共 \d+ 段/.test(opts.note), `${opts.n} 项；${opts.note}`)

  // 筛选：只留一种机型
  await page.evaluate(setInput('[data-form=data-id] [data-field="data_id-filter"]', 'Mavic'))
  await sleep(900)
  const filtered = await evalJson(page, `(() => {
    const el = document.querySelector('[data-form=data-id] [data-field=data_id]')
    return Array.from(el.options).slice(1).map((o) => o.textContent)
  })()`)
  check('筛选按机型收窄挑单', filtered.length > 0 && filtered.every((t) => t.includes('Mavic')),
    `${filtered.length} 项，首项 ${filtered[0] ?? '（无）'}`)

  // 选第一条，标识写进框图
  await page.evaluate(`(() => { const el = document.querySelector('[data-form=data-id] [data-field=data_id]')
    el.value = el.options[1].value; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await sleep(500)
  const noPending = await page.evaluate("document.querySelector('[data-form=slot] [data-pending]')?.textContent ?? ''")
  check('选中即写进框图，不再提示缺数据标识', !noPending.includes('data_id'), noPending || '（无待填）')

  // 真跑一遍：回放链能提交并跑完
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break
    await sleep(250)
  }
  const beforeReplay = await evalJson(page, 'window.__probe().app.context.taskId')
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  const rpTask = await page.waitFor((s) => s.app?.context?.taskId && s.app.context.taskId !== beforeReplay,
    { label: '回放任务已提交', timeoutMs: 60000 })
  check('挑完录音即可直接运行，不用手敲标识', !!rpTask.app.context.taskId, rpTask.app.context.taskId)
  const rpDone = await page.waitFor((s) => ['finished', 'failed', 'cancelled'].includes(s.app?.task?.runState),
    { label: '回放任务结束', timeoutMs: 180000 })
  check('回放任务跑完', rpDone.app.task.runState === 'finished',
    `${rpDone.app.task.runState} / ${rpDone.app.task.result}`)

  // 切回场景辐射源：模式回全合成，场景与目标自动认回来
  await page.evaluate(`(() => { const el = document.querySelector('[data-slot-variant=tx]');
    el.value = '0'; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  const rb = await page.waitFor((s) => s.app?.chain?.mode === 'synthetic'
    && (s.app?.chain?.emitterIds ?? []).length > 0, { label: '切回后场景认回来' })
  check('切回「场景辐射源」后场景与目标自动认回来，不停在「先选场景」',
    rb.app.chain.scenarioId === 'demo-01' && rb.app.chain.emitterIds.includes('uav-1'),
    `${rb.app.chain.scenarioId} / ${rb.app.chain.emitterIds.join()}`)

  // 前端参数要活着回来（D-055）：回放模式下这六个环节不变成节点，
  // 参数暂存在 template_ref.inactive_slots 里，不存就一去不返（铁律 15）
  await page.evaluate("(document.querySelector('[data-slot=adc]').click(), true)")
  await sleep(250)
  const fs = await page.evaluate("document.querySelector('[data-form=slot] [data-field=full_scale_dBm]')?.value ?? ''")
  const pend = await page.evaluate("document.querySelector('[data-form=slot] [data-pending]')?.textContent ?? ''")
  check('转一圈回来 ADC 满量程还在，不用重填（D-055）', fs === '-20' && pend === '', `满量程 ${fs || '空'}；${pend || '无待填'}`)
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
