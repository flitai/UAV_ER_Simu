// 一次性生成器：产出内置缺省链路的规范文本，以及两份 3×3 回归夹具（经真实的 parse → compile 路径再生成）。
// 跑法（web/ 目录）：
//   npx tsx src/chain/examples/_gen.ts            > src/chain/examples/default.ts   （缺省链路；写成 TS 常量）
//   npx tsx src/chain/examples/_gen.ts demo-02    > ../tests/regression/diagrams/chain-demo-02.json
//   npx tsx src/chain/examples/_gen.ts demo-02-ddc > ../tests/regression/diagrams/chain-demo-02-ddc.json
//   npx tsx src/chain/examples/_gen.ts 3x3-aoa    > ../tests/regression/diagrams/chain-3x3-aoa.json
//   npx tsx src/chain/examples/_gen.ts 3x3-tdoa   > ../tests/regression/diagrams/chain-3x3-tdoa.json
// 夹具模式读现有夹具文件、parseChain 解回链路状态、按当前目录与槽位表重新 compile：参数一件不丢，
// 只有编译规则变了的地方（如新加的槽位）会变；再生成后要经 `cuav_run --validate … --scenario demo-03 --library-root models/recognition` 核。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Catalog } from '../../api/catalog.js'
import { parse as parseDoc, serialize } from '../../diagram/doc.js'
import { compile, parseChain } from '../compile.js'
import { emptyChain, type ChainState } from '../model.js'
import type { ScenarioDoc } from '../../state/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog

function loadScenario(id: string): { doc: ScenarioDoc; sha: string } {
  const p = join(ROOT, `data/scene/beijing-yayuncun/scenarios/${id}.scenario.json`)
  return { doc: JSON.parse(readFileSync(p, 'utf8')) as ScenarioDoc, sha: createHash('sha256').update(readFileSync(p)).digest('hex') }
}

const mode = process.argv[2] ?? 'default'
if (mode === 'default') {
  const { doc: scenario, sha } = loadScenario('demo-01')
  const c: ChainState = emptyChain('synthetic', 'chain-default')
  c.name = '典型链路 · 全合成'
  c.scenario = { scenario_id: 'demo-01', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1']
  c.run = { duration_s: 20, seed: 20260907 }
  c.slots.tx_ant.params = { gain_dBi: 2 }
  c.slots.rx_ant.params = { gain_dBi: 3 }
  c.slots.rx_fe.params = { nf_dB: 6, gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.det.params = { nfft: 1024 }
  const text = serialize(compile(c, cat, scenario).doc, cat)
  // 抬头逐字写出来：文档里记的重跑命令是 `... _gen.ts > src/chain/examples/default.ts`，
  // 生成器少写一行抬头，重跑一次就把那段缘由静默删掉了（铁律 15）。写全了这条命令才是幂等的。
  process.stdout.write(
    '// 内置缺省典型链路（C-7，D-051）：全合成模式，绑定 demo-01 的亚运村单站单机场景。\n' +
    '//\n' +
    '// 服务端没有保存过的框图时，框图页就载入它。参数取的是能让整条链**读数有物理意义**的一组：\n' +
    '//   · 接收机增益 20 dB —— 不给增益的话，−111 dBm 的热噪声落在 −20 dBm 满量程、14 位 ADC 的\n' +
    '//     最低有效位之下，谱上只剩量化噪声。这一条现在由频率计划的「ADC 量化噪声不淹没热噪声」拦着。\n' +
    '//   · 时长 20 s、种子固定 —— 演示时一眼能看到信号随距离变化。\n' +
    '//\n' +
    '// 本文件由 `npx tsx src/chain/examples/_gen.ts` 生成，改参数请改生成器再重跑，不要手改这里。\n' +
    '// 单测守两件事：它能被 parseChain 解开；重新编译后与这里逐字节相同。\n' +
    '\n' +
    `export const DEFAULT_CHAIN_TEXT = ${JSON.stringify(text)}\n`)
} else if (mode === 'demo-02') {
  // 宽带回归夹具（C-8）：10 MS/s、两个源。接收机增益与 ADC 满量程要照顾**高斯型图传**——
  // 它的峰均比远高于单音，同样的平均电平下削顶比例高得多，所以留出 12 dB 余量而不是像
  // 缺省链那样贴着满量程（D-066 ⑨：不靠改缺省参数遮掉真实的过载判断）。
  const { doc: scenario, sha } = loadScenario('demo-02')
  const c: ChainState = emptyChain('synthetic', 'chain-demo-02')
  c.name = '典型链路 · 全合成 · demo-02 宽带'
  c.scenario = { scenario_id: 'demo-02', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1', 'uav-2']
  c.run = { duration_s: 6, seed: 20260915 }
  c.slots.rx_fe.params = { gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.det.params = { nfft: 1024 }
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === 'demo-02-ddc') {
  // 同一条宽带链，但**启用 DDC**（M-2，D-070）：10 MS/s 的观测带里选出 2438.5 MHz 的图传，
  // 抽取 2 倍到 5 MS/s。demo-02 那份夹具一字不改，这是另起的一份。
  //
  // 为什么 decim 取 2 而不是 4：decim = 4 时通带边 0.4·fs_out = 1.0 MHz **恰好等于**图传的
  // 半带宽，频率计划的过渡带检查靠等号通过、一点余量不留；decim = 2 的通带边是 2.0 MHz，
  // 留一倍余量。副产品是个讲得清楚的演示——五个跳频点相对 S4 中心落在 +1.625 … +4.9375 MHz，
  // 其中 +1.625 MHz 那一跳还在通带里、照样看得见，另四个进了阻带被压掉。
  const { doc: scenario, sha } = loadScenario('demo-02')
  const c: ChainState = emptyChain('synthetic', 'chain-demo-02-ddc')
  c.name = '典型链路 · 全合成 · demo-02 宽带 · DDC 启用'
  c.scenario = { scenario_id: 'demo-02', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1', 'uav-2']
  c.run = { duration_s: 6, seed: 20260915 }
  c.slots.rx_fe.params = { gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.ddc.bypass = false
  c.slots.ddc.params = { f_shift_Hz: -2500000, decim: 2 }
  c.slots.det.params = { nfft: 1024 }
  c.taps.s3 = true
  c.taps.s4 = true
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === '3x3-aoa' || mode === '3x3-tdoa') {
  const { doc: scenario } = loadScenario('demo-03')
  const file = join(ROOT, `tests/regression/diagrams/chain-${mode}.json`)
  const r = parseDoc(readFileSync(file, 'utf8'))
  if (!r.ok) throw new Error(`夹具不是合法框图：${r.error}`)
  const chain = parseChain(r.doc)
  if (!chain) throw new Error('夹具解不成典型链路：先查槽位表与 parseChain')
  process.stdout.write(serialize(compile(chain, cat, scenario).doc, cat))
} else {
  throw new Error(`未知模式 ${mode}：default | demo-02 | demo-02-ddc | 3x3-aoa | 3x3-tdoa`)
}
