// 假引擎（测试夹具，不进交付包）。命令行、事件信封、events.jsonl 镜像与退出码都与 cuav_run 同构
// （docs/api-versions.md §4.1），但不做任何计算。用途：没有 C++ 构建也能测服务端任务管理器的
// 状态机、取消、脱敏与重启对账。由测试以 process.execPath 拉起（子进程里没有 tsx，所以是 .mjs）。
//
// 模式由框图 name 字段选择："fake:<mode>[,<mode>...]"，未写即 finish：
//   finish  task.state running → log → progress → 3 行谱 + 2 行包络 → task.state finished(valid)，退出 0
//   error2  装载失败（校验与运行都失败）：error{param} → task.state failed，退出 2
//   error2run 校验通过、运行时装载失败（模拟校验后环境变化），事件与退出码同 error2
//   fail3   运行失败：running → error{run_failed, node_id: mix} → task.state failed，退出 3
//   io4     stderr 一句话、不发事件，退出 4
//   hang    running 后每 100 ms 一行 product_row，直到被杀
//   slow    running 后每 50 ms 一行，共 12 行，再 finished
//   many    running 后一口气 40 行谱（不延时），再 finished；用于缓冲溢出与回放测试
//   norows  不写 .f32 产品文件，只发 product_row 事件；用于测服务端「行读不到退回文本」（B-6）
//   crash   running 后两行产品，然后 SIGKILL 自杀
//   crlf    事件行以 \r\n 结尾，并把一条含多字节字符的 log 拆成两次写、中间停 20 ms
//   __bad__ 名字里含它时 --validate 发 error 退 2（模拟校验失败）
// 所有写 stdout 用 writeSync：管道上的 process.stdout.write 在部分平台是异步的，crash 模式会丢事件。
// 每行 product_row 事件之前先把该行写进 <out>/<op_id>/<kind>.f32（Float32 LE，值 = row_index × 1000 + 列号），
// 与真引擎「先 fflush 再发事件」同序，B-6 的二进制帧测试据此核对载荷。

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'

const argv = process.argv.slice(2)
let mode = null
let diagramPath = ''
let outDir = ''
let taskId = ''
let resolvedPath = ''
let seedGiven = false
let seed = 0
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const value = () => {
    if (i + 1 >= argv.length) fail(`${a} 缺参数`)
    return argv[++i]
  }
  if (a === '--catalog') mode = 'catalog'
  else if (a === '--validate') { mode = 'validate'; diagramPath = value() }
  else if (a === '--run') { mode = 'run'; diagramPath = value() }
  else if (a === '--out') outDir = value()
  else if (a === '--task-id') taskId = value()
  else if (a === '--resolved') resolvedPath = value()
  else if (a === '--seed') { seed = Number(value()); seedGiven = true }
  else if (a === '--progress-interval-ms' || a === '--data-index') value()
  else fail(`未知选项 ${a}`)
}
if (!mode) fail('缺子命令')
if (mode === 'run' && !outDir) fail('--run 需要 --out')

