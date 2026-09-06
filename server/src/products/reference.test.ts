// B-7 验收条件：服务端 TypeScript 的归约与 algos/reference/product_window.py 对**同一真实产品文件**
// 的同一查询逐值一致。需要引擎二进制与 uv，缺任一就跳过并说明（照 tasks/integration.test.ts 的做法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, promises as fsp } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { Engine, defaultEngineBinary } from '../tasks/engine.js'
import { createTaskManager } from '../tasks/manager.js'
import { taskDirAbs, type TaskRecord } from '../tasks/store.js'
import { REPO_ROOT, makeRoot, rmrf, slice1, waitFor } from '../tasks/testkit.js'
import { readProductMeta } from './meta.js'
import { openFileRowSource } from './source.js'
import { extractSpectrum, type SpectrumGeom, type SpectrumQuery } from './spectrum.js'
import { extractEnvelope, type EnvelopeGeom, type EnvelopeQuery } from './envelope.js'

const BIN = defaultEngineBinary(REPO_ROOT)
const SCRIPT = 'algos/reference/product_window.py'
const hasUv = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0
const skip = !existsSync(BIN)
  ? `没有引擎二进制 ${BIN}，先 cmake --build engine/build`
  : !hasUv
    ? '没有 uv，跳过 Python 参考对拍'
    : false

/** 1 个 float32 ulp 的相对量。max / min / 包络应逐位相同，mean 走 pow 与 log10 才需要它。 */
function closeF32(a: number, b: number): boolean {
  if (Object.is(a, b)) return true
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1.2e-7
}

test('真引擎 + Python 参考：切片 ① 的产品文件按三组视窗归约，两侧逐值一致', { skip }, async () => {
  const root = await makeRoot('cuav-ref-')
  try {
    const mgr = createTaskManager({ root, engine: new Engine({ bin: BIN, cwd: root }) })
    await mgr.init()
    const r = await mgr.submit({ body: await slice1() })
    const rec = await waitFor(
      () => {
        const t = mgr.get(r.task.task_id)
        return t && t.run_state !== 'queued' && t.run_state !== 'running' && t.exit_code !== undefined ? t : undefined
      },
      '切片 ① 跑完',
      120000,
      50,
    )
    assert.equal((rec as TaskRecord).run_state, 'finished')
    const taskDir = taskDirAbs(mgr.storeConfig, rec.task_id)
    const opDir = join(taskDir, 's4')
    mgr.shutdownSync()

    type Case =
      | { label: string; args: string[]; kind: 'spectrum'; q: SpectrumQuery }
      | { label: string; args: string[]; kind: 'envelope'; q: EnvelopeQuery }
    const cases: Case[] = [
      {
        label: '全窗 max（1953 × 1024 直通）',
        kind: 'spectrum',
        args: ['--kind', 'spectrum', '--stat', 'max'],
        q: { t0: null, t1: null, f0: null, f1: null, px: null, py: null, stat: 'max' },
      },
      {
        label: '时间窗 + 频段 + mean（线性功率域聚合）',
        kind: 'spectrum',
        args: ['--kind', 'spectrum', '--t0', '0.3', '--t1', '1.2', '--f0', '-120000', '--f1', '180000', '--px', '400', '--py', '150', '--stat', 'mean'],
        q: { t0: 0.3, t1: 1.2, f0: -120000, f1: 180000, px: 400, py: 150, stat: 'mean' },
      },
      {
        label: '包络合桶（末桶按 last_bucket_samples 计权）',
        kind: 'envelope',
        args: ['--kind', 'envelope', '--px', '97'],
        q: { t0: null, t1: null, px: 97 },
      },
    ]

    for (const c of cases) {
      const outFile = join(root, `ref-${c.kind}-${c.args.length}.f32`)
      const py = spawnSync('uv', ['run', '--quiet', 'python', SCRIPT, opDir, ...c.args, '--out', outFile], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      assert.equal(py.status, 0, `${c.label}：Python 参考失败\n${py.stderr}`)
      const info = JSON.parse(py.stdout.trim()) as { rows: number; cols: number; t0: number; t1: number; f0?: number; f1?: number }

      const meta = await readProductMeta(taskDir, 's4', c.kind, 'finished')
      const src = await openFileRowSource(meta.f32Path, meta.index.row_len, meta.rows_available)
      let got
      try {
        if (c.kind === 'spectrum') {
          const si = meta.index as { frame_hop_samples: number; bin_width_Hz: number; nfft: number; sample_rate_Hz: number }
          const geom: SpectrumGeom = {
            dt: si.frame_hop_samples / si.sample_rate_Hz,
            bw: si.bin_width_Hz,
            nfft: si.nfft,
            rowsAvail: meta.rows_available,
          }
          got = await extractSpectrum(src, geom, c.q)
        } else {
          const ei = meta.index as { bucket_samples: number; last_bucket_samples: number; sample_rate_Hz: number }
          const geom: EnvelopeGeom = {
            dt: ei.bucket_samples / ei.sample_rate_Hz,
            rowsAvail: meta.rows_available,
            bucketSamples: ei.bucket_samples,
            lastBucketSamples: ei.last_bucket_samples,
            indexFinal: meta.index_final,
          }
          got = await extractEnvelope(src, geom, c.q)
        }
      } finally {
        await src.close()
      }

      assert.equal(got.rows, info.rows, `${c.label} 行数`)
      assert.equal(got.cols, info.cols, `${c.label} 列数`)
      assert.equal(got.t0, info.t0, `${c.label} t0`)
      assert.equal(got.t1, info.t1, `${c.label} t1`)
      if (c.kind === 'spectrum') {
        assert.equal(got.f0, info.f0, `${c.label} f0`)
        assert.equal(got.f1, info.f1, `${c.label} f1`)
      }

      const refBuf = await fsp.readFile(outFile)
      const ref = new Float32Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 4)
      assert.equal(ref.length, got.data.length, `${c.label} 数据长度`)
      const exact = c.kind === 'envelope' || c.q.stat !== 'mean'
      let differing = 0
      let maxRel = 0
      for (let i = 0; i < ref.length; i++) {
        if (got.data[i] === ref[i]) continue
        differing++
        maxRel = Math.max(maxRel, Math.abs(got.data[i] - ref[i]) / Math.max(Math.abs(ref[i]), Number.MIN_VALUE))
        assert.ok(!exact, `${c.label} 第 ${i} 个值应逐位相同：${got.data[i]} vs ${ref[i]}`)
        assert.ok(closeF32(got.data[i], ref[i]), `${c.label} 第 ${i} 个值超出 1 ulp：${got.data[i]} vs ${ref[i]}`)
      }
      console.log(`  ${c.label}：${got.rows} × ${got.cols}，逐位不同 ${differing} / ${ref.length}，最大相对差 ${maxRel}`)
    }
  } finally {
    await rmrf(root)
  }
})
