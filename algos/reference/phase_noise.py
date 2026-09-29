"""接收机本振相位噪声的独立参考实现（Q-4，D-091）。

模型：锁相环单极点。双边相位谱 S_φ(f) = L0 / (1 + (f/fc)²)，L0 = 10^(level/10)，
即奥恩斯坦—乌伦贝克过程；按**精确离散**

    φ[n] = a·φ[n−1] + σw·w[n],   a = exp(−2π·fc/fs),   σw = sqrt(π·fc·L0·(1 − a²))

平稳方差 σφ² = π·fc·L0，与采样率无关；起点取平稳分布 φ[−1] = σφ·w[−1]。
离散过程的双边谱（单位 rad²/Hz）是闭式 σw² / (fs·|1 − a·e^{−jω}|²)，ω = 2π·f/fs。

与引擎 engine/src/receiver.cpp 的 ReceiverFrontEnd 逐式对应：随机数用 gen_engine_golden.py 里那份
Xoshiro256pp 复刻（Box–Muller、缓存第二个正态），相噪流的种子由前端子种子经 mix64 派生，
标签 0x706e5f6c6f5f7631（"pn_lo_v1"）。改这里必须同时改那里。

--selftest 做两件与实现无关的核对：
  1. 经验方差对闭式 σφ²（容差按 AR(1) 有效样本数算：方差估计量的标准差
     ≈ σφ²·sqrt(2·(1 + a²) / ((1 − a²)·N))，取 5 倍）；
  2. Welch 谱对离散闭式谱（带内逐频点比，平均后在 ±0.5 dB 内）。

    uv run --quiet --with numpy python algos/reference/phase_noise.py --selftest
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
MASK64 = (1 << 64) - 1
PN_TAG = 0x706E5F6C6F5F7631


def _xoshiro():
    sys.path.insert(0, _HERE)
    from gen_engine_golden import Xoshiro256pp  # noqa: E402  唯一一份复刻
    return Xoshiro256pp


def mix64(z: int) -> int:
    """splitmix64 的一步，与 geo::mix64（geo/src/ofdm_frame.cpp）同式。"""
    z = (z + 0x9E3779B97F4A7C15) & MASK64
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    return z ^ (z >> 31)


def pn_seed(sub_seed: int) -> int:
    return mix64((sub_seed ^ PN_TAG) & MASK64)


def coeffs(fs: float, fc: float, level_dBc_Hz: float) -> tuple[float, float, float]:
    """(a, σw, σφ)。算式与 ReceiverFrontEnd::phase_noise_coeffs 逐项相同。"""
    L0 = 10.0 ** (level_dBc_Hz / 10.0)
    a = math.exp(-2.0 * math.pi * fc / fs)
    var = math.pi * fc * L0
    return a, math.sqrt(var * (1.0 - a * a)), math.sqrt(var)


def generate(seed: int, n: int, fs: float, fc: float, level_dBc_Hz: float) -> np.ndarray:
    """相噪序列 φ[0..n)（弧度）。seed 是相噪流自己的种子（已经过 pn_seed 派生）。"""
    rng = _xoshiro()(seed)
    a, sw, sp = coeffs(fs, fc, level_dBc_Hz)
    out = np.empty(n, dtype=np.float64)
    phi = sp * rng.normal()
    for i in range(n):
        phi = a * phi + sw * rng.normal()
        out[i] = phi
    return out


def discrete_psd(f: np.ndarray, fs: float, fc: float, level_dBc_Hz: float) -> np.ndarray:
    """离散过程的双边相位谱（rad²/Hz）。"""
    a, sw, _ = coeffs(fs, fc, level_dBc_Hz)
    w = 2.0 * np.pi * f / fs
    return sw * sw / (fs * np.abs(1.0 - a * np.exp(-1j * w)) ** 2)


def selftest() -> int:
    ok = True
    fs, fc, level = 1e6, 2e4, -80.0
    n = 400_000
    x = generate(pn_seed(20260929), n, fs, fc, level)
    a, _, sp = coeffs(fs, fc, level)
    var_want = sp * sp
    var_got = float(np.mean(x * x))
    sd = var_want * math.sqrt(2.0 * (1.0 + a * a) / ((1.0 - a * a) * n))
    print(f"方差 {var_got:.6e} 对闭式 {var_want:.6e}，差 {abs(var_got - var_want) / sd:.2f} 个标准差")
    ok &= abs(var_got - var_want) < 5.0 * sd
    print(f"均方根相位 {math.degrees(math.sqrt(var_got)):.4f} deg（闭式 {math.degrees(sp):.4f}）")

    # Welch：4096 点 Hann，半重叠；在 fc/10 … fs/4 之间逐频点比
    seg = 4096
    win = np.hanning(seg)
    step = seg // 2
    acc = np.zeros(seg)
    cnt = 0
    for s in range(0, n - seg + 1, step):
        v = x[s:s + seg] * win
        acc += np.abs(np.fft.fft(v)) ** 2
        cnt += 1
    psd = acc / cnt / (fs * np.sum(win ** 2))
    f = np.fft.fftfreq(seg, 1.0 / fs)
    sel = (np.abs(f) > fc / 10) & (np.abs(f) < fs / 4)
    ratio_dB = 10 * np.log10(psd[sel] / discrete_psd(f[sel], fs, fc, level))
    print(f"Welch 对离散闭式谱：平均差 {np.mean(ratio_dB):+.3f} dB，逐点中位 {np.median(ratio_dB):+.3f} dB")
    ok &= abs(float(np.mean(ratio_dB))) < 0.5
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