function fail(msg) {
  writeSync(2, msg + '\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------

if (mode === 'catalog') {
  const cat = {
    schema_version: 'cuav-catalog/1',
    engine_version: 'fake-0.0.1',
    port_types: ['IQStream', 'SceneParamFrame'],
    port_compat: [['IQStream', 'IQStream', true], ['IQStream', 'SceneParamFrame', false, 'D-013']],
    components: [
      { type: 'ToneSource', category: 'source', display_name: '单音源', ports: { in: [], out: [{ name: 'out', type: 'IQStream' }] },
        params: [{ name: 'sample_rate_Hz', type: 'number', unit: 'Hz', required: true }] },
      { type: 'NoiseSource', category: 'source', display_name: '噪声源', ports: { in: [], out: [{ name: 'out', type: 'IQStream' }] },
        params: [{ name: 'sample_rate_Hz', type: 'number', unit: 'Hz', required: true }] },
      { type: 'AddMixer', category: 'source', display_name: '加法混合',
        ports: { in: [{ name: 'a', type: 'IQStream' }, { name: 'b', type: 'IQStream' }], out: [{ name: 'out', type: 'IQStream' }] }, params: [] },
      { type: 'SpectrumAnalyzer', category: 'algorithm', display_name: '频谱分析',
        ports: { in: [{ name: 'in', type: 'IQStream' }], out: [{ name: 'spectrum', type: 'SpectrumFrame' }] }, params: [{ name: 'nfft', type: 'number', default: 1024 }] },
      { type: 'FileReplaySource', category: 'data', display_name: '文件回放源', ports: { in: [], out: [{ name: 'out', type: 'IQStream' }] },
        params: [{ name: 'data_id', type: 'string', required: true }, { name: 'manifest_path', type: 'string', internal: true }] },
      { type: 'ObservationTap', category: 'algorithm', display_name: '观测点', ports: { in: [{ name: 'in', type: 'IQStream' }], out: [] },
        params: [{ name: 'op_id', type: 'string', required: true }, { name: 'out_dir', type: 'string', internal: true }] },
    ],
  }
  writeSync(1, JSON.stringify(cat, null, 2) + '\n')
  process.exit(0)
}

// ---------------------------------------------------------------------------

let diagram
try {
  diagram = JSON.parse(readFileSync(diagramPath, 'utf8'))
} catch (e) {
  emitOnce('error', { code: 'json_parse', node_id: '', port: '', message: `框图打不开或不是 JSON：${diagramPath}` })
  process.exit(2)
}
const name = typeof diagram.name === 'string' ? diagram.name : ''
const modes = new Set(name.startsWith('fake:') ? name.slice(5).split(',').map((s) => s.trim()) : ['finish'])
const crlf = modes.has('crlf')
const EOL = crlf ? '\r\n' : '\n'
if (!taskId) taskId = mode === 'run' ? outDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : (diagram.diagram_id ?? 'diagram')

let seq = 0
let eventsFd = -1
function emit(type, t_s, payload) {
  const line = JSON.stringify({ seq: ++seq, task_id: taskId, type, t_s, payload }) + EOL
  writeSync(1, line)
  if (eventsFd >= 0) writeSync(eventsFd, line)
  return line
}
function emitOnce(type, payload) {
  emit(type, 0, payload)
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const replayNodes = Array.isArray(diagram.nodes) ? diagram.nodes.filter((n) => n && n.type === 'FileReplaySource') : []
let resolved = null
if (resolvedPath) {
  try {
    resolved = JSON.parse(readFileSync(resolvedPath, 'utf8'))
  } catch {
    emitOnce('error', { code: 'data_id', node_id: '', port: '', message: `解析旁挂打不开：${resolvedPath}` })
    process.exit(2)
  }
}

function loadError(atRun) {
  if (name.includes('__bad__') || modes.has('error2') || (atRun && modes.has('error2run'))) {
    return { code: 'param', node_id: 'tone', port: '', message: '参数 amplitude 越界（假引擎）' }
  }
  for (const n of replayNodes) {
    const id = n.params && n.params.data_id
    if (!resolved) return { code: 'data_id', node_id: n.id, port: '', message: `没有数据解析器，无法解析 data_id ${id}` }
    const mp = resolved.data && resolved.data[id]
    if (!mp) return { code: 'data_id', node_id: n.id, port: '', message: `data_id 不在解析表里：${id}` }
    if (!existsSync(mp)) return { code: 'data_id', node_id: n.id, port: '', message: `打不开清单 ${mp}` }
  }
  return null
}

const nodeNames = (diagram.nodes ?? []).map((n) => n.id)
const taps = (diagram.observation_points ?? []).map((o) => ({ op_id: o.id, node: o.node, port: o.port, products: o.products }))

if (mode === 'validate') {
  const err = loadError(false)
  if (err) {
    emitOnce('error', err)
    process.exit(2)
  }
  emit('validate', 0, { ok: true, diagram_id: diagram.diagram_id, name, nodes: nodeNames, edges: (diagram.edges ?? []).length,
    observation_points: taps, run: diagram.run, engine_version: 'fake-0.0.1' })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// --run

if (modes.has('io4')) {
  writeSync(2, `打不开 events.jsonl 写入：${outDir}/events.jsonl（假引擎 io4）\n`)
  process.exit(4)
}
mkdirSync(outDir, { recursive: true })
eventsFd = openSync(outDir + '/events.jsonl', 'w')

const err = loadError(true)
if (err) {
  emit('error', 0, err)
  emit('task.state', 0, { run_state: 'failed', result: 'invalid', reasons: [err.message] })
  closeSync(eventsFd)
  process.exit(2)
}

const runSeed = seedGiven ? seed : (diagram.run && diagram.run.seed) ?? 0
const started = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
emit('task.state', 0, { run_state: 'running', diagram_id: diagram.diagram_id, name, seed: runSeed,
  seed_source: seedGiven ? 'cli' : 'diagram', run: diagram.run, nodes: nodeNames, observation_points: taps,
  engine_version: 'fake-0.0.1', started_utc: started })

// 日志里故意带绝对路径与清单路径，供服务端脱敏测试：cwd 是仓库根的替身。
const manifestNote = resolved && resolved.data ? Object.values(resolved.data).map((p) => `打开清单 ${p}`).join('；') : '无回放节点'
emit('log', 0, { level: 'info', message: `已装载框图 ${process.cwd()}/${diagramPath}；${manifestNote}` })
if (crlf) {
  // 把一条含多字节字符的行拆成两次写，中间停一停，逼出跨 chunk 的残片
  const line = JSON.stringify({ seq: ++seq, task_id: taskId, type: 'log', t_s: 0, payload: { level: 'info', message: '多字节：北京亚运村 20 × 20 km' } }) + EOL
  const buf = Buffer.from(line, 'utf8')
  const cut = buf.indexOf(Buffer.from('京', 'utf8')) + 1   // 切在「京」的第一个字节之后
  writeSync(1, buf.subarray(0, cut))
  writeSync(eventsFd, buf)
  sleepMs(20)
  writeSync(1, buf.subarray(cut))
}

const nodeStatus = nodeNames.map((n) => ({ name: n, state: 'valid', blocks_in: 1, blocks_out: 1, samples_in: 1000, samples_out: 1000, notes: [] }))
emit('progress', 0, { round: 1, nodes: nodeStatus })

const op = taps.length ? taps[0].op_id : 's4'
let rows = 0
const rowFds = {}
function productRow(kind, i, t) {
  rows++
  const rowLen = kind === 'spectrum' ? 1024 : 3
  if (!modes.has('norows')) {
    if (rowFds[kind] === undefined) {
      mkdirSync(outDir + '/' + op, { recursive: true })
      rowFds[kind] = openSync(`${outDir}/${op}/${kind}.f32`, 'w')
    }
    const buf = Buffer.alloc(rowLen * 4)
    for (let k = 0; k < rowLen; k++) buf.writeFloatLE(i * 1000 + k, k * 4)
    writeSync(rowFds[kind], buf)
  }
  emit('product_row', t, { op_id: op, kind, row_index: i, row_len: rowLen })
}
function finish(result) {
  const ended = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  emit('task.state', 1.0, { run_state: 'finished', result, reasons: [`清单 ${manifestNote} 来自论文参数（假引擎）`], diagram_id: diagram.diagram_id,
    seed: runSeed, rounds: 3, wall_s: 0.01, realtime_factor: 100, product_rows: rows, nodes: nodeStatus,
    started_utc: started, ended_utc: ended, engine_version: 'fake-0.0.1' })
  closeSync(eventsFd)
  process.exit(0)
}

if (modes.has('fail3')) {
  productRow('spectrum', 0, 0.1)
  emit('error', 0.1, { code: 'run_failed', node_id: 'mix', port: '', message: 'mix 处理失败：假引擎 fail3' })
  emit('task.state', 0.1, { run_state: 'failed', result: 'invalid', reasons: ['mix 处理失败：假引擎 fail3'], rounds: 1, wall_s: 0.01,
    realtime_factor: 10, product_rows: rows, nodes: nodeStatus, started_utc: started, ended_utc: started, engine_version: 'fake-0.0.1' })
  closeSync(eventsFd)
  process.exit(3)
}
if (modes.has('crash')) {
  productRow('spectrum', 0, 0.1)
  productRow('spectrum', 1, 0.2)
  process.kill(process.pid, 'SIGKILL')
}
if (modes.has('hang')) {
  let i = 0
  setInterval(() => productRow('spectrum', i++, i * 0.1), 100)
} else if (modes.has('many')) {
  for (let i = 0; i < 40; i++) productRow('spectrum', i, i * 0.05)
  finish('valid')
} else if (modes.has('slow')) {
  let i = 0
  const timer = setInterval(() => {
    productRow('spectrum', i, i * 0.05)
    if (++i >= 12) {
      clearInterval(timer)
      finish('valid')
    }
  }, 50)
} else {
  for (let i = 0; i < 3; i++) productRow('spectrum', i, i * 0.1)
  for (let i = 0; i < 2; i++) productRow('envelope', i, i * 0.2)
  finish(modes.has('degraded') ? 'degraded' : 'valid')
}
