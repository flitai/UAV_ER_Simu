// 一次性生成器：产出内置缺省链路的规范文本，以及两份 3×3 回归夹具（经真实的 parse → compile 路径再生成）。
// 跑法（web/ 目录）：
//   npx tsx src/chain/examples/_gen.ts            > src/chain/examples/default.ts   （缺省链路；写成 TS 常量）
//   npx tsx src/chain/examples/_gen.ts golden-02    > ../tests/regression/diagrams/chain-golden-02.json
//   npx tsx src/chain/examples/_gen.ts golden-02-ddc > ../tests/regression/diagrams/chain-golden-02-ddc.json
//   npx tsx src/chain/examples/_gen.ts golden-02-chan > ../tests/regression/diagrams/chain-golden-02-chan.json
//   npx tsx src/chain/examples/_gen.ts golden-02-dsp > ../tests/regression/diagrams/chain-golden-02-dsp.json
//   npx tsx src/chain/examples/_gen.ts synthetic > ../tests/regression/diagrams/chain-synthetic.json
//   npx tsx src/chain/examples/_gen.ts golden-01-e3 > ../tests/regression/diagrams/chain-golden-01-e3.json
//   npx tsx src/chain/examples/_gen.ts replay    > ../tests/regression/diagrams/chain-replay.json
//   npx tsx src/chain/examples/_gen.ts mixed     > ../tests/regression/diagrams/chain-mixed.json
//   npx tsx src/chain/examples/_gen.ts 3x3-aoa    > ../tests/regression/diagrams/chain-3x3-aoa.json
//   npx tsx src/chain/examples/_gen.ts 3x3-tdoa   > ../tests/regression/diagrams/chain-3x3-tdoa.json
// 夹具模式读现有夹具文件、parseChain 解回链路状态、按当前目录与槽位表重新 compile：参数一件不丢，
// 只有编译规则变了的地方（如新加的槽位）会变；再生成后要经 `cuav_run --validate … --scenario golden-03 --library-root models/recognition` 核。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Catalog } from '../../api/catalog.js'
import { parse as parseDoc, serialize } from '../../diagram/doc.js'
import { compile, parseChain, switchMode } from '../compile.js'
import { emptyChain, type ChainState } from '../model.js'
import type { ScenarioDoc } from '../../state/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog

function loadScenario(id: string, dir = 'data/scene/beijing-yayuncun/scenarios'): { doc: ScenarioDoc; sha: string } {
  const p = join(ROOT, dir, `${id}.scenario.json`)
  return { doc: JSON.parse(readFileSync(p, 'utf8')) as ScenarioDoc, sha: createHash('sha256').update(readFileSync(p)).digest('hex') }
}

