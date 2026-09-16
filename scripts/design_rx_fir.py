#!/usr/bin/env python3
"""设计并冻结接收滤波 RxFilter 的系数表（06 备忘录 §9D M-3）。

真理源是 `models/receiver/fir_rx_v1.json`；引擎侧的 C++ 表由 `scripts/gen_rx_taps.py`
从它生成，Python 参考 `algos/reference/rx_filter.py` 也读它。三方共享的只有这一份**数据**。
与 `scripts/design_ddc_fir.py`、`scripts/design_pfb_fir.py` 是姊妹脚本，口径刻意一致。

这一件建模的是**接收机的模拟预选 / 中频滤波**（04 §7.5、附录 A 的「滤波」一项；
标准算例第 5 项「接收滤波和群时延」）。它**不抽取**，只做幅频响应与群时延：
输出采样率等于输入采样率，输出样点 m 对应输入样点 m（群时延由封装层扣除，08 §8 口径二）。

建档的键是**相对通带** bw_rel = bw_Hz / fs_in，不是绝对的 Hz：模拟滤波器的带宽本来就
按「占奈奎斯特带的多少」来谈，而同一个 bw_rel 在任何采样率下是同一条归一化响应。
用户在框图上填的仍是 `bw_Hz`（场景里 sites[].receiver.bw_Hz 直接带出来），
组件在**收到第一块、知道 fs 之后**再查表；查不到就报错并列出该 fs 下可取的 bw_Hz，
不静默顶替、也不四舍五入到最近一档（铁律 15）。

设计口径（周/样点，量程 0…0.5，与 remez 的 fs=1.0 口径一致）：
    fp  = bw_rel / 2                 通带边（复基带双边占用 bw_rel·fs，故半宽是 bw_rel/2）
    fst = fp + TRANSITION_REL        阻带边，过渡带各档同宽
阻带 >= 60 dB、通带纹波 <= 0.2 dB、**抽头数取奇数**使群时延 (N-1)/2 为整数个输入样点。
bw_rel 上不去 0.9：fst 会顶到奈奎斯特 0.5，阻带退化成一个点，无解。

只存半表（含中心抽头），装载时镜像展开，理由同 design_ddc_fir.py。
主设计走 scipy（BSD，任何机器都能复算），MATLAB 的 firpm 作独立校验，
见 matlab/design/check_rx_fir.m。

用法：
    uv run --quiet --with scipy --with numpy python scripts/design_rx_fir.py            # 只校验
    uv run --quiet --with scipy --with numpy python scripts/design_rx_fir.py --write    # 重写表

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
_TABLE_REL = os.path.join("models", "receiver", "fir_rx_v1.json")

VERSION = "rx_v1"
# 相对通带档位。0.8 是本项目所有示例场景的实际取值（demo-01/03 是 400 kHz / 500 kS/s，
# demo-02 是 8 MHz / 10 MS/s，都正好 0.8）。不设 0.9 及以上：过渡带会顶到奈奎斯特。
BW_RELS = (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)

TRANSITION_REL = 0.05            # 过渡带宽，相对输入采样率；各档同宽
STOPBAND_ATTEN_MIN_DB = 60.0
PASSBAND_RIPPLE_MAX_DB = 0.2

_WEIGHT = (1.0, 10.0)
_N_MAX = 501


def _symmetrize(h: np.ndarray) -> np.ndarray:
    """强制偶对称：remez 的输出只是数值上近似对称，这里取两端平均一次钉死。"""
    n = h.size
    out = h.astype(np.float64).copy()
    for k in range(n // 2):
        v = 0.5 * (out[k] + out[n - 1 - k])
        out[k] = v
        out[n - 1 - k] = v
    return out


def _edges(bw_rel: float) -> tuple[float, float]:
    fp = bw_rel / 2.0
    return (fp, fp + TRANSITION_REL)


def _measure(h: np.ndarray, bw_rel: float) -> tuple[float, float]:
    """返回 (阻带最大增益 dB 的相反数, 通带峰峰纹波 dB)。"""
    fp, fst = _edges(bw_rel)
    wst = np.linspace(2.0 * math.pi * fst, math.pi, 8192)
    _, hst = freqz(h, 1.0, worN=wst)
    atten = -20.0 * math.log10(float(np.max(np.abs(hst))))
    wp = np.linspace(0.0, 2.0 * math.pi * fp, 4096)
    _, hp = freqz(h, 1.0, worN=wp)
    mag = np.abs(hp)
    ripple = 20.0 * math.log10(float(np.max(mag)) / float(np.min(mag)))
    return (atten, ripple)


def design(bw_rel: float) -> dict:
    """设计一档，返回条目。抽头数从 Kaiser 估阶起按 +2 递增到达标为止。"""
    fp, fst = _edges(bw_rel)
    if fst >= 0.5:
        raise SystemExit(f"bw_rel = {bw_rel} 的阻带边 {fst} 顶到奈奎斯特，无解")

    n0 = int(math.ceil(STOPBAND_ATTEN_MIN_DB / (22.0 * TRANSITION_REL)))
    if n0 % 2 == 0:
        n0 += 1
    n0 = max(n0, 3)

    for k in range(0, (_N_MAX - n0) // 2 + 1):
        n = n0 + 2 * k
        try:
            h = remez(n, [0.0, fp, fst, 0.5], [1.0, 0.0], weight=_WEIGHT, maxiter=60, fs=1.0)
        except Exception:
            continue
        h = _symmetrize(h)
        s = float(np.sum(h))
        if not (abs(s) > 1e-12):
            continue
        h = h / s                       # 通带增益归一：通带内单音过滤波器后幅度不变
        h = _symmetrize(h)
        atten, ripple = _measure(h, bw_rel)
        if atten >= STOPBAND_ATTEN_MIN_DB and ripple <= PASSBAND_RIPPLE_MAX_DB:
            return {
                "bw_rel": bw_rel,
                "ntaps": n,
                "group_delay_in": (n - 1) // 2,
                "stopband_atten_dB": round(atten, 4),
                "passband_ripple_dB": round(ripple, 6),
                "half": [float(v) for v in h[: (n + 1) // 2]],
            }
    raise SystemExit(f"bw_rel = {bw_rel} 在 {_N_MAX} 抽头内没有达标的设计")


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
    bad: list[str] = []
    if doc.get("version") != VERSION:
        bad.append(f"版本不是 {VERSION}")
    got = tuple(e["bw_rel"] for e in doc["entries"])
    if got != BW_RELS:
        bad.append(f"相对通带清单不符：{got} 对 {BW_RELS}")
        return bad
    for e in doc["entries"]:
        r, n = e["bw_rel"], e["ntaps"]
        tag = f"bw_rel = {r}"
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
        atten, ripple = _measure(h, r)
        if atten < STOPBAND_ATTEN_MIN_DB:
            bad.append(f"{tag} 阻带 {atten:.2f} dB < {STOPBAND_ATTEN_MIN_DB}")
        if ripple > PASSBAND_RIPPLE_MAX_DB:
            bad.append(f"{tag} 通带纹波 {ripple:.4f} dB > {PASSBAND_RIPPLE_MAX_DB}")
    return bad


def build() -> dict:
    return {
        "schema": "cuav-fir-table/1",
        "version": VERSION,
        "purpose": "接收滤波 RxFilter 的冻结系数表（04 §7.5 与附录 A 的「滤波」；06 §9D M-3）。"
                   "不抽取，只做幅频响应与群时延。只存半表，装载时镜像展开。",
        "generator": "uv run --quiet --with scipy --with numpy python scripts/design_rx_fir.py --write",
        "spec": {
            "method": "Parks-McClellan 等波纹（scipy.signal.remez）",
            "key": "bw_rel = bw_Hz / fs_in，复基带双边占用；组件收到首块知道 fs 后再查表",
            "passband_edge_rel_fs": "bw_rel / 2",
            "transition_rel_fs": TRANSITION_REL,
            "stopband_atten_min_dB": STOPBAND_ATTEN_MIN_DB,
            "passband_ripple_max_dB": PASSBAND_RIPPLE_MAX_DB,
            "gain": "sum(h) = 1，通带内单音过滤波器后幅度不变",
            "note": "不设 bw_rel >= 0.9：阻带边 bw_rel/2 + 0.05 会顶到奈奎斯特 0.5。"
                    "群时延 (N-1)/2 个输入样点由封装层扣除，于是输出样点 m 对应输入样点 m。",
        },
        "entries": [design(r) for r in BW_RELS],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="设计并冻结接收滤波系数表")
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
        fp, fst = _edges(e["bw_rel"])
        print(f"  bw_rel = {e['bw_rel']:.1f}  通带边 {fp:.3f}  阻带边 {fst:.3f}  "
              f"抽头 {e['ntaps']:>3}  群时延 {e['group_delay_in']:>3}  "
              f"阻带 {e['stopband_atten_dB']:.2f} dB  纹波 {e['passband_ripple_dB']:.4f} dB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
