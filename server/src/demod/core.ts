// 按突发解调（D-107）：OFDM 族出均衡后的星座点，GFSK 族出符号中心频偏。
// 与 Python 参考 algos/reference/demod.py 同序同式（那边的头注写了七步做法与缘由），改动顺序：Python → 这里 → 对拍。
//
// 接收机的做法：不用发射载荷、不用真值的时延与载频偏差。真值行只给粗窗（t_s / t_end_s）、名义中心频率与预设。

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { cx, designLowpass, fft, mix, ratio, resample, type Cx } from './dsp.js'

export const ALGO_VERSION = 'demod-v1'
const PRE_S = 4e-6
const POST_S = 60e-6
const RHO = 0.9
const FINE_WIN = 12
const MIN_ZC_SHIFT = 41
const CFO_PPM = 30e-6
const SYNC_RATIO = 2.0
const GFSK_SPS = 8
const GFSK_PASS_HZ = 200e3
const GFSK_HEADER_MIN = 56
const TRACE_MAX = 2000

export type Json = Record<string, unknown>
export type State = 'valid' | 'degraded' | 'invalid' | 'not_applicable'

export interface TruthRow {
  t_s: number; t_end_s: number; emitter_id: string; label?: string; waveform?: string; preset_id?: string
  center_Hz: number; bw_Hz: number; site_id?: string; cfo_Hz?: number
}

/** 读样点的接口：绝对样点 [mLo, mHi)；超出文件返回 null */
export interface IqSource {
  fs: number
  fc: number
  read(mLo: number, mHi: number): Promise<Cx | null>
}

export interface OfdmResult {
  state: State; reasons: string[]; kind: 'ofdm'; preset_id: string; constellation: string
  variant: number; n_symbols: number; n_subcarriers: number; points: Cx
  evm_rms: number; mer_dB: number; cfo_Hz: number; delay_s: number
  q: number; eps_Hz: number; timing: number; sync_ratio: number; ideal: Array<[number, number]>
}

export interface GfskResult {
  state: State; reasons: string[]; kind: 'gfsk'; preset_id: string; modulation: string; bt: number | null
  symbol_rate_Hz: number; deviation_nominal_Hz: number; deviation_Hz: number; n_symbols: number
  deviations: Float64Array; trace: Float64Array; cfo_Hz: number; delay_s: number; header_match: number; fs_d: number
}

export interface Failed { state: State; reasons: string[]; sync_ratio?: number }
export type DemodResult = OfdmResult | GfskResult | Failed

// ---------------------------------------------------------------- 预设（与 ofdm_ref.Preset 同义）

interface OfdmPreset {
  id: string; constellation: string; fft: number; fs: number; K: number; bits: number
  bursts: Array<{ cp: number[]; zc: number[]; length: number }>; levels: number[]
}

export interface PresetDocs { ofdm: Json; gfsk: Json }

export async function loadPresetDocs(root: string): Promise<PresetDocs> {
  const r = join(root, 'models', 'radiator')
  return {
    ofdm: JSON.parse(await fsp.readFile(join(r, 'presets-v2.json'), 'utf8')) as Json,
    gfsk: JSON.parse(await fsp.readFile(join(r, 'gfsk-presets-v1.json'), 'utf8')) as Json,
  }
}

const BITS: Record<string, number> = { qpsk: 1, '16qam': 2, '64qam': 3 }