const mode = process.argv[2] ?? 'default'
if (mode === 'default') {
  const { doc: scenario, sha } = loadScenario('golden-01')
  const c: ChainState = emptyChain('synthetic', 'chain-default')
  c.name = '典型链路 · 全合成'
  c.scenario = { scenario_id: 'golden-01', sha256: sha }
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
    '// 内置缺省典型链路（C-7，D-051）：全合成模式，绑定 golden-01 的亚运村单站单机场景。\n' +
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
} else if (mode === 'golden-02') {
  // 宽带回归夹具（C-8）：10 MS/s、两个源。接收机增益与 ADC 满量程要照顾**高斯型图传**——
  // 它的峰均比远高于单音，同样的平均电平下削波比例高得多，所以留出 12 dB 余量而不是像
  // 缺省链那样贴着满量程（D-066 ⑨：不靠改缺省参数遮掉真实的过载判断）。
  const { doc: scenario, sha } = loadScenario('golden-02')
  const c: ChainState = emptyChain('synthetic', 'chain-golden-02')
  c.name = '典型链路 · 全合成 · golden-02 宽带'
  c.scenario = { scenario_id: 'golden-02', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1', 'uav-2']
  c.run = { duration_s: 6, seed: 20260915 }
  c.slots.rx_fe.params = { gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.det.params = { nfft: 1024 }
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === 'golden-02-ddc') {
  // 同一条宽带链，但**启用 DDC**（M-2，D-070）：10 MS/s 的观测带里选出 2438.5 MHz 的图传，
  // 抽取 2 倍到 5 MS/s。golden-02 那份夹具一字不改，这是另起的一份。
  //
  // 为什么 decim 取 2 而不是 4：decim = 4 时通带边 0.4·fs_out = 1.0 MHz **恰好等于**图传的
  // 半带宽，频率计划的过渡带检查靠等号通过、一点余量不留；decim = 2 的通带边是 2.0 MHz，
  // 留一倍余量。副产品是个讲得清楚的演示——五个跳频点相对 S4 中心落在 +1.625 … +4.9375 MHz，
  // 其中 +1.625 MHz 那一跳还在通带里、照样看得见，另四个进了阻带被压掉。
  const { doc: scenario, sha } = loadScenario('golden-02')
  const c: ChainState = emptyChain('synthetic', 'chain-golden-02-ddc')
  c.name = '典型链路 · 全合成 · golden-02 宽带 · DDC 启用'
  c.scenario = { scenario_id: 'golden-02', sha256: sha }
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
} else if (mode === 'golden-02-chan') {
  // 同一条宽带链，但**启用信道化**（M-3，D-071）：10 MS/s 切成 4 条 2.5 MHz 的子信道，
  // 取零频那一路（select_channel = channels/2），于是 S5 是 2.5 MS/s @ 2441 MHz。
  //
  // 为什么取零频那一路而不是图传所在的那一路：
  //   · 图传（2437.5–2439.5 MHz）整个落进相邻子信道被压掉，五个跳频点里有三个
  //     （2440.6875 / 2440.375 / 2441.625 MHz）落在本路 ±1.0 MHz 的通带内、留 375 kHz 余量；
  //     于是 S5 的瀑布上 0.5–2.5 s（只有图传）是底噪、3–4.5 s（只有跳频）是突发串 ——
  //     演示的是「把两个辐射源分开」，比「选出一段频率」能讲的更多。
  //   · 选图传那一路（select_channel = 1）通带边 ±1.0 MHz **恰好等于**图传半带宽，
  //     零余量，正是 M-2 给 DDC 定 decim 时拒绝过的那种配置。那一档写在模型卡里当已知边界。
  //   · 另两个跳频点（2442.25 / 2443.4375 MHz）落在阻带，临界抽取下混叠成 62 dB 以下的鬼影。
  // 带外的两跳按 D-067 ④ 记 truth_out_of_band、不进评价的分母；检测器频段随 fs_s5 自动收窄。
  const { doc: scenario, sha } = loadScenario('golden-02')
  const c: ChainState = emptyChain('synthetic', 'chain-golden-02-chan')
  c.name = '典型链路 · 全合成 · golden-02 宽带 · 信道化启用'
  c.scenario = { scenario_id: 'golden-02', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1', 'uav-2']
  c.run = { duration_s: 6, seed: 20260915 }
  c.slots.rx_fe.params = { gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.chan.bypass = false
  c.slots.chan.params = { channels: 4, select_channel: 2 }
  c.slots.det.params = { nfft: 1024 }
  // 取 S3 与 S5 两个观测点。**不取 S4**：DDC 旁路时 S4 的锚点顺链下滑到信道化那一节，
  // 与 S5 是同一个节点同一个口，读数会一模一样（D-051 记过的那种「读数相同是真实后果」）。
  // S3 = 10 MS/s 的宽带、S5 = 2.5 MS/s 的子信道，两份谱摆在一起才看得出信道化做了什么。
  c.taps.s3 = true
  c.taps.s4 = false
  c.taps.s5 = true
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === 'golden-02-dsp') {
  // 三级 DSP 全开（C-10）：接收滤波 → DDC → 信道化，10 → 5 → 2.5 MS/s。
  // 这份夹具的用处是让 04 §15.2 的算例 5 / 7 / 8 **从一条保存下来的典型链路**跑一遍
  // ——单测里它们各自过了，但那是直接调组件；C-10 的验收要的是「从框图跑通」。
  //
  // 参数都有来历，不是凑的：
  //   · 接收滤波的通带由场景带出（`sites[].receiver.bw_Hz` = 8 MHz，8/10 = 0.8 正在抽头表里）；
  //   · DDC 搬 −2.5 MHz、抽 2 倍，S4 = 5 MS/s @ 2438.5 MHz，正对图传中心（同 golden-02-ddc）；
  //   · 信道化切 2 条取零频那一路，S5 = 2.5 MS/s @ 2438.5 MHz，可用子带 ±1.0 MHz —— 图传
  //     是 fc = 1 MHz 的 4 阶巴特沃斯带限噪声，落进这一路的约 90%（−0.45 dB），
  //     它的裙边被切掉的那部分是可算可核的量，不是「看着差不多」。
  // 三个观测点 S3 / S4 / S5 一次跑出三种采样率，链路上每降一级都看得见。
  const { doc: scenario, sha } = loadScenario('golden-02')
  const c: ChainState = emptyChain('synthetic', 'chain-golden-02-dsp')
  c.name = '典型链路 · 全合成 · golden-02 宽带 · 三级 DSP 全开'
  c.scenario = { scenario_id: 'golden-02', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1', 'uav-2']
  c.run = { duration_s: 6, seed: 20260915 }
  c.slots.rx_fe.params = { gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.rx_flt.bypass = false
  c.slots.ddc.bypass = false
  c.slots.ddc.params = { f_shift_Hz: -2500000, decim: 2 }
  c.slots.chan.bypass = false
  c.slots.chan.params = { channels: 2, select_channel: 1 }
  c.slots.det.params = { nfft: 1024 }
  c.taps.s3 = true
  c.taps.s4 = true
  c.taps.s5 = true
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === 'synthetic') {
  // 三种信号源模式各一份回归夹具（C-11，10 报告 §9）。这一份是**全合成**：
  // 就是内置的缺省链（golden-01、20 s、同一组参数），只多勾三个观测点 ——
  // 04 §15.2 的算例 1（单音频移和功率标度）要在 S1 上读，算例 6（ADC 量化）要 S2 与 S3 对比。
  const { doc: scenario, sha } = loadScenario('golden-01')
  const c: ChainState = emptyChain('synthetic', 'chain-synthetic')
  c.name = '典型链路 · 全合成（标准算例回归）'
  c.scenario = { scenario_id: 'golden-01', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1']
  c.run = { duration_s: 20, seed: 20260907 }
  c.slots.tx_ant.params = { gain_dBi: 2 }
  c.slots.rx_ant.params = { gain_dBi: 3 }
  c.slots.rx_fe.params = { nf_dB: 6, gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.det.params = { nfft: 1024 }
  // S0 到 S3 四个点都取：10 报告 §9 的「全合成链的电平链」要从一条**保存的**链路上量出来
  c.taps.s0 = true
  c.taps.s1 = true
  c.taps.s2 = true
  c.taps.s3 = true
  // **不取 S4**：DDC 旁路时它的锚点顺链下滑到 ADC 那一节，与 S3 同节点同口，产品会一模一样
  c.taps.s4 = false
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === 'golden-01-e3') {
  // **E3 建筑遮挡**的回归夹具（D3-5，D-074）。就是上面那份全合成链，只把传播档位提到 E3。
  // 20 s 足够把三段式的前两段走完：起飞时被楼挡住三十几分贝，约 7 s 后过顶转视距。
  // 跑它要真实建筑集（`buildings.geojson` 不入 git），缺数据时回归脚本明说跳过（D-073 ③）。
  const { doc: scenario, sha } = loadScenario('golden-01')
  const c: ChainState = emptyChain('synthetic', 'chain-golden-01-e3')
  c.name = '典型链路 · 全合成 · E3 建筑遮挡'
  c.scenario = { scenario_id: 'golden-01', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1']
  c.run = { duration_s: 20, seed: 20260907 }
  c.slots.tx_ant.params = { gain_dBi: 2 }
  c.slots.rx_ant.params = { gain_dBi: 3 }
  c.slots.rx_fe.params = { nf_dB: 6, gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.det.params = { nfft: 1024 }
  // 传播档位是 `ch` 卡片上的参数，经槽位表的 proxy 写到 `scn` 节点（D-058 ③）
  c.slots.ch.params = { prop_level: 'E3' }
  c.taps.s1 = true
  c.taps.s3 = true
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === 'replay') {
  // **实测回放**（算例 9）。回放模式没有场景：数据自带采样率与中心频率，前六个环节不适用
  // （卡片上标「回放数据已含」）。检测频段只能由用户给——这里取 ±2 MHz，覆盖 DroneRFb 片段里
  // 目标信号的主瓣，而不是 80 MS/s 的整带（整带会把 WiFi 与蓝牙全算进来）。
  // 片段 dronerfb_0_CH0_S4：80 MS/s @ 2440 MHz、4000000 个样点 = 0.05 s。
  const c: ChainState = switchMode(emptyChain('replay', 'chain-replay'), 'replay')
  c.name = '典型链路 · 实测回放（标准算例回归）'
  c.slots.tx.params = { data_id: 'dronerfb_0_CH0_S4' }
  c.slots.det.params = { nfft: 1024, band_lo_Hz: -2000000, band_hi_Hz: 2000000 }
  c.run = { duration_s: 0.05, seed: 20260917 }
  process.stdout.write(serialize(compile(c, cat, null).doc, cat))
} else if (mode === 'mixed') {
  // **混合增强**（算例 10）：合成目标走全链，实测背景在 S4 处相加，前端不再生热噪声
  // （`noise_mode = none`，D-051 ⑥）。AddMixer 要求两路采样率与中心频率一致，
  // 所以场景按背景片段配成 80 MS/s @ 2440 MHz、0.05 s —— 缘由写在场景文件的 trace.notes 里。
  // 前端增益取 0：给合成支路加增益而背景不加，会把两者相对电平拉开 20 dB，背景就被淹没了。
  const { doc: scenario, sha } = loadScenario('mixed-wideband', 'tests/regression/scenarios')
  const c: ChainState = switchMode(emptyChain('mixed', 'chain-mixed'), 'mixed')
  c.name = '典型链路 · 混合增强（标准算例回归）'
  c.scenario = { scenario_id: 'mixed-wideband', sha256: sha }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1']
  c.backgroundDataId = 'dronerfb_0_CH0_S4'
  c.run = { duration_s: 0.05, seed: 20260917 }
  c.slots.tx_ant.params = { gain_dBi: 2 }
  c.slots.rx_ant.params = { gain_dBi: 3 }
  c.slots.rx_fe.params = { nf_dB: 6, gain_dB: 0 }
  c.slots.adc.params = { full_scale_dBm: -20 }
  c.slots.det.params = { nfft: 1024 }
  c.taps.s4 = true
  process.stdout.write(serialize(compile(c, cat, scenario).doc, cat))
} else if (mode === '3x3-aoa' || mode === '3x3-tdoa') {
  const { doc: scenario, sha } = loadScenario('golden-03')
  const file = join(ROOT, `tests/regression/diagrams/chain-${mode}.json`)
  const r = parseDoc(readFileSync(file, 'utf8'))
  if (!r.ok) throw new Error(`夹具不是合法框图：${r.error}`)
  const chain = parseChain(r.doc)
  if (!chain) throw new Error('夹具解不成典型链路：先查槽位表与 parseChain')
  // 场景引用按**盘上那份**重算，不沿用夹具里原有的那个哈希（2026-09-19 改名时发现：
  // 这个分支取了 sha 却没用，于是重新生成出来的夹具带着一个过期哈希，引擎装载时才会报出来）。
  // 别的模式本来就是显式写 `{ scenario_id, sha256: sha }`，这里跟它们一致。
  chain.scenario = { scenario_id: 'golden-03', sha256: sha }
  process.stdout.write(serialize(compile(chain, cat, scenario).doc, cat))
} else {
  throw new Error(`未知模式 ${mode}：default | golden-02 | golden-02-ddc | golden-02-chan | golden-02-dsp | synthetic | replay | mixed | 3x3-aoa | 3x3-tdoa`)
}
