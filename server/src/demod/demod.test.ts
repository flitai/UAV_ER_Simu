// 按突发解调的单测（D-107）：FFT 对直接 DFT、重采样对通带单音、合成 OFDM 与 GFSK 突发上的物理量
// （频偏、时延、EVM、前导与同步字）。合成信号在本测试里按连续时间闭式生成，不借服务端代码，
// 于是这里验的是「解调器解出的东西对不对」，不是「同一段代码跑两遍」。Python 参考的对拍另在
// tests/regression/demod_parity.py。

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cx, designLowpass, fft, resample, type Cx } from './dsp.js'
import { demodGfsk, demodOfdm, loadPresetDocs, overlaps, type IqSource, type TruthRow } from './core.js'
import { encodeFrame } from './routes.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function mem(x: Cx, fs: number, fc: number): IqSource {
  return {
    fs, fc,
    async read(a: number, b: number) {
      if (a < 0 || b > x.re.length) return null
      return { re: x.re.slice(a, b), im: x.im.slice(a, b) }
    },
  }
}

test('FFT 对直接 DFT（N = 64，正反变换）', () => {
  const N = 64
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let i = 0; i < N; i++) { re[i] = Math.sin(0.3 * i * i); im[i] = Math.cos(1.7 * i) }
  const r0 = re.slice()
  const i0 = im.slice()
  fft(re, im)
  let worst = 0
  for (let k = 0; k < N; k++) {
    let sr = 0
    let si = 0
    for (let n = 0; n < N; n++) {
      const a = (-2 * Math.PI * k * n) / N
      sr += r0[n] * Math.cos(a) - i0[n] * Math.sin(a)
      si += r0[n] * Math.sin(a) + i0[n] * Math.cos(a)
    }
    worst = Math.max(worst, Math.hypot(re[k] - sr, im[k] - si))
  }
  assert.ok(worst < 1e-10, `FFT 对 DFT 最大差 ${worst}`)
  fft(re, im, true)
  for (let n = 0; n < N; n++) assert.ok(Math.abs(re[n] - r0[n]) < 1e-12 && Math.abs(im[n] - i0[n]) < 1e-12)
})

test('有理重采样：通带单音 80 → 30.72 MS/s 幅相不变', () => {
  const fs = 80e6
  const f = 3.1e6
  const n = 20000
  const x = cx(n)
  for (let m = 0; m < n; m++) { x.re[m] = Math.cos((2 * Math.PI * f * m) / fs); x.im[m] = Math.sin((2 * Math.PI * f * m) / fs) }
  const { h, T } = designLowpass(fs, 48, 9.5e6, 10.5e6)
  const y = resample(x, 0, 48, 125, h, T, 2000, 5000)
  let worst = 0
  for (let j = 2000; j < 5000; j++) {
    const a = (2 * Math.PI * f * j) / 30.72e6
    worst = Math.max(worst, Math.hypot(y.re[j - 2000] - Math.cos(a), y.im[j - 2000] - Math.sin(a)))
  }
  assert.ok(worst < 1e-3, `单音误差 ${worst}`)
})

/** 连续时间闭式生成一个 OFDM 突发：每个符号 Σ X_k·e^{j2πkΔf(t − τ_s)}，CP 是同一式在 τ_s 之前的延拓 */
function ofdmBurst(fs: number, fsN: number, N: number, K: number, cps: number[], zcRoot: number, t0: number, cfo: number,
  fOff: number, total: number): Cx {
  const df = fsN / N
  const x = cx(total)
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const nzc = 2 * K + 1
  let off = 0
  for (let s = 0; s < cps.length; s++) {
    const ks: number[] = []
    const Xr: number[] = []
    const Xi: number[] = []
    let i = 0
    for (let n = 0; n < nzc; n++) {
      if (n === K) continue
      ks.push(i < K ? i - K : i - K + 1)
      if (s === 0) {
        const m = (zcRoot * ((n * (n + 1)) % (2 * nzc))) % (2 * nzc)
        Xr.push(Math.cos((-Math.PI * m) / nzc)); Xi.push(Math.sin((-Math.PI * m) / nzc))
      } else {
        Xr.push(rnd() < 0.5 ? -Math.SQRT1_2 : Math.SQRT1_2); Xi.push(rnd() < 0.5 ? -Math.SQRT1_2 : Math.SQRT1_2)
      }
      i++
    }
    const tau = t0 + (off + cps[s]) / fsN
    const ta = t0 + off / fsN
    const tb = tau + N / fsN
    for (let m = Math.ceil(ta * fs); m < tb * fs; m++) {
      const t = m / fs
      let sr = 0
      let si = 0
      for (let q = 0; q < ks.length; q++) {
        const a = 2 * Math.PI * ks[q] * df * (t - tau)
        sr += Xr[q] * Math.cos(a) - Xi[q] * Math.sin(a)
        si += Xr[q] * Math.sin(a) + Xi[q] * Math.cos(a)
      }
      const c = 2 * Math.PI * (cfo + fOff) * t
      x.re[m] = (sr * Math.cos(c) - si * Math.sin(c)) / Math.sqrt(2 * K)
      x.im[m] = (sr * Math.sin(c) + si * Math.cos(c)) / Math.sqrt(2 * K)
    }
    off += cps[s] + N
  }
  return x
}

