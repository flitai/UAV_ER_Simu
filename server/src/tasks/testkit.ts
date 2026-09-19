// 测试工具（不进 dist：tsconfig 已排除）。临时仓库根、假引擎、回放夹具、轮询等待。
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from './engine.js'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..', '..')
export const FAKE_ENGINE = join(HERE, 'fake_engine.mjs')
export const SLICE1 = join(REPO_ROOT, 'engine', 'tests', 'diagrams', 'slice1_tone_noise_psd.json')

/** 临时目录充当仓库根（引擎 cwd）。 */
export async function makeRoot(prefix = 'cuav-tasks-'): Promise<string> {
  const dir = await fsp.mkdtemp(join(tmpdir(), prefix))
  // macOS 的 tmpdir 是符号链接，先解析成真实路径，脱敏器比对前缀才对得上 process.cwd()
  return fsp.realpath(dir)
}

export function fakeEngine(root: string): Engine {
  return new Engine({ bin: process.execPath, prefixArgs: [FAKE_ENGINE], cwd: root })
}

/** 切片 ① 框图；给 mode 则把 name 改成 fake:<mode> 选假引擎的行为。 */
export async function slice1(mode?: string): Promise<Record<string, unknown>> {
  const d = JSON.parse(await fsp.readFile(SLICE1, 'utf8')) as Record<string, unknown>
  if (mode) d.name = `fake:${mode}`
  return d
}

/** 回放框图：一个 FileReplaySource 接观测点。 */
export function replayDiagram(dataId: string, mode?: string): Record<string, unknown> {
  return {
    schema_version: 'cuav-diagram/1',
    diagram_id: 'replay-psd',
    name: mode ? `fake:${mode}` : '回放到功率谱',
    nodes: [
      { id: 'replay', type: 'FileReplaySource', params: { data_id: dataId, block_samples: 1000 } },
      { id: 'psd', type: 'SpectrumAnalyzer', params: { nfft: 256 } },
    ],
    edges: [{ id: 'e1', from: { node: 'replay', port: 'out' }, to: { node: 'psd', port: 'in' } }],
    observation_points: [{ id: 's4', node: 'replay', port: 'out', products: ['spectrum', 'envelope'] }],
    run: { seed: 1, duration_s: 1.0, time_basis: 'LogicalSim' },
  }
}

export const FX_BATCH = 'fx'
export const FX_IDS = { ok: 'fx_run_1', holdout: 'fx_hold_1', noFile: 'fx_missing_1' }

/**
 * 在 root 下造一批数据：data/iq/measured/fx/{index.manifest.json, fx_run_1.*, fx_hold_1.*}，
 * 索引里另有 fx_missing_1 但盘上没有它的清单；holdout.manifest.json 列 fx_hold_1。
 * 写法照 engine/tests/test_runner.cpp 的回放夹具（3000 样点 ci16）。
 */
