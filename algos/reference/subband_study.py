#!/usr/bin/env python3
"""Q-4b 第一步：分子带检测的原型研究（关卡，先于任何 C++；06 §9K Q-4b，计划 2026-10-04）。

问题：宽带里同时出现的图传、遥控、DroneID 被全带统计量并成一个突发（D-069 ⑧：golden-02 段号 181 吞掉 100 个跳频突发）。
本脚本在同一份数据上对比几种做法，逐辐射源做**一对一**匹配，回答「各成各的突发」做到了没有、代价是什么。

数据：
  · 试样集 sample-v1 的 S3（80 MS/s，交付包里的 SigMF，注记即真值）：S01–S10；
  · golden-02（10 MS/s、6 s，图传 + 五点跳频，末尾 1 s 两者同时）：现跑一次 chain-golden-02 并导出。

做法（都用同一份静态的逐频点噪声估计：全体帧的中位数 / ln 2——**这是原型的简化**，引擎用的是带删截的滑动中位数；
两种做法用同一份噪声，比较的是分段与成簇，不是噪声估计）：
  · full：今天的全带检测——频段内所有频点求和一个统计量，按帧判决，段只按时间分；
  · sub-*：分子带——频段切成 K0 个频点一块（多级时 K0·2^l），每块一个统计量与门限，命中块连成簇，
    簇跨帧按频率重叠连成段（只往前连、不重编段号），段的频段是它所有簇的并集。

门限：每帧整体虚警率 pfa = 1e-3，分给全部检验（Bonferroni）。块统计量 Λ = ΣP / Σn，H0 下按 Gamma(ν, 1/ν) 求门限；
矩形窗相邻频点独立，ν = S；Hann 窗相邻频点的功率相关系数 4/9、隔一个 1/36，按矩匹配取等效自由度
ν = S² / (S + 2(S−1)·4/9 + 2(S−2)/36)。

一对一匹配：段与真值行在时间上重叠比 ≥ 0.5、在频率上重叠比 ≥ 0.5（都对两者中较短 / 较窄的那个）才算候选；
按「时间比 × 频率比」从大到小贪心配对，每个段至多配一行真值、每行真值至多配一个段。由此：
  检出率 = 配上的真值 / 真值；碎片 = 有候选但没配上的段（一段真值被切成几段）；
  被并掉 = 有候选但没配上的真值（它的段已经配给了别的真值）；虚警段 = 没有任何候选的段。
全带检测的段频段是整个检测频段，与任何真值的频率重叠比都是 1——一个并起来的段只能配一行，其余全算「被并掉」。

跑法（约几分钟；结果写 data/tmp/q4b-study/report.txt）：
    uv run --quiet --with numpy --with scipy python algos/reference/subband_study.py
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

import numpy as np
from scipy import stats

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "data", "tmp", "q4b-study")
NFFT = 1024
PFA = 1e-3
MERGE_GAP = 2
BAND_FRAC = 0.45


# ---------------------------------------------------------------- 数据

def load_sigmf(stem: str) -> tuple[np.ndarray, float, float, list[dict]]:
    with open(stem + ".sigmf-meta", encoding="utf-8") as fh:
        meta = json.load(fh)
    raw = np.fromfile(stem + ".sigmf-data", dtype="<i2").astype(np.float32)
    x = (raw[0::2] + 1j * raw[1::2]).astype(np.complex64)
    return x, float(meta["global"]["core:sample_rate"]), float(meta["captures"][0]["core:frequency"]), meta["annotations"]


def golden02(engine: str) -> str:
    """跑 chain-golden-02（6 s）并把 S3 导出成 SigMF；返回文件名前缀。"""
    stem = os.path.join(OUT, "golden-02", "g02_s3")
    if os.path.exists(stem + ".sigmf-meta"):
        return stem
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import iq_export_sigmf as X
    d = json.load(open(os.path.join(ROOT, "tests", "regression", "diagrams", "chain-golden-02.json"), encoding="utf-8"))
    d["diagram_id"] = "q4b-study-golden-02"
    # DDC 旁路时 S4 与 S3 挂在同一个 ADC 节点上；取挂在 ADC 上的那个观测点（按导出口径就是 S3）
    adc = next(n["id"] for n in d["nodes"] if n["type"] == "AdcQuantizer")
    op_id = next(op["id"] for op in d["observation_points"] if op["node"] == adc)
    for op in d["observation_points"]:
        if op["id"] == op_id:
            op["products"] = list(op["products"]) + ["iq"]
    run = os.path.join(ROOT, "data", "runs", "q4b-study-golden-02")
    shutil.rmtree(run, ignore_errors=True)
    os.makedirs(run)
    dp = os.path.join(run, "diagram.json")
    with open(dp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, indent=2)
    p = subprocess.run([engine, "--run", os.path.relpath(dp, ROOT), "--out", os.path.relpath(run, ROOT),
                        "--scenario", "data/scene/beijing-yayuncun/scenarios/golden-02.scenario.json",
                        "--library-root", "models/recognition"], cwd=ROOT, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"cuav_run 失败：{p.stderr[-600:]}")
    os.makedirs(os.path.dirname(stem), exist_ok=True)
    X.export_run(run, os.path.dirname(stem), ops=[op_id], stem_prefix="g02")
    shutil.rmtree(run, ignore_errors=True)
    if op_id != "s3":
        for ext in (".sigmf-data", ".sigmf-meta", ".cuav-links.jsonl"):
            os.replace(os.path.join(os.path.dirname(stem), f"g02_{op_id}{ext}"), stem + ext)
    return stem


# ---------------------------------------------------------------- 谱与噪声

def frame_power(x: np.ndarray, window: str) -> np.ndarray:
    k = x.size // NFFT
    w = np.hanning(NFFT + 1)[:NFFT].astype(np.float32) if window == "hann" else np.ones(NFFT, np.float32)
    out = np.empty((k, NFFT), dtype=np.float32)
    step = 4096
    for a in range(0, k, step):
        blk = x[a * NFFT:min(k, a + step) * NFFT].reshape(-1, NFFT) * w
        out[a:a + blk.shape[0]] = np.abs(np.fft.fftshift(np.fft.fft(blk, axis=1), axes=1)) ** 2
    return out


def band_slice(fs: float) -> tuple[int, int]:
    f = (np.arange(NFFT) - NFFT // 2) * fs / NFFT
    idx = np.flatnonzero((f >= -BAND_FRAC * fs) & (f < BAND_FRAC * fs))
    return int(idx[0]), int(idx[-1]) + 1


def nu(S: int, window: str) -> float:
    if window != "hann":
        return float(S)
    var = S + 2 * max(S - 1, 0) * 4.0 / 9.0 + 2 * max(S - 2, 0) / 36.0
    return S * S / var


def eta(S: int, window: str, pfa: float) -> float:
    v = nu(S, window)
    return float(stats.gamma.isf(pfa, a=v, scale=1.0 / v))


_EIG: dict = {}


def hann_eigs(S: int) -> np.ndarray:
    """周期 Hann 窗下 S 个相邻频点复值的相关矩阵（1, −2/3, 1/6 的带状 Toeplitz）的特征值。"""
    if S not in _EIG:
        r = np.zeros(S)
        r[0] = 1.0
        if S > 1:
            r[1] = -2.0 / 3.0
        if S > 2:
            r[2] = 1.0 / 6.0
        from scipy.linalg import toeplitz
        _EIG[S] = np.clip(np.linalg.eigvalsh(toeplitz(r)), 1e-12, None)
    return _EIG[S]


def tail_saddle(lam: np.ndarray, x: float) -> float:
    """P(Σ λ_i E_i > x)，E_i 独立单位指数：Lugannani–Rice 鞍点近似。"""
    mean = lam.sum()
    if x <= mean:
        return 1.0
    lo, hi = 0.0, (1.0 - 1e-12) / lam.max()
    for _ in range(200):                   # 解 K'(t) = Σ λ/(1 − λt) = x
        t = 0.5 * (lo + hi)
        if np.sum(lam / (1 - lam * t)) < x:
            lo = t
        else:
            hi = t
    t = 0.5 * (lo + hi)
    K = -np.sum(np.log1p(-lam * t))
    K2 = np.sum((lam / (1 - lam * t)) ** 2)
    w = np.sqrt(2 * (t * x - K))
    u = t * np.sqrt(K2)
    return float(stats.norm.sf(w) + stats.norm.pdf(w) * (1 / u - 1 / w))


_ETA_CAL: dict = {}


def eta_cal(S: int, window: str, pfa: float) -> float:
    """按块统计量的精确分布（鞍点近似）求门限：Λ = Σ P / Σ n，H0 下 S·Λ = Σ λ_i E_i。"""
    key = (S, window, pfa)
    if key not in _ETA_CAL:
        lam = hann_eigs(S) if window == "hann" else np.ones(S)
        lo, hi = 1.0, 50.0
        for _ in range(100):
            m = 0.5 * (lo + hi)
            if tail_saddle(lam, S * m) > pfa:
                lo = m
            else:
                hi = m
        _ETA_CAL[key] = 0.5 * (lo + hi)
    return _ETA_CAL[key]


# ---------------------------------------------------------------- 检测

def detect_full(P: np.ndarray, n: np.ndarray, window: str) -> list[tuple[int, int, int, int]]:
    """全带：(首帧, 末帧, 首频点, 末频点)，频点是频段内下标。"""
    M = P.shape[1]
    lam = P.sum(axis=1, dtype=np.float64) / float(n.sum())
    hit = lam > eta(M, window, PFA)
    segs, start, last = [], None, None
    for f in np.flatnonzero(hit):
        if last is not None and f - last - 1 <= MERGE_GAP:
            last = f
            continue
        if start is not None:
            segs.append((start, last, 0, M - 1))
        start = last = f
    if start is not None:
        segs.append((start, last, 0, M - 1))
    return segs


def marked_bins(P: np.ndarray, n: np.ndarray, window: str, k0: int, multi: bool, cal: bool = False) -> np.ndarray:
    F, M = P.shape
    sizes = [k0]
    while multi and sizes[-1] * 2 <= M:
        sizes.append(sizes[-1] * 2)
    n_tests = sum(-(-M // S) for S in sizes)
    cp = np.zeros((F, M + 1), dtype=np.float64)
    np.cumsum(P, axis=1, dtype=np.float64, out=cp[:, 1:])
    cn = np.concatenate([[0.0], np.cumsum(n, dtype=np.float64)])
    mask = np.zeros((F, M), dtype=bool)
    sub_any = None
    prev_hit = None
    for S in sizes:
        edges = np.arange(0, M, S)
        ends = np.minimum(edges + S, M)
        lam = (cp[:, ends] - cp[:, edges]) / (cn[ends] - cn[edges])
        thr_f = eta_cal if cal else eta
        thr = np.array([thr_f(int(e - b), window, PFA / n_tests) for b, e in zip(edges, ends)])
        hit = lam > thr
        if prev_hit is None:
            marked = hit
            sub_any = np.zeros_like(hit)
        else:
            below = prev_hit | sub_any_prev
            if below.shape[1] % 2:
                below = np.concatenate([below, np.zeros((F, 1), bool)], axis=1)
            sub_any = below.reshape(F, -1, 2).any(axis=2)[:, :hit.shape[1]]
            marked = hit & ~sub_any
        mask |= np.repeat(marked, S, axis=1)[:, :M]
        prev_hit, sub_any_prev = hit, sub_any
    return mask


def clusters(mask: np.ndarray, bridge: int) -> list[tuple[int, int, int]]:
    """每帧的簇：(帧, 首频点, 末频点)；间隙 ≤ bridge 个频点的串并成一簇。"""
    F, M = mask.shape
    pad = np.zeros((F, M + 2), dtype=np.int8)
    pad[:, 1:-1] = mask
    d = np.diff(pad, axis=1)
    fs_, ks = np.nonzero(d == 1)
    fe_, ke = np.nonzero(d == -1)
    out = []
    i = 0
    while i < len(fs_):
        f, lo, hi = fs_[i], ks[i], ke[i] - 1
        j = i + 1
        while j < len(fs_) and fs_[j] == f and ks[j] - hi - 1 <= bridge:
            hi = ke[j] - 1
            j += 1
        out.append((int(f), int(lo), int(hi)))
        i = j
    return out


def link_recent(cl: list[tuple[int, int, int]], tol: int, window: int) -> list[tuple[int, int, int, int]]:
    """簇对段**最近 window 帧**的频段并集做连接：旧的频段会淡出，并集不会一路长大；短暂的闪动仍连得上。
    段的频段取核心（至少一半的帧里命中的频点）。"""
    from collections import deque
    segs: list[dict] = []
    open_ids: list[int] = []
    for f, lo, hi in cl:
        open_ids = [s for s in open_ids if f - segs[s]["last"] - 1 <= MERGE_GAP]
        best, best_ov = None, None
        for s in open_ids:
            a = segs[s]
            q = a["recent"]
            while q and q[0][0] < f - window:
                q.popleft()
            if not q:
                continue
            rlo, rhi = min(x[1] for x in q), max(x[2] for x in q)
            if lo <= rhi + tol and hi >= rlo - tol:
                ov = min(hi, rhi) - max(lo, rlo)
                if best is None or ov > best_ov:
                    best, best_ov = s, ov
        if best is None:
            segs.append({"first": f, "last": f, "recent": deque(), "cur": -1, "frames": 0, "count": {}, "lo": lo, "hi": hi})
            best = len(segs) - 1
            open_ids.append(best)
        a = segs[best]
        if a["cur"] != f:
            a["cur"], a["frames"] = f, a["frames"] + 1
        a["recent"].append((f, lo, hi))
        a["last"] = f
        a["lo"], a["hi"] = min(a["lo"], lo), max(a["hi"], hi)
        for b in range(lo, hi + 1):
            a["count"][b] = a["count"].get(b, 0) + 1
    out = []
    for a in segs:
        core = [b for b, c in a["count"].items() if 2 * c >= a["frames"]]
        lo, hi = (min(core), max(core)) if core else (a["lo"], a["hi"])
        out.append((a["first"], a["last"], lo, hi))
    return out


def link_last(cl: list[tuple[int, int, int]], tol: int, M: int) -> list[tuple[int, int, int, int]]:
    """簇只对段**上一帧**的频段做连接（不对并集，防止并集一路长大把邻近的源都罩进去）；
    段的频段取核心：在该段至少一半的帧里命中的频点（没有就退回并集）。"""
    segs: list[dict] = []
    open_ids: list[int] = []
    for f, lo, hi in cl:
        open_ids = [s for s in open_ids if f - segs[s]["last"] - 1 <= MERGE_GAP]
        best, best_ov = None, None
        for s in open_ids:
            a = segs[s]
            if lo <= a["hi_last"] + tol and hi >= a["lo_last"] - tol:
                ov = min(hi, a["hi_last"]) - max(lo, a["lo_last"])
                if best is None or ov > best_ov:
                    best, best_ov = s, ov
        if best is None:
            segs.append({"first": f, "last": f, "lo_last": lo, "hi_last": hi, "cur": f, "frames": 1,
                         "count": {}, "lo": lo, "hi": hi})
            best = len(segs) - 1
            open_ids.append(best)
        a = segs[best]
        if a["cur"] != f:
            a["cur"], a["frames"] = f, a["frames"] + 1
            a["lo_last"], a["hi_last"] = lo, hi
        else:
            a["lo_last"], a["hi_last"] = min(a["lo_last"], lo), max(a["hi_last"], hi)
        a["last"] = f
        a["lo"], a["hi"] = min(a["lo"], lo), max(a["hi"], hi)
        for b in range(lo, hi + 1):
            a["count"][b] = a["count"].get(b, 0) + 1
    out = []
    for a in segs:
        core = [b for b, c in a["count"].items() if 2 * c >= a["frames"]]
        lo, hi = (min(core), max(core)) if core else (a["lo"], a["hi"])
        out.append((a["first"], a["last"], lo, hi))
    return out


def link(cl: list[tuple[int, int, int]], tol: int) -> list[tuple[int, int, int, int]]:
    """簇跨帧连成段：只往前连、不重编段号；返回 (首帧, 末帧, 首频点, 末频点)。"""
    segs: list[list[int]] = []       # [first, last, lo, hi]
    open_ids: list[int] = []
    for f, lo, hi in cl:
        open_ids = [s for s in open_ids if f - segs[s][1] - 1 <= MERGE_GAP]
        best, best_ov = None, None
        for s in open_ids:
            a = segs[s]
            if lo <= a[3] + tol and hi >= a[2] - tol:
                ov = min(hi, a[3]) - max(lo, a[2])
                if best is None or ov > best_ov:
                    best, best_ov = s, ov
        if best is None:
            segs.append([f, f, lo, hi])
            open_ids.append(len(segs) - 1)
        else:
            a = segs[best]
            a[1], a[2], a[3] = f, min(a[2], lo), max(a[3], hi)
    return [tuple(s) for s in segs]


# ---------------------------------------------------------------- 评价

def evaluate(segs, b0: int, fs: float, fc: float, truth: list[dict]) -> dict:
    df = fs / NFFT
    dt = NFFT / fs
    S = np.array([(s[0] * dt, (s[1] + 1) * dt, fc + (b0 + s[2] - NFFT // 2 - 0.5) * df,
                   fc + (b0 + s[3] - NFFT // 2 + 0.5) * df) for s in segs]).reshape(-1, 4)
    T = [(a["core:sample_start"] / fs, (a["core:sample_start"] + a["core:sample_count"]) / fs,
          a["core:freq_lower_edge"], a["core:freq_upper_edge"], a["cuav:emitter_id"]) for a in truth
         if a.get("cuav:capture") == "full"]
    pairs = []
    cand_s = np.zeros(len(S), bool)
    cand_t = np.zeros(len(T), bool)
    for ti, (t0, t1, f0, f1, _) in enumerate(T):
        if not len(S):
            break
        ovt = np.minimum(S[:, 1], t1) - np.maximum(S[:, 0], t0)
        rt = ovt / np.minimum(S[:, 1] - S[:, 0], t1 - t0)
        ovf = np.minimum(S[:, 3], f1) - np.maximum(S[:, 2], f0)
        rf = ovf / np.minimum(S[:, 3] - S[:, 2], f1 - f0)
        ok = np.flatnonzero((ovt > 0) & (rt >= 0.5) & (ovf > 0) & (rf >= 0.5))
        for si in ok:
            pairs.append((-(rt[si] * rf[si]), t0, si, ti))
        cand_s[ok] = True
        cand_t[ti] = len(ok) > 0
    pairs.sort()
    used_s, used_t = set(), set()
    for _, _, si, ti in pairs:
        if si in used_s or ti in used_t:
            continue
        used_s.add(si)
        used_t.add(ti)
    per: dict = {}
    for ti, t in enumerate(T):
        e = per.setdefault(t[4], {"truth": 0, "matched": 0, "merged": 0})
        e["truth"] += 1
        e["matched"] += ti in used_t
        e["merged"] += (ti not in used_t) and bool(cand_t[ti])
    return {"segments": len(S), "false": int((~cand_s).sum()),
            "fragments": int(sum(1 for si in range(len(S)) if cand_s[si] and si not in used_s)), "per": per}


# ---------------------------------------------------------------- 主程序

VARIANTS = [
    ("full", {"kind": "full", "window": "rect"}),
    ("sub-rect-8", {"kind": "sub", "window": "rect", "k0": 8, "multi": False, "bridge": 0}),
    ("sub-hann-8", {"kind": "sub", "window": "hann", "k0": 8, "multi": False, "bridge": 8}),
    ("sub-hann-4-multi", {"kind": "sub", "window": "hann", "k0": 4, "multi": True, "bridge": 4}),
    ("sub-hann-8-multi", {"kind": "sub", "window": "hann", "k0": 8, "multi": True, "bridge": 8}),
    ("sub-hann-16-multi", {"kind": "sub", "window": "hann", "k0": 16, "multi": True, "bridge": 16}),
    # 合并间隙与连接容差放宽到 4 倍块宽：强图传的谱肩与它同时出现、离带边几个块，看能不能并回图传段
    ("sub-hann-8-multi-wide", {"kind": "sub", "window": "hann", "k0": 8, "multi": True, "bridge": 32, "tol": 32}),
    # 第二轮：门限按块统计量的精确分布（鞍点近似）；连接只对上一帧的频段、段频段取核心
    ("sub-hann-8-multi-cal", {"kind": "sub", "window": "hann", "k0": 8, "multi": True, "bridge": 8, "cal": True}),
    ("sub-hann-8-multi-cal-last", {"kind": "sub", "window": "hann", "k0": 8, "multi": True, "bridge": 8, "cal": True,
                                   "link": "last"}),
    ("sub-hann-16-multi-cal-last", {"kind": "sub", "window": "hann", "k0": 16, "multi": True, "bridge": 16, "cal": True,
                                    "link": "last"}),
    # 第三轮：对最近 L 帧的频段并集连接
    ("sub-hann-8-multi-cal-recent16", {"kind": "sub", "window": "hann", "k0": 8, "multi": True, "bridge": 8, "cal": True,
                                       "link": "recent", "window_frames": 16}),
    ("sub-hann-8-multi-cal-recent64", {"kind": "sub", "window": "hann", "k0": 8, "multi": True, "bridge": 8, "cal": True,
                                       "link": "recent", "window_frames": 64}),
    ("sub-hann-16-multi-cal-recent64", {"kind": "sub", "window": "hann", "k0": 16, "multi": True, "bridge": 16, "cal": True,
                                        "link": "recent", "window_frames": 64}),
]


VARIANT_FILTER: set = set()


def run_case(name: str, stem: str) -> list[dict]:
    x, fs, fc, truth = load_sigmf(stem)
    b0, b1 = band_slice(fs)
    out = []
    cache: dict = {}
    for vname, v in VARIANTS:
        if VARIANT_FILTER and vname not in VARIANT_FILTER:
            continue
        t = time.time()
        if v["window"] not in cache:
            P = frame_power(x, v["window"])[:, b0:b1]
            cache[v["window"]] = (P, np.median(P, axis=0).astype(np.float64) / np.log(2.0))
        P, n = cache[v["window"]]
        if v["kind"] == "full":
            segs = detect_full(P, n, v["window"])
        else:
            cl = clusters(marked_bins(P, n, v["window"], v["k0"], v["multi"], v.get("cal", False)), v["bridge"])
            if v.get("link") == "last":
                segs = link_last(cl, v.get("tol", v["k0"]), P.shape[1])
            elif v.get("link") == "recent":
                segs = link_recent(cl, v.get("tol", v["k0"]), v["window_frames"])
            else:
                segs = link(cl, v.get("tol", v["k0"]))
        ev = evaluate(segs, b0, fs, fc, truth)
        ev.update({"case": name, "variant": vname, "seconds": round(time.time() - t, 1)})
        out.append(ev)
        print(f"  {name} {vname}: 段 {ev['segments']}、虚警段 {ev['false']}、碎片 {ev['fragments']}；"
              + "；".join(f"{e} {d['matched']}/{d['truth']}（并掉 {d['merged']}）" for e, d in sorted(ev["per"].items())),
              flush=True)
    return out


def report(rows: list[dict]) -> str:
    lines = ["# Q-4b 原型研究：分子带检测（原型阶段验证值）", "",
             "| 数据 | 做法 | 段 | 虚警段 | 碎片 | 逐辐射源：配上 / 真值（被并掉） |", "|---|---|---|---|---|---|"]
    for r in rows:
        per = "；".join(f"{e} {d['matched']}/{d['truth']}（{d['merged']}）" for e, d in sorted(r["per"].items())) or "—"
        lines.append(f"| {r['case']} | {r['variant']} | {r['segments']} | {r['false']} | {r['fragments']} | {per} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cases", help="只跑这些（逗号分隔，如 s07,golden-02）")
    ap.add_argument("--variants", help="只跑这些做法（逗号分隔）")
    ap.add_argument("--engine", default=os.path.join(ROOT, "engine", "build", "cuav_run"))
    a = ap.parse_args()
    if a.variants:
        VARIANT_FILTER.update(a.variants.split(","))
    os.makedirs(OUT, exist_ok=True)
    pkg = os.path.join(ROOT, "data", "eval", "sample-v1", "package", "data")
    cases = [(f"s{i:02d}", os.path.join(pkg, f"sv1-s{i:02d}_s3")) for i in range(1, 11)]
    cases.append(("golden-02", None))
    want = set(a.cases.split(",")) if a.cases else None
    rows = []
    for name, stem in cases:
        if want and name not in want:
            continue
        if stem is None:
            stem = golden02(a.engine)
        print(f"== {name}", flush=True)
        rows += run_case(name, stem)
        with open(os.path.join(OUT, "report.txt"), "w", encoding="utf-8") as fh:
            fh.write(report(rows))
        with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)
    print(f"报告写到 {os.path.relpath(os.path.join(OUT, 'report.txt'), ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
