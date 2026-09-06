// 视窗数学单测：对译部分沿用 server/src/products/window.test.ts 的数值，前端独有部分各自成组。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAP_PX, CAP_PY, MAX_BYTES,
  boxToViewport, clampViewport, colEdgeHz, cursorStep, freqToX, fullWindow, groupBounds, groupCount,
  liveWindow, panSpan, planSpectrumQuery, selectCols, selectRows, spectrumGeomOf, envelopeGeomOf, srcIndexForPixel,
  timeToY, xToFreq, yToTime, zoomSpan, type SpectrumGeom, type Viewport,
} from './viewport.js'
import type { ProductIndex } from '../state/types.js'

const G: SpectrumGeom = { dt: 0.001, bw: 1000, nfft: 64, rowsAvail: 37 }

test('groupBounds / groupCount：与服务端同式', () => {
  assert.deepEqual(groupBounds(10, 0), [0])
  assert.deepEqual(groupBounds(6, 3), [0, 2, 4, 6])
  assert.deepEqual(groupBounds(7, 3), [0, 2, 4, 7])
  assert.deepEqual(groupBounds(5, 5), [0, 1, 2, 3, 4, 5])
  assert.equal(groupCount(0, 10, CAP_PX), 0)
  assert.equal(groupCount(64, 1000, CAP_PX), 64)   // 不插值
  assert.equal(groupCount(64, 7, CAP_PX), 7)
  assert.equal(groupCount(10000, null, CAP_PX), CAP_PX)
  assert.equal(groupCount(3000, null, CAP_PY), CAP_PY)
})

test('selectRows / selectCols / colEdgeHz：半开区间、钳位、窗外归零', () => {
  assert.deepEqual(selectRows(null, null, 0.001, 37), { lo: 0, hi: 37 })
  assert.deepEqual(selectRows(0.0035, 0.0121, 0.001, 37), { lo: 3, hi: 13 })
  assert.deepEqual(selectRows(1, 2, 0.001, 37), { lo: 37, hi: 37 })
  assert.deepEqual(selectRows(-2, -1, 0.001, 37), { lo: 0, hi: 0 })
  assert.deepEqual(selectCols(null, null, 1000, 64), { lo: 0, hi: 64 })
  assert.deepEqual(selectCols(0, 0, 1000, 64), { lo: 32, hi: 33 })
  assert.deepEqual(selectCols(-12500, 7300, 1000, 64), { lo: 20, hi: 40 })
  assert.deepEqual(selectCols(-1e9, 1e9, 1000, 64), { lo: 0, hi: 64 })
  assert.equal(colEdgeHz(0, 1000, 64), -32500)
  assert.equal(colEdgeHz(64, 1000, 64), 31500)
})

test('srcIndexForPixel：n = P 恒等；n < P 逐像素采样单调且覆盖每个源项；n > P 不越界', () => {
  for (let p = 0; p < 10; p++) assert.equal(srcIndexForPixel(p, 10, 10), p)
  const seen = new Set<number>()
  let prev = -1
  for (let p = 0; p < 1800; p++) {
    const i = srcIndexForPixel(p, 1024, 1800)
    assert.ok(i >= prev && i < 1024)
    prev = i
    seen.add(i)
  }
  assert.equal(seen.size, 1024)
  assert.equal(srcIndexForPixel(9, 3, 10), 2)
  assert.equal(srcIndexForPixel(0, 0, 10), -1)
})

test('spectrumGeomOf / envelopeGeomOf：从索引取几何，缺关键字段给 null', () => {
  const idx = {
    kind: 'spectrum', op_id: 's4', row_len: 1024, rows: 0, sample_rate_Hz: 1e6, center_Hz: 2.44e9, bin_width_Hz: 1e6 / 1024,
    frame_hop_samples: 1024, t0_s: 0, nfft: 1024, window: 'hann', scale: 'dBm', state: 'valid', state_reasons: [],
    rows_available: 1953, index_final: true, run_state: 'finished',
  } as ProductIndex
  const g = spectrumGeomOf(idx)!
  assert.equal(g.dt, 1024 / 1e6)
  assert.equal(g.nfft, 1024)
  assert.equal(g.rowsAvail, 1953)
  assert.equal(spectrumGeomOf({ ...idx, sample_rate_Hz: 0 }), null)
  const e = envelopeGeomOf({ ...idx, kind: 'envelope', row_len: 3, bucket_samples: 4096, last_bucket_samples: 100, rows_available: 489, index_final: false })!
  assert.equal(e.dt, 4096 / 1e6)
  assert.equal(e.lastBucketSamples, 100)
  assert.equal(e.indexFinal, false)
  assert.equal(envelopeGeomOf(idx), null)
})

