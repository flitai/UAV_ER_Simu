// 视窗抽取的黄金基准比对（B-7 验收条件：与 Python 参考对同一输入逐值一致）。
//
// 基准 tests/golden/product-window.json 由 algos/reference/product_window.py --golden 生成，
// 里面只存**公式**与输入哈希，不存输入本身：本测试按同样的公式再生成一遍输入并核对 sha256，
// 因此两侧的输入必然逐位相同，比较的才真是归约逻辑（铁律 10：基准不得静默变）。
//
// 判据：max / min 与包络三列**逐位相同**（比较、乘加、除、sqrt 都是正确舍入的 IEEE 运算）；
// mean 走 pow 与 log10，V8 与 libm 可差 1 个 float64 ulp，故允许 1 个 float32 ulp。
// 超差是发现，查根因，禁止放宽容差。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { MemoryRowSource } from './window.js'
import { ENVELOPE_ROW_LEN, extractEnvelope, type EnvelopeGeom } from './envelope.js'
import { extractSpectrum, type SpectrumGeom, type Stat } from './spectrum.js'
import { REPO_ROOT } from '../tasks/testkit.js'

const GOLDEN = join(REPO_ROOT, 'tests', 'golden', 'product-window.json')

interface Golden {
  schema: string
  spectrum: { rows: number; nfft: number; sample_rate_Hz: number; frame_hop_samples: number; bin_width_Hz: number; input_sha256: string }
  envelope: { rows: number; sample_rate_Hz: number; bucket_samples: number; last_bucket_samples: number; input_sha256: string }
  cases: Array<{
    id: string
    kind: 'spectrum' | 'envelope'
    index_rows?: number
    query: { t0: number | null; t1: number | null; f0?: number | null; f1?: number | null; px: number | null; py?: number | null; stat?: Stat }
    expect: { rows: number; cols: number; t0: number; t1: number; f0?: number; f1?: number; data: number[] }
  }>
}

/** 与 product_window.py 的 build_spectrum_fixture 同一公式。 */
function buildSpectrum(rows: number, nfft: number): Float32Array {
  const d = new Float32Array(rows * nfft)
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < nfft; k++) {
      d[i * nfft + k] = (i * 7 + k) % 13 === 0 ? -300 : -100 + ((i * 37 + k * 11) % 60) - ((i * k) % 7) * 0.5
    }
  }
  return d
}

/** 与 product_window.py 的 build_envelope_fixture 同一公式。 */
function buildEnvelope(rows: number): Float32Array {
  const d = new Float32Array(rows * ENVELOPE_ROW_LEN)
  for (let j = 0; j < rows; j++) {
    const mn = ((j * 3) % 11) / 16
    const mx = mn + (((j * 5) % 7) + 1) / 8
    d[j * 3] = mn
    d[j * 3 + 1] = mx
    d[j * 3 + 2] = (mn + mx) / 2
  }
  return d
}

function sha256(a: Float32Array): string {
  return createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex')
}

/** 一个 float32 ulp 的相对量：float32 尾数 24 位，eps ≈ 1.19e-7。 */
function closeF32(a: number, b: number): boolean {
  if (Object.is(a, b)) return true
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1.2e-7
}

test('黄金基准：合成输入哈希一致，12 个用例的归约与 Python 参考逐值一致', async () => {
  const g = JSON.parse(await fsp.readFile(GOLDEN, 'utf8')) as Golden
  assert.equal(g.schema, 'cuav-server-golden/1')

  const specData = buildSpectrum(g.spectrum.rows, g.spectrum.nfft)
  const envData = buildEnvelope(g.envelope.rows)
  assert.equal(sha256(specData), g.spectrum.input_sha256, '谱夹具与基准记录的输入不一致')
  assert.equal(sha256(envData), g.envelope.input_sha256, '包络夹具与基准记录的输入不一致')

  const specSrc = new MemoryRowSource(specData, g.spectrum.nfft)
  const specGeom: SpectrumGeom = {
    dt: g.spectrum.frame_hop_samples / g.spectrum.sample_rate_Hz,
    bw: g.spectrum.bin_width_Hz,
    nfft: g.spectrum.nfft,
    rowsAvail: g.spectrum.rows,
  }
  const envSrc = new MemoryRowSource(envData, ENVELOPE_ROW_LEN)

  assert.equal(g.cases.length, 12)
  for (const c of g.cases) {
    const e = c.expect
    const got =
      c.kind === 'spectrum'
        ? await extractSpectrum(specSrc, specGeom, {
            t0: c.query.t0,
            t1: c.query.t1,
            f0: c.query.f0 ?? null,
            f1: c.query.f1 ?? null,
            px: c.query.px,
            py: c.query.py ?? null,
            stat: c.query.stat ?? 'max',
          })
        : await extractEnvelope(
            envSrc,
            ((): EnvelopeGeom => ({
              dt: g.envelope.bucket_samples / g.envelope.sample_rate_Hz,
              rowsAvail: g.envelope.rows,
              bucketSamples: g.envelope.bucket_samples,
              lastBucketSamples: g.envelope.last_bucket_samples,
              indexFinal: c.index_rows === g.envelope.rows,
            }))(),
            { t0: c.query.t0, t1: c.query.t1, px: c.query.px },
          )

    assert.equal(got.rows, e.rows, `${c.id} 行数`)
    assert.equal(got.cols, e.cols, `${c.id} 列数`)
    assert.equal(got.t0, e.t0, `${c.id} t0`)
    assert.equal(got.t1, e.t1, `${c.id} t1`)
    if (c.kind === 'spectrum') {
      assert.equal(got.f0, e.f0, `${c.id} f0`)
      assert.equal(got.f1, e.f1, `${c.id} f1`)
    } else {
      assert.equal(got.f0, null)
    }
    assert.equal(got.data.length, e.data.length, `${c.id} 数据长度`)
    const exact = c.kind === 'envelope' || (c.query.stat ?? 'max') !== 'mean'
    for (let i = 0; i < e.data.length; i++) {
      if (exact) assert.equal(got.data[i], e.data[i], `${c.id} 第 ${i} 个值应逐位相同`)
      else assert.ok(closeF32(got.data[i], e.data[i]), `${c.id} 第 ${i} 个值超出 1 ulp：${got.data[i]} vs ${e.data[i]}`)
    }
  }
})

test('黄金基准：末桶权重是两个包络用例的唯一差别（索引已收尾才用 last_bucket_samples）', async () => {
  const g = JSON.parse(await fsp.readFile(GOLDEN, 'utf8')) as Golden
  const fin = g.cases.find((c) => c.id === 'env-full-final')!
  const unf = g.cases.find((c) => c.id === 'env-full-unfinished')!
  assert.deepEqual(fin.query, unf.query)
  const a = fin.expect.data
  const b = unf.expect.data
  const diff = a.map((v, i) => (v === b[i] ? 0 : 1))
  assert.equal(
    diff.reduce((s, v) => s + v, 0),
    1,
    '只有最后一组的 rms 应当不同',
  )
  assert.equal(diff[diff.length - 1], 1)
})
