// 切片 ③「拖出框图」的端到端验收（06 备忘录 §9E、§9B U-2；设计见 09 §6）。
//
// 核心判据：**画布不自行解释任何规则**。组件库、参数控件、连线合法性与拒绝理由全部来自
// 组件目录（GET /api/v1/components，由 cuav_run --catalog 生成）。所以断言里凡涉及规则的，
// 都拿目录原文比对，而不是把规则再抄一遍。
//
// 覆盖：六类分组（含空分组）、示例载入后画布画出节点与连线、拓扑分列、类别与端口类型、
// 观测点标记、参数面板由 ParamSpec 生成、互斥参数成组、内部参数不出现（D-037）、
// 拖出新节点、非法连线被拒且理由与目录一致、撤销重做、序列化往返、提交并跑通。
//
// 跑法（先起服务：cd server && npm run build && node dist/index.js；引擎已构建；web/dist 为最新）：
//     node tests/e2e/slice3-smoke.mjs [--url http://127.0.0.1:8080/]

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchChrome, Page } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(Boolean))
const BASE = (args.url ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }
const evalJson = async (page, expr) => JSON.parse(await page.evaluate(`JSON.stringify(${expr})`))

let chrome, page, dir
const pageErrors = []
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-slice3-'))
  chrome = await launchChrome({ userDataDir: dir, windowSize: '1920,1200' })
  page = await Page.open(chrome.port, 'about:blank')
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0]))
  // 自由画布自 C-7 起是高级模式，入口 #/diagram/canvas；框图页缺省是典型链路视图
  await page.send('Page.navigate', { url: `${BASE}#/diagram/canvas` })
  await page.waitFor((s) => s.ready && s.app?.view === 'diagram', { label: '框图页', timeoutMs: 90000 })
  await sleep(800)

  // ---------- 组件库只由目录驱动 ----------
  const catalog = await page.evaluateAsync(`fetch('/api/v1/components').then(r => r.json())`)
  const groups = await evalJson(page, "Array.from(document.querySelectorAll('[data-palette-group]')).map(e=>e.dataset.paletteGroup)")
  check('组件库按 04 §8.1 的六类分组', JSON.stringify(groups) === JSON.stringify(['source', 'channel', 'antenna', 'receiver', 'data', 'algorithm']), groups.join(','))
  const items = await page.evaluate("document.querySelectorAll('[data-palette-item]').length")
  check('组件库条目数与目录一致（不另存一份清单）', items === catalog.components.length, `界面 ${items}，目录 ${catalog.components.length}`)
  // C-2 之后六类都有组件了；断言仍按「界面的空分组数 = 目录里的空类别数」写，
  // 它守的是「不隐藏空分组」这条规则本身，而不是某一时刻恰好有几个空分组
  const emptyGroups = await page.evaluate("document.querySelectorAll('.palette-empty').length")
  const allCats = ['source', 'channel', 'antenna', 'receiver', 'data', 'algorithm']
  const emptyInCatalog = allCats.filter((k) => !catalog.components.some((c) => c.category === k)).length
  check('空分组数与目录一致，且空分组不隐藏（04 §8.1 是六类）', emptyGroups === emptyInCatalog, `${emptyGroups} 个空分组`)
  check('C-2 之后六类都有组件（天线与接收机不再为空，D-050 销项）', emptyInCatalog === 0, `${emptyInCatalog} 个空类别`)

  // ---------- 载入示例：画布画出节点、连线、分列 ----------
  await page.evaluate(`(() => { const el = document.querySelector('[data-action=example]');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, 'slice2');
    el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await sleep(700)
  let st = await page.waitFor((s) => s.app?.diagram?.nodes > 0, { label: '框图载入' })
  const d0 = st.app.diagram
  const nodesOn = await page.evaluate("document.querySelectorAll('[data-node]').length")
  const edgesOn = await page.evaluate("document.querySelectorAll('.react-flow__edge').length")
  check('画布画出全部节点与连线', nodesOn === d0.nodes && edgesOn === d0.edges, `${nodesOn}/${d0.nodes} 节点，${edgesOn}/${d0.edges} 连线`)
  const cols = await evalJson(page, "[...new Set(Array.from(document.querySelectorAll('.react-flow__node')).map(e=>Math.round(parseFloat((e.style.transform.match(/translate\\(([-0-9.]+)px/)||[0,0])[1]))))]")
  check('无 position 的节点按拓扑深度分列，不堆在一点（09 §6.4）', cols.length >= 4, `${cols.length} 列`)
  const cats = await evalJson(page, "[...new Set(Array.from(document.querySelectorAll('[data-node]')).map(e=>e.dataset.category))]")
  check('节点带类别，据此取类别色', cats.every(Boolean) && cats.length >= 3, cats.join(','))
  const ptypes = await evalJson(page, "[...new Set(Array.from(document.querySelectorAll('[data-port-type]')).map(e=>e.dataset.portType))]")
  check('端口把手带类型（形状按类型区分，色弱可辨）', ptypes.includes('IQStream') && ptypes.includes('SceneParamFrame'), ptypes.join(','))
  const taps = await page.evaluate("document.querySelectorAll('[data-tap]').length")
  check('观测点在画布上有标记', taps === d0.taps && taps >= 1, `${taps} 个`)

  // ---------- 参数面板由 ParamSpec 生成 ----------
  await page.evaluate("(document.querySelector('[data-node=\"noise\"]').click(), true)")
  await sleep(400)
  check('点节点出参数面板', await page.evaluate("!!document.querySelector('[data-form=node]')"))
  const noiseSpec = catalog.components.find((c) => c.type === 'NoiseSource')
  const shown = await evalJson(page, "Array.from(document.querySelectorAll('[data-form=node] [data-field]')).map(e=>e.dataset.field)")
  const wantVisible = noiseSpec.params.filter((p) => !p.internal).map((p) => p.name)
  check('面板控件与目录的非内部参数一一对应', wantVisible.every((n) => shown.includes(n)), `缺 ${wantVisible.filter((n) => !shown.includes(n)).join(',') || '无'}`)
  const internalNames = catalog.components.flatMap((c) => c.params.filter((p) => p.internal).map((p) => p.name))
  check('内部参数一个都不出现（D-037 在画布侧的执行点）', internalNames.every((n) => !shown.includes(n)), `内部参数共 ${new Set(internalNames).size} 种`)
  const excl = await page.evaluate("document.querySelector('[data-exclusive]')?.dataset.exclusive ?? ''")
  const wantExcl = noiseSpec.params.find((p) => p.excludes?.length)
  check('互斥参数并排成组，界面上构造不出 param_conflict（09 §6.6）', !!wantExcl && excl.includes(wantExcl.name) && excl.includes(wantExcl.excludes[0]), excl)
  check('必填且无缺省的参数标「待填」', await page.evaluate("!!document.querySelector('[data-pending]')"))

  // ---------- 观测点：点标记能打开它的面板（回归：曾经建完取消选中就再也打不开） ----------
  await page.evaluate("(document.querySelector('[data-canvas] .react-flow__pane')?.click(), true)")
  await sleep(200)
  await page.evaluate("(document.querySelector('[data-tap]').click(), true)")
  await sleep(300)
  const tapForm = await evalJson(page, `(() => { const f = document.querySelector('[data-form=tap]')
    return f ? { has: true, id: f.querySelector('[data-field=op_id]')?.value ?? '',
      iqDisabled: !!f.querySelector('[data-product=iq]')?.disabled } : { has: false } })()`)
  check('点观测点标记打开观测点面板', tapForm.has, `op_id=${tapForm.id}`)
  check('iq 产品开关置灰而不是隐藏（D-040 ③ 明确拒绝，不静默忽略）', tapForm.iqDisabled === true)

  // ---------- 连线判据取自目录 ----------
  const row = catalog.port_compat.find((r) => r[0] === 'IQStream' && r[1] === 'SceneParamFrame')
  check('目录给出 IQ 流 → 参数流 的拒绝理由（D-013）', !!row && row[2] === false && /不得直连/.test(row[3] ?? ''), (row?.[3] ?? '').slice(0, 36) + '…')
  // 全枚举：类型数的平方。C-1 加了 RecognitionList，7×7 = 49（D-051）
  const n = catalog.port_types.length
  check('兼容矩阵是端口类型数的全枚举', catalog.port_compat.length === n * n, `${n}×${n} = ${catalog.port_compat.length} 条`)

  // ---------- 拖出新节点、撤销、重做 ----------
  const before = st.app.diagram.nodes
  await page.evaluate("(document.querySelector('[data-palette-item=\"ToneSource\"]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.nodes === before + 1, { label: '加一个节点', timeoutMs: 15000 })
  check('从组件库加节点，画布与文档同步', st.app.diagram.nodes === before + 1 && st.app.diagram.dirty === true)
  check('撤销栈记了一步', st.app.undo.diagram.depth >= 1, `深度 ${st.app.undo.diagram.depth}`)
  await page.evaluate("(document.querySelector('[data-action=undo]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.nodes === before, { label: '撤销', timeoutMs: 15000 })
  check('撤销回到加节点之前', st.app.diagram.nodes === before)
  await page.evaluate("(document.querySelector('[data-action=redo]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.nodes === before + 1, { label: '重做', timeoutMs: 15000 })
  check('重做又回到加节点之后', st.app.diagram.nodes === before + 1)
  await page.evaluate("(document.querySelector('[data-action=undo]').click(), true)")
  st = await page.waitFor((s) => s.app?.diagram?.nodes === before, { label: '再撤销', timeoutMs: 15000 })

  // ---------- 拖动跟手（回归：曾经每帧从文档重推位置，节点被拽回旧位，表现为「拉动滞后」） ----------
  const nodeBox = await evalJson(page, `(() => { const e = document.querySelector('.react-flow__node'); const r = e.getBoundingClientRect();
    return { id: e.dataset.id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 12) } })()`)
  const xOf = async (id) => await page.evaluate(
    `(() => { const e = document.querySelector('.react-flow__node[data-id="${id}"]');
      return Math.round(parseFloat((e.style.transform.match(/translate\\(([-0-9.]+)px/) || [0, 0])[1])) })()`)
  const x0 = await xOf(nodeBox.id)
  const undo0 = (await page.waitFor((s) => !!s.app, { label: 'x' })).app.undo.diagram.depth
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nodeBox.x, y: nodeBox.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeBox.x + 60, y: nodeBox.y + 40, button: 'left', buttons: 1 })
  await sleep(120)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeBox.x + 160, y: nodeBox.y + 90, button: 'left', buttons: 1 })
  await sleep(120)
  const xMid = await xOf(nodeBox.id)   // 还没松手，此刻就该已经跟过去了
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nodeBox.x + 160, y: nodeBox.y + 90, button: 'left', buttons: 0 })
  await sleep(300)
  const xEnd = await xOf(nodeBox.id)
  check('拖动过程中节点就跟着光标走（不是松手才跳过去）', xMid - x0 > 80, `按下前 ${x0}，拖到一半 ${xMid}，松手后 ${xEnd}`)
  check('松手后位置落在 16 px 网格上', xEnd % 16 === 0, `x = ${xEnd}`)
  st = await page.waitFor((s) => s.app?.undo?.diagram?.depth > undo0, { label: '拖动入撤销栈', timeoutMs: 15000 })
  check('一次拖动只入一步撤销栈，不是每帧一步', st.app.undo.diagram.depth === undo0 + 1, `${undo0} → ${st.app.undo.diagram.depth}`)
  await page.evaluate("(document.querySelector('[data-action=undo]').click(), true)")
  await sleep(300)

  // ---------- 隐藏视图不得穿透（回归：React Flow 给节点写行内 visibility:visible，节点浮到地图上） ----------
  await page.pressKey({ key: '1', code: 'Digit1', vk: 49, modifiers: 1 })
  await page.waitFor((s) => s.app?.view === 'scene', { label: '切到场景页', timeoutMs: 20000 })
  await sleep(400)
  const hidden = await evalJson(page, `(() => {
    const host = document.querySelector('[data-view=diagram]')
    const cs = getComputedStyle(host)
    const node = document.querySelector('.react-flow__node')
    return { opacity: cs.opacity, visibility: cs.visibility, nodeInline: node ? node.style.visibility : null }
  })()`)
  check('切到场景页后框图视图整体不可见（opacity 兜住 React Flow 的行内 visibility）',
    hidden.opacity === '0', `host opacity=${hidden.opacity} visibility=${hidden.visibility}，节点行内 visibility=${hidden.nodeInline}`)
  await page.pressKey({ key: '2', code: 'Digit2', vk: 50, modifiers: 1 })
  st = await page.waitFor((s) => s.app?.view === 'diagram', { label: '切回框图页', timeoutMs: 20000 })
  await sleep(300)
  const backOpacity = await page.evaluate("getComputedStyle(document.querySelector('[data-view=diagram]')).opacity")
  check('切回框图页后恢复可见', backOpacity === '1', `opacity=${backOpacity}`)

  // ---------- 提交：画布产出的框图要能过引擎的 --validate ----------
  for (let i = 0; i < 40; i++) { if (await page.evaluate("(!document.querySelector('[data-action=run]')?.disabled)")) break; await sleep(250) }
  const t0 = (await page.waitFor((s) => !!s.app, { label: 'x' })).app.context.taskId
  await page.evaluate("(document.querySelector('[data-action=run]').click(), true)")
  st = await page.waitFor((s) => s.app?.context?.taskId && s.app.context.taskId !== t0, { label: '任务已提交', timeoutMs: 30000 })
  check('画布序列化出的框图通过引擎 --validate 并提交', !!st.app.context.taskId, st.app.context.taskId)
  st = await page.waitFor((s) => ['finished', 'failed', 'cancelled'].includes(s.app?.task?.runState), { label: '任务结束', timeoutMs: 180000 })
  check('任务跑完且结果有效', st.app.task.runState === 'finished' && st.app.task.result === 'valid', `${st.app.task.runState} / ${st.app.task.result}`)

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
