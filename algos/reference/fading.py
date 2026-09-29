"""小尺度衰落生成核的独立参考实现（Q-4，D-091）。

与引擎 engine/src/fading.cpp 逐式对应（改这里必须同时改那里）：
  · 每个散射抽头 l 一组 N = 16 个正弦：g_l(Φ) = N^{-1/2}·Σ_n exp(j·(Φ·cos α_{l,n} + φ_{l,n}))，
    α_{l,n} = 2π·(n + θ_l)/N；Φ 是多普勒相位积分 2π·∫f_D dt。
  · 固定 8 个抽头：τ_l = l·τ0/2、p_l ∝ exp(−τ_l/τ0)、Σ p_l = 1；参数给的是离散时延谱的均方根时延扩展，
    τ0 = S / rms_ratio()；按 floor(τ·fs + 0.5) 取整到样点、同样点合并。
  · 随机量按抽头 0…7 各取 θ_l 与 16 个 φ（均匀），最后取视距相位 θ0。
随机数用 gen_engine_golden.py 里那份 Xoshiro256pp 复刻。

--selftest 做与实现无关的统计核对（系综 = 对不同种子取平均）：
  1. E|g|² = 1；
  2. 系综自相关 E[g(Φ+Δ)·g*(Φ)] = J0(Δ)——对 θ 均匀取平均时 α 在 [0, 2π) 上恰好均匀，这是**精确**等式，
     不是 N → ∞ 的近似；
  3. 8 个抽头合并成平坦时（128 个正弦）包络对瑞利分布的 KS 距离；单个抽头（16 个正弦）的有限 N 偏差照实打印；
  4. 莱斯 K 的矩法估计 K̂ = sqrt(1−γ)/(1 − sqrt(1−γ))，γ = Var|h|²/E²|h|²，对设定值。

    uv run --quiet --with numpy python algos/reference/fading.py --selftest
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
TAPS = 8
SINUSOIDS = 16
TWO_PI = 6.283185307179586476925286766559


def _xoshiro():
    sys.path.insert(0, _HERE)
    from gen_engine_golden import Xoshiro256pp  # noqa: E402  唯一一份复刻
    return Xoshiro256pp


class Draws:
    def __init__(self, rng):
        self.theta = []
        self.phi = []
        self.cos_alpha = []
        for _ in range(TAPS):
            th = rng.uniform()
            ph = [TWO_PI * rng.uniform() for _ in range(SINUSOIDS)]
            self.theta.append(th)
            self.phi.append(ph)
            self.cos_alpha.append([math.cos(TWO_PI * (n + th) / SINUSOIDS) for n in range(SINUSOIDS)])
        self.los_phase = TWO_PI * rng.uniform()


def diffuse(d: Draws, l: int, Phi: float) -> complex:
    re = 0.0
    im = 0.0
    for n in range(SINUSOIDS):
        a = Phi * d.cos_alpha[l][n] + d.phi[l][n]
        re += math.cos(a)
        im += math.sin(a)
    s = 1.0 / math.sqrt(SINUSOIDS)
    return complex(re * s, im * s)


def tap_power(l: int) -> float:
    total = 0.0
    for k in range(TAPS):
        total += math.exp(-0.5 * k)
    return math.exp(-0.5 * l) / total


def rms_ratio() -> float:
    m = 0.0
    m2 = 0.0
    for l in range(TAPS):
        t = 0.5 * l
        p = tap_power(l)
        m += p * t
        m2 += p * t * t
    return math.sqrt(m2 - m * m)


class Layout:
    def __init__(self, delay_spread_s: float, fs: float):
        tau0 = delay_spread_s / rms_ratio()
        self.delay: list[int] = []
        self.members: list[list[int]] = []
        self.power: list[float] = []
        for l in range(TAPS):
            dl = int(math.floor(0.5 * l * tau0 * fs + 0.5))
            if dl in self.delay:
                k = self.delay.index(dl)
            else:
                self.delay.append(dl)
                self.members.append([])
                self.power.append(0.0)
                k = len(self.delay) - 1
            self.members[k].append(l)
            self.power[k] += tap_power(l)
        m = 0.0
        m2 = 0.0
        for dl, p in zip(self.delay, self.power):
            t = dl / fs
            m += p * t
            m2 += p * t * t
        self.rms_delay_spread_s = math.sqrt(max(0.0, m2 - m * m))


def diffuse_at(d: Draws, lay: Layout, Phi: float) -> list[complex]:
    out = []
    for k in range(len(lay.delay)):
        acc = 0j
        for l in lay.members[k]:
            acc += math.sqrt(tap_power(l)) * diffuse(d, l, Phi)
        out.append(acc)
    return out


# ---------------------------------------------------------------- 自检

def _j0(x: float) -> float:
    # 贝塞尔 J0 的级数（|x| ≤ 12 足够）：Σ (−x²/4)^k / (k!)²
    s, term, k = 1.0, 1.0, 0
    while True:
        k += 1
        term *= -(x * x / 4.0) / (k * k)
        s += term
        if abs(term) < 1e-17:
            return s


def _ensemble(n_seeds: int, fn):
    X = _xoshiro()
    return [fn(Draws(X(1000 + s))) for s in range(n_seeds)]


def selftest() -> int:
    ok = True
    ns = 4000
    flat = Layout(0.0, 1e6)
    assert flat.delay == [0] and abs(sum(flat.power) - 1.0) < 1e-15

    # 1 与 2：单抽头的系综功率与自相关
    deltas = [0.0, 0.5, 1.0, 2.0, 2.405, 4.0, 7.0]
    Phi0 = 12.345
    rows = _ensemble(ns, lambda d: [diffuse(d, 0, Phi0 + dd) for dd in deltas])
    g0 = np.array([r[0] for r in rows])
    p = float(np.mean(np.abs(g0) ** 2))
    sd = math.sqrt(1.0 / ns)          # |g|² 近似指数分布，方差 1
    print(f"E|g|² = {p:.4f}（期望 1，标准误 {sd:.4f}）")
    ok &= abs(p - 1.0) < 5 * sd
    for j, dd in enumerate(deltas):
        gj = np.array([r[j] for r in rows])
        r = complex(np.mean(gj * np.conj(g0)))
        want = _j0(dd)
        print(f"  自相关 Δ = {dd:5.3f}：{r.real:+.4f}{r.imag:+.4f}j，J0 = {want:+.4f}")
        ok &= abs(r - want) < 5 * sd

    # 3：包络对瑞利分布（平坦 = 128 个正弦；单抽头 16 个正弦只打印）
    def ks_rayleigh(z: np.ndarray) -> float:
        x = np.sort(np.abs(z) ** 2)
        emp = np.arange(1, x.size + 1) / x.size
        return float(np.max(np.abs(emp - (1.0 - np.exp(-x)))))
    zf = np.array(_ensemble(ns, lambda d: diffuse_at(d, flat, Phi0)[0]))
    z1 = g0
    crit = 1.63 / math.sqrt(ns)       # KS 1% 临界值
    ksf, ks1 = ks_rayleigh(zf), ks_rayleigh(z1)
    print(f"包络 KS（|h|² 对指数分布）：平坦 128 正弦 {ksf:.4f}、单抽头 16 正弦 {ks1:.4f}，1% 临界 {crit:.4f}")
    ok &= ksf < crit

    # 4：莱斯 K 的矩法估计
    for k_dB in (0.0, 6.0, 9.0, 12.0):
        K = 10 ** (k_dB / 10)

        def h(d, K=K):
            los = math.sqrt(K / (K + 1)) * complex(math.cos(d.los_phase), math.sin(d.los_phase))
            return los + math.sqrt(1 / (K + 1)) * diffuse_at(d, flat, Phi0)[0]
        hh = np.array(_ensemble(ns, h))
        pw = np.abs(hh) ** 2
        gam = float(np.var(pw) / np.mean(pw) ** 2)
        kh = math.sqrt(1 - gam) / (1 - math.sqrt(1 - gam)) if gam < 1 else 0.0
        print(f"莱斯 K 设定 {k_dB:4.1f} dB：矩法估计 {10 * math.log10(max(kh, 1e-9)):+.2f} dB，E|h|² = {np.mean(pw):.4f}")
        if k_dB > 0:
            ok &= abs(10 * math.log10(kh) - k_dB) < 1.0
    print(f"离散时延谱均方根比值 {rms_ratio():.10f}（τ0 = 1）")
    print("自检", "通过" if ok else "失败")
    return 0 if ok else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
