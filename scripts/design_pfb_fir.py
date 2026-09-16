#!/usr/bin/env python3
"""设计并冻结多相 FFT 信道化的原型低通系数表（06 备忘录 §9D M-3）。

真理源是 `models/channelizer/fir_pfb_v1.json`；引擎侧的 C++ 表由 `scripts/gen_pfb_taps.py`
从它生成，Python 参考 `algos/reference/channelizer.py` 也读它。三方共享的只有这一份**数据**，
算法各写各的（三方互证的前提）。与 `scripts/design_ddc_fir.py` 是姊妹脚本，口径刻意一致。

设计口径（10 报告 §3.7）：临界抽取，抽取比 = 子信道数 M，子信道输出采样率 fs_out = fs_in / M。
通带边 0.4·fs_out、阻带边 0.5·fs_out，换算成周/样点（scipy.signal.remez 在 fs=1.0 下的口径，
量程 0…0.5）：
    fp = 0.4·fs_out/fs_in = 0.4/M，    fst = 0.5·fs_out/fs_in = 0.5/M
**别把「归一化到奈奎斯特」和「周/样点」混起来**——差一个 2，滤波器会窄一半，
把本该保留的半个子信道白白滤掉（M-2 的第一版就是这么错的，靠看 S4 的谱才发现；
MATLAB 的 firpm 用的正是奈奎斯特量程，见 matlab/design/check_pfb_fir.m 里的 2× 换算）。

抽头数的约束是本表的核心，两条要求本来是冲突的：

  * 08 报告 §8 口径二要群时延 (N−1)/2 是**整数**个输入样点  →  N 必须**奇数**；
  * 多相分解要把 h 拆成 M 条支路               →  N 最好是 M 的倍数，而 M 是偶数。

取 **N = M·T + 1 且 T 为偶数**同时满足两者，并且额外白捡一个好处：此时
`gd = M·T/2 = M·(T/2)` 是 **M 的整数倍**，于是信道化输出里那个常数相位
`exp(−j2πk·gd/M)` 恒等于 1，M 路输出**不需要任何逐信道的相位修正**
（T 取奇数则要逐信道乘一次，三方还得各对一遍，没有必要）。
N 不是 M 的倍数，所以装载时再**零填充到 pad_to = M·(T+1)**，让 M 条支路等长：
给 FIR 末尾补零不改变 H(ω) 的任何一点，群时延与线性相位都不受影响。

实测 T = 28 对 M = 2…64 全档达标，于是每支路恒 29 个抽头、每输出样点每子信道 29 次乘加，
**与 M 无关**——与 DDC 的「每输入样点恒 ≈27 次乘加，与 D 无关」是同一句话。

只存半表（含中心抽头），装载时镜像展开：remez 返回的系数**不保证逐位对称**，
存全表会让三方的群时延在 1e-17 级上对不齐；镜像后对称性逐位成立。

为什么主设计走 scipy 而不是 MATLAB：scipy 是 BSD，**任何机器都能复算这张表**，
而 CI 与 scripts/build-all.sh 都不装也不调 MATLAB。MATLAB 的 firpm 作独立校验，
见 matlab/design/check_pfb_fir.m——两家等波纹实现互为佐证（D-070）。

用法：
    uv run --quiet --with scipy --with numpy python scripts/design_pfb_fir.py            # 只校验
    uv run --quiet --with scipy --with numpy python scripts/design_pfb_fir.py --write    # 重写表

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
_TABLE_REL = os.path.join("models", "channelizer", "fir_pfb_v1.json")

VERSION = "pfb_v1"
# 支持的子信道数。只收 2 的幂：多相 + FFT 的结构本来就要求它，而且 plan.ts 的
# fs_s5 = fs_s4 / channels 也按整数分。**不收 M = 1**——那是恒等变换，
# 「不做信道化」的表达方式是槽位旁路，不是 channels = 1（见 configure() 的报错）。
CHANNELS = (2, 4, 8, 16, 32, 64)

PASSBAND_EDGE_REL_OUT = 0.4      # 通带边，相对子信道输出采样率
STOPBAND_EDGE_REL_OUT = 0.5      # 阻带边，相对子信道输出采样率
STOPBAND_ATTEN_MIN_DB = 60.0
PASSBAND_RIPPLE_MAX_DB = 0.2

# remez 的加权：与各自允许的纹波成反比，与 design_ddc_fir.py 同值
_WEIGHT = (1.0, 10.0)

# 支路抽头数 T+1 的搜索上限（T 为偶数，从 2 起）
_T_MAX = 96


def _symmetrize(h: np.ndarray) -> np.ndarray:
    """强制偶对称：remez 的输出只是数值上近似对称，这里取两端平均一次钉死。"""
    n = h.size
    out = h.astype(np.float64).copy()
    for k in range(n // 2):
        v = 0.5 * (out[k] + out[n - 1 - k])
        out[k] = v
        out[n - 1 - k] = v
    return out


def _measure(h: np.ndarray, channels: int) -> tuple[float, float]:
    """返回 (阻带最大增益 dB 的相反数, 通带峰峰纹波 dB)。"""
    fp = PASSBAND_EDGE_REL_OUT / channels      # 周/样点：0.4·fs_out / fs_in
    fst = STOPBAND_EDGE_REL_OUT / channels     # 周/样点：0.5·fs_out / fs_in
    wst = np.linspace(2.0 * math.pi * fst, math.pi, 8192)
    _, hst = freqz(h, 1.0, worN=wst)
    atten = -20.0 * math.log10(float(np.max(np.abs(hst))))
    wp = np.linspace(0.0, 2.0 * math.pi * fp, 4096)
    _, hp = freqz(h, 1.0, worN=wp)
    mag = np.abs(hp)
    ripple = 20.0 * math.log10(float(np.max(mag)) / float(np.min(mag)))
    return (atten, ripple)


def design(channels: int) -> dict:
    """设计一档。T 从 2 起按 +2 递增（只取偶数）到达标为止。"""
    m = int(channels)
    fp = PASSBAND_EDGE_REL_OUT / m
    fst = STOPBAND_EDGE_REL_OUT / m

    for t in range(2, _T_MAX + 1, 2):
        n = m * t + 1
        try:
            h = remez(n, [0.0, fp, fst, 0.5], [1.0, 0.0], weight=_WEIGHT, maxiter=60, fs=1.0)
        except Exception:
            continue
        h = _symmetrize(h)
        s = float(np.sum(h))
        if not (abs(s) > 1e-12):
            continue
        h = h / s                       # 通带增益归一：子信道中心的单音过滤波器组后幅度不变
        h = _symmetrize(h)              # 除法可能破坏最后一位的对称，再钉一次
        atten, ripple = _measure(h, m)
        if atten >= STOPBAND_ATTEN_MIN_DB and ripple <= PASSBAND_RIPPLE_MAX_DB:
            gd = (n - 1) // 2
            assert gd == m * t // 2 and gd % m == 0, "T 为偶数时 gd 必是 M 的整数倍"
            return {
                "channels": m,
                "taps_per_branch": t + 1,
                "ntaps": n,
                "pad_to": m * (t + 1),
                "group_delay_in": gd,
                "stopband_atten_dB": round(atten, 4),
                "passband_ripple_dB": round(ripple, 6),
                "half": [float(v) for v in h[: (n + 1) // 2]],
            }
    raise SystemExit(f"M = {m} 在 T <= {_T_MAX} 内没有达标的抽头数")


def expand(entry: dict) -> np.ndarray:
    """半表镜像成全表再零填充到 pad_to。装载侧（C++ / Python / MATLAB）必须逐字同法。"""
    half = np.asarray(entry["half"], dtype=np.float64)
    n = int(entry["ntaps"])
    pad = int(entry["pad_to"])
    h = np.zeros(pad, dtype=np.float64)
    k_half = (n + 1) // 2
    for k in range(k_half):
        h[k] = half[k]
        h[n - 1 - k] = half[k]
    return h


def check(doc: dict) -> list[str]:
    """逐档自检。返回不合格的说明；空列表即通过。"""
    bad: list[str] = []
    if doc.get("version") != VERSION:
        bad.append(f"版本不是 {VERSION}")
    got = tuple(e["channels"] for e in doc["entries"])
    if got != CHANNELS:
        bad.append(f"子信道数清单不符：{got} 对 {CHANNELS}")
        return bad
    for e in doc["entries"]:
        m, n = e["channels"], e["ntaps"]
        tag = f"M = {m}"
        if m < 2 or (m & (m - 1)) != 0:
            bad.append(f"{tag} 不是不小于 2 的 2 的幂")
        if n % 2 == 0:
            bad.append(f"{tag} 抽头数 {n} 不是奇数，群时延不是整数样点（08 §8 口径二）")
        gd = e["group_delay_in"]
        if gd != (n - 1) // 2:
            bad.append(f"{tag} 群时延与抽头数不符")
        # 本表独有的一条：gd 必须是 M 的整数倍，常数相位才恒为 1（方案 §2）
        if gd % m != 0:
            bad.append(f"{tag} 群时延 {gd} 不是 M 的整数倍，输出会带一个逐信道的常数相位")
        t = e["taps_per_branch"] - 1
        if n != m * t + 1:
            bad.append(f"{tag} 抽头数 {n} 不是 M·T+1（T = {t}）")
        if t % 2 != 0:
            bad.append(f"{tag} 每支路抽头数 {t + 1} 对应的 T = {t} 不是偶数")
        if e["pad_to"] != m * (t + 1):
            bad.append(f"{tag} pad_to 与 M·(T+1) 不符")
        if len(e["half"]) != (n + 1) // 2:
            bad.append(f"{tag} 半表长度不符：{len(e['half'])} 对 {(n + 1) // 2}")
            continue
        h = expand(e)
        for k in range(n // 2):
            if h[k] != h[n - 1 - k]:
                bad.append(f"{tag} 镜像后第 {k} 个抽头不逐位对称")
                break
        if np.any(h[n:] != 0.0):
            bad.append(f"{tag} 零填充区不是精确的零")
        s = float(np.sum(h))
        if abs(s - 1.0) > 1e-12:
            bad.append(f"{tag} 通带增益归一失效：sum(h) = {s!r}")
        atten, ripple = _measure(h, m)
        if atten < STOPBAND_ATTEN_MIN_DB:
            bad.append(f"{tag} 阻带 {atten:.2f} dB < {STOPBAND_ATTEN_MIN_DB}")
        if ripple > PASSBAND_RIPPLE_MAX_DB:
            bad.append(f"{tag} 通带纹波 {ripple:.4f} dB > {PASSBAND_RIPPLE_MAX_DB}")
    return bad


def build() -> dict:
    return {
        "schema": "cuav-fir-table/1",
        "version": VERSION,
        "purpose": "多相 FFT 信道化的原型低通冻结系数表（04 §7.7「多相滤波器组」；06 §9D M-3）。"
                   "只存半表，装载时镜像展开再零填充到 pad_to，对称性因此逐位成立。",
        "generator": "uv run --quiet --with scipy --with numpy python scripts/design_pfb_fir.py --write",
        "spec": {
            "method": "Parks-McClellan 等波纹（scipy.signal.remez）",
            "passband_edge_rel_out": PASSBAND_EDGE_REL_OUT,
            "stopband_edge_rel_out": STOPBAND_EDGE_REL_OUT,
            "stopband_atten_min_dB": STOPBAND_ATTEN_MIN_DB,
            "passband_ripple_max_dB": PASSBAND_RIPPLE_MAX_DB,
            "gain": "sum(h) = 1，子信道中心的单音过滤波器组后幅度不变",
            "taps": "N = M·T+1，T 取偶数：N 为奇数使群时延为整数输入样点（08 §8 口径二），"
                    "且 gd = M·T/2 是 M 的整数倍，使常数相位 exp(-j2πk·gd/M) 恒为 1。"
                    "装载时零填充到 pad_to = M·(T+1) 让 M 条支路等长；补零不改变 H(ω)。",
            "note": "归一化到输入采样率：通带 [0, 0.4/M]、阻带 [0.5/M, 0.5] 周/样点。"
                    "临界抽取的固有后果：相邻子信道的过渡带折进本路的外侧 20%，"
                    "可用子带是 ±0.4·fs_out，0.4…0.5 之间有邻道残留。",
        },
        "entries": [design(m) for m in CHANNELS],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="设计并冻结多相 FFT 信道化的原型低通系数表")
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
        print(f"  M = {e['channels']:>2}  抽头 {e['ntaps']:>5}  支路 {e['taps_per_branch']:>3}  "
              f"群时延 {e['group_delay_in']:>4}（= {e['group_delay_in'] // e['channels']}·M）  "
              f"阻带 {e['stopband_atten_dB']:.2f} dB  纹波 {e['passband_ripple_dB']:.4f} dB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
