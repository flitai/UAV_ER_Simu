#!/usr/bin/env python3
"""突发特征提取的参考实现（C-4；10 报告 §4.3；EM-S-03 §10.5–§10.10）。

引擎侧 `engine/src/processing.cpp` 的 `FeatureExtractor` 与这里**逐步同序**，黄金基准
`engine/tests/golden/features.json` 逐段对拍。两侧的差异只来自 FFT 精度（引擎 float32、这里
numpy float64），所以谱类量按容差比，计数、时间、段号、质量逐位相同。

口径（与引擎注释一一对应）：
- 切帧与检测器同律：从第 0 个样点起、不加窗、不重叠、fftshift；第 k 帧就是检测行 frame_index = k。
- 段 = 检测器并好的突发（segment_id）；段内只有**命中帧**参与统计，合并空隙里的非命中帧不计。
- 段的收口：出现新的 segment_id，或连续未命中帧数超过 merge_gap_frames，或流结束。
- 两套谱：**电量**（带内功率、信噪比、噪声）用不加窗的帧，与检测器逐位同源，噪声由 Λ 反推
  n_bin = mean(e / Λ) / M；**形状**（质心、带宽、平坦度、峰值）用同一帧加周期 Hann 窗的 PSD——矩形帧对
  不在 bin 上的单音漏出 sinc² 旁瓣，99% 占用带宽会量到几十个 bin。加窗后每 bin 噪声按 Σw²/nfft 缩放，
  去噪与过闸（noise_gate · n_bin_w / √F）都在加窗域做；过闸的 bin 才算信号 bin。
- 质心与带宽只用信号 bin；平坦度用带内**原始**加窗段均 PSD（含噪声底）；峰值 bin 除以相干增益 (Σw)²；
  峰均比用命中帧的时域样点。
- 「上一段」只由 quality ∈ {full, overload} 的段充当：一帧虚警夹在两个真突发之间不该搅乱间隔与跳频差。

**浮点累加一律显式循环**（D-046 ⑧）：CPython 的 sum() 是补偿求和、numpy 是成对求和，与引擎的
「acc = acc + x」不同；这里凡是与引擎逐位对拍的量都手写循环。
"""
from __future__ import annotations

import math

import numpy as np

from energy_detector import frame_bin_power  # noqa: F401  (re-export for callers)


def hann_periodic_f32(nfft: int) -> tuple[np.ndarray, float, float]:
    """周期 Hann（与引擎 FeatureExtractor::configure 同式）：double 算窗值转 float32；
    Σw、Σw² 按 float32 的窗值用 double 顺序累加。返回 (w, wsum, wsq)。"""
    w = np.zeros(nfft, dtype=np.float32)
    for n in range(nfft):
        w[n] = np.float32(0.5 - 0.5 * math.cos(2.0 * math.pi * float(n) / float(nfft)))
    wsum = 0.0
    wsq = 0.0
    for n in range(nfft):
        v = float(w[n])
        wsum = wsum + v
        wsq = wsq + v * v
    return w, wsum, wsq