function ofdmPreset(doc: Json, pid: string): OfdmPreset {
  const p = (doc.presets as Json[]).find((x) => x.id === pid)
  if (!p) throw new Error(`预设表里没有 ${pid}`)
  const num = (doc.numerologies as Json[]).find((n) => n.id === p.numerology)!
  const fftN = Number(num.fft_size)
  const bursts = (p.bursts as Json[]).map((b) => {
    const cs = Number(b.cp_short ?? num.cp_short)
    const cl = Number(b.cp_long ?? num.cp_long)
    const longAt = new Set((b.cp_long_at as number[]).map(Number))
    const n = Number(b.n_symbols)
    const cp = Array.from({ length: n }, (_, i) => (longAt.has(i) ? cl : cs))
    const zc = new Array<number>(n).fill(0)
    for (const [idx, root] of b.zc as number[][]) zc[idx] = root
    return { cp, zc, length: cp.reduce((a, c) => a + fftN + c, 0) }
  })
  const bits = BITS[String(p.constellation)]
  const L = 1 << bits
  const norm = Math.sqrt((2.0 * (L * L - 1.0)) / 3.0)
  const levels = Array.from({ length: L }, (_, i) => (2.0 * i - (L - 1)) / norm)
  return {
    id: pid, constellation: String(p.constellation), fft: fftN, fs: Number(num.fs_native_Hz),
    K: Number(p.half_subcarriers), bits, bursts, levels,
  }
}

function kOf(K: number, i: number): number {
  return i < K ? i - K : i - K + 1
}

function zcValue(root: number, nzc: number, n: number): [number, number] {
  const m = (root * ((n * (n + 1)) % (2 * nzc))) % (2 * nzc)
  const ang = (-Math.PI * m) / nzc
  return [Math.cos(ang), Math.sin(ang)]
}

function zcCarriers(K: number, root: number): Cx {
  const nzc = 2 * K + 1
  const out = cx(2 * K)
  let i = 0
  for (let n = 0; n < nzc; n++) {
    if (n === K) continue
    const [a, b] = zcValue(root, nzc, n)
    out.re[i] = a
    out.im[i] = b
    i++
  }
  return out
}

function zcShift(root: number, K: number, N: number): number {
  const s = ((root * N) / (2 * K + 1)) % N
  return s > N / 2 ? s - N : s
}

function sliceLevel(v: number, lv: number[]): number {
  let best = lv[0]
  let bd = Math.abs(v - lv[0])
  for (let i = 1; i < lv.length; i++) {
    const d = Math.abs(v - lv[i])
    if (d < bd) {
      bd = d
      best = lv[i]
    }
  }
  return best
}

/** 从 r[w − jLo] 起 N 个样点做 FFT，返回整段谱（长 N） */
function fftAt(r: Cx, off: number, N: number): Cx {
  const y = cx(N)
  y.re.set(r.re.subarray(off, off + N))
  y.im.set(r.im.subarray(off, off + N))
  fft(y.re, y.im)
  return y
}

function rotateAbs(r: Cx, jLo: number, perSample: number): Cx {
  const out = cx(r.re.length)
  for (let i = 0; i < r.re.length; i++) {
    let ph = (jLo + i) * perSample
    ph -= Math.floor(ph)
    const c = Math.cos(2 * Math.PI * ph)
    const s = -Math.sin(2 * Math.PI * ph)
    out.re[i] = r.re[i] * c - r.im[i] * s
    out.im[i] = r.re[i] * s + r.im[i] * c
  }
  return out
}

// ---------------------------------------------------------------- OFDM

