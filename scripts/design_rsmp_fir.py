#!/usr/bin/env python3
"""设计并冻结 OFDM 波形有理重采样的原型低通（Q-2，14 号报告 §2.4，决策 D-088）。

真理源是 `models/radiator/fir_rsmp_v1.json`；引擎侧的 C++ 表由
`scripts/gen_fir_taps.py --kind rsmp` 从它生成，Python 参考 `algos/reference/resampler.py`
与 MATLAB 一方（`matlab/golden/gen_rsmp_golden.m`，upfirdn）都读它。三方共享的只有这一份**数据**。
与 design_ddc_fir.py / design_pfb_fir.py / design_rx_fir.py 是姊妹脚本。

**它建模什么**：发射机把原生采样率（FFT 点数 × 15 kHz）的数字基带送进 DAC 与重建 / 发射滤波，
得到一个带限的模拟信号；仿真在站点采样率上观察它。原生率 → 站点采样率是有理比 L/M
（L = 125，M ∈ {24, 48, 96}；15.36 → 80 MS/s 为 125/24 等），实现是「插 L 个零 → 低通 → 抽 M」
的多相形式。低通就是这里设计的这一张原型表，**一张表服务全部 M 与全部数值结构**：
带边按原生采样率的比例给出，三种数值结构（1024 / 2048 / 4096 点）的占用比例几乎相同
（601/1024、1201/2048、2401/4096，最高子载波都在 0.2930·fs_n），只升采样（fs_site ≥ fs_n）。

设计口径（带边相对原生采样率 fs_n；原型滤波器工作在 L·fs_n 上）：
    通带边 0.2935·fs_n    盖住全部有用子载波（(K + 0.5)/N ≤ 0.29346）
    阻带边 0.5·fs_n       原生奈奎斯特：镜像（fs_n ± 0.2935）与原生带外的符号边沿旁瓣都压掉，
                          站点采样率最低 20 MS/s（125/96）时输出奈奎斯特 0.651·fs_n 也在它之上
    阻带 ≥ 60 dB，通带纹波 ≤ 0.05 dB，直流增益 = L（插零使幅度降为 1/L，这里补回）
抽头数 N = L·T + 1、**T 取偶数**：N 为奇数使群时延 (N−1)/2 = L·T/2 为整数个原型样点，
且恰为 T/2 个原生样点。取满足指标的最小偶数 T。

**方法用 Kaiser 窗 sinc 而不是等波纹**：N ≈ 2500，remez 在这个长度上既慢又常不收敛；
Kaiser 设计是闭式的、可复算。与另三张表方法不同是有意的，不影响三方互证——各方拿到的都是
冻结的抽头本身（显式数据），不是设计方法。

只存半表（含中心抽头），装载时镜像展开，理由同 design_ddc_fir.py。

用法：
    uv run --quiet --with scipy --with numpy python scripts/design_rsmp_fir.py            # 只校验
    uv run --quiet --with scipy --with numpy python scripts/design_rsmp_fir.py --write    # 重写表

路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
from scipy.signal import firwin, freqz

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TABLE_REL = os.path.join("models", "radiator", "fir_rsmp_v1.json")

VERSION = "rsmp_v1"
L = 125
M_SUPPORTED = (24, 48, 96)
PASS_REL = 0.2935               # 相对原生采样率
STOP_REL = 0.5
STOPBAND_ATTEN_MIN_DB = 60.0
PASSBAND_RIPPLE_MAX_DB = 0.05
ATTEN_TARGET_DB = 66.0          # Kaiser β 按它取，留 6 dB 余量给「实测 ≥ 60」
T_CANDIDATES = range(8, 42, 2)


def kaiser_beta(a_db: float) -> float:
    if a_db > 50:
        return 0.1102 * (a_db - 8.7)
    if a_db >= 21:
        return 0.5842 * (a_db - 21) ** 0.4 + 0.07886 * (a_db - 21)
    return 0.0


def _symmetrize(h: np.ndarray) -> np.ndarray:
    n = h.size
    out = h.astype(np.float64).copy()
    for k in range(n // 2):
        v = 0.5 * (out[k] + out[n - 1 - k])
        out[k] = v
        out[n - 1 - k] = v
    return out


def design(t: int) -> np.ndarray:
    n = L * t + 1
    fc = 0.5 * (PASS_REL + STOP_REL) / L          # 周 / 原型样点
    h = firwin(n, 2.0 * fc, window=("kaiser", kaiser_beta(ATTEN_TARGET_DB)))   # firwin 以奈奎斯特为 1
    h = _symmetrize(h)
    h = h * (L / float(np.sum(h)))
    return _symmetrize(h)


def measure(h: np.ndarray) -> tuple[float, float]:
    """(阻带最小衰减 dB, 通带峰峰纹波 dB)；频率换成相对原生采样率的物理带边去量。"""
    # 原型采样率上的周 / 样点 = 相对 fs_n 的频率 / L
    wp = np.linspace(0.0, 2.0 * math.pi * PASS_REL / L, 4096)
    ws = np.linspace(2.0 * math.pi * STOP_REL / L, math.pi, 1 << 17)
    _, hp = freqz(h, worN=wp)
    _, hs = freqz(h, worN=ws)
    gp = 20.0 * np.log10(np.abs(hp) / L)
    gs = 20.0 * np.log10(np.maximum(np.abs(hs), 1e-300) / L)
    return float(-gs.max()), float(gp.max() - gp.min())


def build() -> dict:
    for t in T_CANDIDATES:
        h = design(t)
        atten, ripple = measure(h)
        if atten >= STOPBAND_ATTEN_MIN_DB and ripple <= PASSBAND_RIPPLE_MAX_DB:
            break
    else:
        raise SystemExit("在候选 T 内找不到满足指标的设计")
    n = h.size
    gd = (n - 1) // 2
    assert n == L * t + 1 and t % 2 == 0 and gd == L * t // 2 and gd % L == 0
    return {
        "schema": "cuav-fir-table/1",
        "version": VERSION,
        "purpose": "OFDM 族波形的有理重采样原型低通（Q-2，D-088；14 号报告 §2.4）：原生采样率 → 站点采样率，"
                   "插 L 个零、低通、抽 M 的多相形式。一张表服务全部 M 与全部数值结构。只存半表，装载时镜像展开。",
        "generator": "uv run --quiet --with scipy --with numpy python scripts/design_rsmp_fir.py --write",
        "spec": {
            "method": "Kaiser 窗 sinc（scipy.signal.firwin），β 按 66 dB 取；取满足指标的最小偶数 T",
            "interp_L": L,
            "decim_M_supported": list(M_SUPPORTED),
            "passband_edge_rel_native": PASS_REL,
            "stopband_edge_rel_native": STOP_REL,
            "stopband_atten_min_dB": STOPBAND_ATTEN_MIN_DB,
            "passband_ripple_max_dB": PASSBAND_RIPPLE_MAX_DB,
            "gain": "sum(h) = L：插零使幅度降为 1/L，这里补回，通带内单音过重采样后幅度不变",
            "note": "带边相对原生采样率 fs_n，原型滤波器工作在 L·fs_n；N = L·T+1、T 偶数，"
                    "群时延 (N−1)/2 = L·T/2 个原型样点 = T/2 个原生样点，由封装层扣除（08 报告 §8 口径二）。"
                    "只升采样：站点采样率 = fs_n·L/M ≥ fs_n。",
        },
        "entries": [{
            "interp_L": L,
            "taps_per_phase": t,
            "ntaps": n,
            "group_delay_proto": gd,
            "group_delay_native": gd // L,
            "kaiser_beta": kaiser_beta(ATTEN_TARGET_DB),
            "cutoff_rel_native": 0.5 * (PASS_REL + STOP_REL),
            "stopband_atten_dB": round(atten, 4),
            "passband_ripple_dB": round(ripple, 6),
            "half": [float(v) for v in h[: gd + 1]],
        }],
    }


def expand(e: dict) -> np.ndarray:
    half = np.asarray(e["half"], dtype=np.float64)
    return np.concatenate([half, half[-2::-1]])


def check(doc: dict) -> list:
    errs = []
    for e in doc["entries"]:
        h = expand(e)
        if h.size != e["ntaps"] or h.size != L * e["taps_per_phase"] + 1:
            errs.append("抽头数与 L·T+1 对不上")
        if e["taps_per_phase"] % 2:
            errs.append("T 不是偶数")
        if abs(float(np.sum(h)) - L) > 1e-9 * L:
            errs.append(f"直流增益 {np.sum(h)} ≠ L")
        atten, ripple = measure(h)
        if atten < STOPBAND_ATTEN_MIN_DB:
            errs.append(f"阻带 {atten:.2f} dB < {STOPBAND_ATTEN_MIN_DB}")
        if ripple > PASSBAND_RIPPLE_MAX_DB:
            errs.append(f"通带纹波 {ripple:.4f} dB > {PASSBAND_RIPPLE_MAX_DB}")
        print(f"L = {L}，T = {e['taps_per_phase']}，{h.size} 抽头，群时延 {e['group_delay_native']} 个原生样点，"
              f"阻带 {atten:.2f} dB，通带纹波 {ripple:.4f} dB")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="重新设计并覆盖冻结表")
    a = ap.parse_args()
    path = os.path.join(_ROOT, _TABLE_REL)
    if a.write:
        doc = build()
        errs = check(doc)
        if errs:
            print("设计不合格，不写表：" + "；".join(errs), file=sys.stderr)
            return 1
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(f"写出 {_TABLE_REL.replace(os.sep, '/')}")
        return 0
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    errs = check(doc)
    if errs:
        print("冻结表不合格：" + "；".join(errs), file=sys.stderr)
        return 1
    print("冻结表合格")
    return 0


if __name__ == "__main__":
    sys.exit(main())
