#!/usr/bin/env python3
"""分子带检测的参考实现（Q-4b，D-093；原型研究见 subband_study.py 与 WORKLOG 2026-10-04）。

与引擎 `EnergyDetector` 的分子带模式（`subband_bins` = K0 > 0）逐帧同序，黄金基准
`engine/tests/golden/energy_detector_subband.json` 由 `gen_engine_golden.py --mode subband` 用本模块生成。
帧级的全带判决（统计量、门限、命中、段号）一字不动，分子带的结果嵌在每帧那一行里。

每帧的顺序（契约，C++ 同序）：
  ① 频段内每个频点的 Hann 窗功率 P_j（周期 Hann、float32 窗值、float32 FFT，与特征提取同）；
  ② 每个频点各有一个长 W 的环：环空的频点本帧先入环；环变过的重算噪声 n_j = 中位数 / ln 2；
  ③ 多级块：第 l 级块宽 S_l = K0·2^l（S_l ≤ M，M = 频段内频点数），从频段第一个频点起切，尾块保留；
     块统计量 Λ = ΣP / Σn，命中当且仅当 Λ > η(块宽, pfa / 检验总数)；
  ④ 一个块命中、且它下面任何一级的块都没命中，才标记它（第 0 级命中即标记）；
  ⑤ 标记的频点连成串，间隙 ≤ K0 个频点的串并成一簇；
  ⑥ 跨帧连接：先关掉超过 merge_gap_frames 没续上的段；每簇对每个开着的段的**最近 L 帧**频段并集比
     （L = LINK_FRAMES），重叠（容差 K0 个频点）最多的连上，平局取段号小的；没有就开新段。只往前连、
     不重编段号，一个段一帧可以接几个簇；
  ⑦ 删截：标记的频点两边各扩 GUARD_BINS 个频点不入环，其余频点各自入环（满则弹最旧）。
     判决时任一频点已连续超过 W 帧没入环，计一帧陈旧。

门限：Hann 窗下相邻频点的复值相关系数是 −2/3、隔一个 1/6，块统计量在 H0 下是 (1/S)·Σ λ_i E_i
（λ_i 是相关矩阵的特征值，E_i 独立单位指数）。尾部概率用 Lugannani–Rice 鞍点近似；η 按二分求。
原型研究量过：矩匹配的 Gamma 在 Bonferroni 之后的深尾部偏松 1.2–3 倍。特征值这里用 numpy 的
特征分解，引擎用久期方程（相关矩阵 = 三对角 Toeplitz 的平方加角上秩 2 修正，按奇偶拆成两个
「对角 + 秩 1」）——两种独立的方法，门限对拍到 1e-9。
"""
from __future__ import annotations

import bisect
import math
from collections import deque

import numpy as np

LINK_FRAMES = 64            # 连接看的最近帧数 L
GUARD_BINS = 2              # 删截时标记频点两边外扩的频点数（Hann 主瓣）
ALLOWED_K0 = (2, 4, 8, 16, 32, 64)
LN2 = math.log(2.0)


# ---------------------------------------------------------------- 门限

_EIG: dict = {}


def corr_eigs(S: int) -> np.ndarray:
    """周期 Hann 窗下 S 个相邻频点复值相关矩阵（带状 Toeplitz：1、−2/3、1/6）的特征值，升序。"""
    if S not in _EIG:
        R = np.zeros((S, S))
        for i in range(S):
            R[i, i] = 1.0
            if i + 1 < S:
                R[i, i + 1] = R[i + 1, i] = -2.0 / 3.0
            if i + 2 < S:
                R[i, i + 2] = R[i + 2, i] = 1.0 / 6.0
        _EIG[S] = np.linalg.eigvalsh(R)
    return _EIG[S]