export async function demodOfdm(iq: IqSource, row: TruthRow, doc: Json): Promise<DemodResult> {
  const p = ofdmPreset(doc, String(row.preset_id))
  const fs = iq.fs
  const fsN = p.fs
  const N = p.fft
  const K = p.K
  const df = fsN / N
  const n0 = Math.round(row.t_s * fsN)
  const nLen = Math.round((row.t_end_s - row.t_s) * fsN)
  const v = p.bursts.findIndex((b) => b.length === nLen)
  if (v < 0) return { state: 'invalid', reasons: [`突发长度 ${nLen} 个原生样点不是预设的任一变体`] }
  const cps = p.bursts[v].cp
  const zcs: Array<[number, number]> = []
  p.bursts[v].zc.forEach((r, s) => { if (r) zcs.push([s, r]) })
  const offs = [0]
  for (const c of cps) offs.push(offs[offs.length - 1] + c + N)
  const b = Math.floor(Math.min(...cps) / 4)
  const [U, D] = ratio(fsN, fs)
  const { h, T } = designLowpass(fs, U, 0.5 * row.bw_Hz + 0.5e6, 0.5 * row.bw_Hz + 1.5e6)
  const c = U * T
  const thLo = n0 - Math.ceil(PRE_S * fsN)
  const thHi = n0 + Math.ceil(POST_S * fsN)
  const jLo = thLo - b - FINE_WIN - 4
  const jHi = thHi + nLen + FINE_WIN + 4
  const mLo = Math.floor((jLo * D - c) / U)
  const mHi = Math.floor(((jHi - 1) * D + c) / U) + 1
  const x = await iq.read(mLo, mHi)
  if (x === null) return { state: 'invalid', reasons: ['取段超出文件'] }
  mix(x, mLo, (row.center_Hz - iq.fc) / fs)
  const r = resample(x, mLo, U, D, h, T, jLo, jHi)
  const nr = r.re.length

  // ② CP 相关定时与小数倍频偏（累加和，与 numpy 的 cumsum 同序）
  const Pr = new Float64Array(nr - N + 1)
  const Pi = new Float64Array(nr - N + 1)
  const E = new Float64Array(nr - N + 1)
  for (let n = 0; n < nr - N; n++) {
    const ar = r.re[n], ai = r.im[n], br = r.re[n + N], bi = -r.im[n + N]
    Pr[n + 1] = Pr[n] + (ar * br - ai * bi)
    Pi[n + 1] = Pi[n] + (ar * bi + ai * br)
    E[n + 1] = E[n] + 0.5 * ((ar * ar + ai * ai) + (r.re[n + N] * r.re[n + N] + r.im[n + N] * r.im[n + N]))
  }
  let best = -Infinity
  let thBest = thLo
  let gR = 0
  let gI = 0
  for (let th = thLo; th <= thHi; th++) {
    const i = th - jLo
    let a = 0, bb = 0, e = 0
    for (let s = 0; s < cps.length; s++) {
      a += Pr[i + offs[s] + cps[s]] - Pr[i + offs[s]]
      bb += Pi[i + offs[s] + cps[s]] - Pi[i + offs[s]]
      e += E[i + offs[s] + cps[s]] - E[i + offs[s]]
    }
    const lam = Math.hypot(a, bb) - RHO * e
    if (lam > best) {
      best = lam
      thBest = th
      gR = a
      gI = bb
    }
  }
  const eps = (-Math.atan2(gI, gR) * fsN) / (2.0 * Math.PI * N)
  const r1 = rotateAbs(r, jLo, eps / fsN)

  // ③ ZC 上联合搜 q 与精定时
  const Zs = new Map<number, Cx>()
  for (const [, rt] of zcs) if (!Zs.has(rt)) Zs.set(rt, zcCarriers(K, rt))
  const Yz = new Map<number, Cx>()
  for (const [s] of zcs) Yz.set(s, fftAt(r1, thBest + offs[s] + cps[s] - b - jLo, N))
  const judge = zcs.filter(([, rt]) => Math.abs(zcShift(rt, K, N)) >= MIN_ZC_SHIFT)
  const Q = Math.ceil((CFO_PPM * row.center_Hz) / df)
  const ks = Array.from({ length: 2 * K }, (_, i) => kOf(K, i))
  const mod = (a: number) => ((a % N) + N) % N
  const perQ: Array<[number, number, number]> = []
  for (let q = -Q; q <= Q; q++) {
    const acc = new Float64Array(2 * FINE_WIN + 1)
    for (const [s, rt] of judge) {
      const Y = Yz.get(s)!
      const Z = Zs.get(rt)!
      const V = cx(N)
      for (let i = 0; i < 2 * K; i++) {
        const kk = mod(ks[i])
        const yy = mod(ks[i] + q)
        const zr = Z.re[i], zi = -Z.im[i]
        V.re[kk] = Y.re[yy] * zr - Y.im[yy] * zi
        V.im[kk] = Y.re[yy] * zi + Y.im[yy] * zr
      }
      fft(V.re, V.im, true)
      for (let t = 0; t < 2 * FINE_WIN + 1; t++) {
        const n = mod(b - FINE_WIN + t)
        acc[t] += Math.hypot(V.re[n], V.im[n])
      }
    }
    let at = 0
    for (let t = 1; t < acc.length; t++) if (acc[t] > acc[at]) at = t
    perQ.push([acc[at], q, b - FINE_WIN + at])
  }
  perQ.sort((u, w) => w[0] - u[0])
  const [pk, qBest, nBest] = perQ[0]
  const syncRatio = perQ.length > 1 && perQ[1][0] > 0 ? pk / perQ[1][0] : Infinity
  if (syncRatio < SYNC_RATIO) {
    return { state: 'invalid', reasons: [`同步失败：ZC 相关峰比 ${syncRatio.toFixed(2)}（线 ${SYNC_RATIO}）`], sync_ratio: syncRatio }
  }
  const thF = thBest + (nBest - b)
  let cfo = qBest * df + eps
  const r2 = rotateAbs(r1, jLo, qBest / N)

  // ④ 逐符号 FFT 与信道估计
  const Ys: Cx[] = []
  for (let s = 0; s < cps.length; s++) {
    const Y = fftAt(r2, thF + offs[s] + cps[s] - b - jLo, N)
    const o = cx(2 * K)
    for (let i = 0; i < 2 * K; i++) {
      o.re[i] = Y.re[mod(ks[i])]
      o.im[i] = Y.im[mod(ks[i])]
    }
    Ys.push(o)
  }
  const H = cx(2 * K)
  for (const [s, rt] of zcs) {
    const Y = Ys[s]
    const Z = Zs.get(rt)!
    for (let i = 0; i < 2 * K; i++) {
      const den = Z.re[i] * Z.re[i] + Z.im[i] * Z.im[i]
      H.re[i] += (Y.re[i] * Z.re[i] + Y.im[i] * Z.im[i]) / den
      H.im[i] += (Y.im[i] * Z.re[i] - Y.re[i] * Z.im[i]) / den
    }
  }
  for (let i = 0; i < 2 * K; i++) {
    H.re[i] /= zcs.length
    H.im[i] /= zcs.length
  }
  let sr = 0
  let si = 0
  for (let i = 0; i < 2 * K - 1; i++) {
    if (ks[i + 1] - ks[i] !== 1) continue
    sr += H.re[i + 1] * H.re[i] + H.im[i + 1] * H.im[i]
    si += H.im[i + 1] * H.re[i] - H.re[i + 1] * H.im[i]
  }
  const b2 = (-Math.atan2(si, sr) * N) / (2.0 * Math.PI)
  const sRef = zcs[0][0]
  const uRef = thF + offs[sRef] + cps[sRef] - b + b2
  const delay = (uRef - (n0 + offs[sRef] + cps[sRef])) / fsN

  // ⑤ 均衡与逐符号相位跟踪
  const lv = p.levels
  const data: number[] = []
  for (let s = 0; s < cps.length; s++) if (!p.bursts[v].zc[s]) data.push(s)
  const pts = cx(data.length * 2 * K)
  const phis: number[] = []
  const tts: number[] = []
  let err = 0
  let ref = 0
  const Xr = cx(2 * K)
  data.forEach((s, di) => {
    const Y = Ys[s]
    const tS = thF + offs[s] + cps[s] + N / 2.0
    let pred = 0.0
    if (phis.length >= 2) {
      const k = phis.length
      pred = phis[k - 1] + ((phis[k - 1] - phis[k - 2]) / (tts[k - 1] - tts[k - 2])) * (tS - tts[k - 1])
    } else if (phis.length === 1) pred = phis[0]
    const cr = Math.cos(-pred)
    const ci = Math.sin(-pred)
    for (let i = 0; i < 2 * K; i++) {
      const den = H.re[i] * H.re[i] + H.im[i] * H.im[i]
      const xr = (Y.re[i] * H.re[i] + Y.im[i] * H.im[i]) / den
      const xi = (Y.im[i] * H.re[i] - Y.re[i] * H.im[i]) / den
      Xr.re[i] = xr * cr - xi * ci
      Xr.im[i] = xr * ci + xi * cr
    }
    let gr = 1
    let gi = 0
    for (let it = 0; it < 2; it++) {
      const gd = gr * gr + gi * gi
      let nr2 = 0, ni2 = 0, dd = 0
      for (let i = 0; i < 2 * K; i++) {
        const ur = (Xr.re[i] * gr + Xr.im[i] * gi) / gd
        const ui = (Xr.im[i] * gr - Xr.re[i] * gi) / gd
        const dr = sliceLevel(ur, lv)
        const dI = sliceLevel(ui, lv)
        nr2 += Xr.re[i] * dr + Xr.im[i] * dI
        ni2 += Xr.im[i] * dr - Xr.re[i] * dI
        dd += dr * dr + dI * dI
      }
      gr = nr2 / dd
      gi = ni2 / dd
    }
    const gd = gr * gr + gi * gi
    for (let i = 0; i < 2 * K; i++) {
      const fr = (Xr.re[i] * gr + Xr.im[i] * gi) / gd
      const fi = (Xr.im[i] * gr - Xr.re[i] * gi) / gd
      const dr = sliceLevel(fr, lv)
      const dI = sliceLevel(fi, lv)
      err += (fr - dr) * (fr - dr) + (fi - dI) * (fi - dI)
      ref += dr * dr + dI * dI
      pts.re[di * 2 * K + i] = fr
      pts.im[di * 2 * K + i] = fi
    }
    phis.push(pred + Math.atan2(gi, gr))
    tts.push(tS)
  })
  const evm = Math.sqrt(err / ref)
  if (phis.length >= 2) {
    const tm = tts.reduce((a, t) => a + t, 0) / tts.length
    const pm = phis.reduce((a, f) => a + f, 0) / phis.length
    let num = 0, den = 0
    for (let i = 0; i < tts.length; i++) {
      num += (tts[i] - tm) * (phis[i] - pm)
      den += (tts[i] - tm) ** 2
    }
    cfo += ((num / den) * fsN) / (2.0 * Math.PI)
  }
  const ideal: Array<[number, number]> = []
  for (const a of lv) for (const bb of lv) ideal.push([a, bb])
  return {
    state: 'valid', reasons: [], kind: 'ofdm', preset_id: p.id, constellation: p.constellation, variant: v,
    n_symbols: data.length, n_subcarriers: 2 * K, points: pts, evm_rms: evm, mer_dB: -20.0 * Math.log10(evm),
    cfo_Hz: cfo, delay_s: delay, q: qBest, eps_Hz: eps, timing: thF, sync_ratio: syncRatio, ideal,
  }
}

