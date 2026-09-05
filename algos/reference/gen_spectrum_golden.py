#!/usr/bin/env python3
"""生成频谱分析组件（Welch 功率谱，P1-4a）的黄金基准，三方互证的 Python 一方。

## 为什么输入写进文件而不是复刻随机源

能量检测的黄金基准两侧从同一个种子各自生成输入（gen_engine_golden.py）。这里的第三方是
MATLAB，在 MATLAB 里逐位复刻 xoshiro256++ 得用 uint64 手工分半做乘法，成本高、易错。
改用**闭式定义的确定性信号**：三个单音、一个直流、48 个按黄金分割摆放的低幅单音，任何工具
都能按公式重算；再把它量化成 float32（引擎内部格式，docs/iq-format.md），把量化后的值写进
JSON。JSON 里的值才是基准输入，公式只是说明。

## 谱的口径

Welch 平均的**功率谱**（不是功率谱密度）：每段加周期 Hann 窗，DFT 后取 |X|²，各段平均，
再除以 (Σw)²。这样一个复单音的峰值等于它的功率 A²，满量程单音（A = 1）读 0 dBFS。与
MATLAB `pwelch(x, hann(nfft,'periodic'), noverlap, nfft, fs, 'centered', 'power')` 同口径。
零频移到中间（fftshift）。

## 判据

线性功率逐频点相对误差 ≤ 1e-9，或绝对误差 ≤ 1e-12 × 峰值（近零频点用绝对判据）。
引擎的频谱分析在 double 里算，能达到这个精度；float32 只出现在输入样点上，三方读到的是同一组值。

用法：
    uv run --quiet --with numpy python algos/reference/gen_spectrum_golden.py \\
        -o engine/tests/golden/spectrum_welch.json
"""
from __future__ import annotations

import argparse
import json
import math

import numpy as np

FS = 1.0e6
NFFT = 256
OVERLAP = 0.5
SEGMENTS = 8
HOP = int(NFFT * (1.0 - OVERLAP))
N = HOP * (SEGMENTS - 1) + NFFT          # 正好 SEGMENTS 段，无尾样点

# 闭式信号定义（说明性的，基准输入以 JSON 里的 float32 值为准）
TONES = [
    {"freq_Hz": 100e3, "amplitude": 0.5, "phase_rad": 0.0, "note": "落在频点中心：256 点 × 100 kHz / 1 MHz = 25.6，不是整数，故实为偏离中心"},
    {"freq_Hz": 125e3, "amplitude": 0.5, "phase_rad": 0.0, "note": "落在频点中心（bin 32）"},
    {"freq_Hz": 123456.789, "amplitude": 0.2, "phase_rad": 1.0, "note": "偏离频点中心，看泄漏"},
    {"freq_Hz": -250e3, "amplitude": 0.1, "phase_rad": 2.0, "note": "负频率"},
    {"freq_Hz": 0.0, "amplitude": 0.05, "phase_rad": 0.0, "note": "直流"},
]
COMB_COUNT = 48
GOLDEN = 0.6180339887498949
PHASE_SEED = 0.7548776662466927


def frac(v: float) -> float:
    return v - math.floor(v)


def build_signal() -> np.ndarray:
    n = np.arange(N, dtype=np.float64)
    x = np.zeros(N, dtype=np.complex128)
    for t in TONES:
        x += t["amplitude"] * np.exp(1j * (2 * math.pi * t["freq_Hz"] * n / FS + t["phase_rad"]))
    for k in range(1, COMB_COUNT + 1):
        f = FS * (frac(k * GOLDEN) - 0.5)
        a = 0.004 * (1 + (k % 7))
        ph = 2 * math.pi * frac(k * k * PHASE_SEED)
        x += a * np.exp(1j * (2 * math.pi * f * n / FS + ph))
    # 量化到 float32（引擎内部格式），再回到 float64：三方读到的都是这组精确可表示的值
    return x.astype(np.complex64).astype(np.complex128)


def hann_periodic(nfft: int) -> np.ndarray:
    n = np.arange(nfft, dtype=np.float64)
    return 0.5 * (1.0 - np.cos(2.0 * math.pi * n / nfft))


def welch_power(x: np.ndarray, nfft: int, hop: int, w: np.ndarray) -> np.ndarray:
    k_count = (len(x) - nfft) // hop + 1
    acc = np.zeros(nfft, dtype=np.float64)
    for k in range(k_count):
        seg = x[k * hop:k * hop + nfft] * w
        spec = np.fft.fft(seg)
        acc += np.abs(spec) ** 2
    power = acc / k_count / (w.sum() ** 2)
    return np.fft.fftshift(power)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="生成 Welch 功率谱黄金基准")
    ap.add_argument("-o", "--output", required=True)
    args = ap.parse_args(argv)

    x = build_signal()
    w = hann_periodic(NFFT)
    power = welch_power(x, NFFT, HOP, w)
    psd_db = 10.0 * np.log10(np.maximum(power, 1e-30))

    iq = np.empty(2 * N, dtype=np.float64)
    iq[0::2] = x.real
    iq[1::2] = x.imag

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "频谱分析组件（Welch 功率谱，dBFS）与 Python、MATLAB 参考的三方互证基准",
        "generator": "algos/reference/gen_spectrum_golden.py",
        "params": {
            "sample_rate_Hz": FS,
            "nfft": NFFT,
            "overlap": OVERLAP,
            "hop": HOP,
            "segments": SEGMENTS,
            "window": "hann_periodic",
            "scale": "power_dBFS",
            "definition": "P[k] = mean_over_segments |FFT(w·x_seg)[k]|^2 / (Σw)^2，fftshift；复单音峰值 = A^2",
        },
        "signal": {
            "description": "闭式确定性信号，量化为 float32 后写入 input.iq；公式仅作说明，基准输入以 input.iq 为准",
            "count": N,
            "tones": TONES,
            "comb": {
                "count": COMB_COUNT,
                "freq_Hz": "fs · (frac(k · 0.6180339887498949) − 0.5)",
                "amplitude": "0.004 · (1 + (k mod 7))",
                "phase_rad": "2π · frac(k² · 0.7548776662466927)",
                "k": "1..48",
            },
        },
        "input": {
            "format": "float32 值的十进制表示，I、Q 交织，float64 精确可表示",
            "count": N,
            "iq": [float(v) for v in iq],
        },
        "expected": {
            "python": {
                "method": "numpy.fft，手写 Welch（本文件 welch_power）",
                "numpy_version": np.__version__,
                "power": [float(v) for v in power],
                "psd_dB": [float(v) for v in psd_db],
                "peak_dB": float(psd_db.max()),
                "peak_bin": int(psd_db.argmax()),
            },
            "matlab": "由 matlab/golden/gen_spectrum_golden.m 写到同目录 spectrum_welch.matlab.json",
        },
        "tolerance": {
            "power_rel": 1e-9,
            "power_abs_rel_to_peak": 1e-12,
            "note": "线性功率逐频点比较；引擎频谱在 double 中计算，float32 只在输入样点上",
        },
    }
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    print(f"写出 {args.output}：{N} 样点，{SEGMENTS} 段，峰值 {psd_db.max():.4f} dBFS @ bin {int(psd_db.argmax())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
