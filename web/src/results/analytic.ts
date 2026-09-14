// EM-S-02 的解析检出率（D-026 显式选定的两式）在浏览器侧的复刻（C-9）。
//
// 用途只有一个：评价页签在 `?dev=1` 下把解析 ROC 曲线族叠在实测 ROC 上。
// **这是第二份实现**，真理源是 `algos/reference/energy_detector.py`（行 77 的 regularized_gamma_q、
// 行 312 / 319 的两式），本文件必须与它逐值对拍 rel ≤ 1e-9（铁律 10）——基准 tests/golden/analytic-pd.json，
// 对拍在 analytic.test.ts。改这里等于改基准，要重生成并解释。
//
// 记检测频段内 M 个频点、归一化门限 η（Λ 的门限，H0 下 E[Λ] = 1）、s = 带内信噪比的线性值：
//   Pfa(η)        = Q(M, M·η)
//   Pd 随机型     = Q(M, M·η / (1 + s))            带限噪声（图传一类），每个频点功率按 (1+s) 等比放大
//   Pd 确定型     = Σ_k Poisson(k; M·s)·Q(M+k, M·η) 单音，非中心卡方的泊松混合
// 两式在 s → 0 时都退化为 Pfa。

/** 正则化上不完全伽马函数 Q(a, x) = Γ(a, x) / Γ(a)。级数与连分式按 x < a+1 切换（Numerical Recipes）。 */
export function regularizedGammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) throw new RangeError(`参数越界：a=${a}, x=${x}`)
  if (x === 0) return 1
  if (x < a + 1) {
    // 级数展开算 P(a,x)，再取 1 − P
    let ap = a
    let total = 1 / a
    let term = total
    for (let i = 0; i < 10000; i++) {
      ap += 1
      term *= x / ap
      total += term
      if (Math.abs(term) < Math.abs(total) * 1e-16) break
    }
    return 1 - total * Math.exp(-x + a * Math.log(x) - lgamma(a))
  }
  // 连分式算 Q(a,x)
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-16) break
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h
}

// Lanczos g=7、n=9 的 lgamma（JS 没有 Math.lgamma）。Python 的 math.lgamma 是 C 库实现，
// 两者在 a ≥ 1 的整数与半整数上相对误差在 1e-15 量级，经 exp 放大后仍远优于 1e-9 的判据；
// 黄金基准把 a 取到 2000 正是为了钉住这一点。
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]

function lgamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z)
  const zz = z - 1
  let x = LANCZOS[0]
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (zz + i)
  const t = zz + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x)
}

/** 解 Q(M, M·η) = pfa，返回归一化门限 η。二分，与 Python 参考同样的 200 次迭代。 */
export function thresholdForPfa(mBins: number, pfa: number): number {
  if (!(pfa > 0 && pfa < 1)) throw new RangeError(`目标虚警率必须在 (0,1)，收到 ${pfa}`)
  let lo = 1e-6
  let hi = 1
  while (regularizedGammaQ(mBins, mBins * hi) > pfa) {
    hi *= 2
    if (hi > 1e6) throw new Error('门限求解发散')
  }
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi)
    if (regularizedGammaQ(mBins, mBins * mid) > pfa) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/** 虚警率 Pfa(η) = Q(M, M·η)。 */
export function pfaOf(mBins: number, eta: number): number {
  return regularizedGammaQ(mBins, mBins * eta)
}

/** 随机型（带限噪声）目标的检出概率。snrLinear 是带内信噪比的线性值。 */
export function pdRandom(mBins: number, eta: number, snrLinear: number): number {
  if (snrLinear < 0) throw new RangeError('信噪比线性值不能为负')
  return regularizedGammaQ(mBins, (mBins * eta) / (1 + snrLinear))
}

/**
 * 确定型（单音）目标的检出概率，广义 Marcum Q 的泊松混合级数。
 *
 * 项数随 M·s 涨：M = 921、s = +6 dB 时约 4400 项、每项一次 Q，画一条曲线就是亿级运算量，
 * **所以曲线族用随机型式**（pdRandom），本式只在 M·s 小的地方用（跨层算例 ① 的口径对照）。
 */
export function pdDeterministic(mBins: number, eta: number, snrLinear: number, terms?: number): number {
  if (snrLinear < 0) throw new RangeError('信噪比线性值不能为负')
  const lam = mBins * snrLinear
  if (lam === 0) return regularizedGammaQ(mBins, mBins * eta)
  const n = terms ?? Math.trunc(lam + 12 * Math.sqrt(lam) + 40)
  let total = 0
  const logLam = Math.log(lam)
  for (let k = 0; k < n; k++) {
    const logW = -lam + k * logLam - lgamma(k + 1)
    if (logW < -50 && k > lam) break
    total += Math.exp(logW) * regularizedGammaQ(mBins + k, mBins * eta)
  }
  return Math.min(total, 1)
}

export function snrDbToLinear(snrDb: number): number {
  return 10 ** (snrDb / 10)
}

/** 解析 ROC 曲线族的一条：给定 M 与带内信噪比，按门限扫描出 (pfa, pd) 点列（pfa 降序）。 */
export interface AnalyticRocCurve {
  snr_dB: number
  points: Array<{ pfa: number; pd: number }>
}

/**
 * 画曲线族：门限 η 从 `pfa = 1 − 1e-6` 对应处扫到 `pfa = 1e-6` 对应处，按 pfa 的对数等分取点，
 * 这样曲线在左下角（小 pfa）不会被拉成一条贴轴的直线。每点只一次 Q。
 */
export function analyticRocFamily(mBins: number, snrsDb: readonly number[], points = 64): AnalyticRocCurve[] {
  if (!(mBins >= 1) || !Number.isFinite(mBins)) return []
  const etas: number[] = []
  for (let i = 0; i < points; i++) {
    // pfa 从 1−1e-3 到 1e-6 对数等分，反解门限
    const u = i / (points - 1)
    const pfa = Math.exp(Math.log(1 - 1e-3) * (1 - u) + Math.log(1e-6) * u)
    etas.push(thresholdForPfa(mBins, pfa))
  }
  return snrsDb.map((snr_dB) => {
    const s = snrDbToLinear(snr_dB)
    return { snr_dB, points: etas.map((eta) => ({ pfa: pfaOf(mBins, eta), pd: pdRandom(mBins, eta, s) })) }
  })
}

/**
 * 曲线族的信噪比档（dB），**随 M 走**。
 *
 * 不能用一组固定的档：H0 下 Λ 的均值是 1、标准差是 1/√M，H1 下均值是 1+s，所以「能不能检出」看的是
 * s·√M 而不是 s 本身。M = 921 时 −12…+6 dB 这一族全部贴在 Pd = 1 上，一条也读不出来（实测踩到）。
 * 取检测边沿 s ≈ 1/√M 即 **−5·log10(M)** 作中心，取 +(−2…8) dB 每 2 dB 一条——这个偏移是量出来的：
 * 在 pfa = 1e-3 上，M = 5 / 32 / 921 / 2000 四档的 Pd 都从 0.01 上下起、到 0.7 以上，转换区正好铺满图
 * （中心那一档的 Pd 只有 0.017，所以族不能以中心对称）。这是检测器自己的尺度，不是照着实测曲线凑出来的。
 */
export function familySnrsDb(mBins: number): number[] {
  const center = Math.round(-5 * Math.log10(mBins))
  return [-2, 0, 2, 4, 6, 8].map((d) => center + d)
}
