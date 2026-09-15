// 一次性生成器：产出内置缺省链路的规范文本，以及两份 3×3 回归夹具（经真实的 parse → compile 路径再生成）。
// 跑法（web/ 目录）：
//   npx tsx src/chain/examples/_gen.ts            > src/chain/examples/default.ts   （缺省链路；写成 TS 常量）
//   npx tsx src/chain/examples/_gen.ts demo-02    > ../tests/regression/diagrams/chain-demo-02.json
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
  process.stdout.write(
    '// 内置的缺省典型链路（全合成，demo-01）。由 _gen.ts 生成，不要手改：npx tsx src/chain/examples/_gen.ts > src/chain/examples/default.ts\n' +
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
} else if (mode === '3x3-aoa' || mode === '3x3-tdoa') {
  const { doc: scenario } = loadScenario('demo-03')
  const file = join(ROOT, `tests/regression/diagrams/chain-${mode}.json`)
  const r = parseDoc(readFileSync(file, 'utf8'))
  if (!r.ok) throw new Error(`夹具不是合法框图：${r.error}`)
  const chain = parseChain(r.doc)
  if (!chain) throw new Error('夹具解不成典型链路：先查槽位表与 parseChain')
  process.stdout.write(serialize(compile(chain, cat, scenario).doc, cat))
} else {
  throw new Error(`未知模式 ${mode}：default | demo-02 | 3x3-aoa | 3x3-tdoa`)
}
