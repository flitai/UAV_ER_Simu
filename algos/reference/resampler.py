#!/usr/bin/env python3
"""OFDM 有理重采样的 Python 第二参考（Q-2，14 号报告 §2.4，决策 D-088）。

与引擎 engine/src/resampler.cpp（封装）+ models/radiator/coder/（Coder 算法核）同口径，但**刻意写成
直接型**：y[m] = Σ_n h[m·M + gd − L·n]·x[n]，按原生样点 n 求和、只取落在滤波器支撑里的项。
Coder 核那一侧是按相位 r 与原生偏移 q 拆开的多相形式，两边下标走法不同，对拍才不是同一段代码跑两遍。

时间锚（08 报告 §8 口径二）：站点样点 m 恰在原生时刻 m·M/L（gd = L·T/2 已扣除）。
原生序号小于 0 或超出给定序列的样点按 0 算。

自检（--selftest）量的是物理，不是对拍：
  · 冲激对齐：原生 δ[n − k·M] 的输出峰恰在站点样点 125·k（偏差 0 样点）；
  · 通带单音：原生 0.25·fs_n 的复指数重采样后，与站点时刻上的同一复指数相差 < 1e-3（幅度与相位都对）；
  · 直流：常数输入的稳态输出 = 1（每一相的抽头和都约为 1）。

用法：
    uv run --quiet --with numpy python algos/reference/resampler.py --selftest
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
TABLE_REL = os.path.join("models", "radiator", "fir_rsmp_v1.json")


def load_table(path: str | None = None) -> dict:
    with open(path or os.path.join(_ROOT, TABLE_REL), "r", encoding="utf-8") as f:
        doc = json.load(f)
    e = doc["entries"][0]
    half = np.asarray(e["half"], dtype=np.float64)
    h = np.concatenate([half, half[-2::-1]])
    return {"L": e["interp_L"], "T": e["taps_per_phase"], "gd": e["group_delay_proto"], "h": h,
            "M": list(doc["spec"]["decim_M_supported"])}


def resample(x: np.ndarray, x0: int, M: int, m_lo: int, m_hi: int, tab: dict | None = None) -> np.ndarray:
    """站点样点 m ∈ [m_lo, m_hi) 的输出。x[i] 是原生序号 x0 + i 的样点，其余按 0。"""
    tab = tab or load_table()
    L, gd, h = tab["L"], tab["gd"], tab["h"]
    N = h.size
    out = np.zeros(m_hi - m_lo, dtype=np.complex128)
    for j, m in enumerate(range(m_lo, m_hi)):
        p = m * M + gd
        # 0 ≤ p − L·n ≤ N−1  ⇔  ceil((p − N + 1)/L) ≤ n ≤ floor(p/L)
        n_hi = p // L
        n_lo = -((-(p - N + 1)) // L)
        acc = 0j
        for n in range(max(n_lo, x0), min(n_hi, x0 + x.size - 1) + 1):
            acc += h[p - L * n] * x[n - x0]
        out[j] = acc
    return out


def window_cycle(win: np.ndarray, M: int, c: int, tab: dict | None = None) -> np.ndarray:
    """与 Coder 核同一个接口：窗口 = 原生样点 c·M − T/2 … 起的 M+T 个，出站点样点 125c … 125c+124。"""
    tab = tab or load_table()
    L, T = tab["L"], tab["T"]
    return resample(win, c * M - T // 2, M, L * c, L * c + L, tab)


def _selftest() -> int:
    tab = load_table()
    L, T = tab["L"], tab["T"]
    fails = 0

    def check(cond: bool, what: str) -> None:
        nonlocal fails
        print(("  通过  " if cond else "  失败  ") + what)
        fails += 0 if cond else 1

    for M in tab["M"]:
        # 冲激对齐：δ 放在原生 k·M 上，输出峰应在站点 125·k
        k = 7
        x = np.zeros(1, dtype=np.complex128) + 1.0
        y = resample(x, k * M, M, L * k - 400, L * k + 400, tab)
        peak = int(np.argmax(np.abs(y))) + L * k - 400
        check(peak == L * k, f"M = {M}：冲激峰在站点样点 {peak}（应为 {L * k}），偏差 {peak - L * k}")
        # 通带单音：原生 0.25·fs_n 的复指数
        f = 0.25
        n = np.arange(0, 4000)
        x = np.exp(2j * math.pi * f * n)
        m_lo, m_hi = int(200 * L / M) + 1, int(3800 * L / M) - 1
        m_lo, m_hi = m_lo, m_lo + 600
        y = resample(x, 0, M, m_lo, m_hi, tab)
        want = np.exp(2j * math.pi * f * np.arange(m_lo, m_hi) * M / L)
        err = float(np.max(np.abs(y - want)))
        check(err < 1e-3, f"M = {M}：通带单音对站点时刻上的复指数最大差 {err:.2e}（幅度与相位都对）")
        # 直流
        x = np.ones(3000, dtype=np.complex128)
        y = resample(x, 0, M, int(1000 * L / M), int(1000 * L / M) + 300, tab)
        check(float(np.max(np.abs(y - 1.0))) < 1e-3, f"M = {M}：直流稳态 = 1（最大差 {np.max(np.abs(y - 1.0)):.2e}）")
    print("自检" + ("全部通过" if fails == 0 else f"有 {fails} 项失败"))
    return 0 if fails == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