def tail(lam, x: float) -> float:
    """P(Σ λ_i E_i > x)，Lugannani–Rice 鞍点近似（C++ dsp::subband_tail 同式同序）。"""
    mean = 0.0
    lmax = 0.0
    for v in lam:
        mean += float(v)
        lmax = max(lmax, float(v))
    if not x > mean:
        return 1.0
    lo, hi = 0.0, (1.0 - 1e-12) / lmax
    for _ in range(200):                      # 解 K'(t) = Σ λ/(1 − λt) = x
        t = 0.5 * (lo + hi)
        k1 = 0.0
        for v in lam:
            k1 += float(v) / (1.0 - float(v) * t)
        if k1 < x:
            lo = t
        else:
            hi = t
    t = 0.5 * (lo + hi)
    K = 0.0
    K2 = 0.0
    for v in lam:
        v = float(v)
        K -= math.log1p(-v * t)
        q = v / (1.0 - v * t)
        K2 += q * q
    w = math.sqrt(2.0 * (t * x - K))
    u = t * math.sqrt(K2)
    return 0.5 * math.erfc(w / math.sqrt(2.0)) + math.exp(-0.5 * w * w) / math.sqrt(2.0 * math.pi) * (1.0 / u - 1.0 / w)


_ETA: dict = {}


def threshold(S: int, pfa_test: float) -> float:
    """块宽 S、单次检验虚警率 pfa_test 的门限 η（Λ = ΣP / Σn 的门限）。"""
    key = (S, pfa_test)
    if key not in _ETA:
        lam = corr_eigs(S)
        lo, hi = 1.0, 200.0
        for _ in range(100):
            m = 0.5 * (lo + hi)
            if tail(lam, S * m) > pfa_test:
                lo = m
            else:
                hi = m
        _ETA[key] = 0.5 * (lo + hi)
    return _ETA[key]


def level_sizes(M: int, k0: int) -> list[int]:
    sizes = []
    s = k0
    while s <= M:
        sizes.append(s)
        s *= 2
    return sizes or [M]


