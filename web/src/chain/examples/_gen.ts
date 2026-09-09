// 一次性生成器：产出内置缺省链路的规范文本。跑法：npx tsx src/chain/examples/_gen.ts
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Catalog } from '../../api/catalog.js'
import { serialize } from '../../diagram/doc.js'
import { compile } from '../compile.js'
import { emptyChain, type ChainState } from '../model.js'
import type { ScenarioDoc } from '../../state/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SCEN = join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog
const scenario = JSON.parse(readFileSync(SCEN, 'utf8')) as ScenarioDoc
const sha = createHash('sha256').update(readFileSync(SCEN)).digest('hex')

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
process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
