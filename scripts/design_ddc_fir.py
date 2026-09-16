#!/usr/bin/env python3
"""设计并冻结 DDC 的抗混叠低通系数表（06 备忘录 §9D M-2）。

真理源是 `models/adc-ddc/fir_lp_v1.json`；引擎侧的 C++ 表由 `scripts/gen_ddc_taps.py`
从它生成，Python 参考 `algos/reference/ddc.py` 也读它。三方共享的只有这一份**数据**，
算法各写各的（三方互证的前提）。

设计口径（10 报告 §3.6）：对抽取比 D，通带边 0.4·fs_out、阻带边 0.5·fs_out。
换算成周/样点（scipy.signal.remez 在 fs=1.0 下的口径，量程 0…0.5）：
    fp = 0.4·fs_out/fs_in = 0.4/D，    fst = 0.5·fs_out/fs_in = 0.5/D
阻带边取 0.5/D 不是别的值，因为抽取 D 倍后混叠恰好发生在 |f| > fs_out/2 处；
通带边留在 0.4·fs_out，于是过渡带宽 0.1·fs_out。
**别把「归一化到奈奎斯特」和「周/样点」混起来**——差一个 2，滤波器会窄一半，
把本该保留的半个输出带白白滤掉（第一版就是这么错的，靠看 S4 的谱才发现）。
阻带 >= 60 dB；**抽头数取奇数**，使群时延 (N-1)/2 恰为整数个输入样点（08 报告 §8 口径二，
首期不引入分数延迟器）。D = 1 是 h = [1.0]、群时延 0 的同一条代码路径，不设特例分支。

只存半表（含中心抽头），装载时镜像展开：remez 返回的系数**不保证逐位对称**，
存全表会让三方的群时延在 1e-17 级上对不齐；镜像后对称性逐位成立。

为什么用 scipy 而不是 MATLAB：开发机的 MATLAB 是学术许可，其产物带
「不得用于政府 / 商业 / 组织用途」的条款；scipy 是 BSD，且只是开发期工具，
不进运行时也不进交付包（铁律 6 只要求运行不联网、依赖随包）。
MATLAB 的 firpm 留作独立校验，见 matlab/design/check_ddc_fir.m。

用法：
    uv run --quiet --with scipy --with numpy python scripts/design_ddc_fir.py            # 只校验
    uv run --quiet --with scipy --with numpy python scripts/design_ddc_fir.py --write    # 重写表

路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
from scipy.signal import freqz, remez

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TABLE_REL = os.path.join("models", "adc-ddc", "fir_lp_v1.json")

VERSION = "lp_v1"
# 支持的抽取比。v1 止于 20：更大的抽取比单级 remez 的抽头数线性涨，应当走多级
# （CIC / 半带级联），排到 M-3。加一档只需在这里加一个数再 --write。
DECIMS = (1, 2, 4, 5, 8, 10, 16, 20)

PASSBAND_EDGE_REL_OUT = 0.4      # 通带边，相对输出采样率
STOPBAND_EDGE_REL_OUT = 0.5      # 阻带边，相对输出采样率
STOPBAND_ATTEN_MIN_DB = 60.0
PASSBAND_RIPPLE_MAX_DB = 0.2

# remez 的加权：与各自允许的纹波成反比（δp = 0.01 ≈ 0.086 dB，δs = 1e-3 = 60 dB）
_WEIGHT = (1.0, 10.0)


def _symmetrize(h: np.ndarray) -> np.ndarray:
    """强制偶对称：remez 的输出只是数值上近似对称，这里取两端平均一次钉死。"""
    n = h.size
    out = h.astype(np.float64).copy()
    for k in range(n // 2):
        v = 0.5 * (out[k] + out[n - 1 - k])
        out[k] = v
        out[n - 1 - k] = v
    return out


def _measure(h: np.ndarray, decim: int) -> tuple[float, float]:
    """返回 (阻带最大增益 dB 的相反数, 通带峰峰纹波 dB)。"""
    if decim == 1:
        return (float("inf"), 0.0)
    fp = PASSBAND_EDGE_REL_OUT / decim          # 周/样点：0.4·fs_out / fs_in
    fst = STOPBAND_EDGE_REL_OUT / decim        # 周/样点：0.5·fs_out / fs_in
    wst = np.linspace(2.0 * math.pi * fst, math.pi, 8192)
    _, hst = freqz(h, 1.0, worN=wst)
    atten = -20.0 * math.log10(float(np.max(np.abs(hst))))
    wp = np.linspace(0.0, 2.0 * math.pi * fp, 4096)
    _, hp = freqz(h, 1.0, worN=wp)
    mag = np.abs(hp)
    ripple = 20.0 * math.log10(float(np.max(mag)) / float(np.min(mag)))
    return (atten, ripple)


def design(decim: int) -> dict:
    """设计一档，返回条目。抽头数从 remez 估阶起按 +2 递增到达标为止。"""
    if decim == 1:
        return {
            "decim": 1,
            "ntaps": 1,
            "group_delay_in": 0,
            "stopband_atten_dB": None,
            "passband_ripple_dB": 0.0,
            "half": [1.0],
        }

    fp = PASSBAND_EDGE_REL_OUT / decim
    fst = STOPBAND_EDGE_REL_OUT / decim
    # Kaiser 估阶作起点（Harris 经验式），再向上找最小的达标奇数
    trans = fst - fp
    n0 = int(math.ceil(STOPBAND_ATTEN_MIN_DB / (22.0 * trans)))
    if n0 % 2 == 0:
        n0 += 1
    n0 = max(n0, 3)

    for k in range(0, 400):
        n = n0 + 2 * k
        try:
            h = remez(n, [0.0, fp, fst, 0.5], [1.0, 0.0], weight=_WEIGHT, maxiter=60, fs=1.0)
        except Exception:
            continue
        h = _symmetrize(h)
        s = float(np.sum(h))
        if not (abs(s) > 1e-12):
            continue
        h = h / s                       # 通带增益归一：通带内单音过 DDC 后幅度不变
        h = _symmetrize(h)              # 除法可能破坏最后一位的对称，再钉一次
        atten, ripple = _measure(h, decim)
        if atten >= STOPBAND_ATTEN_MIN_DB and ripple <= PASSBAND_RIPPLE_MAX_DB:
            half = h[: (n + 1) // 2]
            return {
                "decim": decim,
                "ntaps": n,
                "group_delay_in": (n - 1) // 2,
                "stopband_atten_dB": round(atten, 4),
                "passband_ripple_dB": round(ripple, 6),
                "half": [float(v) for v in half],
            }
    raise SystemExit(f"D = {decim} 在 {400} 次搜索内没有达标的抽头数；该档应走多级抽取")


def expand(entry: dict) -> np.ndarray:
    """半表镜像成全表。装载侧（C++ / Python / MATLAB）必须逐字同法。"""
    half = np.asarray(entry["half"], dtype=np.float64)
    n = int(entry["ntaps"])
    h = np.empty(n, dtype=np.float64)
    m = (n + 1) // 2
    for k in range(m):
        h[k] = half[k]
        h[n - 1 - k] = half[k]
    return h


def check(doc: dict) -> list[str]:
    """逐档自检。返回不合格的说明；空列表即通过。"""
    bad: list[str] = []
    if doc.get("version") != VERSION:
        bad.append(f"版本不是 {VERSION}")
    got = tuple(e["decim"] for e in doc["entries"])
    if got != DECIMS:
        bad.append(f"抽取比清单不符：{got} 对 {DECIMS}")
        return bad
    for e in doc["entries"]:
        d, n = e["decim"], e["ntaps"]
        tag = f"D = {d}"
        if n % 2 == 0:
            bad.append(f"{tag} 抽头数 {n} 不是奇数，群时延不是整数样点（08 §8 口径二）")
        if e["group_delay_in"] != (n - 1) // 2:
            bad.append(f"{tag} 群时延与抽头数不符")
        if len(e["half"]) != (n + 1) // 2:
            bad.append(f"{tag} 半表长度不符：{len(e['half'])} 对 {(n + 1) // 2}")
            continue
        h = expand(e)
        for k in range(n // 2):
            if h[k] != h[n - 1 - k]:
                bad.append(f"{tag} 镜像后第 {k} 个抽头不逐位对称")
                break
        s = float(np.sum(h))
        if abs(s - 1.0) > 1e-12:
            bad.append(f"{tag} 通带增益归一失效：sum(h) = {s!r}")
        atten, ripple = _measure(h, d)
        if d > 1:
            if atten < STOPBAND_ATTEN_MIN_DB:
                bad.append(f"{tag} 阻带 {atten:.2f} dB < {STOPBAND_ATTEN_MIN_DB}")
            if ripple > PASSBAND_RIPPLE_MAX_DB:
                bad.append(f"{tag} 通带纹波 {ripple:.4f} dB > {PASSBAND_RIPPLE_MAX_DB}")
    return bad


def build() -> dict:
    return {
        "schema": "cuav-fir-table/1",
        "version": VERSION,
        "purpose": "DDC 抗混叠低通的冻结系数表（04 §7.7 第 3 步；06 §9D M-2）。"
                   "只存半表，装载时镜像展开，对称性因此逐位成立。",
        "generator": "uv run --quiet --with scipy --with numpy python scripts/design_ddc_fir.py --write",
        "spec": {
            "method": "Parks-McClellan 等波纹（scipy.signal.remez）",
            "passband_edge_rel_out": PASSBAND_EDGE_REL_OUT,
            "stopband_edge_rel_out": STOPBAND_EDGE_REL_OUT,
            "stopband_atten_min_dB": STOPBAND_ATTEN_MIN_DB,
            "passband_ripple_max_dB": PASSBAND_RIPPLE_MAX_DB,
            "gain": "sum(h) = 1，通带内单音过 DDC 后幅度不变",
            "note": "归一化到输入采样率：通带 [0, 0.2/D]、阻带 [0.25/D, 0.5] 周/样点。"
                    "D = 1 是 h = [1.0]、群时延 0 的同一条代码路径，不设特例分支。",
        },
        "entries": [design(d) for d in DECIMS],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="设计并冻结 DDC 抗混叠低通系数表")
    ap.add_argument("--write", action="store_true", help="重新设计并覆盖表；缺省只校验已冻结的表")
    ap.add_argument("--out", default=_TABLE_REL, help="表文件，仓库相对路径")
    a = ap.parse_args(argv)
    path = os.path.join(_ROOT, a.out)

    if a.write:
        doc = build()
        bad = check(doc)
        if bad:
            for b in bad:
                print(f"不合格：{b}", file=sys.stderr)
            print("没有写出表（铁律 15：不写坏基准）", file=sys.stderr)
            return 1
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        print(f"写出 {a.out}")
    else:
        if not os.path.exists(path):
            print(f"找不到 {a.out}，先跑 --write", file=sys.stderr)
            return 2
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        bad = check(doc)
        if bad:
            for b in bad:
                print(f"不合格：{b}", file=sys.stderr)
            return 1
        print(f"系数表校验通过：{a.out}")

    for e in doc["entries"]:
        at = e["stopband_atten_dB"]
        print(f"  D = {e['decim']:>2}  抽头 {e['ntaps']:>5}  群时延 {e['group_delay_in']:>5}  "
              f"阻带 {'—' if at is None else f'{at:.2f} dB':>9}  纹波 {e['passband_ripple_dB']:.4f} dB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