// ---------------------------------------------------------------- GFSK

export async function demodGfsk(iq: IqSource, row: TruthRow, gdoc: Json): Promise<DemodResult> {
  const raw = (gdoc.presets as Json[]).find((x) => x.id === row.preset_id)
  if (!raw) return { state: 'invalid', reasons: [`预设表里没有 ${String(row.preset_id)}`] }
  const R = Number(raw.symbol_rate_Hz)
  const fdev = Number(raw.deviation_Hz)
  const nBits = Math.round((row.t_end_s - row.t_s) * R)
  const fs = iq.fs
  const D = Math.max(1, Math.floor(fs / (GFSK_SPS * R)))
  const fsD = fs / D
  const { h, T } = designLowpass(fs, 1, GFSK_PASS_HZ, fsD - GFSK_PASS_HZ)
  const c = T
  const jLo = Math.floor((row.t_s - PRE_S) * fsD) - 4
  const jHi = Math.ceil((row.t_end_s + POST_S) * fsD) + 4
  const mLo = jLo * D - c
  const mHi = (jHi - 1) * D + c + 1
  const x = await iq.read(mLo, mHi)
  if (x === null) return { state: 'invalid', reasons: ['取段超出文件'] }
  mix(x, mLo, (row.center_Hz - iq.fc) / fs)
  const y = resample(x, mLo, 1, D, h, T, jLo, jHi)
  const nf = y.re.length - 1
  const f = new Float64Array(nf)
  for (let i = 0; i < nf; i++) {
    const zr = y.re[i + 1] * y.re[i] + y.im[i + 1] * y.im[i]
    const zi = y.im[i + 1] * y.re[i] - y.re[i + 1] * y.im[i]
    f[i] = (Math.atan2(zi, zr) * fsD) / (2.0 * Math.PI)
  }
  const tF0 = (jLo + 0.5) / fsD
  const at = (t: number): number => {
    const u = (t - tF0) * fsD
    const i = Math.min(Math.max(Math.floor(u), 0), nf - 2)
    const a = u - i
    return f[i] * (1.0 - a) + f[i + 1] * a
  }
  const head: number[] = []
  for (let k = 0; k < 32; k++) head.push(k % 2 === 0 ? 1 : -1)
  for (let k = 31; k >= 0; k--) head.push((0xD391D391 >>> k) & 1 ? 1 : -1)
  const step = 1.0 / (8.0 * fsD)
  const nStep = Math.ceil((PRE_S + POST_S) / step)
  const cs = new Float64Array(nStep + 1)
  for (let i = 0; i <= nStep; i++) {
    const tau = row.t_s - PRE_S + i * step
    let s = 0
    for (let k = 0; k < 64; k++) s += head[k] * at(tau + (k + 0.5) / R)
    cs[i] = s
  }
  let iPk = 0
  for (let i = 1; i <= nStep; i++) if (cs[i] > cs[iPk]) iPk = i
  const thr = cs[iPk] - 0.02 * Math.abs(cs[iPk])
  let iA = iPk
  while (iA > 0 && cs[iA - 1] >= thr) iA--
  let iB = iPk
  while (iB < nStep && cs[iB + 1] >= thr) iB++
  const tau = row.t_s - PRE_S + 0.5 * (iA + iB) * step
  const fc = new Float64Array(nBits)
  for (let k = 0; k < nBits; k++) fc[k] = at(tau + (k + 0.5) / R)
  let cfo0 = 0
  for (let k = 0; k < 32; k++) cfo0 += fc[k]
  cfo0 /= 32
  let sp = 0, np_ = 0, sn = 0, nn = 0
  for (let k = 0; k < nBits; k++) {
    if (fc[k] > cfo0) { sp += fc[k]; np_++ } else { sn += fc[k]; nn++ }
  }
  const cfo = np_ && nn ? 0.5 * (sp / np_ + sn / nn) : cfo0
  const dev = new Float64Array(nBits)
  let absSum = 0
  for (let k = 0; k < nBits; k++) {
    dev[k] = fc[k] - cfo
    absSum += Math.abs(dev[k])
  }
  let match = 0
  for (let k = 0; k < 64; k++) if ((dev[k] > 0 ? 1 : -1) === head[k]) match++
  const i0 = Math.max(Math.floor((tau - 2.0 / R - tF0) * fsD), 0)
  const i1 = Math.min(Math.ceil((tau + (nBits + 2.0) / R - tF0) * fsD), nf)
  const stride = Math.max(1, Math.ceil((i1 - i0) / TRACE_MAX))
  const tr: number[] = []
  for (let i = i0; i < i1; i += stride) tr.push(tF0 + i / fsD - tau, f[i] - cfo)
  const state: State = match >= GFSK_HEADER_MIN ? 'valid' : 'invalid'
  return {
    state, reasons: state === 'valid' ? [] : [`前导与同步字只对上 ${match}/64`], kind: 'gfsk',
    preset_id: String(raw.id), modulation: String(raw.modulation), bt: raw.bt === null || raw.bt === undefined ? null : Number(raw.bt),
    symbol_rate_Hz: R, deviation_nominal_Hz: fdev, deviation_Hz: absSum / nBits, n_symbols: nBits, deviations: dev,
    trace: Float64Array.from(tr), cfo_Hz: cfo, delay_s: tau - row.t_s, header_match: match, fs_d: fsD,
  }
}