test('fullWindow / liveWindow / clampViewport', () => {
  const full = fullWindow(G)
  assert.deepEqual(full, { t0: 0, t1: 0.037, f0: -32500, f1: 31500, stat: 'max' })
  assert.deepEqual(liveWindow(99, 50, 0.001), { t0: 0.05, t1: 0.1 })
  assert.deepEqual(liveWindow(3, 50, 0.001), { t0: 0, t1: 0.004 })
  const c = clampViewport({ t0: -1, t1: 100, f0: 1e9, f1: -1e9, stat: 'mean' }, G)
  assert.deepEqual(c, { t0: 0, t1: 0.037, f0: -32500, f1: 31500, stat: 'mean' })
  // 跨度小于一行 / 一列时撑到最小跨度
  const tiny = clampViewport({ t0: 0.0105, t1: 0.0106, f0: 10, f1: 20, stat: 'max' }, G)
  assert.ok(tiny.t1 - tiny.t0 >= G.dt - 1e-12)
  assert.ok(tiny.f1 - tiny.f0 >= G.bw - 1e-9)
})

test('planSpectrumQuery：px / py 与服务端缺省同式，字节永不超上限；W/H 为 0 取 1', () => {
  const vp: Viewport = fullWindow(G)
  const q = planSpectrumQuery(vp, 1800, 900, G)
  assert.equal(q.px, 1800)
  assert.equal(q.py, 900)
  const big: SpectrumGeom = { dt: 1e-3, bw: 1, nfft: 65536, rowsAvail: 100000 }
  const qb = planSpectrumQuery(fullWindow(big), 5000, 5000, big)
  assert.equal(qb.px, CAP_PX)
  assert.ok(qb.py * Math.min(qb.px, big.nfft) * 4 <= MAX_BYTES)
  assert.ok(qb.py <= CAP_PY)
  const z = planSpectrumQuery(vp, 0, 0, G)
  assert.deepEqual([z.px, z.py], [1, 1])
})

test('像素映射：顶 = t1，往返一致；zoomSpan 锚点不动；panSpan 不出界', () => {
  assert.equal(timeToY(0.1, 100, 0, 0.1), 0)
  assert.equal(timeToY(0, 100, 0, 0.1), 100)
  assert.ok(Math.abs(yToTime(timeToY(0.037, 400, 0.01, 0.05), 400, 0.01, 0.05) - 0.037) < 1e-12)
  assert.ok(Math.abs(xToFreq(freqToX(1234, 800, -5000, 5000), 800, -5000, 5000) - 1234) < 1e-9)
  const z = zoomSpan({ lo: 0, hi: 10 }, 2, 0.5, 0.1, { lo: 0, hi: 10 })
  assert.deepEqual(z, { lo: 1, hi: 6 })
  const zo = zoomSpan({ lo: 1, hi: 6 }, 2, 2, 0.1, { lo: 0, hi: 10 })
  assert.deepEqual(zo, { lo: 0, hi: 10 })          // 放大超界裁到全范围
  assert.deepEqual(zoomSpan({ lo: 4, hi: 5 }, 4.5, 0.01, 0.5, { lo: 0, hi: 10 }), { lo: 4.25, hi: 4.75 })
  assert.deepEqual(panSpan({ lo: 1, hi: 3 }, -5, { lo: 0, hi: 10 }), { lo: 0, hi: 2 })
  assert.deepEqual(panSpan({ lo: 1, hi: 3 }, 20, { lo: 0, hi: 10 }), { lo: 8, hi: 10 })
})

test('boxToViewport：框选任意方向都得到正序视窗并夹到数据内', () => {
  const vp = fullWindow(G)
  const v = boxToViewport(vp, { x0: 320, y0: 300, x1: 160, y1: 100 }, 640, 400, G)
  assert.ok(v.f0 < v.f1 && v.t0 < v.t1)
  assert.ok(Math.abs(v.f0 - xToFreq(160, 640, vp.f0, vp.f1)) < 1e-9)
  assert.ok(Math.abs(v.t1 - yToTime(100, 400, vp.t0, vp.t1)) < 1e-12)
})

test('cursorStep：从窗内最新一行起，按 dt 格点步进，Shift 十帧，越窗夹住', () => {
  const win = { t0: 0, t1: 0.037 }
  assert.ok(Math.abs(cursorStep(null, -1, false, 0.001, win) - 0.035) < 1e-12)
  assert.ok(Math.abs(cursorStep(0.02, 1, true, 0.001, win) - 0.03) < 1e-12)
  assert.ok(Math.abs(cursorStep(0.035, 1, true, 0.001, win) - 0.036) < 1e-12)
  assert.equal(cursorStep(0.0005, -1, false, 0.001, win), 0)
})
