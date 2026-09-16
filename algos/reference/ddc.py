#!/usr/bin/env python3
"""DDC 的 Python 参考实现（06 备忘录 §9D M-2；04 §7.7）。

这是三方互证里的**独立第二实现**：与引擎 `engine/src/dsp.cpp` 只共享
`models/adc-ddc/fir_lp_v1.json` 这一份**数据**，代码各写各的。

两条写法是契约，必须与 C++ 逐字同序（铁律 10）：
  ① NCO 相位以**圈**计，不以弧度计。2π 不是精确可表示的二进制数，每次回卷注入一次舍入；
     而 [1,2) 区间减 1.0 指数不变、尾数对齐，结果精确。于是相位序列只是「已处理输入样点数」
     的函数：与块长无关、逐位复现、跨语言逐位相同（唯一分歧在 cos/sin 的末位）。
  ② FIR 点积按抽头**升序**累加。

时间锚（08 报告 §8 口径一、二）：输出样点 m ↔ 输入样点 m·D。实现方式是把抽取相位的初值
置为群时延 gd，于是第一个输出取在绝对输入样点 gd，其对称窗口覆盖输入 [-gd, +gd]。

用法：
    uv run --quiet --with numpy python algos/reference/ddc.py --selftest

路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TABLE_REL = os.path.join("models", "adc-ddc", "fir_lp_v1.json")


def load_table(path: str | None = None) -> dict:
    """读冻结系数表，半表镜像成全表。与 C++ ddc_fir_expand 逐字同法。"""
    p = path or os.path.join(_ROOT, TABLE_REL)
    with open(p, encoding="utf-8") as fh:
        doc = json.load(fh)
    out = {}
    for e in doc["entries"]:
        n = int(e["ntaps"])
        half = e["half"]
        h = np.empty(n, dtype=np.float64)
        m = (n + 1) // 2
        for k in range(m):
            h[k] = half[k]
            h[n - 1 - k] = half[k]
        out[int(e["decim"])] = {
            "ntaps": n,
            "group_delay": int(e["group_delay_in"]),
            "h": h,
            "stopband_atten_dB": e["stopband_atten_dB"],
            "passband_ripple_dB": e["passband_ripple_dB"],
        }
    return out


def phase_step(f_shift_Hz: float, fs_Hz: float) -> float:
    """每输入样点的相位增量，单位「圈」，落在 [0,1)。"""
    if not fs_Hz > 0.0:
        return 0.0
    r = f_shift_Hz / fs_Hz
    return r - math.floor(r)


class Ddc:
    """分块带状态的 DDC。状态跨块保持，结果与块长无关。"""

    def __init__(self, decim: int, f_shift_Hz: float, fs_Hz: float, table: dict | None = None):
        tab = table if table is not None else load_table()
        if decim not in tab:
            raise ValueError(f"抽取比 {decim} 不在冻结抽头表内，支持的取值是 "
                             + " / ".join(str(k) for k in sorted(tab)))
        e = tab[decim]
        if e["ntaps"] % 2 == 0 or e["group_delay"] * 2 != e["ntaps"] - 1:
            raise ValueError("抽头表内部不一致：抽头数必须是奇数且群时延等于 (N-1)/2")
        self.decim = decim
        self.ntaps = e["ntaps"]
        self.group_delay = e["group_delay"]
        self.h = e["h"]
        self.hist = np.zeros(self.ntaps - 1, dtype=np.complex128)
        self.phase = 0.0
        self.dphi = phase_step(f_shift_Hz, fs_Hz)
        self.next = self.group_delay          # 时间锚就在这一行
        self.n_in = 0

    def block(self, x: np.ndarray) -> np.ndarray:
        """处理一块，返回本块产出的输出样点（可能是空的）。"""
        n = int(x.size)
        nt = self.ntaps
        hn = nt - 1
        two_pi = 6.28318530717958647692

        # ① 历史 + 本块线性拼接
        work = np.empty(hn + n, dtype=np.complex128)
        work[:hn] = self.hist

        # ② 混频：乘 exp(-j2π·f_shift·t)
        ph = self.phase
        for i in range(n):
            th = -two_pi * ph
            c = math.cos(th)
            s = math.sin(th)
            xr = float(x[i].real)
            xi = float(x[i].imag)
            work[hn + i] = complex(xr * c - xi * s, xr * s + xi * c)
            ph += self.dphi
            if ph >= 1.0:
                ph -= 1.0
        self.phase = ph

        # ③ 低通 + 抽取。升序累加是契约，不用 numpy 的 dot：
        #    成对求和与顺序累加在最后几位上不同（D-046 ⑧ 踩过同一个坑）。
        outs = []
        p = self.next
        h = self.h
        while p < n:
            top = hn + p
            ar = 0.0
            ai = 0.0
            for k in range(nt):
                v = work[top - k]
                ar += h[k] * v.real
                ai += h[k] * v.imag
            outs.append(complex(ar, ai))
            p += self.decim
        self.next = p - n

        # ④ 留史：work 的末 hn 项（n < hn 时同样正确）
        self.hist = work[n:n + hn].copy()
        self.n_in += n
        return np.asarray(outs, dtype=np.complex64) if outs else np.zeros(0, dtype=np.complex64)

    def out_count_expected(self) -> int:
        """已吃进 n_in 个输入时应当产出的输出样点数（闭式，进单测）。"""
        return (self.n_in - 1 - self.group_delay) // self.decim + 1 if self.n_in > self.group_delay else 0


def run(x: np.ndarray, decim: int, f_shift_Hz: float, fs_Hz: float,
        block: int = 4096, table: dict | None = None) -> np.ndarray:
    st = Ddc(decim, f_shift_Hz, fs_Hz, table)
    parts = []
    for i in range(0, int(x.size), block):
        parts.append(st.block(x[i:i + block]))
    got = np.concatenate(parts) if parts else np.zeros(0, dtype=np.complex64)
    assert got.size == st.out_count_expected(), (got.size, st.out_count_expected())
    return got


def _selftest() -> int:
    tab = load_table()
    fs = 1.0e7
    bad = []

    # ① 通带增益：落在通带内的单音幅度不变（在纹波之内）
    for d in (2, 4, 10):
        f = 0.25 * (0.4 * fs / d)                       # 通带边的四分之一处
        n = np.arange(200000)
        x = np.exp(2j * np.pi * f * n / fs).astype(np.complex64)
        y = run(x, d, 0.0, fs, table=tab)
        amp = float(np.mean(np.abs(y[1000:])))
        rip = tab[d]["passband_ripple_dB"]
        if abs(20 * math.log10(amp)) > rip:
            bad.append(f"D={d} 通带增益 {20*math.log10(amp):+.4f} dB 超出纹波 {rip:.4f} dB")

    # ② 阻带抑制：落在阻带内的单音被压 ≥ 60 dB
    for d in (2, 4, 10):
        f = 0.75 * (fs / 2)                              # 深阻带
        if d == 2:
            f = 0.40 * fs                                # D=2 的阻带从 0.125·fs 起
        n = np.arange(200000)
        x = np.exp(2j * np.pi * f * n / fs).astype(np.complex64)
        y = run(x, d, 0.0, fs, table=tab)
        amp = float(np.mean(np.abs(y[2000:])))
        att = -20 * math.log10(max(amp, 1e-30))
        if att < 60.0:
            bad.append(f"D={d} 阻带抑制只有 {att:.2f} dB")

    # ③ 群时延：输入 n0 处的冲激，输出峰值落在 m = n0/D，偏差 0 样点
    for d in (2, 4, 5, 10):
        gd = tab[d]["group_delay"]
        n0 = d * 500
        x = np.zeros(n0 + 4 * gd + 4 * d, dtype=np.complex64)
        x[n0] = 1.0
        y = run(x, d, 0.0, fs, table=tab)
        peak = int(np.argmax(np.abs(y)))
        if peak != n0 // d:
            bad.append(f"D={d} 冲激峰值在 m={peak}，应当是 {n0 // d}")

    # ④ 块长无关：同一条流按不同块长切，结果逐位相同
    rng = np.random.default_rng(20260916)
    x = (rng.standard_normal(60000) + 1j * rng.standard_normal(60000)).astype(np.complex64)
    ref = run(x, 4, -2.5e6, fs, block=4096, table=tab)
    for b in (1, 7, 997, 65536):
        got = run(x, 4, -2.5e6, fs, block=b, table=tab)
        if got.size != ref.size or not np.array_equal(got, ref):
            bad.append(f"块长 {b} 的结果与块长 4096 不同")

    # ⑤ D=1 是纯频移：群时延 0、样点数不变、逐样点等于 x·exp(-j2πft/fs)
    x = (rng.standard_normal(5000) + 1j * rng.standard_normal(5000)).astype(np.complex64)
    y = run(x, 1, -2.5e6, fs, table=tab)
    n = np.arange(x.size)
    want = (x.astype(np.complex128) * np.exp(-2j * np.pi * 0.75 * n)).astype(np.complex64)
    if y.size != x.size:
        bad.append(f"D=1 样点数 {y.size} 应当是 {x.size}")
    else:
        rel = float(np.max(np.abs(y - want)) / max(float(np.max(np.abs(want))), 1e-30))
        if rel > 1e-6:
            bad.append(f"D=1 与解析频移的最大相对差 {rel:.3e}")

    for b in bad:
        print(f"不合格：{b}")
    if bad:
        return 1
    print("DDC 参考实现自检通过：通带增益 / 阻带抑制 / 群时延对齐 / 块长无关 / D=1 纯频移")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DDC 参考实现")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return _selftest()
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
