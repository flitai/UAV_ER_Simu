#!/usr/bin/env python3
"""多相 FFT 信道化的 Python 参考实现（06 备忘录 §9D M-3；04 §7.7、§15.2 算例 8）。

这是三方互证里的**独立第二实现**：与 MATLAB / Coder 产物只共享
`models/channelizer/fir_pfb_v1.json` 这一份**数据**，代码各写各的。

**本文件刻意用「直接式」，不照抄多相 + FFT 的结构**：

    y_k[m] = Σ_n h[n]·x[p-n]·exp(-j2πk(p-n)/M),    p = m·M + gd

先按子信道中心频率搬移、再滤波、再抽取，一路照定义算。这样它验的就不只是「同一套算术有没有
写错」，而是**多相恒等式本身成不成立** —— 如果哪天原型表的抽头数不再满足 N = M·T+1、
或者 gd 不再是 M 的整数倍，多相那边会悄悄多出一个逐信道的常数相位，而这边照定义算不会，
两边当场对不上。把常数相位 exp(-j2πk·p/M) **显式留在式子里**也是为此：不预先把它约掉，
「它恒等于 1」就成了一条被验证的结论，而不是一条被假定的前提。

**与 DDC 参考的一处不同**：那边逐字规定了累加次序（升序、不用 numpy.dot），为的是换来
float32 逐位相同。这边**不作这种承诺，也不该作** —— MATLAB 的 fft 走 FFTW、Coder 生成的是
自带的基 2 实现、numpy 走 pocketfft，三家的蝶形次序与旋转因子求值本来就不同。
M-3 的验收判据是 rel <= 1e-9（06 §9D），不是逐位。次序不同反而使这一路对拍更有力：
它是真的另一条计算路径，不是同一条路径的转写。

时间锚（08 报告 §8 口径一、二）：输出样点 m ↔ 输入样点 m·M。实现方式与 DDC 同：
把换向器相位的初值置为群时延 gd。

用法：
    uv run --quiet --with numpy python algos/reference/channelizer.py --selftest

路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TABLE_REL = os.path.join("models", "channelizer", "fir_pfb_v1.json")


def load_table(path: str | None = None) -> dict:
    """读冻结原型表，半表镜像成全表再零填充到 pad_to。与 C++ pfb_fir_expand 逐字同法。"""
    p = path or os.path.join(_ROOT, TABLE_REL)
    with open(p, encoding="utf-8") as fh:
        doc = json.load(fh)
    out = {}
    for e in doc["entries"]:
        n = int(e["ntaps"])
        pad = int(e["pad_to"])
        half = e["half"]
        h = np.zeros(pad, dtype=np.float64)
        m = (n + 1) // 2
        for k in range(m):
            h[k] = half[k]
            h[n - 1 - k] = half[k]
        out[int(e["channels"])] = {
            "ntaps": n,
            "pad_to": pad,
            "taps_per_branch": int(e["taps_per_branch"]),
            "group_delay": int(e["group_delay_in"]),
            "h": h,
            "stopband_atten_dB": e["stopband_atten_dB"],
            "passband_ripple_dB": e["passband_ripple_dB"],
        }
    return out


def raw_bin(select_channel: int, channels: int) -> int:
    """界面编号 j（相对中心从低到高，j = M/2 是零频）→ 原始 FFT 下标 k（中心频率 k·fs/M）。

    j = 0 是**带边**那一路（中心 ±fs/2，频带绕过奈奎斯特），临界抽取滤波器组里它合法，
    但作缺省最差 —— 组件的缺省取 channels/2，即零频那一路（D-071 对 10 报告 §3.7 的一处偏离）。
    """
    return (select_channel + channels // 2) % channels


def center_offset_Hz(select_channel: int, channels: int, fs_in_Hz: float) -> float:
    """所选子信道相对输入中心频率的偏移。输出中心 = 输入中心 + 本值。"""
    return (select_channel - channels // 2) * (fs_in_Hz / channels)


class Channelizer:
    """分块带状态的信道化，只输出一路子信道。状态跨块保持，结果与块长无关。"""

    def __init__(self, channels: int, select_channel: int, table: dict | None = None):
        tab = table if table is not None else load_table()
        if channels not in tab:
            raise ValueError(f"子信道数 {channels} 不在冻结原型表内，支持的取值是 "
                             + " / ".join(str(k) for k in sorted(tab)))
        if not (0 <= select_channel < channels):
            raise ValueError(f"select_channel 必须落在 [0, {channels})，给的是 {select_channel}")
        e = tab[channels]
        if e["ntaps"] % 2 == 0 or e["group_delay"] * 2 != e["ntaps"] - 1:
            raise ValueError("原型表内部不一致：抽头数必须是奇数且群时延等于 (N-1)/2")
        self.M = channels
        self.j = select_channel
        self.k = raw_bin(select_channel, channels)
        self.P = e["pad_to"]
        self.group_delay = e["group_delay"]
        self.h = e["h"]
        self.hist = np.zeros(self.P - 1, dtype=np.complex128)
        self.next = self.group_delay          # 时间锚就在这一行
        self.n_in = 0
        self.m_out = 0
        # B[n] = h[n]·exp(+j2πk·n/M)：直接式里与 m 无关的那一半，预先算好
        n = np.arange(self.P, dtype=np.float64)
        self.B = self.h * np.exp(2j * math.pi * self.k * n / self.M)

    def block(self, x: np.ndarray) -> np.ndarray:
        """处理一块，返回本块产出的输出样点（可能是空的）。"""
        n = int(x.size)
        hn = self.P - 1
        work = np.empty(hn + n, dtype=np.complex128)
        work[:hn] = self.hist
        work[hn:] = x

        # 本块能产出哪些输出：p 在块内推进，跨块由 self.next 递延
        ps = np.arange(self.next, n, self.M, dtype=np.int64)
        if ps.size:
            # 每个输出取一段长 P 的**倒序**窗口 x[p-n]，n = 0..P-1
            idx = (hn + ps)[:, None] - np.arange(self.P, dtype=np.int64)[None, :]
            win = work[idx]                              # (n_out, P)
            acc = win @ self.B                           # Σ_n h[n]·exp(+j2πkn/M)·x[p-n]
            # 常数相位显式留着，不预先约掉：它恒为 1 是要被验证的结论
            m0 = self.m_out
            mm = np.arange(m0, m0 + ps.size, dtype=np.float64)
            p_abs = mm * self.M + self.group_delay
            out = acc * np.exp(-2j * math.pi * self.k * p_abs / self.M)
            self.m_out += int(ps.size)
            outs = out.astype(np.complex64)
        else:
            outs = np.zeros(0, dtype=np.complex64)

        self.next = int(ps[-1]) + self.M - n if ps.size else self.next - n
        self.hist = work[n:n + hn].copy()
        self.n_in += n
        return outs

    def out_count_expected(self) -> int:
        """已吃进 n_in 个输入时应当产出的输出样点数（闭式，进单测）。"""
        gd = self.group_delay
        return (self.n_in - 1 - gd) // self.M + 1 if self.n_in > gd else 0


def run(x: np.ndarray, channels: int, select_channel: int,
        block: int = 4096, table: dict | None = None) -> np.ndarray:
    st = Channelizer(channels, select_channel, table)
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

    # ① 子信道中心的单音：增益恰为 1（sum(h) = 1 的直接后果），且输出是实的
    #    —— 「常数相位恒为 1」的可观测形式。gd 不再是 M 的整数倍时这一条先红。
    for M in (2, 4, 8):
        for j in range(M):
            f = center_offset_Hz(j, M, fs)
            n = np.arange(20000)
            x = np.exp(2j * np.pi * f * n / fs).astype(np.complex64)
            y = run(x, M, j, table=tab)
            amp = float(np.mean(np.abs(y[200:])))
            if abs(20 * math.log10(amp)) > 1e-6:
                bad.append(f"M={M} j={j} 中心增益 {20*math.log10(amp):+.3e} dB，应为 0")
            im = float(np.max(np.abs(np.imag(y[200:]))))
            if im > 1e-5:
                bad.append(f"M={M} j={j} 输出虚部 {im:.3e} 不在舍入量级：常数相位没有约掉")

    # ② 邻道抑制：信号落在隔壁子信道中心时，本路读到的不高于原型阻带
    for M in (4, 8):
        att_min = float(tab[M]["stopband_atten_dB"])
        for j in (0, M // 2, M - 1):
            f = center_offset_Hz((j + 1) % M, M, fs)
            n = np.arange(40000)
            x = np.exp(2j * np.pi * f * n / fs).astype(np.complex64)
            y = run(x, M, j, table=tab)
            amp = float(np.mean(np.abs(y[2000:])))
            att = -20 * math.log10(max(amp, 1e-30))
            if att < att_min - 0.5:
                bad.append(f"M={M} j={j} 邻道抑制只有 {att:.2f} dB，原型阻带是 {att_min:.2f} dB")

    # ③ 群时延：输入 n0 处的冲激，输出峰值落在 m = n0/M，偏差 0 样点
    for M in (2, 4, 8, 16):
        gd = tab[M]["group_delay"]
        n0 = M * 300
        x = np.zeros(n0 + 4 * gd + 4 * M, dtype=np.complex64)
        x[n0] = 1.0
        y = run(x, M, M // 2, table=tab)
        peak = int(np.argmax(np.abs(y)))
        if peak != n0 // M:
            bad.append(f"M={M} 冲激峰值在 m={peak}，应当是 {n0 // M}")

    # ④ 块长无关：同一条流按不同块长切，结果逐位相同
    rng = np.random.default_rng(20260916)
    x = (rng.standard_normal(40000) + 1j * rng.standard_normal(40000)).astype(np.complex64)
    ref = run(x, 8, 5, block=4096, table=tab)
    for b in (1, 7, 997, 65536):
        got = run(x, 8, 5, block=b, table=tab)
        if got.size != ref.size or not np.array_equal(got, ref):
            bad.append(f"块长 {b} 的结果与块长 4096 不同")

    # ⑤ 各路能量之和守恒到宽带输入的量级（临界抽取滤波器组不该凭空造出或吞掉能量）
    x = (rng.standard_normal(40000) + 1j * rng.standard_normal(40000)).astype(np.complex64)
    M = 8
    tot = sum(float(np.mean(np.abs(run(x, M, j, table=tab)[500:]) ** 2)) for j in range(M))
    ref_p = float(np.mean(np.abs(x) ** 2))
    if not (0.8 < tot / ref_p < 1.25):
        bad.append(f"M=8 各路功率之和 / 输入功率 = {tot/ref_p:.4f}，离 1 太远")

    for b in bad:
        print(f"不合格：{b}")
    if bad:
        return 1
    print("信道化参考实现自检通过：中心增益 / 常数相位 / 邻道抑制 / 群时延对齐 / "
          "块长无关 / 各路功率之和")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="多相 FFT 信道化参考实现（直接式）")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return _selftest()
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