def band_bins(nfft: int, fs: float, lo_Hz: float, hi_Hz: float) -> list[int]:
    """与引擎 build_band / build_mask 同一规则：fftshift 后第 k 个 bin 的频率落在 [lo, hi)。"""
    out = []
    half = float(nfft // 2)
    for k in range(nfft):
        f = (float(k) - half) * fs / float(nfft)
        if f >= lo_Hz and f < hi_Hz:
            out.append(k)
    return out


def _frame_time_stats(frame: np.ndarray) -> tuple[float, float]:
    """时域 Σ|x|² 与 max|x|²，double 顺序累加（与引擎 push_frame 同序）。"""
    s = 0.0
    mx = 0.0
    re = frame.real.astype(np.float32)
    im = frame.imag.astype(np.float32)
    for i in range(frame.shape[0]):
        r = float(re[i])
        q = float(im[i])
        a = r * r + q * q
        s = s + a
        if a > mx:
            mx = a
    return s, mx


def extract(x: np.ndarray, fs: float, center_Hz: float, nfft: int, det: dict,
            band_lo_Hz: float, band_hi_Hz: float, *, bandwidth_method: str = "occupied_99",
            min_frames: int = 2, window_frames: int = 64, merge_gap_frames: int = 2,
            noise_gate: float = 4.0, calibrated: bool = True,
            overload: np.ndarray | None = None) -> tuple[list[dict], dict]:
    """按检测行提取每个突发的特征。

    `det` 是 energy_detector.sliding_from_power 的返回（statistic / hit / segment_id 逐帧数组）。
    返回 (rows, margins)：rows 每段一个 dict（键与 features.jsonl 的行相同，不含 node/site/trace）；
    margins 记录每段离判决边界的相对距离（min_gate_margin / min_cum_margin），生成黄金基准时
    用来断言没有 bin 卡在闸或累积功率边界上——引擎 float32 与这里 float64 的差异会在那里翻转。
    """
    if bandwidth_method not in ("occupied_99", "edge_minus_20dB"):
        raise ValueError("bandwidth_method 必须是 occupied_99 / edge_minus_20dB")
    power = frame_bin_power(x, nfft)
    n_frames = power.shape[0]
    w, wsum, wsq = hann_periodic_f32(nfft)
    xw = (x[:n_frames * nfft].reshape(n_frames, nfft) * w).astype(np.complex64).reshape(-1)
    power_w = frame_bin_power(xw, nfft)
    stat = det["statistic"]
    hit = det["hit"]
    seg_id = det["segment_id"]
    if overload is None:
        overload = np.zeros(n_frames, dtype=bool)
    bins = band_bins(nfft, fs, band_lo_Hz, band_hi_Hz)
    M = len(bins)
    half = float(nfft // 2)
    bin_hz = fs / float(nfft)

    rows: list[dict] = []
    margins = {"min_gate_margin": math.inf, "min_cum_margin": math.inf}
    state = {"open": False, "gap": 0, "has_prev": False, "prev_t_end": 0.0, "prev_center": 0.0}
    hit_window: list[bool] = []
    cur: dict = {}

    def compute_row(s: dict) -> dict:
        F = float(s["frames"])
        r: dict = {}
        r["segment_id"] = int(s["id"])
        r["frames"] = int(s["frames"])
        r["t_s"] = float(s["first"] * nfft) / fs
        r["t_end_s"] = float((s["last"] + 1) * nfft) / fs
        r["duration_s"] = r["t_end_s"] - r["t_s"]
        mean_psd = s["psd_w_sum"] / F          # 形状量用加窗 PSD
        e_mean = s["e_sum"] / F
        noise_mean = s["noise_sum"] / F
        n_bin = noise_mean / float(M) * (wsq / float(nfft)) if M else 0.0
        gate = n_bin * noise_gate / math.sqrt(F)
        sig = [0.0] * M
        total = 0.0
        nsig = 0
        gm = math.inf
        for j in range(M):
            v = float(mean_psd[bins[j]]) - n_bin
            sig[j] = v if v > gate else 0.0
            if sig[j] > 0.0:
                nsig += 1
            total = total + sig[j]
            if gate > 0.0:
                gm = min(gm, abs(v / gate - 1.0))
        r["signal_bins"] = nsig
        cm = math.inf
        if total > 0.0:
            num = 0.0
            for j in range(M):
                idx = float(bins[j]) - half
                num = num + idx * fs / float(nfft) * sig[j]
            r["center_Hz"] = center_Hz + num / total
            lo, hi = 0, M - 1
            if bandwidth_method == "occupied_99":
                edge = 0.005 * total
                cum = 0.0
                for j in range(M):
                    cum = cum + sig[j]
                    cm = min(cm, abs(cum - edge) / total)
                    if cum >= edge:
                        lo = j
                        break
                cum = 0.0
                for j in range(M - 1, -1, -1):
                    cum = cum + sig[j]
                    cm = min(cm, abs(cum - edge) / total)
                    if cum >= edge:
                        hi = j
                        break
            else:
                peak = 0.0
                for j in range(M):
                    if sig[j] > peak:
                        peak = sig[j]
                thr = peak * 0.01
                for j in range(M):
                    if sig[j] > 0.0:
                        cm = min(cm, abs(sig[j] / thr - 1.0))
                    if sig[j] >= thr:
                        lo = j
                        break
                for j in range(M - 1, -1, -1):
                    if sig[j] >= thr:
                        hi = j
                        break
            r["bandwidth_Hz"] = float(bins[hi] - bins[lo] + 1) * bin_hz
        else:
            r["center_Hz"] = center_Hz + 0.5 * (band_lo_Hz + band_hi_Hz)
            r["bandwidth_Hz"] = 0.0
        anyzero = M == 0
        logsum = 0.0
        arith = 0.0
        for j in range(M):
            v = float(mean_psd[bins[j]])
            if v <= 0.0:
                anyzero = True
            else:
                logsum = logsum + math.log(v)
            arith = arith + v
        r["spectral_flatness"] = 0.0 if (anyzero or arith <= 0.0) else math.exp(logsum / float(M)) / (arith / float(M))
        n2 = float(nfft) * float(nfft)
        r["has_dBm"] = bool(s["calibrated"])
        if r["has_dBm"]:
            r["band_power_dBm"] = 10.0 * math.log10(max(e_mean / n2, 1e-30))
            pk = 0.0
            for j in range(M):
                v = float(mean_psd[bins[j]])
                if v > pk:
                    pk = v
            r["peak_dBm"] = 10.0 * math.log10(max(pk / (wsum * wsum), 1e-30))
        r["snr_dB"] = 10.0 * math.log10(max(e_mean, 1e-30) / max(noise_mean, 1e-30))
        mean_abs2 = s["sum_abs2"] / (F * float(nfft))
        r["crest_factor_dB"] = 10.0 * math.log10(max(s["max_abs2"] / mean_abs2, 1e-30)) if mean_abs2 > 0.0 else 0.0
        r["duty"] = s["duty"]
        r["overload"] = bool(s["overload"])
        if s["overload"]:
            r["quality"] = "overload"
        elif s["frames"] < min_frames:
            r["quality"] = "short"
        elif nsig == 0:
            r["quality"] = "low_snr"
        else:
            r["quality"] = "full"
        r["_gate_margin"] = gm
        r["_cum_margin"] = cm
        return r

    def close_segment():
        r = compute_row(cur)
        r["has_prev"] = state["has_prev"]
        if state["has_prev"]:
            r["interval_from_prev_s"] = r["t_s"] - state["prev_t_end"]
            r["hop_from_prev_Hz"] = r["center_Hz"] - state["prev_center"]
        else:
            r["interval_from_prev_s"] = None
            r["hop_from_prev_Hz"] = None
        if r["quality"] in ("full", "overload"):
            state["has_prev"] = True
            state["prev_t_end"] = r["t_end_s"]
            state["prev_center"] = r["center_Hz"]
        margins["min_gate_margin"] = min(margins["min_gate_margin"], r.pop("_gate_margin"))
        margins["min_cum_margin"] = min(margins["min_cum_margin"], r.pop("_cum_margin"))
        rows.append(r)
        state["open"] = False
        state["gap"] = 0

    for k in range(n_frames):
        hit_window.append(bool(hit[k]))
        if len(hit_window) > window_frames:
            hit_window.pop(0)
        if hit[k]:
            if state["open"] and cur["id"] != int(seg_id[k]):
                close_segment()
            if not state["open"]:
                cur = {"id": int(seg_id[k]), "first": k, "last": k, "frames": 0,
                       "psd_sum": np.zeros(nfft, dtype=np.float64), "psd_w_sum": np.zeros(nfft, dtype=np.float64),
                       "e_sum": 0.0, "noise_sum": 0.0,
                       "sum_abs2": 0.0, "max_abs2": 0.0, "overload": False, "calibrated": True, "duty": 0.0}
                state["open"] = True
            cur["last"] = k
            cur["frames"] += 1
            cur["psd_sum"] += power[k]
            cur["psd_w_sum"] += power_w[k]
            e = 0.0
            for j in range(M):
                e = e + float(power[k][bins[j]])
            cur["e_sum"] = cur["e_sum"] + e
            lam = float(stat[k])
            cur["noise_sum"] = cur["noise_sum"] + (e / lam if lam > 0.0 else 0.0)
            s_abs2, mx = _frame_time_stats(x[k * nfft:(k + 1) * nfft])
            cur["sum_abs2"] = cur["sum_abs2"] + s_abs2
            if mx > cur["max_abs2"]:
                cur["max_abs2"] = mx
            cur["overload"] = cur["overload"] or bool(overload[k])
            cur["calibrated"] = cur["calibrated"] and calibrated
            hits = 0
            for h in hit_window:
                if h:
                    hits += 1
            cur["duty"] = float(hits) / float(len(hit_window))
            state["gap"] = 0
        elif state["open"]:
            state["gap"] += 1
            if state["gap"] > merge_gap_frames:
                close_segment()
    if state["open"]:
        close_segment()
    return rows, margins
