// 客户端归约的黄金基准比对：按 server/src/products/golden.test.ts 记录的公式重生成夹具、核对 sha256，
// 再对 tests/golden/product-window.json 的 12 个用例逐值比较（max / min / 包络逐位，mean ≤ 1 float32 ulp）。
// 跟随模式的单行归约 reduceSpectrumRow 与整块归约必须对单行组逐位一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENVELOPE_ROW_LEN, planSpectrum, reduceEnvelope, reduceSpectrum, reduceSpectrumRow } from './reduce.js'
import type { EnvelopeGeom, SpectrumGeom, Stat } from './viewport.js'

const GOLDEN = fileURLToPath(new URL('../../../tests/golden/product-window.json', import.meta.url))

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

function buildSpectrum(rows: number, nfft: number): Float32Array {
  const d = new Float32Array(rows * nfft)
  for (let i = 0; i < rows; i++) for (let k = 0; k < nfft; k++) d[i * nfft + k] = (i * 7 + k) % 13 === 0 ? -300 : -100 + ((i * 37 + k * 11) % 60) - ((i * k) % 7) * 0.5
  return d
}
function buildEnvelope(rows: number): Float32Array {
  const d = new Float32Array(rows * ENVELOPE_ROW_LEN)
  for (let j = 0; j < rows; j++) {
    const mn = ((j * 3) % 11) / 16
    const mx = mn + (((j * 5) % 7) + 1) / 8
    d[j * 3] = mn; d[j * 3 + 1] = mx; d[j * 3 + 2] = (mn + mx) / 2
  }
  return d
}
const sha256 = (a: Float32Array) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex')
const closeF32 = (a: number, b: number) => Object.is(a, b) || Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1.2e-7

test('黄金基准：前端归约与服务端 / Python 参考对 12 个用例逐值一致', async () => {
  const g = JSON.parse(await fsp.readFile(GOLDEN, 'utf8')) as Golden
  assert.equal(g.schema, 'cuav-server-golden/1')
  const spec = buildSpectrum(g.spectrum.rows, g.spectrum.nfft)
  const env = buildEnvelope(g.envelope.rows)
  assert.equal(sha256(spec), g.spectrum.input_sha256)
  assert.equal(sha256(env), g.envelope.input_sha256)
  const nfft = g.spectrum.nfft
  const specRow = (i: number) => spec.subarray(i * nfft, (i + 1) * nfft)
  const envRow = (j: number) => env.subarray(j * 3, (j + 1) * 3)
  const sg: SpectrumGeom = { dt: g.spectrum.frame_hop_samples / g.spectrum.sample_rate_Hz, bw: g.spectrum.bin_width_Hz, nfft, rowsAvail: g.spectrum.rows }
  assert.equal(g.cases.length, 12)
  for (const c of g.cases) {
    const e = c.expect
    const got = c.kind === 'spectrum'
      ? reduceSpectrum(specRow, sg, { t0: c.query.t0, t1: c.query.t1, f0: c.query.f0 ?? null, f1: c.query.f1 ?? null, px: c.query.px, py: c.query.py ?? null, stat: c.query.stat ?? 'max' })
      : reduceEnvelope(envRow, ((): EnvelopeGeom => ({
          dt: g.envelope.bucket_samples / g.envelope.sample_rate_Hz, rowsAvail: g.envelope.rows, bucketSamples: g.envelope.bucket_samples,
          lastBucketSamples: g.envelope.last_bucket_samples, indexFinal: c.index_rows === g.envelope.rows,
        }))(), { t0: c.query.t0, t1: c.query.t1, px: c.query.px })
    assert.equal(got.rows, e.rows, `${c.id} 行数`)
    assert.equal(got.cols, e.cols, `${c.id} 列数`)
    assert.equal(got.t0, e.t0, `${c.id} t0`)
    assert.equal(got.t1, e.t1, `${c.id} t1`)
    if (c.kind === 'spectrum') { assert.equal(got.f0, e.f0); assert.equal(got.f1, e.f1) } else assert.equal(got.f0, null)
    assert.equal(got.data.length, e.data.length)
    const exact = c.kind === 'envelope' || (c.query.stat ?? 'max') !== 'mean'
    for (let i = 0; i < e.data.length; i++) {
      if (exact) assert.equal(got.data[i], e.data[i], `${c.id} 第 ${i} 个值应逐位相同`)
      else assert.ok(closeF32(got.data[i]!, e.data[i]!), `${c.id} 第 ${i} 个值超出 1 ulp`)
    }
  }
})

test('reduceSpectrumRow：单行列分组与整块归约的单行组逐位一致（三种统计量）', async () => {
  const g = JSON.parse(await fsp.readFile(GOLDEN, 'utf8')) as Golden
  const nfft = g.spectrum.nfft
  const spec = buildSpectrum(g.spectrum.rows, nfft)
  const sg: SpectrumGeom = { dt: g.spectrum.frame_hop_samples / g.spectrum.sample_rate_Hz, bw: g.spectrum.bin_width_Hz, nfft, rowsAvail: g.spectrum.rows }
  for (const stat of ['max', 'min', 'mean'] as Stat[]) {
    const q = { t0: 5 * sg.dt, t1: 6 * sg.dt, f0: -12500, f1: 7300, px: 7, py: 1, stat }
    const whole = reduceSpectrum((i) => spec.subarray(i * nfft, (i + 1) * nfft), sg, q)
    const p = planSpectrum(sg, q)
    assert.equal(whole.rows, 1)
    const out = new Float32Array(whole.cols)
    reduceSpectrumRow(spec.subarray(5 * nfft, 6 * nfft), p.colSpan.lo, p.cb, stat, out, 0)
    assert.deepEqual(Array.from(out), Array.from(whole.data), stat)
  }
})
