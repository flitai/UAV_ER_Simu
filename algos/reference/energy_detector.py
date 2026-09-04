"""能量检测器的参考实现（评价基线）。

定位：`algos/` 是「算法与评价基线」。本文件是**参考实现**，用来产出基线数字与黄金向量；
P1-4 要在引擎里实现的 C++ 版本必须复现这里的结果，两者不共用代码路径（与 CLAUDE.md
「同一模型可有 M1/M2 函数式实现与 M3 分块流组件、共用参数集不共用代码」一致）。

## 检测量的定义（写死在这里，改动即为基准变化，须按铁律 10 处理）

对复基带样点 x[n]，采样率 Fs：

1. 按帧长 `nfft` 切帧，**不加窗、不重叠**。不加窗是刻意的：汉宁窗会让相邻频点相关，
   H0 假设下的卡方自由度就不再是 2M，解析虚警率随之失效。摸底工具里算功率谱用汉宁窗是
   为了看谱形，那是另一件事，两处口径不同且都写明了理由。
2. 每帧做 `nfft` 点 DFT，得 X_m[k]。
3. 在频点集合 B（|B| = M 个频点）上取能量 T[m] = Σ_{k∈B} |X_m[k]|²。
4. 归一化：Λ[m] = T[m] / (M · σ̂²)，σ̂² 是每频点的噪声功率估计。

## H0 下的分布与门限

若噪声是循环对称复高斯白噪声，矩形窗下各频点相互独立，则 T/σ² 服从自由度 2M 的卡方分布
的一半，即 Gamma(M, 1)，于是 Λ ~ Gamma(M, 1)/M，均值为 1，且

    Pfa(η) = P(Λ > η) = Q(M, M·η)

Q 是正则化上不完全伽马函数。给定目标虚警率求门限就是解上式，本文件用二分法，
`regularized_gamma_q` 自带实现，不引入 scipy——M=1、2、3 时有闭式解可对拍。

## 噪声功率估计

`estimate_noise_per_bin`：对每个频点取**帧维中位数**，再除以 ln2。理由是 M=1 时单频点功率
服从指数分布，其中位数是 σ²·ln2；中位数对突发稳健，只要突发占空比低于一半。

注意这与 WORKLOG 2026-09-03 第四条日志里那个坑不是一回事：那里是**用时间维中位数当整段底噪**
（会被近距离强信号污染 8.5 dB），这里是**逐频点取帧维中位数再作分布修正**，两者的对象和
用途都不同。

**这个估计有一个可解析的已知偏差，解读虚警率时必须算进去**：若占空比 d 的帧被突发抬高，
这些帧排到分布顶端，中位数于是落在原分布的 0.5/(1−d) 分位上。指数分布下 d = 5% 对应
1.077 倍，即噪声被**高估 0.33 dB**；d = 10% 时高估 0.68 dB。**方向是高估**，门限因此偏高、
虚警率因此偏低——所以在真实突发背景上测到的虚警率超标是**保守估计**，真实超标只会更大。
单测 `test_estimator_bias_under_bursts_matches_theory` 把这条钉住。用均值则在同样条件下
被拉高十倍以上，那才是不可用的。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

LN2 = math.log(2.0)


# ---------------------------------------------------------------- 特殊函数

def regularized_gamma_q(a: float, x: float) -> float:
    """正则化上不完全伽马函数 Q(a, x) = Γ(a, x) / Γ(a)。

    级数与连分式两条路径按 x < a+1 切换（Numerical Recipes 的经典做法）。
    a 为正整数时有闭式解，单测用它对拍。
    """
    if x < 0 or a <= 0:
        raise ValueError(f"参数越界：a={a}, x={x}")
    if x == 0:
        return 1.0
    if x < a + 1.0:
        # 级数展开算 P(a,x)，再取 1 - P
        ap = a
        total = 1.0 / a
        term = total
        for _ in range(10000):
            ap += 1.0
            term *= x / ap
            total += term
            if abs(term) < abs(total) * 1e-16:
                break
        return 1.0 - total * math.exp(-x + a * math.log(x) - math.lgamma(a))
    # 连分式算 Q(a,x)
    tiny = 1e-300
    b = x + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / b
    h = d
    for i in range(1, 10000):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-16:
            break
    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def threshold_for_pfa(m_bins: int, pfa: float) -> float:
    """解 Q(M, M·η) = Pfa，返回归一化门限 η（Λ 的门限，均值为 1 的量纲）。"""
    if not 0 < pfa < 1:
        raise ValueError(f"目标虚警率必须在 (0,1)，收到 {pfa}")
    lo, hi = 1e-6, 1.0
    while regularized_gamma_q(m_bins, m_bins * hi) > pfa:
        hi *= 2.0
        if hi > 1e6:
            raise RuntimeError("门限求解发散")
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if regularized_gamma_q(m_bins, m_bins * mid) > pfa:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------- 检测器

@dataclass
class Band:
    """检测频段，用相对中心频率的赫兹表示。"""

    lo_Hz: float
    hi_Hz: float

    def mask(self, nfft: int, fs: float) -> np.ndarray:
        fr = np.fft.fftshift(np.fft.fftfreq(nfft, 1 / fs))
        return (fr >= self.lo_Hz) & (fr < self.hi_Hz)


def frame_bin_power(x: np.ndarray, nfft: int) -> np.ndarray:
    """切帧、不加窗、不重叠，返回每帧每频点的功率，形状 (帧数, nfft)。"""
    k = x.size // nfft
    if k == 0:
        return np.zeros((0, nfft))
    X = np.fft.fftshift(np.fft.fft(x[:k * nfft].reshape(k, nfft), axis=1), axes=1)
    return (X.real.astype(np.float64) ** 2 + X.imag.astype(np.float64) ** 2)


def estimate_noise_per_bin(power: np.ndarray) -> np.ndarray:
    """逐频点取帧维中位数并按指数分布修正，返回每频点噪声功率估计。"""
    if power.shape[0] == 0:
        return np.zeros(power.shape[1])
    return np.median(power, axis=0) / LN2


def statistic(power: np.ndarray, band_mask: np.ndarray,
              noise_per_bin: np.ndarray) -> np.ndarray:
    """归一化检测量 Λ，均值在 H0 下为 1。"""
    m = int(np.count_nonzero(band_mask))
    if m == 0:
        raise ValueError("检测频段内没有频点")
    noise_band = float(np.sum(noise_per_bin[band_mask]))
    if noise_band <= 0:
        raise ValueError("噪声功率估计为零，无法归一化")
    return power[:, band_mask].sum(axis=1) / noise_band


def detect(x: np.ndarray, fs: float, band: Band, nfft: int, pfa: float
           ) -> tuple[np.ndarray, float, dict]:
    """对一段样点跑一次能量检测。

    返回 (逐帧判决布尔数组, 所用门限 η, 中间量)。噪声估计取自这段数据自身。
    """
    p = frame_bin_power(x, nfft)
    mask = band.mask(nfft, fs)
    m = int(np.count_nonzero(mask))
    noise = estimate_noise_per_bin(p)
    lam = statistic(p, mask, noise)
    eta = threshold_for_pfa(m, pfa)
    return lam > eta, eta, {"m_bins": m, "frames": int(p.shape[0]),
                            "lambda": lam, "noise_per_bin": noise}
