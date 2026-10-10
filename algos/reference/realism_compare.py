#!/usr/bin/env python3
"""真实感对照：生成 IQ 与公开实测数据逐项比（Q-5，D-096；14 号报告 §7.2–§7.3；06 §9K）。

口径全部写在 14 号报告 §7.3（先写死，再取数）。本脚本只做三件事：

1. **实测一侧**：按 §7.3 的配对选实测片段（DroneRFb 只取视距片），用 Q-0b 的提取器
   （`q0b_param_extract.py`，常数一个不改）逐块量突发，分「验证集」「实测样本集」「全部」三列。
2. **合成一侧**：按格子集 `tests/regression/eval-dataset/realism-v1.json` 逐格跑 `cuav_run`（只出 S3），
   读 `s3/iq.cf32`，按实测的块长切块，用同一个提取器量。
3. **比**：每对每个统计量给三列的数、差、KS 距离与判定；平均谱形给带内 dB 均方根差；跳频点给点数与跨度；
   归因变体（只对 P1）与结构自检另列。

本脚本在 Q-0b 的提取之外只加三样东西，都写在这里：逐突发去噪功率谱的平均（`burst_psd`）、
两样本 KS 距离（`ks_distance`）、按 §7.3 的线判定（`LINES`）。

**选窗与选样本只用实测样本集与写死的规则**：遥控 / 上行的角色窗取 `q0b-params.json`（实测样本集认出的），
三列共用该对第一型的窗（同一对里各型的窗差不到 0.3%）；代表性时频图取「按 data_id 排序第一个满足条件的块」。

输出：
- `data/eval/realism-v1/realism.json`（入库）：全部数字、样本清单与判定；不写时间戳与 git 提交，两次运行逐字节相同；
- 报告由 `realism_report.py` 写成单文件 HTML（`data/eval/realism-v1/realism-report.html`，不入库）。

缓存（`data/tmp/realism/cache/`）：实测一侧按「本脚本 + Q-0b 脚本 + 索引 + 验证集清单」的哈希缓存，
合成一侧按「本脚本 + Q-0b 脚本 + 框图 + 场景 + 引擎」的哈希逐格缓存；改了任何一样就重算。`--no-cache` 全部重算。

跑法（开发机约 10 分钟；需要 data/iq/measured 与已建好的 engine/build/cuav_run）：
    uv run --quiet --with numpy --with scipy --with matplotlib python algos/reference/realism_compare.py
    uv run --quiet --with numpy --with scipy --with matplotlib python algos/reference/realism_compare.py --check
单测（合成夹具，不读数据、不跑引擎）：
    uv run --quiet --with numpy --with scipy python -m unittest tests/unit/test_realism_compare.py

全部数字是**原型阶段验证值**（D-028）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pickle
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from scipy import fft as sfft

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import q0b_param_extract as Q  # noqa: E402

VERSION = "0.1.0"
SET_ID = "realism-v1"
OUT_DIR = os.path.join("data", "eval", SET_ID)
OUT_JSON = os.path.join(OUT_DIR, "realism.json")
TMP = os.path.join("data", "tmp", "realism")
CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))

MHZ = 1e6

# ---------------------------------------------------------------- 14 §7.3 的配对与判定线

# main / ref：主列与参照列取哪部分实测（holdout = 验证集，train = 实测样本集，all = 全部）
PAIRS = [
    {"id": "p1", "cell": "p1", "preset": "dji-video-20m-a", "kind": "video", "source": "dronerfb_dji",
     "classes": ["A", "D", "F", "G"], "main": "holdout", "ref": "train", "independent": True,
     "measured": "DroneRFb A / D / F / G 型的图传", "block_s": 0.05,
     "psd_res_Hz": 78125.0, "psd_span_Hz": 15e6},
    {"id": "p2", "cell": "p2", "preset": "dji-video-20m-c", "kind": "video", "source": "dronerfb_dji",
     "classes": ["C", "E"], "main": "holdout", "ref": "train", "independent": True,
     "measured": "DroneRFb C / E 型的图传", "block_s": 0.05,
     "psd_res_Hz": 78125.0, "psd_span_Hz": 15e6},
    {"id": "p3", "cell": "p3", "preset": "dji-uplink-1m", "kind": "link", "source": "dronerfb_dji",
     "classes": ["C", "E"], "main": "holdout", "ref": "train", "independent": True,
     "measured": "DroneRFb C / E 型的上行", "block_s": 0.05,
     "psd_res_Hz": 19531.25, "psd_span_Hz": 2.5e6},
    {"id": "p4", "cell": "p4", "preset": "dji-uplink-2m", "kind": "link", "source": "dronerfb_dji",
     "classes": ["A", "G"], "main": "holdout", "ref": "train", "independent": True,
     "measured": "DroneRFb A / G 型的上行", "block_s": 0.05,
     "psd_res_Hz": 19531.25, "psd_span_Hz": 4e6},
    {"id": "p5", "cell": "p5", "preset": "dji-uplink-4m", "kind": "link", "source": "dronerfb_dji",
     "classes": ["D", "F"], "main": "holdout", "ref": "train", "independent": True,
     "measured": "DroneRFb D / F 型的上行", "block_s": 0.05,
     "psd_res_Hz": 19531.25, "psd_span_Hz": 7e6},
    {"id": "p6", "cell": "p6", "preset": "dji-video-40m", "kind": "video", "source": "dronerfa_mavic3_5g8",
     "classes": None, "main": "all", "ref": None, "independent": False,
     "measured": "DroneRFa Mavic 3 的 5.8 GHz 图传", "block_s": 0.1,
     "psd_res_Hz": 100000.0, "psd_span_Hz": 28e6},
    {"id": "p7", "cell": "p7", "preset": "frsky-d16v2-fcc", "kind": "link", "source": "dronerfa_frsky_x20",
     "classes": None, "main": "holdout", "ref": "train", "independent": True,
     "measured": "DroneRFa FrSky X20 遥控", "block_s": 0.1,
     "psd_res_Hz": 6103.515625, "psd_span_Hz": 0.5e6},
    {"id": "p8", "cell": "p8", "preset": "futaba-sfhss", "kind": "link", "source": "dronerfa_futaba_t14sg",
     "classes": None, "main": "all", "ref": None, "independent": False,
     "measured": "DroneRFa Futaba T14SG 遥控（协议不同）", "block_s": 0.1,
     "psd_res_Hz": 12207.03125, "psd_span_Hz": 2.5e6, "supplement": "preset_window"},
]
VARIANTS = ["p1-ideal", "p1-tgn-b", "p1-tgn-c", "p1-tgn-d", "p1-tgn-e", "p1-tgn-f"]
SELFCHECKS = [
    {"id": "s1", "cell": "s1", "preset": "dji-video-10m", "kind": "video", "block_s": 0.05,
     "video": {"f_range_Hz": [2450e6, 2480e6], "min_bw_Hz": 6e6}, "link_bw": (0.5e6, 12e6),
     "psd_res_Hz": 78125.0, "psd_span_Hz": 10e6},
    {"id": "s2", "cell": "s2", "preset": "dji-droneid", "kind": "burst", "block_s": 0.05,
     "video": None, "link_bw": (5e6, 12e6), "bw10_range_Hz": (6e6, 12e6), "dur_range_s": (0.3e-3, 1.5e-3)},
]

# 判定线（14 §7.3，线在取数之前定）
LINES = {
    "obw99_Hz": {"measure": "rel_median", "line": 0.05},
    "bw10_Hz": {"measure": "rel_median", "line": 0.05},
    "dur_s": {"measure": "rel_median", "line": 0.05},
    "flatness": {"measure": "abs_median", "line": 0.05},
    "papr_dB": {"measure": "abs_median", "line": 0.5},
    "interval_s": {"measure": "ks", "line": 0.2},
    "shape": {"measure": "rms_dB", "line": 1.0},
    "hops": {"measure": "points_and_span", "line": 0.05},
}
# 只报数、不判
INFO_STATS = ["bw3_Hz", "snr_dB"]
STAT_ORDER = ["obw99_Hz", "bw10_Hz", "dur_s", "interval_s", "flatness", "papr_dB", "bw3_Hz", "snr_dB"]
SELFCHECK_LINE = 0.05            # 结构自检对出处的数：相对差 ≤ 5%（同带宽、时长的线）
DROID_DUR_S = 9880 / 15.36e6     # DroneID 九符号 9880 个原生样点（NDSS 2023 §III-B；14 §2.6）
DROID_PERIOD_S = 0.64
OCC_10M_HZ = 601 * 15e3

# 代表性时频图：一块里至少这么多个可比突发
REP_MIN_VIDEO = 5
REP_MIN_CORE = 3
SPEC_ROWS = 600
SPEC_RANGE_DB = 40.0


# ---------------------------------------------------------------- 小工具

def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def r6(a):
    """保留 6 位有效数字（None 原样）；JSON 里的数一律经它，两次运行逐字节相同。"""
    if a is None:
        return None
    a = float(a)
    if not math.isfinite(a):
        return None
    return float(f"{a:.6g}")


def ks_distance(a, b) -> float | None:
    """两样本 KS 距离：两条经验分布函数之差的上确界。任一侧没有样本返回 None。"""
    a = np.sort(np.asarray(a, dtype=float))
    b = np.sort(np.asarray(b, dtype=float))
    if a.size == 0 or b.size == 0:
        return None
    v = np.concatenate([a, b])
    fa = np.searchsorted(a, v, side="right") / a.size
    fb = np.searchsorted(b, v, side="right") / b.size
    return float(np.max(np.abs(fa - fb)))


def median(vals) -> float | None:
    v = [x for x in vals if x is not None and math.isfinite(x)]
    return float(np.median(v)) if v else None


def source(sid: str) -> dict:
    return next(s for s in Q.SOURCES if s["id"] == sid)


def q0b_doc() -> dict:
    with open(os.path.join(ROOT, "data", "iq", "measured", "q0b-params.json"), encoding="utf-8") as fh:
        return json.load(fh)


def link_window(q0b: dict, pair: dict) -> dict:
    """该对的角色窗：q0b-params.json 实测样本集认出的窗，取该对第一型（DroneRFa 只有一组）。"""
    src = next(s for s in q0b["sources"] if s["id"] == pair["source"])
    want = pair["classes"][0] if pair["classes"] else None
    for g in src["groups"]:
        if want is None or g["group"] == want:
            link = g["links"][0]
            if not link.get("found"):
                raise SystemExit(f"{pair['id']}：q0b-params.json 里 {pair['source']} / {want} 没认出角色")
            return {"bw10_Hz": link["mode"]["bw10_Hz"], "dur_s": link["mode"]["dur_s"], "from": want or "all"}
    raise SystemExit(f"{pair['id']}：q0b-params.json 里没有 {pair['source']} / {want}")


# ---------------------------------------------------------------- 一块：与 Q-0b analyse_block 同一过程，另留下时频图

def block_bursts(x: np.ndarray, fs: float, fc: float, video: dict | None, link_bw: tuple[float, float]):
    """与 `Q.analyse_block` 逐步相同（除去不依赖突发检测的探测信噪比），多返回时频图 tf 供逐突发谱用。

    `test_realism_compare.py` 在合成夹具上核对两者的突发逐字段相同。"""
    tf = Q.tf_map(x, fs, fc)
    bl = Q.blobs(tf)
    channels, ex = [], []
    if video:
        for k0, k1 in Q.find_channels(tf, bl, video["min_bw_Hz"], *video["f_range_Hz"]):
            bursts, info = Q.channel_bursts(x, tf, k0, k1)
            channels.append({"f_lo_Hz": tf.bin_freq(k0), "f_hi_Hz": tf.bin_freq(k1), "bursts": bursts})
            ex.append((k0, k1, info["runs"]))
    hops = Q.hop_bursts(x, tf, bl, link_bw, exclude=ex)
    return tf, channels, hops


def psd_grid(pair: dict) -> np.ndarray:
    n = int(round(pair["psd_span_Hz"] / pair["psd_res_Hz"]))
    return np.arange(-n, n + 1) * pair["psd_res_Hz"]


def burst_psd(x: np.ndarray, tf, t0_s: float, dur_s: float, align_Hz: float, res_Hz: float,
              grid: np.ndarray, robust: bool) -> np.ndarray | None:
    """一个突发核心段（中点 ± 0.4 × 时长，与 Q-0b 精化同段）的去噪功率谱，插到相对 align_Hz 的格点上。

    帧长 m = 2^⌈log2(fs/res)⌉、汉宁窗、不重叠；功率按 |X|²/Σw² 归一（与 Q-0b 的时频图同一尺度，故能直接
    减去 tf.noise_mean 插值出的噪声）。robust：逐频点取帧的中位数并减 ln2 × 噪声（图传，与 Q-0b 宽带信道同法）；
    否则取均值减噪声（跳频类）。核心段不足一帧（robust 时不足 5 帧）返回 None。"""
    fs = tf.fs
    m = 1 << int(math.ceil(math.log2(fs / res_Hz)))
    c = (t0_s + 0.5 * dur_s) * fs
    a, b = int(max(0, c - 0.4 * dur_s * fs)), int(min(x.size, c + 0.4 * dur_s * fs))
    k = (b - a) // m
    if k < (5 if robust else 1):
        return None
    w = np.hanning(m)
    X = sfft.fftshift(sfft.fft(x[a:a + k * m].astype(np.complex128).reshape(k, m) * w, axis=1), axes=1)
    pw = (X.real ** 2 + X.imag ** 2) / np.sum(w * w)
    fb = tf.fc + (np.arange(m) - m / 2) * fs / m
    nm = np.interp(fb, tf.fc + (np.arange(tf.nfft) - tf.nfft / 2) * tf.bin_Hz, tf.noise_mean)
    ex = (np.median(pw, axis=0) - math.log(2) * nm) if robust else (np.mean(pw, axis=0) - nm)
    return np.interp(align_Hz + grid, fb, ex, left=np.nan, right=np.nan)


def normalized(v: np.ndarray | None, grid: np.ndarray, band_Hz: float) -> np.ndarray | None:
    """按 |偏移| ≤ band/2 内的均值归一；带内有缺口或均值不为正返回 None。"""
    if v is None:
        return None
    inb = np.abs(grid) <= band_Hz / 2
    if not np.all(np.isfinite(v[inb])):
        return None
    mu = float(np.mean(v[inb]))
    if mu <= 0:
        return None
    return v / mu


def spec_image(x: np.ndarray, fs: float, rows: int = SPEC_ROWS) -> np.ndarray:
    """时频图：1024 点汉宁窗、不重叠，按时间分组取均值；以逐频点第 10 百分位为底，换成「高出底噪的 dB」，
    截到 [0, SPEC_RANGE_DB]。返回 float32 [行, 1024]，最早的一行在前。"""
    nfft = Q.NFFT
    n_frames = x.size // nfft
    w = np.hanning(nfft)
    grp = max(1, n_frames // rows)
    n_rows = n_frames // grp
    out = np.empty((n_rows, nfft))
    for r0 in range(0, n_rows, 64):
        r1 = min(n_rows, r0 + 64)
        seg = x[r0 * grp * nfft:r1 * grp * nfft].astype(np.complex128).reshape(r1 - r0, grp, nfft)
        X = sfft.fftshift(sfft.fft(seg * w, axis=2), axes=2)
        out[r0:r1] = np.mean(X.real ** 2 + X.imag ** 2, axis=1)
    floor = np.percentile(out, Q.FLOOR_PCT, axis=0)
    img = 10 * np.log10(np.maximum(out, 1e-300) / np.maximum(floor, 1e-300))
    return np.clip(img, 0.0, SPEC_RANGE_DB).astype(np.float32)


# ---------------------------------------------------------------- 一块 → 每个提取器的行

def extract(x: np.ndarray, fs: float, fc: float, cfg: dict) -> dict:
    """一块 → {提取器 id: 结果}。cfg：video、link_bw 与提取器表（每个配对一个）。

    图传与 Q-0b 的 summarize_video 同一取舍；遥控 / 上行与 summarize_link 同一取舍（角色窗、核心突发）。"""
    tf, channels, hops = block_bursts(x, fs, fc, cfg["video"], cfg["link_bw"])
    seconds = tf.mask.shape[0] * tf.cell_s
    out = {}
    for ex in cfg["extractors"]:
        grid = ex["grid"]
        res = {"seconds": seconds, "rows": [], "intervals": [], "steps": [], "core_centers": [],
               "snr": [], "n_bursts": 0, "n_core": 0, "on_s": 0.0, "psd_sum": np.zeros(grid.size),
               "psd_cnt": np.zeros(grid.size, dtype=np.int64), "n_psd": 0, "n_psd_skipped": 0}
        if ex["kind"] == "video":
            for ch in channels:
                align = round(0.5 * (ch["f_lo_Hz"] + ch["f_hi_Hz"]) / 0.5e6) * 0.5e6
                bs = sorted(ch["bursts"], key=lambda z: z.t0_s)
                res["n_bursts"] += len(bs)
                res["on_s"] += sum(z.dur_s for z in bs)
                ok = [z.snr_dB >= Q.VIDEO_MIN_SNR_DB for z in bs]
                for i in range(len(bs) - 1):
                    if ok[i] and ok[i + 1]:
                        res["intervals"].append(bs[i + 1].t0_s - bs[i].t0_s)
                res["snr"] += [z.snr_dB for z in bs]
                for z, o in zip(bs, ok):
                    if o and not z.truncated:
                        res["rows"].append(_row(z))
                        _acc_psd(res, normalized(burst_psd(x, tf, z.t0_s, z.dur_s, align, ex["res"], grid, True),
                                                 grid, ex["band_Hz"]))
        elif ex["kind"] == "link":
            mode = ex["window"]
            hs = sorted((h for h in hops if Q.in_role(h, mode)), key=lambda h: h.t0_s)
            cs = [h for h in hs if Q.in_core(h, mode)]
            res["n_bursts"] = len(hs)
            res["n_core"] = len(cs)
            res["snr"] = [h.snr_dB for h in hs]
            res["core_centers"] = [h.f_center_Hz for h in cs]
            for u, v in zip(cs, cs[1:]):
                res["intervals"].append(v.t0_s - u.t0_s)
                res["steps"].append(v.f_center_Hz - u.f_center_Hz)
            for h in hs:
                if not h.truncated and not h.contested:
                    res["rows"].append(_row(h))
                    _acc_psd(res, normalized(burst_psd(x, tf, h.t0_s, h.dur_s, h.f_center_Hz, ex["res"], grid, False),
                                             grid, ex["band_Hz"]))
        elif ex["kind"] == "burst":       # 结构自检 S2：DroneID，按宽度与时长取全部突发
            lo, hi = ex["bw10_range_Hz"]
            dlo, dhi = ex["dur_range_s"]
            for h in sorted(hops, key=lambda h: h.t0_s):
                if lo <= h.bw10_Hz <= hi and dlo <= h.dur_s <= dhi and not h.truncated:
                    res["rows"].append(_row(h))
                    res["n_bursts"] += 1
        out[ex["id"]] = res
    return out


def _row(z) -> dict:
    return {"t0_s": z.t0_s, "dur_s": z.dur_s, "f_center_Hz": z.f_center_Hz, "obw99_Hz": z.obw99_Hz,
            "bw10_Hz": z.bw10_Hz, "bw3_Hz": z.bw3_Hz, "flatness": z.flatness, "snr_dB": z.snr_dB,
            "papr_dB": z.papr_dB}


def _acc_psd(res: dict, v: np.ndarray | None) -> None:
    if v is None:
        res["n_psd_skipped"] += 1
        return
    ok = np.isfinite(v)
    res["psd_sum"][ok] += v[ok]
    res["psd_cnt"][ok] += 1
    res["n_psd"] += 1


def preset_window(item: dict) -> dict:
    """补充窗（取数之后加的，不判定）：按预设自己的占用带宽与单包时长认合成突发。

    只给 P8：Futaba 实测片段的角色窗（1.32 MHz、1.93 ms）装不下 S-FHSS 的包（约 0.2 MHz、1.44 ms），
    按口径三列共用一个窗时合成一侧一个突发也认不出（协议不同，14 §7.1）。"""
    from eval_dataset import scenario as S
    _, raw = S.preset(item["preset"])
    n_bits = raw["frame"]["packets"][0]["n_bits"]
    return {"bw10_Hz": float(raw["occupied_bw_Hz"]), "dur_s": n_bits / float(raw["symbol_rate_Hz"]), "from": "preset"}


def extractor_cfg(item: dict, q0b: dict | None, own: bool = False) -> dict:
    """配对 / 自检 → 提取器描述（可 pickle，交给工作进程）。own：用预设自己的补充窗，提取器 id 加后缀 -own。"""
    from eval_dataset import scenario as S
    band = float(S.preset(item["preset"])[1]["occupied_bw_Hz"])
    ex = {"id": item["id"] + ("-own" if own else ""), "kind": item["kind"], "band_Hz": band}
    if item["kind"] in ("video", "link"):
        ex["res"] = item["psd_res_Hz"]
        ex["grid"] = psd_grid(item)
    else:
        ex["res"] = 1.0
        ex["grid"] = np.zeros(1)
    if item["kind"] == "link":
        ex["window"] = preset_window(item) if own else link_window(q0b, item)
    if item["kind"] == "burst":
        ex["bw10_range_Hz"] = item["bw10_range_Hz"]
        ex["dur_range_s"] = item["dur_range_s"]
    return ex


# ---------------------------------------------------------------- 实测一侧

def _measured_job(args):
    path, batch, data_id, cfg = args
    from iq_format import store
    p = store.open_product(path)
    fs, fc = p.sample_rate_Hz, p.center_frequency_Hz
    block = Q.DRONERFA_BLOCK if batch == "dronerfa" else p.sample_count
    out = []
    for start in range(0, p.sample_count, block):
        n = min(block, p.sample_count - start)
        if n < 64 * Q.CELL_FRAMES * Q.NFFT:
            continue
        out.append({"start": start, "n": n, "fs": fs, "fc": fc, "res": extract(p.read(start, n), fs, fc, cfg)})
    return data_id, out


def measured_plan(q0b: dict) -> tuple[list[tuple], dict]:
    """每个实测片段一个作业：(清单路径, 批次, data_id, 提取器配置)；另返回每对每列的 data_id 清单。"""
    ids, hashes, _ = Q.load_holdout()
    index = {b: Q.load_index(b) for b in ("dronerfb", "dronerfa")}
    jobs: dict[str, tuple] = {}
    columns: dict[str, dict[str, list[str]]] = {}
    for pair in PAIRS:
        src = source(pair["source"])
        rule = {k: v for k, v in src["select"].items() if k != "split"}
        recs = Q.select(index[src["batch"]], rule)
        if pair["classes"]:
            recs = [r for r in recs if r.truth.get("class_code", "")[:1] in pair["classes"]
                    and r.truth.get("visibility") == "LOS"]
        hold = [r for r in recs if r.data_id in ids or (r.content_sha256 and r.content_sha256 in hashes)]
        hold_ids = {r.data_id for r in hold}
        if src["batch"] == "dronerfb":
            train = [r for r in recs if r.truth.get("split") == "train" and r.data_id not in hold_ids]
        else:
            train = [r for r in recs if r.data_id not in hold_ids]
        cols = {"holdout": hold, "train": train, "all": [r for r in recs if r.data_id not in hold_ids]}
        if pair["main"] == "all" and hold:
            raise SystemExit(f"{pair['id']}：主列写的是「全部」，但有 {len(hold)} 片在验证集里——口径与数据不符")
        columns[pair["id"]] = {}
        for col in (pair["main"], pair["ref"]):
            if col is None:
                continue
            columns[pair["id"]][col] = sorted(r.data_id for r in cols[col])
            for r in cols[col]:
                jobs.setdefault(r.data_id, (r, src))
    q = {p["id"]: extractor_cfg(p, q0b) for p in PAIRS}
    member = {p["id"]: set().union(*columns[p["id"]].values()) for p in PAIRS}
    out = []
    for data_id in sorted(jobs):
        r, src = jobs[data_id]
        mine = [p for p in PAIRS if data_id in member[p["id"]]]
        cfg = {"video": src["video"], "link_bw": tuple(src["links"][0]["bw_range_Hz"]),
               "extractors": [q[p["id"]] for p in mine]}
        out.append((r.path, r.batch, data_id, cfg))
    return out, columns


# ---------------------------------------------------------------- 合成一侧

def _synth_job(args):
    path, start, n, fs, fc, cfg = args
    x = np.memmap(path, dtype=np.complex64, mode="r")[start:start + n]
    return {"start": start, "n": n, "fs": fs, "fc": fc, "res": extract(np.asarray(x), fs, fc, cfg)}


def run_cell(cell_id: str) -> tuple[str, dict]:
    """跑一格：prepare（写场景、编框图、--validate）→ cuav_run（只出 S3）。返回 (运行目录, 输入哈希)。"""
    import gen_eval_dataset as G
    from eval_dataset import cells as C
    doc = C.load(SET_ID)
    cell = next(c for c in doc["cells"] if c["id"] == cell_id)
    files = G.prepare_cell(doc, cell)
    run_dir = os.path.join(ROOT, TMP, "runs", cell_id)
    shutil.rmtree(run_dir, ignore_errors=True)
    p = subprocess.run([CUAV_RUN, "--run", files["diagram"], "--out", rel(run_dir), "--task-id", f"rv1-{cell_id}",
                        "--scenario", files["scenario"], "--library-root", "models/recognition"],
                       cwd=ROOT, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"{cell_id}：cuav_run 退出码 {p.returncode}：{(p.stdout + p.stderr).strip()[-800:]}")
    return run_dir, {"diagram_sha256": sha256_file(os.path.join(ROOT, files["diagram"])),
                     "scenario_sha256": sha256_file(os.path.join(ROOT, files["scenario"]))}


def synth_inputs_key(cell_id: str) -> str:
    """缓存键：本脚本、Q-0b 脚本、格子文件、引擎二进制。框图与场景由格子文件确定性生成，格子文件变了它们才会变。"""
    h = hashlib.sha256()
    for p in (__file__, Q.__file__, os.path.join(ROOT, "tests", "regression", "eval-dataset", f"{SET_ID}.json"),
              CUAV_RUN):
        h.update(sha256_file(p).encode())
    h.update(cell_id.encode())
    return h.hexdigest()[:20]


def analyse_synth(cell_id: str, item: dict, q0b: dict, workers: int, use_cache: bool) -> dict:
    cache = os.path.join(ROOT, TMP, "cache", f"synth-{cell_id}-{synth_inputs_key(cell_id)}.pkl")
    if use_cache and os.path.exists(cache):
        with open(cache, "rb") as fh:
            return pickle.load(fh)
    run_dir, hashes = run_cell(cell_id)
    with open(os.path.join(run_dir, "s3", "iq.index.json"), encoding="utf-8") as fh:
        idx = json.load(fh)
    fs, fc, n_all = idx["sample_rate_Hz"], idx["center_Hz"], idx["samples"]
    path = os.path.join(run_dir, "s3", "iq.cf32")
    block = int(round(item["block_s"] * fs))
    if item["kind"] in ("video", "link") and "source" in item:
        src = source(item["source"])
        exs = [extractor_cfg(item, q0b)]
        if item.get("supplement") == "preset_window":
            exs.append(extractor_cfg(item, q0b, own=True))
        cfg = {"video": src["video"], "link_bw": tuple(src["links"][0]["bw_range_Hz"]), "extractors": exs}
    else:
        cfg = {"video": item.get("video"), "link_bw": item["link_bw"], "extractors": [extractor_cfg(item, q0b)]}
    jobs = [(path, s, block, fs, fc, cfg) for s in range(0, n_all - block + 1, block)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        blocks = list(pool.map(_synth_job, jobs))
    rep = representative(blocks, item, item["id"])
    if rep is None and item.get("supplement") == "preset_window":
        rep = representative(blocks, item, item["id"] + "-own")
        if rep is not None:
            rep["window"] = "own"
    img = None
    if rep is not None:
        x = np.asarray(np.memmap(path, dtype=np.complex64, mode="r")[rep["start"]:rep["start"] + rep["n"]])
        img = spec_image(x, fs)
    out = {"cell": cell_id, "fs": fs, "fc": fc, "samples": n_all, "state": idx.get("state"),
           "clipped_samples": idx.get("clipped_samples"), "block_samples": block, "blocks": blocks,
           "rep": rep, "rep_img": img, **hashes}
    shutil.rmtree(run_dir, ignore_errors=True)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "wb") as fh:
        pickle.dump(out, fh, protocol=4)
    return out


# ---------------------------------------------------------------- 汇总

def representative(blocks: list[dict], item: dict, ex_id: str, data_id: str | None = None) -> dict | None:
    """第一个满足条件的块：图传 ≥ REP_MIN_VIDEO 个可比突发，跳频类 ≥ REP_MIN_CORE 个核心突发，DroneID ≥ 1 个。"""
    for b in blocks:
        r = b["res"].get(ex_id)
        if r is None:
            continue
        need = (len(r["rows"]) >= REP_MIN_VIDEO if item["kind"] == "video" else
                r["n_core"] >= REP_MIN_CORE if item["kind"] == "link" else r["n_bursts"] >= 1)
        if need:
            return {"data_id": data_id, "start": b["start"], "n": b["n"], "fs": b["fs"], "fc": b["fc"]}
    return None


def pool_column(blocks: list[dict], ex_id: str, tag: str | None = None) -> dict:
    """把一列的块结果并起来。tag：DroneRFb 的型号字母，逐行带上，供分型补充表用。"""
    rows, intervals, steps, centers, snr = [], [], [], [], []
    psd_sum = psd_cnt = None
    sec = on = 0.0
    n_b = n_core = n_psd = n_skip = n_blocks = 0
    for b in blocks:
        r = b["res"].get(ex_id)
        if r is None:
            continue
        n_blocks += 1
        sec += r["seconds"]
        on += r["on_s"]
        rows += [dict(z, cls=b.get("cls")) for z in r["rows"]]
        intervals += r["intervals"]
        steps += r["steps"]
        centers += r["core_centers"]
        snr += r["snr"]
        n_b += r["n_bursts"]
        n_core += r["n_core"]
        n_psd += r["n_psd"]
        n_skip += r["n_psd_skipped"]
        psd_sum = r["psd_sum"].copy() if psd_sum is None else psd_sum + r["psd_sum"]
        psd_cnt = r["psd_cnt"].copy() if psd_cnt is None else psd_cnt + r["psd_cnt"]
    shape = None
    if psd_sum is not None and n_psd:
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(psd_cnt > 0, psd_sum / np.maximum(psd_cnt, 1), np.nan)
            shape = 10 * np.log10(np.where(mean > 0, mean, np.nan))
    return {"rows": rows, "intervals": intervals, "steps": steps, "core_centers": centers, "snr": snr,
            "seconds": sec, "on_s": on, "n_blocks": n_blocks, "n_bursts": n_b, "n_core": n_core,
            "n_psd": n_psd, "n_psd_skipped": n_skip, "shape_dB": shape}


def values(col: dict, stat: str) -> list[float]:
    if stat == "interval_s":
        return [v for v in col["intervals"]]
    if stat == "snr_dB":
        return [v for v in col["snr"] if math.isfinite(v)]
    return [z[stat] for z in col["rows"] if z[stat] is not None and math.isfinite(z[stat])]


def summary(vals: list[float]) -> dict:
    if not vals:
        return {"n": 0}
    p = np.percentile(np.asarray(vals, dtype=float), [10, 50, 90])
    return {"n": len(vals), "p10": r6(p[0]), "median": r6(p[1]), "p90": r6(p[2])}


def compare(stat: str, main: list[float], other: list[float]) -> dict:
    """other 对 main：中位数差、相对差、KS 距离；有线的统计量给判定。"""
    mm, mo = median(main), median(other)
    out = {"ks": r6(ks_distance(main, other)),
           "diff": r6(mo - mm) if mm is not None and mo is not None else None,
           "rel": r6((mo - mm) / mm) if mm not in (None, 0) and mo is not None else None}
    line = LINES.get(stat)
    if line is None:
        return out
    if mm is None or mo is None:
        out.update(verdict="无法比较", why="一侧没有可比的突发")
        return out
    m = line["measure"]
    val = abs(out["rel"]) if m == "rel_median" else abs(out["diff"]) if m == "abs_median" else out["ks"]
    out.update(measure=m, value=r6(val), line=line["line"], verdict="一致" if val <= line["line"] else "有差距")
    return out


def shape_rms(a: np.ndarray | None, b: np.ndarray | None, grid: np.ndarray, band_Hz: float) -> float | None:
    if a is None or b is None:
        return None
    inb = (np.abs(grid) <= band_Hz / 2) & np.isfinite(a) & np.isfinite(b)
    if not inb.any():
        return None
    d = b[inb] - a[inb]
    return float(np.sqrt(np.mean(d * d)))


def hop_summary(col: dict, window: dict) -> dict:
    fsr = Q.freq_set(col["core_centers"], 0.3 * window["bw10_Hz"])
    fsr.pop("points_Hz", None)
    steps = [abs(v) for v in col["steps"]]
    return {**fsr, "step_abs_median_Hz": r6(median(steps)) if steps else None}


def hop_compare(main: dict, other: dict) -> dict:
    if not main.get("n_points") or not other.get("n_points"):
        return {"verdict": "无法比较", "why": "一侧没有核心突发"}
    span_rel = (other["span_Hz"] - main["span_Hz"]) / main["span_Hz"] if main["span_Hz"] else None
    ok = other["n_points"] == main["n_points"] and span_rel is not None and abs(span_rel) <= LINES["hops"]["line"]
    return {"points_diff": other["n_points"] - main["n_points"], "span_rel": r6(span_rel),
            "line": LINES["hops"]["line"], "verdict": "一致" if ok else "有差距"}


def column_doc(col: dict, item: dict, window: dict | None) -> dict:
    d = {"n_blocks": col["n_blocks"], "seconds": r6(col["seconds"]), "n_bursts": col["n_bursts"], "n_clean": len(col["rows"]),
         "bursts_per_s": r6(col["n_bursts"] / col["seconds"]) if col["seconds"] else None,
         "n_psd": col["n_psd"], "n_psd_skipped": col["n_psd_skipped"],
         "stats": {s: summary(values(col, s)) for s in STAT_ORDER},
         "dur_peaks_ms": Q.histogram_peaks([z["dur_s"] * 1e3 for z in col["rows"]], 0.02),
         "interval_peaks_ms": Q.histogram_peaks([v * 1e3 for v in col["intervals"]], 0.1)}
    if item["kind"] == "video":
        d["duty"] = r6(col["on_s"] / col["seconds"]) if col["seconds"] else None
    if item["kind"] == "link":
        d["n_core"] = col["n_core"]
        d["core_per_s"] = r6(col["n_core"] / col["seconds"]) if col["seconds"] else None
        d["hops"] = hop_summary(col, window)
    return d


def pair_doc(pair: dict, cols: dict[str, dict], synth: dict, window: dict | None, columns: dict,
             synth_col: dict, q0b: dict) -> dict:
    grid = psd_grid(pair)
    band = extractor_cfg(pair, q0b)["band_Hz"]
    main = cols[pair["main"]]
    ref = cols.get(pair["ref"]) if pair["ref"] else None
    stats = []
    for s in STAT_ORDER:
        vm, vs = values(main, s), values(synth_col, s)
        row = {"stat": s, "synth_vs_main": compare(s, vm, vs)}
        if ref is not None:
            row["ref_vs_main"] = compare(s, vm, values(ref, s))
            row["ref_vs_main"].pop("verdict", None)
            row["ref_vs_main"].pop("why", None)
        stats.append(row)
    shape = {"res_Hz": pair["psd_res_Hz"], "span_Hz": pair["psd_span_Hz"], "band_Hz": band,
             "synth_vs_main_rms_dB": r6(shape_rms(main["shape_dB"], synth_col["shape_dB"], grid, band))}
    shape["verdict"] = ("无法比较" if shape["synth_vs_main_rms_dB"] is None else
                        "一致" if shape["synth_vs_main_rms_dB"] <= LINES["shape"]["line"] else "有差距")
    shape["line"] = LINES["shape"]["line"]
    if ref is not None:
        shape["ref_vs_main_rms_dB"] = r6(shape_rms(main["shape_dB"], ref["shape_dB"], grid, band))
    shape["curves_dB"] = {k: [r6(v) for v in c["shape_dB"]] if c["shape_dB"] is not None else None
                          for k, c in (("main", main), ("ref", ref), ("synth", synth_col)) if c is not None}
    doc = {"id": pair["id"], "preset": pair["preset"], "kind": pair["kind"], "measured": pair["measured"],
           "dataset": source(pair["source"])["dataset"], "classes": pair["classes"], "main": pair["main"],
           "ref": pair["ref"], "independent": pair["independent"], "block_s": pair["block_s"],
           "window": window,
           "columns": {"main": column_doc(main, pair, window),
                       **({"ref": column_doc(ref, pair, window)} if ref is not None else {}),
                       "synth": column_doc(synth_col, pair, window)},
           "stats": stats, "shape": shape,
           "synthetic": {"cell": synth["cell"], "fs_Hz": synth["fs"], "center_Hz": synth["fc"],
                         "samples": synth["samples"], "state": synth["state"],
                         "clipped_samples": synth["clipped_samples"]},
           "samples": {k: v for k, v in columns[pair["id"]].items()}}
    if pair["kind"] == "link":
        doc["hops"] = {"synth_vs_main": hop_compare(doc["columns"]["main"]["hops"], doc["columns"]["synth"]["hops"])}
        if ref is not None:
            h = hop_compare(doc["columns"]["main"]["hops"], doc["columns"]["ref"]["hops"])
            h.pop("verdict", None)
            doc["hops"]["ref_vs_main"] = h
    if pair["classes"]:
        doc["by_class"] = {}
        for c in pair["classes"]:
            sub = {**main, "rows": [z for z in main["rows"] if z.get("cls") == c]}
            doc["by_class"][c] = {s: summary(values(sub, s)) for s in ("obw99_Hz", "bw10_Hz", "dur_s", "flatness")}
    return doc


def verdicts(doc: dict) -> dict:
    """一对的判定汇总：统计量 → 一致 / 有差距 / 无法比较。"""
    v = {r["stat"]: r["synth_vs_main"]["verdict"] for r in doc["stats"] if "verdict" in r["synth_vs_main"]}
    v["shape"] = doc["shape"]["verdict"]
    if "hops" in doc:
        v["hops"] = doc["hops"]["synth_vs_main"]["verdict"]
    return v


# ---------------------------------------------------------------- 诊断（取数之后加的，不判定；报告里解释差距用的数都从这里来）

def _noise_profile(job):
    """一个实测片段的前几块：逐频点噪声均值（未占用格），按中位数归一。"""
    path, batch, n_blocks = job
    from iq_format import store
    p = store.open_product(path)
    block = Q.DRONERFA_BLOCK if batch == "dronerfa" else p.sample_count
    out = []
    for s in range(0, min(p.sample_count, n_blocks * block), block):
        tf = Q.tf_map(p.read(s, min(block, p.sample_count - s)), p.sample_rate_Hz, p.center_frequency_Hz)
        out.append(tf.noise_mean / np.median(tf.noise_mean))
    return p.sample_rate_Hz, p.center_frequency_Hz, out


def _band_profile(freq: np.ndarray, db: np.ndarray, center: float, band: float, edge: float = 2e6) -> dict:
    """占用带宽内三段的平均 dB：低端 [c−B/2, c−B/2+2 MHz]、中段 [c−1 MHz, c+1 MHz]、高端 [c+B/2−2 MHz, c+B/2]。"""
    def mean_in(lo, hi):
        sel = (freq >= lo) & (freq <= hi) & np.isfinite(db)
        return r6(float(np.mean(db[sel]))) if sel.any() else None
    lo = mean_in(center - band / 2, center - band / 2 + edge)
    mid = mean_in(center - 1e6, center + 1e6)
    hi = mean_in(center + band / 2 - edge, center + band / 2)
    return {"low_dB": lo, "mid_dB": mid, "high_dB": hi,
            "low_minus_high_dB": r6(lo - hi) if lo is not None and hi is not None else None,
            "mid_minus_edges_dB": r6(mid - 0.5 * (lo + hi)) if None not in (lo, mid, hi) else None}


def receiver_profile(recs: list, center: float, band: float, n_blocks: int, workers: int) -> dict:
    """采集接收机在某频段内的噪声底形状（噪声不经过发射机，只经过接收机）。"""
    with ProcessPoolExecutor(max_workers=workers) as pool:
        res = list(pool.map(_noise_profile, [(r.path, r.batch, n_blocks) for r in recs]))
    fs, fc = res[0][0], res[0][1]
    prof = np.mean([v for _, _, vs in res for v in vs], axis=0)
    freq = fc + (np.arange(Q.NFFT) - Q.NFFT / 2) * fs / Q.NFFT
    return {"n_records": len(recs), "n_blocks": sum(len(vs) for _, _, vs in res),
            **_band_profile(freq, 10 * np.log10(prof), center, band)}


def diagnose(pairs_out: list[dict], columns: dict, measured: dict, q0b: dict, workers: int) -> dict:
    """解释差距用的几个数（取数之后加的，不判定）：
    - 采集接收机的噪声底形状 vs 实测图传平均谱形状（P1：DroneRFb 实测样本集里的背景片；P6：Mavic 3 RF1 实测片段本身）；
    - P3：实测角色窗里恒包络突发（峰均比 < 4 dB）的占比，与去掉它们之后的峰均比中位数。"""
    idx = {b: Q.load_index(b) for b in ("dronerfb", "dronerfa")}
    out = {"note": "取数之后为解释差距加的诊断，不判定"}
    for pid, recs, center, n_blocks in (
            ("p1", [r for r in idx["dronerfb"] if r.truth.get("class_code", "")[:1] == "B"
                    and r.truth.get("split") == "train"], 2462.5e6, 1),
            ("p6", [r for r in idx["dronerfa"] if r.truth.get("class_code") == "T1010" and r.channel_id == "RF1"],
             5796.5e6, 3)):
        p = next(d for d in pairs_out if d["id"] == pid)
        sh = p["shape"]
        n = int(round(sh["span_Hz"] / sh["res_Hz"]))
        grid = np.arange(-n, n + 1) * sh["res_Hz"]
        sig = np.array([np.nan if v is None else v for v in sh["curves_dB"]["main"]])
        out[pid] = {"receiver_noise": receiver_profile(recs, center, sh["band_Hz"], n_blocks, workers),
                    "measured_signal": _band_profile(grid + center, sig, center, sh["band_Hz"]),
                    "receiver_source": "DroneRFb 实测样本集里的背景片" if pid == "p1" else "Mavic 3 的 5.8 GHz 实测片段（未占用格）"}
    p3 = next(d for d in pairs_out if d["id"] == "p3")
    rows = [z for d in columns["p3"]["holdout"] for b in measured[d] for z in b["res"].get("p3", {}).get("rows", [])]
    pa = np.array([z["papr_dB"] for z in rows if z["papr_dB"] is not None])
    out["p3"] = {"papr_n": int(pa.size), "constant_envelope_frac": r6(float(np.mean(pa < 4.0))) if pa.size else None,
                 "papr_median_without_constant_envelope_dB": r6(float(np.median(pa[pa >= 4.0]))) if (pa >= 4).any() else None,
                 "synth_papr_median_dB": p3["columns"]["synth"]["stats"]["papr_dB"].get("median")}
    return out


# ---------------------------------------------------------------- 主流程

def measured_key() -> str:
    h = hashlib.sha256()
    for p in (__file__, Q.__file__, os.path.join(ROOT, "data", "iq", "measured", "holdout.manifest.json"),
              os.path.join(ROOT, "data", "iq", "measured", "q0b-params.json"),
              os.path.join(ROOT, "data", "iq", "measured", "dronerfb", "index.manifest.json"),
              os.path.join(ROOT, "data", "iq", "measured", "dronerfa", "index.manifest.json")):
        h.update(sha256_file(p).encode())
    return h.hexdigest()[:20]


def analyse_measured(q0b: dict, workers: int, use_cache: bool) -> tuple[dict, dict]:
    cache = os.path.join(ROOT, TMP, "cache", f"measured-{measured_key()}.pkl")
    if use_cache and os.path.exists(cache):
        with open(cache, "rb") as fh:
            return pickle.load(fh)
    jobs, columns = measured_plan(q0b)
    print(f"实测：{len(jobs)} 个实测片段", flush=True)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        res = dict(pool.map(_measured_job, jobs, chunksize=4))
    out = (res, columns)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "wb") as fh:
        pickle.dump(out, fh, protocol=4)
    return out


def class_of(data_id: str, index: dict) -> str | None:
    t = index.get(data_id)
    return t.get("class_code", "")[:1] if t else None


def build(workers: int, use_cache: bool) -> tuple[dict, dict]:
    """返回 (realism.json 的内容, 只给报告用的数组：代表块时频图与平均谱形)。"""
    q0b = q0b_doc()
    measured, columns = analyse_measured(q0b, workers, use_cache)
    idx, paths = {}, {}
    for b in ("dronerfb", "dronerfa"):
        for r in Q.load_index(b):
            idx[r.data_id] = r.truth
            paths[r.data_id] = r.path
    figs: dict = {"pairs": {}, "variants": {}, "selfchecks": {}}
    pairs_out = []
    for pair in PAIRS:
        print(f"{pair['id']}：合成 {pair['cell']}", flush=True)
        window = link_window(q0b, pair) if pair["kind"] == "link" else None
        synth = analyse_synth(pair["cell"], pair, q0b, workers, use_cache)
        cols = {}
        for col, ids in columns[pair["id"]].items():
            blocks = [dict(b, cls=class_of(d, idx)) for d in ids for b in measured[d]]
            cols[col] = pool_column(blocks, pair["id"])
        synth_col = pool_column(synth["blocks"], pair["id"])
        doc = pair_doc(pair, cols, synth, window, columns, synth_col, q0b)
        doc["verdicts"] = verdicts(doc)
        own_col = None
        if pair.get("supplement") == "preset_window":
            own_col = pool_column(synth["blocks"], pair["id"] + "-own")
            own_w = preset_window(pair)
            sup = column_doc(own_col, pair, own_w)
            sup["window"] = {k: r6(v) if isinstance(v, float) else v for k, v in own_w.items()}
            sup["note"] = "取数之后加的补充，不判定：按预设自己的占用带宽与单包时长认合成突发"
            sup["shape_dB"] = [r6(v) for v in own_col["shape_dB"]] if own_col["shape_dB"] is not None else None
            doc["supplement"] = sup
        pairs_out.append(doc)
        # 代表块：主列按 data_id 排序第一个满足条件的块
        rep_m = None
        for d in columns[pair["id"]][pair["main"]]:
            rep_m = representative([dict(b) for b in measured[d]], pair, pair["id"], d)
            if rep_m:
                break
        rep_m_img = None
        if rep_m:
            from iq_format import store
            rep_m_img = spec_image(store.open_product(paths[rep_m["data_id"]]).read(rep_m["start"], rep_m["n"]),
                                   rep_m["fs"])
        figs["pairs"][pair["id"]] = {"rep_main": rep_m, "rep_main_img": rep_m_img,
                                     "rep_synth": synth["rep"], "rep_synth_img": synth["rep_img"],
                                     "cols": {k: {"rows": c["rows"], "intervals": c["intervals"],
                                                  "core_centers": c["core_centers"]}
                                              for k, c in (("main", cols[pair["main"]]),
                                                           ("ref", cols.get(pair["ref"])),
                                                           ("synth", own_col if own_col is not None else synth_col))
                                              if c is not None},
                                     "synth_label": "合成（按 S-FHSS 自身参数认）" if own_col is not None else "合成"}
        doc["representative"] = {"main": rep_m and {"data_id": rep_m["data_id"], "block_start": rep_m["start"]},
                                 "synth": synth["rep"] and {"block_start": synth["rep"]["start"]}}
    # 归因变体（P1）
    p1 = PAIRS[0]
    variants_out = []
    main_p1 = next(d for d in pairs_out if d["id"] == "p1")
    p1_main_col = pool_column([dict(b) for d in columns["p1"]["holdout"] for b in measured[d]], "p1")
    grid = psd_grid(p1)
    band = extractor_cfg(p1, q0b)["band_Hz"]
    for cid in VARIANTS:
        print(f"变体：{cid}", flush=True)
        item = dict(p1, cell=cid)
        synth = analyse_synth(cid, item, q0b, workers, use_cache)
        col = pool_column(synth["blocks"], "p1")
        v = {"cell": cid, "flatness": summary(values(col, "flatness")), "bw3_Hz": summary(values(col, "bw3_Hz")),
             "obw99_Hz": summary(values(col, "obw99_Hz")), "papr_dB": summary(values(col, "papr_dB")),
             "flatness_vs_main": compare("flatness", values(p1_main_col, "flatness"), values(col, "flatness")),
             "shape_rms_dB": r6(shape_rms(p1_main_col["shape_dB"], col["shape_dB"], grid, band)),
             "shape_dB": [r6(x) for x in col["shape_dB"]] if col["shape_dB"] is not None else None}
        variants_out.append(v)
        figs["variants"][cid] = {"flatness": values(col, "flatness")}
    # 结构自检
    selfchecks_out = []
    for sc in SELFCHECKS:
        print(f"结构自检：{sc['id']}", flush=True)
        synth = analyse_synth(sc["cell"], sc, q0b, workers, use_cache)
        col = pool_column(synth["blocks"], sc["id"])
        d = {"id": sc["id"], "preset": sc["preset"], "cell": sc["cell"],
             "stats": {s: summary(values(col, s)) for s in ("obw99_Hz", "bw10_Hz", "dur_s", "flatness", "papr_dB")},
             "checks": []}
        obw = median(values(col, "obw99_Hz"))
        if sc["id"] == "s1":
            d["checks"].append(_selfcheck("99% 占用带宽", obw, OCC_10M_HZ, "Hz",
                                          "601 个子载波 × 15 kHz（与 DroneID 同族的数值结构假定）"))
        else:
            dur = median(values(col, "dur_s"))
            t_abs = sorted(b["start"] / b["fs"] + z["t0_s"] for b in synth["blocks"] for z in b["res"]["s2"]["rows"])
            per = median(np.diff(t_abs).tolist()) if len(t_abs) >= 2 else None
            d["n_bursts"] = len(t_abs)
            d["checks"] += [
                _selfcheck("突发时长", dur, DROID_DUR_S, "s", "9 个 OFDM 符号 9880 个原生样点 @ 15.36 MS/s（NDSS 2023 §III-B）"),
                _selfcheck("突发周期", per, DROID_PERIOD_S, "s", "640 ms（NDSS 2023）"),
                _selfcheck("99% 占用带宽", obw, OCC_10M_HZ, "Hz", "601 个子载波 × 15 kHz（NDSS 2023）"),
            ]
        selfchecks_out.append(d)
        figs["selfchecks"][sc["id"]] = {"rep_img": synth["rep_img"], "rep": synth["rep"]}

    diagnostics = diagnose(pairs_out, columns, measured, q0b, workers)
    ids_h, _, holdout_sha = Q.load_holdout()
    doc = {
        "schema": "cuav-realism/1",
        "producer": f"algos/reference/realism_compare.py {VERSION}",
        "status": "原型阶段验证值（D-028）：公开数据集只用于验证技术途径",
        "rules": "14 号报告 §7.3（2026-10-10 先写死，再取数）",
        "ruler": f"algos/reference/q0b_param_extract.py {Q.VERSION}",
        "inputs": {"holdout_manifest_sha256": holdout_sha,
                   "q0b_params_sha256": sha256_file(os.path.join(ROOT, "data", "iq", "measured", "q0b-params.json")),
                   "cells_sha256": sha256_file(os.path.join(ROOT, "tests", "regression", "eval-dataset",
                                                            f"{SET_ID}.json"))},
        "lines": LINES,
        "pairs": pairs_out,
        "variants": {"pair": "p1", "main_flatness": main_p1["columns"]["main"]["stats"]["flatness"],
                     "rows": variants_out,
                     "grid": {"res_Hz": p1["psd_res_Hz"], "span_Hz": p1["psd_span_Hz"], "band_Hz": band}},
        "selfchecks": selfchecks_out,
        "diagnostics": diagnostics,
    }
    return doc, figs


def _selfcheck(name: str, got: float | None, want: float, unit: str, source_text: str) -> dict:
    if got is None:
        return {"name": name, "want": want, "got": None, "unit": unit, "source": source_text, "verdict": "无法比较"}
    relv = (got - want) / want
    return {"name": name, "want": r6(want), "got": r6(got), "unit": unit, "rel": r6(relv), "line": SELFCHECK_LINE,
            "source": source_text, "verdict": "一致" if abs(relv) <= SELFCHECK_LINE else "有差距"}


def dumps(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=1, allow_nan=False) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--no-cache", action="store_true", help="不用缓存，全部重算（含重跑引擎）")
    ap.add_argument("--check", action="store_true", help="全部重算，核对入库的 realism.json 逐字节相同（不写文件）")
    ap.add_argument("--no-report", action="store_true", help="只写 realism.json，不出 HTML")
    a = ap.parse_args(argv)
    if not os.path.exists(CUAV_RUN):
        raise SystemExit(f"找不到引擎 {rel(CUAV_RUN)}：先建 engine/build")
    doc, figs = build(a.workers, use_cache=not (a.no_cache or a.check))
    text = dumps(doc)
    out = os.path.join(ROOT, OUT_JSON)
    if a.check:
        with open(out, encoding="utf-8") as fh:
            old = fh.read()
        if old != text:
            print(f"不一致：重算的结果与入库的 {OUT_JSON} 不同")
            return 1
        print(f"一致：重算结果与 {OUT_JSON} 逐字节相同")
        return 0
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print(f"写了 {OUT_JSON}")
    for d in doc["pairs"]:
        gap = [k for k, v in d["verdicts"].items() if v == "有差距"]
        na = [k for k, v in d["verdicts"].items() if v == "无法比较"]
        print(f"  {d['id']} {d['preset']}：有差距 {'、'.join(gap) or '无'}；无法比较 {'、'.join(na) or '无'}")
    if not a.no_report:
        import realism_report
        path = realism_report.write(doc, figs)
        print(f"写了 {rel(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