test('OFDM：合成遥控上行突发（30.72 MS/s，已知时延与 −45.2 kHz 频偏）', async () => {
  const docs = await loadPresetDocs(ROOT)
  const fs = 30.72e6
  const fsN = 15.36e6
  const cps = [80, 72, 72, 72, 72, 72, 72]
  const len = cps.reduce((a, c) => a + c + 1024, 0)
  const tS = 0.0002
  const delay = 3.3875e-6
  const cfo = -45233.6625
  const fOff = 5e6
  const x = ofdmBurst(fs, fsN, 1024, 74, cps, 29, tS + delay, cfo, fOff, Math.ceil((tS + 0.001) * fs))
  const row: TruthRow = { t_s: tS, t_end_s: tS + len / fsN, emitter_id: 'rc', waveform: 'ofdm', preset_id: 'dji-uplink-2m',
    center_Hz: 2.44e9 + fOff, bw_Hz: 2235000 }
  const r = await demodOfdm(mem(x, fs, 2.44e9), row, docs.ofdm)
  assert.equal(r.state, 'valid', JSON.stringify(r))
  if (!('kind' in r) || r.kind !== 'ofdm') throw new Error('不是 OFDM 结果')
  assert.ok(20 * Math.log10(r.evm_rms) < -40, `EVM ${20 * Math.log10(r.evm_rms)} dB`)
  assert.ok(Math.abs(r.cfo_Hz - cfo) < 1, `频偏 ${r.cfo_Hz}`)
  assert.ok(Math.abs(r.delay_s - delay) < 0.05e-6, `时延 ${r.delay_s}`)
  assert.equal(r.q, -3)
  assert.equal(r.points.re.length, 6 * 148)
})

test('GFSK：合成 2-FSK 包（无噪），前导与同步字 64/64、频偏与载频偏差', async () => {
  const docs = await loadPresetDocs(ROOT)
  const fs = 8e6
  const R = 128143.310546875
  const fdev = 38085.9375
  const cfo = 12000
  const bits: number[] = []
  for (let k = 0; k < 32; k++) bits.push(k % 2 === 0 ? 1 : -1)
  for (let k = 31; k >= 0; k--) bits.push((0xD391D391 >>> k) & 1 ? 1 : -1)
  let s = 7
  while (bits.length < 184) { s = (s * 69069 + 1) % 4294967296; bits.push(s & 0x10000 ? 1 : -1) }
  const tS = 0.0003
  const delay = 2e-6
  const n = Math.ceil((tS + 184 / R + 0.0002) * fs)
  const x = cx(n)
  let ph = 0
  for (let m = 0; m < n; m++) {
    const t = m / fs - tS - delay
    const k = Math.floor(t * R)
    const f = k >= 0 && k < bits.length ? bits[k] * fdev + cfo : 0
    if (k >= 0 && k < bits.length) {
      x.re[m] = Math.cos(ph)
      x.im[m] = Math.sin(ph)
    }
    ph += (2 * Math.PI * f) / fs
  }
  const row: TruthRow = { t_s: tS, t_end_s: tS + 184 / R, emitter_id: 'rc', waveform: 'gfsk', preset_id: 'futaba-sfhss',
    center_Hz: 2.44e9, bw_Hz: 204315.185546875 }
  const r = await demodGfsk(mem(x, fs, 2.44e9), row, docs.gfsk)
  assert.equal(r.state, 'valid', JSON.stringify({ ...r, deviations: undefined, trace: undefined }))
  if (!('kind' in r) || r.kind !== 'gfsk') throw new Error('不是 GFSK 结果')
  assert.equal(r.header_match, 64)
  assert.ok(Math.abs(r.cfo_Hz - cfo) < 300, `载频偏差 ${r.cfo_Hz}`)
  assert.ok(Math.abs(r.deviation_Hz - fdev) / fdev < 0.05, `频偏 ${r.deviation_Hz}`)
})

test('重叠：同一站、时间与频段都相交才算', () => {
  const a: TruthRow = { t_s: 0, t_end_s: 0.001, emitter_id: 'a', center_Hz: 2.46e9, bw_Hz: 18e6, site_id: 's' }
  const rows: TruthRow[] = [a,
    { t_s: 0.0005, t_end_s: 0.0006, emitter_id: 'b', center_Hz: 2.465e9, bw_Hz: 2e6, site_id: 's' },
    { t_s: 0.0005, t_end_s: 0.0006, emitter_id: 'c', center_Hz: 2.40e9, bw_Hz: 2e6, site_id: 's' },
    { t_s: 0.0050, t_end_s: 0.0060, emitter_id: 'd', center_Hz: 2.46e9, bw_Hz: 2e6, site_id: 's' },
    { t_s: 0.0005, t_end_s: 0.0006, emitter_id: 'e', center_Hz: 2.46e9, bw_Hz: 2e6, site_id: 't' }]
  assert.deepEqual(overlaps(a, rows), ['b'])
})

test('帧：帧头补齐到 4 字节、数据段按 sections 依次排', () => {
  const buf = encodeFrame({ schema: 'cuav-demod/1', sections: [{ name: 'points', count: 2, stride: 2 }], note: '中' },
    [Float32Array.from([1, 2, 3, 4])])
  const hl = buf.readUInt32LE(0)
  assert.equal(hl % 4, 0)
  const head = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8')) as { note: string }
  assert.equal(head.note, '中')
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset + 4 + hl, buf.byteOffset + buf.length))
  assert.deepEqual(Array.from(data), [1, 2, 3, 4])
})