// ---------------------------------------------------------------- 分派、读样点、重叠

export function demodulable(w: string | undefined): boolean {
  return w === 'ofdm' || w === 'droneid' || w === 'gfsk'
}

export async function demod(iq: IqSource, row: TruthRow, docs: PresetDocs): Promise<DemodResult> {
  if (row.waveform === 'ofdm' || row.waveform === 'droneid') return demodOfdm(iq, row, docs.ofdm)
  if (row.waveform === 'gfsk') return demodGfsk(iq, row, docs.gfsk)
  return { state: 'not_applicable', reasons: [`波形 ${String(row.waveform)} 无星座`] }
}

/** 运行目录里某个观测点的 iq.cf32（只读，按需读一段） */
export async function openIq(opDir: string): Promise<IqSource & { start: number; samples: number; t0: number }> {
  const idx = JSON.parse(await fsp.readFile(join(opDir, 'iq.index.json'), 'utf8')) as Json
  const n = Number(idx.samples)
  const path = join(opDir, 'iq.cf32')
  const size = (await fsp.stat(path)).size
  if (size !== 8 * n) throw new Error(`iq.cf32 长度 ${size} 字节与索引 ${n} 个样点对不上`)
  const start = Math.trunc(Number(idx.start_sample))
  const fs = Number(idx.sample_rate_Hz)
  return {
    fs, fc: Number(idx.center_Hz), start, samples: n, t0: Number(idx.t0_s ?? start / fs),
    async read(mLo: number, mHi: number): Promise<Cx | null> {
      const a = mLo - start
      const b = mHi - start
      if (a < 0 || b > n) return null
      const f32 = new Float32Array(2 * (b - a))
      const fh = await fsp.open(path, 'r')
      try {
        const buf = Buffer.from(f32.buffer)
        let got = 0
        while (got < buf.length) {
          const { bytesRead } = await fh.read(buf, got, buf.length - got, 8 * a + got)
          if (bytesRead === 0) throw new Error('iq.cf32 读到文件尾')
          got += bytesRead
        }
      } finally {
        await fh.close()
      }
      const out = cx(b - a)
      for (let i = 0; i < b - a; i++) {
        out.re[i] = f32[2 * i]
        out.im[i] = f32[2 * i + 1]
      }
      return out
    },
  }
}

/** 同一站、时间与频段都相交的其他辐射源（与 Python overlaps 同式） */
export function overlaps(row: TruthRow, rows: TruthRow[], marginS = 1e-4, marginHz = 1e5): string[] {
  const lo = row.center_Hz - row.bw_Hz / 2 - marginHz
  const hi = row.center_Hz + row.bw_Hz / 2 + marginHz
  const out = new Set<string>()
  for (const r of rows) {
    if (r.emitter_id === row.emitter_id || r.site_id !== row.site_id) continue
    if (r.t_s > row.t_end_s + marginS || r.t_end_s + marginS < row.t_s) continue
    if (r.center_Hz + r.bw_Hz / 2 < lo || r.center_Hz - r.bw_Hz / 2 > hi) continue
    out.add(r.emitter_id)
  }
  return [...out].sort()
}