def n_tests(M: int, sizes: list[int]) -> int:
    return sum(-(-M // s) for s in sizes)


# ---------------------------------------------------------------- 逐帧

class SubbandDetector:
    """一个检测器节点的分子带状态。frame() 每帧调一次，返回本帧的簇。"""

    def __init__(self, M: int, k0: int, pfa: float, window: int, merge_gap: int):
        if k0 not in ALLOWED_K0:
            raise ValueError(f"subband_bins 必须取 {ALLOWED_K0}")
        self.M, self.k0, self.W, self.gap = M, k0, window, merge_gap
        self.sizes = level_sizes(M, k0)
        self.tests = n_tests(M, self.sizes)
        self.pfa_test = pfa / self.tests
        self.eta = {}
        for s in self.sizes:
            for b0 in range(0, M, s):
                w = min(s, M - b0)
                if w not in self.eta:
                    self.eta[w] = threshold(w, self.pfa_test)
        self.rings = [deque() for _ in range(M)]
        self.sorted = [[] for _ in range(M)]
        self.noise = [0.0] * M
        self.dirty = [False] * M
        self.ever_full = [False] * M
        self.since = [0] * M
        self.stale_frames = 0
        self.segments: list[dict] = []        # {id, last, recent: deque[(f, lo, hi)]}
        self.next_id = 0
        self.frames = 0
        self.hit_frames = 0
        self.min_margin = math.inf            # 全部块里 |Λ/η − 1| 的最小值：黄金基准要求它不卡在门限上

    def _push(self, j: int, v: float) -> None:
        r, s = self.rings[j], self.sorted[j]
        if len(r) == self.W:
            old = r.popleft()
            del s[bisect.bisect_left(s, old)]
        r.append(v)
        bisect.insort(s, v)
        if len(r) == self.W:
            self.ever_full[j] = True
        self.dirty[j] = True

    def frame(self, p: list[float], f: int) -> list[dict]:
        M = self.M
        admitted = [False] * M
        for j in range(M):                                   # ② 环空先入环
            if not self.rings[j]:
                self._push(j, p[j])
                admitted[j] = True
        for j in range(M):
            if self.dirty[j]:
                s = self.sorted[j]
                n = len(s)
                med = s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])
                self.noise[j] = med / LN2
                self.dirty[j] = False
        if max(self.since) > self.W:
            self.stale_frames += 1
        # ③ 多级块
        hits = []
        for s in self.sizes:
            row = []
            for b0 in range(0, M, s):
                b1 = min(b0 + s, M)
                e = 0.0
                n = 0.0
                for j in range(b0, b1):
                    e += p[j]
                    n += self.noise[j]
                eta = self.eta[b1 - b0]
                if n > 0.0:
                    self.min_margin = min(self.min_margin, abs(e / n / eta - 1.0))
                row.append(n > 0.0 and e / n > eta)
            hits.append(row)
        # ④ 标记
        mark = [False] * M
        below = None
        for li, s in enumerate(self.sizes):
            row = hits[li]
            if li == 0:
                marked = row
                below_l = [False] * len(row)
            else:
                prev = hits[li - 1]
                below_l = []
                for b in range(len(row)):
                    any_ = False
                    for c in (2 * b, 2 * b + 1):
                        if c < len(prev) and (prev[c] or below[c]):
                            any_ = True
                    below_l.append(any_)
                marked = [row[b] and not below_l[b] for b in range(len(row))]
            for b, m in enumerate(marked):
                if m:
                    for j in range(b * s, min(b * s + s, M)):
                        mark[j] = True
            below = below_l
        # ⑤ 成簇
        clusters = []
        j = 0
        while j < M:
            if not mark[j]:
                j += 1
                continue
            lo = j
            hi = j
            while hi + 1 < M and mark[hi + 1]:
                hi += 1
            if clusters and lo - clusters[-1][1] - 1 <= self.k0:
                clusters[-1][1] = hi
            else:
                clusters.append([lo, hi])
            j = hi + 1
        # ⑥ 连接
        self.segments = [sg for sg in self.segments if f - sg["last"] - 1 <= self.gap]
        out = []
        for lo, hi in clusters:
            best, best_ov = None, None
            for sg in self.segments:
                q = sg["recent"]
                while q and q[0][0] < f - LINK_FRAMES:
                    q.popleft()
                if not q:
                    continue
                rlo = min(x[1] for x in q)
                rhi = max(x[2] for x in q)
                if lo <= rhi + self.k0 and hi >= rlo - self.k0:
                    ov = min(hi, rhi) - max(lo, rlo)
                    if best is None or ov > best_ov:
                        best, best_ov = sg, ov
            if best is None:
                best = {"id": self.next_id, "last": f, "recent": deque()}
                self.next_id += 1
                self.segments.append(best)
            best["recent"].append((f, lo, hi))
            best["last"] = f
            e = 0.0
            n = 0.0
            for jj in range(lo, hi + 1):
                e += p[jj]
                n += self.noise[jj]
            out.append({"lo": lo, "hi": hi, "e": e, "n": n, "statistic": e / n if n > 0.0 else 0.0,
                        "segment_id": best["id"]})
        # ⑦ 删截与入环
        guard = [False] * M
        for jj in range(M):
            if mark[jj]:
                for g in range(max(0, jj - GUARD_BINS), min(M, jj + GUARD_BINS + 1)):
                    guard[g] = True
        for jj in range(M):
            if not guard[jj] and not admitted[jj]:
                self._push(jj, p[jj])
                admitted[jj] = True
            self.since[jj] = 0 if admitted[jj] else self.since[jj] + 1
        self.frames += 1
        self.hit_frames += bool(out)
        return out

    def summary(self) -> dict:
        never = sum(1 for v in self.ever_full if not v)
        return {"bins": self.k0, "levels": len(self.sizes), "tests": self.tests, "pfa_test": self.pfa_test,
                "window": "hann", "link_frames": LINK_FRAMES, "guard_bins": GUARD_BINS,
                "segments": self.next_id, "hit_frames": self.hit_frames, "never_full_bins": never,
                "stale_frames": self.stale_frames, "degraded": 2 * never > self.M}


def frame_power_hann(x: np.ndarray, nfft: int, band: list[int]) -> tuple[np.ndarray, float]:
    """每帧频段内各频点的 Hann 窗功率（与引擎同：float32 窗值、complex64 相乘、FFT、fftshift）与 Σw²。"""
    import features as ft
    w, _, wsq = ft.hann_periodic_f32(nfft)
    k = x.size // nfft
    xw = (x[:k * nfft].reshape(k, nfft) * w).astype(np.complex64).reshape(-1)
    power = ft.frame_bin_power(xw, nfft)
    return power[:, band], wsq


if __name__ == "__main__":
    for S in (1, 8, 64):
        print(S, threshold(S, 1e-3 / 232))
