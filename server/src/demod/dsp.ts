// 解调用的信号处理件（D-107）：基 2 FFT、Kaiser 窗 sinc 原型、多相有理重采样、按绝对样点号混频。
// 与 Python 参考 algos/reference/demod.py 同序同式；那边用 numpy 的 fft，这边是自写的基 2，两家对拍不是同一段代码。
// 复数一律拆成两条 Float64Array（re / im）。

export interface Cx { re: Float64Array; im: Float64Array }

export function cx(n: number): Cx {
  return { re: new Float64Array(n), im: new Float64Array(n) }
}

/** 原位基 2 FFT；inverse 时按 1/N 归一（与 numpy 的 ifft 同） */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  if (n & (n - 1)) throw new Error(`FFT 点数 ${n} 不是 2 的幂`)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  const sgn = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = (sgn * 2 * Math.PI) / len
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k)
      const wi = Math.sin(ang * k)
      for (let i = k; i < n; i += len) {
        const j = i + half
        const xr = re[j] * wr - im[j] * wi
        const xi = re[j] * wi + im[j] * wr
        re[j] = re[i] - xr
        im[j] = im[i] - xi
        re[i] += xr
        im[i] += xi
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/** 第一类零阶修正贝塞尔函数，级数求和（与 Python 同式） */
export function besselI0(x: number): number {
  let s = 1.0
  let t = 1.0
  const q = (x * x) / 4.0
  for (let k = 1; ; k++) {
    t *= q / (k * k)
    s += t
    if (t < 1e-17 * s) return s
  }
}

export function kaiserBeta(aDb: number): number {
  if (aDb > 50.0) return 0.1102 * (aDb - 8.7)
  if (aDb >= 21.0) return 0.5842 * (aDb - 21.0) ** 0.4 + 0.07886 * (aDb - 21.0)
  return 0.0
}

export const STOP_DB = 70.0

/** 多相原型：采样率 fsIn·U 上的 Kaiser 窗 sinc，长 2·U·T + 1、中心 U·T，通带增益 1（乘 U） */
export function designLowpass(fsIn: number, U: number, fPass: number, fStop: number): { h: Float64Array; T: number } {
  const nIn = (STOP_DB - 8.0) / (2.285 * 2.0 * Math.PI * (fStop - fPass) / fsIn)
  const T = Math.ceil(nIn / 2.0)
  const c = U * T
  const wc = (0.5 * (fPass + fStop)) / (fsIn * U)
  const beta = kaiserBeta(STOP_DB)
  const i0b = besselI0(beta)
  const h = new Float64Array(2 * c + 1)
  for (let i = 0; i < 2 * c + 1; i++) {
    const d = i - c
    const r = d / c
    const w = besselI0(beta * Math.sqrt(Math.max(0.0, 1.0 - r * r))) / i0b
    const a = 2.0 * wc * d
    const s = d === 0 ? 1.0 : Math.sin(Math.PI * a) / (Math.PI * a)
    h[i] = U * 2.0 * wc * s * w
  }
  return { h, T }
}

/** 输出 j ∈ [jLo, jHi)，在输入的分数下标 j·D/U 处；x 是输入样点 m0 + i，越界按 0。按 m 递增累加 */
export function resample(x: Cx, m0: number, U: number, D: number, h: Float64Array, T: number, jLo: number, jHi: number): Cx {
  const c = U * T
  const out = cx(jHi - jLo)
  const n = x.re.length
  for (let j = jLo; j < jHi; j++) {
    const p = j * D + c
    const mHi = Math.floor(p / U)
    const mLo = Math.ceil((p - 2 * c) / U)
    const a = Math.max(mLo, m0)
    const b = Math.min(mHi, m0 + n - 1)
    let ar = 0.0
    let ai = 0.0
    for (let m = a; m <= b; m++) {
      const hv = h[p - m * U]
      ar += hv * x.re[m - m0]
      ai += hv * x.im[m - m0]
    }
    out.re[j - jLo] = ar
    out.im[j - jLo] = ai
  }
  return out
}

/** 乘 e^{−j2π·φ}，φ = (m·fOverFs) 的小数部分，m 为绝对样点号 m0 + i（原位） */
export function mix(x: Cx, m0: number, fOverFs: number): void {
  const n = x.re.length
  for (let i = 0; i < n; i++) {
    let ph = (m0 + i) * fOverFs
    ph -= Math.floor(ph)
    const c = Math.cos(2 * Math.PI * ph)
    const s = -Math.sin(2 * Math.PI * ph)
    const r = x.re[i]
    const q = x.im[i]
    x.re[i] = r * c - q * s
    x.im[i] = r * s + q * c
  }
}

/** 两个采样率之比的最简分数 U/D（fsOut/fsIn） */
export function ratio(fsOut: number, fsIn: number): [number, number] {
  let a = Math.round(fsOut)
  let b = Math.round(fsIn)
  const g = gcd(a, b)
  a /= g
  b /= g
  return [a, b]
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}