export async function makeDataFixture(root: string): Promise<void> {
  const dir = join(root, 'data', 'iq', 'measured', FX_BATCH)
  await fsp.mkdir(dir, { recursive: true })
  const iq = Buffer.alloc(3000 * 4)
  for (let i = 0; i < 6000; i++) iq.writeInt16LE(((i * 53) % 4000) - 2000, i * 2)
  // 清单里**故意**塞进那些不许发给浏览器的东西（铁律 17、D-037）：producer 与 conversion.tool 是
  // 仓库相对路径、origin.source_file 是外部源文件名、power.reason 里带脚本路径、
  // calibration.table 是另一个路径、truth.original_name 是外部切片名、permission 是溯源。
  // 不这么造，datasets.test.ts 里那几条「响应里没有路径」的断言就是空过的。
  const manifest = (id: string) => JSON.stringify({
    manifest_version: '1.0', observation_point: 'S4',
    identity: { data_id: id, producer: 'tools/iq_convert.py 0.1.0', content_sha256: 'fx'.repeat(32) },
    sampling: { sample_format: 'ci16_le', byte_order: 'little', iq_layout: 'interleaved_IQ', internal_format: 'cf32', sample_rate_Hz: 1e6, sample_count: 3000 },
    frequency: { center_frequency_Hz: 2.44e9, effective_bandwidth_Hz: 1e6 },
    time: { start_time: null, time_basis: 'file_acquisition', continuity: { flag: 'continuous' } },
    channel: { station_id: 'unknown', channel_id: 'CH0', antenna: null },
    power: {
      full_scale: 32768, scale: null, absolute_power: 'estimated', agc: 'unknown',
      reason: '功率标定常数为估算值；甲方数据到货后按 scripts/ds8_calibration.py 重估替换',
      calibration: { full_scale_dBm: -1.6, source: 'model', status: 'prototype', note: '由链路预算反推', table: 'data/iq/measured/calibration.json' },
    },
    quality: { status: 'degraded', checks: { hash_duplicate: 'valid' }, reasons: ['测试夹具'] },
    origin: { kind: 'measured', dataset: 'FX-SET', source_file: '0.mat', source_sha256: null, doi: '10.0000/fx', conversion: { tool: 'tools/iq_convert.py 0.1.0' } },
    model_trace: { model_id: 'measured:FX-SET', model_level: 'E4', model_layer: 'M3', credibility: 'V2' },
    truth: { class_name: '甲型机', original_name: 'D1_IN_S2_slice_47' },
    permission: { owner: '某单位', usage_scope: '内部' },
    survey: { tool: 'tools/iq_survey.py 0.1.0', stats: { rms_dBFS: -35.5, peak_dBFS: -19.4, clip_samples: 0 } },
    segments: [{ file: `${id}.iq`, start_sample: 0, sample_count: 3000, sha256: 'fx'.repeat(32) }],
  }, null, 2)
  for (const id of [FX_IDS.ok, FX_IDS.holdout]) {
    await fsp.writeFile(join(dir, `${id}.iq`), iq)
    await fsp.writeFile(join(dir, `${id}.manifest.json`), manifest(id))
  }
  await fsp.writeFile(join(dir, 'index.manifest.json'), JSON.stringify({
    schema: 'cuav-batch-index/1', directory: `data/iq/measured/${FX_BATCH}`,
    datasets: { 'FX-SET': 3 },
    // 标定常数在真实批索引里是**按数据集**一块（D-047），详情端点的 index 档靠它
    calibration: { 'FX-SET': { full_scale_dBm: -1.6, source: 'model', status: 'prototype', estimated_utc: '2026-09-06T04:16:45Z', product_count: 3 } },
    // 摘要字段（D-056）：列清单端点要用它们，两批真实数据的 truth 形状不同，这里各造一种。
    // source_file 与 original_name 是真实索引里就有的外部来源，留着给详情的白名单当靶子
    products: [
      { data_id: FX_IDS.ok, source_file: '0.mat', channel_id: 'CH0', segments: 1, content_sha256: 'fx'.repeat(32),
        center_frequency_Hz: 2.44e9, sample_count: 3000, quality: 'degraded',
        truth: { class_name: '甲型机', visibility: 'LOS', distance_m: 10, split: 'test', original_name: 'D1_IN_S2_slice_47' } },
      { data_id: FX_IDS.holdout, source_file: '1.mat', channel_id: 'CH0', segments: 1, content_sha256: 'fy'.repeat(32),
        center_frequency_Hz: 2.44e9, sample_count: 3000, quality: 'valid',
        truth: { class_name: '乙型机', distance_range_m: [20, 40] } },
      { data_id: FX_IDS.noFile },
    ],
  }))
  await fsp.writeFile(join(root, 'data', 'iq', 'measured', 'holdout.manifest.json'), JSON.stringify({
    schema: 'cuav-holdout-manifest/1', holdout: [{ data_id: FX_IDS.holdout }],
  }))
}

export async function waitFor<T>(fn: () => T | undefined | null | false, label: string, timeoutMs = 10000, stepMs = 20): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

export async function rmrf(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true })
}
