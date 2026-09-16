#!/usr/bin/env python3
"""接收滤波 RxFilter 的 Python 参考实现（06 备忘录 §9D M-3；04 §7.5、§15.2 算例 5）。

这是三方互证里的**独立第二实现**：与 MATLAB / Coder 产物只共享
`models/receiver/fir_rx_v1.json` 这一份**数据**，代码各写各的。MATLAB 那边是一句
`filter(h, 1, x, zi)`，这边自己维护历史缓冲逐样点卷积 —— 两条不同的路径算同一件事，
「分块喂等于整段喂」于是成为被验证的结论，而不是借来的性质。

建模对象是接收机的**模拟预选 / 中频滤波**：不抽取，只做幅频响应与群时延。

**群时延照扣**（08 报告 §8 口径二）：本类给出的是**组件**的行为，即输出样点 m 对应输入样点 m
（丢掉因果输出最前面的 gd 个，末尾也不补零）。Coder 内核给的是因果输出 y(n) = Σ h(k)·x(n-k+1)，
峰值在 n+gd —— 两者差的正是封装层要扣掉的那一段。不扣会怎样：下游三处断言照样过
（样点编号仍连续），流却整体晚了 gd 个样点，而 D-069 刚把「源怎么发的」与「真值怎么记的」
对齐到 0.0 ns。这种「不报错只是错了」正是口径二要写成规矩而不是惯例的理由。

用法：
    uv run --quiet --with numpy python algos/reference/rx_filter.py --selftest

路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TABLE_REL = os.path.join("models", "receiver", "fir_rx_v1.json")


def load_table(path: str | None = None) -> dict:
    """读冻结系数表，半表镜像成全表。与 C++ rx_fir_expand 逐字同法。"""
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
        out[float(e["bw_rel"])] = {
            "ntaps": n,
            "group_delay": int(e["group_delay_in"]),
            "h": h,
            "stopband_atten_dB": e["stopband_atten_dB"],
            "passband_ripple_dB": e["passband_ripple_dB"],
        }
    return out


def lookup(table: dict, bw_rel: float):
    """按相对通带查表，相对容差 1e-9。与 C++ rx_fir_v1() 同判据。

    容差只吃「两个 double 相除」的表示误差，**不是取最近一档**：差得更远一律返回 None，
    由调用方报错并列出可取的值（铁律 15）。
    """
    for r, e in table.items():
        if abs(bw_rel - r) <= 1e-9 * r:
            return e
    return None


class RxFilter:
    """分块带状态的接收滤波，群时延已扣除。状态跨块保持，结果与块长无关。"""

    def __init__(self, bw_rel: float, table: dict | None = None):
        tab = table if table is not None else load_table()
        e = lookup(tab, bw_rel)
        if e is None:
            raise ValueError(f"相对通带 {bw_rel} 不在冻结抽头表内，支持的取值是 "
                             + " / ".join(f"{k:g}" for k in sorted(tab)))
        if e["ntaps"] % 2 == 0 or e["group_delay"] * 2 != e["ntaps"] - 1:
            raise ValueError("抽头表内部不一致：抽头数必须是奇数且群时延等于 (N-1)/2")
        self.ntaps = e["ntaps"]
        self.group_delay = e["group_delay"]
        self.h = e["h"]
        self.hist = np.zeros(self.ntaps - 1, dtype=np.complex128)
        self.next = self.group_delay      # 时间锚：第一个输出取在因果输出的第 gd 个
        self.n_in = 0

    def block(self, x: np.ndarray) -> np.ndarray:
        n = int(x.size)
        hn = self.ntaps - 1
        work = np.empty(hn + n, dtype=np.complex128)
        work[:hn] = self.hist
        work[hn:] = x

        ps = np.arange(self.next, n, 1, dtype=np.int64)
        if ps.size:
            idx = (hn + ps)[:, None] - np.arange(self.ntaps, dtype=np.int64)[None, :]
            outs = (work[idx] @ self.h).astype(np.complex64)
        else:
            outs = np.zeros(0, dtype=np.complex64)

        self.next = max(0, self.next - n)
        self.hist = work[n:n + hn].copy()
        self.n_in += n
        return outs

    def out_count_expected(self) -> int:
        gd = self.group_delay
        return self.n_in - gd if self.n_in > gd else 0


def run(x: np.ndarray, bw_rel: float, block: int = 4096, table: dict | None = None) -> np.ndarray:
    st = RxFilter(bw_rel, table)
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
    for r in (0.3, 0.5, 0.8):
        f = 0.25 * (r / 2) * fs
        n = np.arange(100000)
        x = np.exp(2j * np.pi * f * n / fs).astype(np.complex64)
        y = run(x, r, table=tab)
        amp = float(np.mean(np.abs(y[500:])))
        rip = tab[r]["passband_ripple_dB"]
        if abs(20 * math.log10(amp)) > rip:
            bad.append(f"bw_rel={r} 通带增益 {20*math.log10(amp):+.4f} dB 超出纹波 {rip:.4f} dB")

    # ② 阻带抑制：落在阻带内的单音被压到原型指标
    for r in (0.3, 0.5, 0.8):
        att_min = float(tab[r]["stopband_atten_dB"])
        f = (r / 2 + 0.05 + 0.02) * fs            # 阻带边再往里一点
        if f >= 0.5 * fs:
            f = 0.48 * fs
        n = np.arange(100000)
        x = np.exp(2j * np.pi * f * n / fs).astype(np.complex64)
        y = run(x, r, table=tab)
        amp = float(np.mean(np.abs(y[2000:])))
        att = -20 * math.log10(max(amp, 1e-30))
        if att < att_min - 0.5:
            bad.append(f"bw_rel={r} 阻带抑制只有 {att:.2f} dB，指标是 {att_min:.2f} dB")

    # ③ 群时延已扣除：输入 n0 处的冲激，输出峰值就在 n0，偏差 0 样点
    for r in (0.2, 0.5, 0.8):
        gd = tab[r]["group_delay"]
        n0 = 500
        x = np.zeros(n0 + 4 * gd + 16, dtype=np.complex64)
        x[n0] = 1.0
        y = run(x, r, table=tab)
        peak = int(np.argmax(np.abs(y)))
        if peak != n0:
            bad.append(f"bw_rel={r} 冲激峰值在 {peak}，扣除群时延后应当就是 {n0}")

    # ④ 块长无关：同一条流按不同块长切，结果逐位相同
    rng = np.random.default_rng(20260916)
    x = (rng.standard_normal(30000) + 1j * rng.standard_normal(30000)).astype(np.complex64)
    ref = run(x, 0.8, block=4096, table=tab)
    for b in (1, 7, 997, 65536):
        got = run(x, 0.8, block=b, table=tab)
        if got.size != ref.size or not np.array_equal(got, ref):
            bad.append(f"块长 {b} 的结果与块长 4096 不同")

    # ⑤ 查表容差只吃表示误差，不取最近一档
    if lookup(tab, 800000.0 / 1000000.0) is None:
        bad.append("0.8 由两个 double 相除得到时查不到表：容差太紧")
    if lookup(tab, 0.79) is not None or lookup(tab, 0.9) is not None:
        bad.append("查表把不在表里的值匹配上了：容差太松，成了「取最近一档」")

    for b in bad:
        print(f"不合格：{b}")
    if bad:
        return 1
    print("接收滤波参考实现自检通过：通带增益 / 阻带抑制 / 群时延已扣除 / 块长无关 / 查表容差")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="接收滤波参考实现")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return _selftest()
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
