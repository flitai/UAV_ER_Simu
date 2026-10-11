#!/usr/bin/env python3
"""从实测突发盲估计 OFDM 数值结构（D-102）：有用符号长度 Tu（子载波间隔 1/Tu）与平均符号周期 Ts。

为什么要做：图传与遥控上行的数值结构（子载波间隔、循环前缀、FFT 点数）没有公开资料，预设表 v1
按 DroneID 同族的「类 LTE」结构整体假定（A 档，D-085 ①）。真实感对照的 8 项统计量看不到数值结构
（占用带宽相同时 15 kHz 与 30 kHz 给出相同的统计量），这里换一把能看到它的尺子。

方法：
1. 自相关：循环前缀是符号尾部的复制，突发内 r(τ) = Σ x[n]·x*[n+τ] 在 τ = Tu 处出现峰
   （van de Beek 等，IEEE TSP 1997）。每个突发去中心频率、按占用带宽低通、两端各去 3%，
   算归一化 |r(τ)|/r(0)，各突发平均后找峰，抛物线插值到分数样点。搜索下限取主瓣宽度
   （约 fs/带宽 个样点）的 25 倍，窄带信号的旁瓣按 1/τ 衰减，下限太低会把旁瓣当成峰。
2. 历元折叠：c[n] = x[n]·x*[n+L]（L 取上一步的峰）只在循环前缀处有非零均值，以符号周期为周期。
   对每个候选周期把 c 按 n mod T 折叠求复平均，正确的 T 使折叠能量最大；各突发的能量曲线相加。
   有长短两种循环前缀时，读数是一种平均符号周期；用同一方法处理两种排布的仿真突发（--sim 一节）
   可以看出实测属于哪一种。FFT 点数在信号上不可观测。

数据：只用实测样本集（真实感对照 realism_compare 的 train / all 列），不碰验证集；跑完用
tools/freeze_holdout.py 同一判据复核用到的全部产物，与验证集相交即作废退出。突发的位置取自
realism_compare 的逐突发结果（有缓存就读缓存，没有就重算，约 10 分钟）。对照取样例数据集
（data/eval/sample-v1/package/data/）里按预设生成的突发，不在就明说跳过。

输出 data/iq/measured/cp-numerology.json 与 cp-numerology-report.md（同一输入两次运行逐字节相同）。
用法（项目根目录）：
  uv run --quiet --with numpy --with scipy python algos/reference/cp_numerology.py [--per-group 200]
单测：uv run --quiet --with numpy --with scipy python -m unittest tests/unit/test_cp_numerology.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

VERSION = "0.1.0"
OUT_JSON = os.path.join("data", "iq", "measured", "cp-numerology.json")
OUT_MD = os.path.join("data", "iq", "measured", "cp-numerology-report.md")
SAMPLE_DIR = os.path.join("data", "eval", "sample-v1", "package", "data")

LAG_MIN, LAG_MAX = 400, 12000       # 滞后搜索范围（样点）；80 MS/s 下 5–150 µs
LAG_MIN_MAINLOBES = 25              # 下限至少为主瓣宽度（fs/带宽）的这么多倍
CP_SPAN = 900                       # 符号周期的候选：Tu 之后 0–900 个样点
EDGE = 0.03                         # 突发两端各丢 3%，避开开关过渡
SNR_MIN_DB = 15.0
SEED = 0                            # 打乱片段顺序用，使各型号均匀入选

# (组名, realism_compare 的配对, 列, 型号字母集合或 None, 最短时长 s, 最低信噪比 dB, 报不报平均符号周期)
# Mavic 3 的 5.8 GHz 图传信噪比中位数只有 11.7 dB，门槛取 8 dB；上行突发窄而短，循环前缀相关弱，
# 平均符号周期的读数不可靠，只报子载波间隔。
GROUPS = [
    ("video-20m-A", "p1", "train", {"A"}, 0.9e-3, SNR_MIN_DB, True),
    ("video-20m-C", "p2", "train", {"C"}, 0.85e-3, SNR_MIN_DB, True),
    ("video-20m-D", "p1", "train", {"D"}, 0.9e-3, SNR_MIN_DB, True),
    ("video-20m-E", "p2", "train", {"E"}, 0.85e-3, SNR_MIN_DB, True),
    ("video-20m-F", "p1", "train", {"F"}, 0.9e-3, SNR_MIN_DB, True),
    ("video-20m-G", "p1", "train", {"G"}, 0.9e-3, SNR_MIN_DB, True),
    ("video-40m-mavic3", "p6", "all", None, 0.9e-3, 8.0, True),
    ("uplink-1m", "p3", "train", None, 0.45e-3, SNR_MIN_DB, False),
    ("uplink-2m", "p4", "train", None, 0.45e-3, SNR_MIN_DB, False),
    ("uplink-4m", "p5", "train", None, 0.45e-3, SNR_MIN_DB, False),
]
CONTROLS = [("control-video-20m-a", "sv1-s02_s3", "video_link", True),
            ("control-uplink", "sv1-s03_s3", "rc_hopping", False)]


def r6(a):
    return None if a is None else float(f"{float(a):.6g}")


# ---------------------------------------------------------------- 估计

def baseband(x: np.ndarray, fs: float, df: float, bw: float) -> np.ndarray:
    """去中心频率 df，按带宽 bw 做频域砖墙低通。"""
    n = x.size
    x = x.astype(np.complex128) * np.exp(-2j * np.pi * df * np.arange(n) / fs)
    X = np.fft.fft(x)
    X[np.abs(np.fft.fftfreq(n, 1 / fs)) > bw / 2] = 0
    return np.fft.ifft(X)


def acorr(x: np.ndarray, maxlag: int) -> np.ndarray:
    nfft = 1 << int(np.ceil(np.log2(2 * x.size)))
    X = np.fft.fft(x, nfft)
    r = np.fft.ifft(np.abs(X) ** 2)[:maxlag + 1]
    return np.abs(r) / r[0].real


def fold_energy(x: np.ndarray, L: int, cands: np.ndarray) -> np.ndarray:
    c = x[:-L] * np.conj(x[L:])
    c = c / np.mean(np.abs(x) ** 2)
    n = np.arange(c.size)
    e = np.empty(cands.size)
    for i, T in enumerate(cands):
        k = n % T
        cnt = np.bincount(k, minlength=T)
        pr = (np.bincount(k, weights=c.real, minlength=T)
              + 1j * np.bincount(k, weights=c.imag, minlength=T)) / np.maximum(cnt, 1)
        e[i] = np.mean(np.abs(pr) ** 2)
    return e


def parabolic(y: np.ndarray, i: int) -> float:
    if 0 < i < y.size - 1:
        a, b, c = y[i - 1], y[i], y[i + 1]
        d = a - 2 * b + c
        if d != 0:
            return i + 0.5 * (a - c) / d
    return float(i)


def estimate(bursts: list[np.ndarray], fs: float, bw: float, with_ts: bool = True) -> dict:
    """一组突发的盲估计：子载波间隔、峰高与背景中位数之比、平均符号周期。"""
    lag_min = max(LAG_MIN, int(LAG_MIN_MAINLOBES * fs / bw))
    used = [x for x in bursts if x.size >= 2 * LAG_MAX]
    if not used:
        return {"n_bursts": 0}
    prof = np.zeros(LAG_MAX + 1)
    for x in used:
        prof += acorr(x, LAG_MAX)
    prof /= len(used)
    seg = prof[lag_min:]
    i = int(np.argmax(seg))
    lag = lag_min + parabolic(seg, i)
    med = float(np.median(seg))
    out = {"n_bursts": len(used), "lag_min": lag_min, "lag_samples": lag, "Tu_us": lag / fs * 1e6,
           "scs_kHz": fs / lag / 1e3, "peak": float(seg[i]), "median": med,
           "peak_over_median": float(seg[i] / med) if med > 0 else None}
    if with_ts:
        L = int(round(lag))
        cands = np.arange(L + 1, L + CP_SPAN + 1)
        etot = np.zeros(cands.size)
        for x in used:
            etot += fold_energy(x, L, cands)
        Ts = int(cands[int(np.argmax(etot))])
        out.update(Ts_samples=Ts, Ts_us=Ts / fs * 1e6, cp_mean_us=(Ts - lag) / fs * 1e6)
    return out


def synth_bursts(cps: list[int], n_bursts: int, *, scs_Hz: float = 15e3, half_sc: int = 600,
                 snr_dB: float = 20.0, seed: int = 1) -> tuple[list[np.ndarray], float, float]:
    """仿真 OFDM 突发：2048 点、子载波间隔 scs_Hz、±half_sc 个子载波、16QAM，有理重采样到 80 MS/s，加高斯噪声。

    cps：每个符号的循环前缀长度（原生样点，原生率 = 2048·scs_Hz）。返回 (突发, 采样率, 占用带宽)。"""
    from fractions import Fraction
    from scipy.signal import resample_poly
    rng = np.random.default_rng(seed)
    N, K, fs = 2048, half_sc, 80e6
    ratio = Fraction(int(fs), int(N * scs_Hz)).limit_denominator(1000)
    bw = (2 * K + 1) * scs_Hz
    out = []
    for _ in range(n_bursts):
        sym = []
        for cp in cps:
            X = np.zeros(N, complex)
            d = (rng.choice([-3, -1, 1, 3], 2 * K) + 1j * rng.choice([-3, -1, 1, 3], 2 * K)) / np.sqrt(10)
            X[1:K + 1], X[-K:] = d[:K], d[K:]
            x = np.fft.ifft(X)
            sym.append(np.r_[x[-cp:], x])
        y = resample_poly(np.concatenate(sym), ratio.numerator, ratio.denominator)
        y = y / np.sqrt(np.mean(np.abs(y) ** 2))
        y = y + (rng.standard_normal(y.size) + 1j * rng.standard_normal(y.size)) * np.sqrt(0.5 / 10 ** (snr_dB / 10))
        e = int(EDGE * y.size)
        out.append(baseband(y[e:y.size - e], fs, 0.0, bw * 1.005))
    return out, fs, bw


# 预设 v1 的排布：只有首符号用长循环前缀；LTE 常规循环前缀：每 7 个符号（一个时隙）的首符号用长循环前缀
SIM_PATTERNS = {"first_only": [160] + [144] * 14,
                "per_slot": [160] + [144] * 6 + [160] + [144] * 6 + [160]}


def simulate_patterns(n_bursts: int = 60) -> dict:
    out = {"n_bursts": n_bursts, "snr_dB": 20.0, "symbols": 15, "fs_native_Hz": 30.72e6}
    for k, cps in SIM_PATTERNS.items():
        b, fs, bw = synth_bursts(cps, n_bursts)
        r = estimate(b, fs, bw)
        out[k] = {"cp_native": cps, "scs_kHz": r6(r["scs_kHz"]), "Ts_us": r6(r["Ts_us"])}
    return out


# ---------------------------------------------------------------- 数据

def measured(per_group: int, workers: int):
    import realism_compare as RC
    import q0b_param_extract as Q
    from iq_format import store
    meas, columns = RC.analyse_measured(RC.q0b_doc(), workers, use_cache=True)
    idx = {}
    for b in ("dronerfb", "dronerfa"):
        for r in Q.load_index(b):
            idx[r.data_id] = r
    rng = np.random.default_rng(SEED)
    used_paths = []
    for name, pid, col, cls, dmin, smin, with_ts in GROUPS:
        bursts, bws, fs_g = [], [], None
        ids = sorted(columns[pid][col])
        for d in [ids[i] for i in rng.permutation(len(ids))]:
            rec = idx[d]
            if cls is not None and rec.truth.get("class_code", "")[:1] not in cls:
                continue
            prod, took = None, 0
            for b in meas[d]:
                r = b["res"].get(pid)
                if r is None:
                    continue
                for z in r["rows"]:
                    if z["snr_dB"] is None or z["snr_dB"] < smin or z["dur_s"] < dmin or took >= 2:
                        continue
                    if prod is None:
                        prod = store.open_product(rec.path)
                        used_paths.append(rec.path)
                    fs = b["fs"]
                    n0 = b["start"] + int(round((z["t0_s"] + EDGE * z["dur_s"]) * fs))
                    n = int(round((1 - 2 * EDGE) * z["dur_s"] * fs))
                    bursts.append(baseband(prod.read(n0, n), fs, z["f_center_Hz"] - b["fc"], z["obw99_Hz"]))
                    bws.append(z["obw99_Hz"])
                    fs_g = fs
                    took += 1
                if took >= 2:
                    break
            if len(bursts) >= per_group:
                break
        res = estimate(bursts, fs_g, float(np.median(bws)), with_ts) if bursts else {"n_bursts": 0}
        res.update(name=name, pair=pid, column=col, snr_min_dB=smin, fs_Hz=fs_g,
                   bw_median_Hz=float(np.median(bws)) if bws else None)
        yield res, used_paths


def controls(per_group: int):
    base = os.path.join(ROOT, SAMPLE_DIR)
    for name, stem, label, with_ts in CONTROLS:
        meta_p = os.path.join(base, stem + ".sigmf-meta")
        if not os.path.exists(meta_p):
            yield {"name": name, "n_bursts": 0, "skipped": f"{SAMPLE_DIR} 不在，对照跳过"}
            continue
        meta = json.load(open(meta_p, encoding="utf-8"))
        fs = meta["global"]["core:sample_rate"]
        fc = meta["captures"][0]["core:frequency"]
        raw = np.memmap(os.path.join(base, stem + ".sigmf-data"), dtype="<i2", mode="r")
        bursts, bws, preset = [], [], None
        for a in meta["annotations"]:
            if a["core:label"] != label:
                continue
            preset = preset or a.get("cuav:preset_id")
            n0, n = a["core:sample_start"], a["core:sample_count"]
            m0, m = n0 + int(EDGE * n), int((1 - 2 * EDGE) * n)
            s = np.asarray(raw[2 * m0:2 * (m0 + m)], dtype=np.float64)
            lo, hi = a["core:freq_lower_edge"], a["core:freq_upper_edge"]
            bursts.append(baseband(s[0::2] + 1j * s[1::2], fs, 0.5 * (lo + hi) - fc, hi - lo))
            bws.append(hi - lo)
            if len(bursts) >= per_group:
                break
        res = estimate(bursts, fs, float(np.median(bws)), with_ts)
        res.update(name=name, source=f"{SAMPLE_DIR}/{stem}", preset_id=preset, fs_Hz=fs,
                   bw_median_Hz=float(np.median(bws)))
        yield res


def rounded(d: dict) -> dict:
    return {k: (r6(v) if isinstance(v, float) else v) for k, v in d.items()}


def report(doc: dict) -> str:
    L = ["# 图传数值结构的盲估计（循环前缀自相关）", "",
         f"由 `algos/reference/cp_numerology.py {VERSION}` 生成（D-102）。只用实测样本集；"
         f"用到的 {doc['holdout']['checked_products']} 个产物与验证集交集 **{doc['holdout']['intersection']}**。", "",
         "| 组 | 突发数 | 子载波间隔 / kHz | 平均符号周期 / µs | 峰 / 背景中位数 |", "|---|---|---|---|---|"]
    for g in doc["controls"] + doc["groups"]:
        if not g.get("n_bursts"):
            L.append(f"| {g['name']} | 0 | — | — | — |")
            continue
        ts = f"{g['Ts_us']:.2f}" if "Ts_us" in g else "—"
        L.append(f"| {g['name']} | {g['n_bursts']} | {g['scs_kHz']:.3f} | {ts} | {g['peak_over_median']:.1f} |")
    s = doc["sim"]
    L += ["", "两种长循环前缀排布的仿真突发（15 个符号、信噪比 20 dB），同一方法的读数：", "",
          "| 排布 | 平均符号周期 / µs |", "|---|---|",
          f"| 只有首符号用长循环前缀（预设 v1） | {s['first_only']['Ts_us']:.3f} |",
          f"| 每 7 个符号的首符号用长循环前缀（LTE 常规循环前缀） | {s['per_slot']['Ts_us']:.3f} |", ""]
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-group", type=int, default=200)
    ap.add_argument("--workers", type=int, default=10)
    a = ap.parse_args(argv)
    os.chdir(ROOT)
    import freeze_holdout
    import q0b_param_extract as Q
    _, _, holdout_sha = Q.load_holdout()
    groups, paths = [], []
    for res, used in measured(a.per_group, a.workers):
        groups.append(rounded(res))
        paths = used
        print(f"{res['name']}：{res['n_bursts']} 个突发，{res.get('scs_kHz', float('nan')):.3f} kHz", flush=True)
    uniq = sorted(set(paths))
    if freeze_holdout.check(uniq) != 0:
        raise SystemExit("用到的产物与验证集相交，结果作废（铁律 10）")
    ctrl = [rounded(r) for r in controls(a.per_group)]
    sim = simulate_patterns()
    doc = {"schema": "cuav-cp-numerology/1", "producer": f"algos/reference/cp_numerology.py {VERSION}",
           "decision": "D-102",
           "status": "原型阶段验证值（D-028）：公开数据集只用于验证技术途径",
           "method": {"lag_range": [LAG_MIN, LAG_MAX], "lag_min_mainlobes": LAG_MIN_MAINLOBES, "cp_span": CP_SPAN,
                      "edge": EDGE, "per_group": a.per_group, "seed": SEED},
           "holdout": {"manifest_sha256": holdout_sha, "checked_products": len(uniq), "intersection": 0},
           "controls": ctrl, "groups": groups, "sim": sim}
    with open(os.path.join(ROOT, OUT_JSON), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    with open(os.path.join(ROOT, OUT_MD), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(report(doc) + "\n")
    print(f"wrote {OUT_JSON}、{OUT_MD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
