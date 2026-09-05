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
  const manifest = (id: string) => JSON.stringify({
    manifest_version: '1.0', observation_point: 'S4',
    identity: { data_id: id },
    sampling: { sample_format: 'ci16_le', byte_order: 'little', iq_layout: 'interleaved_IQ', internal_format: 'cf32', sample_rate_Hz: 1e6, sample_count: 3000 },
    frequency: { center_frequency_Hz: 2.44e9, effective_bandwidth_Hz: 1e6 },
    power: { full_scale: 32768, scale: null },
    quality: { status: 'degraded', reasons: ['测试夹具'] }, segments: [],
  }, null, 2)
  for (const id of [FX_IDS.ok, FX_IDS.holdout]) {
    await fsp.writeFile(join(dir, `${id}.iq`), iq)
    await fsp.writeFile(join(dir, `${id}.manifest.json`), manifest(id))
  }
  await fsp.writeFile(join(dir, 'index.manifest.json'), JSON.stringify({
    schema: 'cuav-batch-index/1', directory: `data/iq/measured/${FX_BATCH}`,
    products: [FX_IDS.ok, FX_IDS.holdout, FX_IDS.noFile].map((data_id) => ({ data_id })),
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
