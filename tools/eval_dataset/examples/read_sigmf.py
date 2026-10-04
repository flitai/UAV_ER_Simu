#!/usr/bin/env python3
"""读取本数据集的一段 SigMF 文件（只依赖 numpy；装了 matplotlib 时可另存时频图）。

用法：
    python read_sigmf.py data/sv1-s02_s3                 # 打印摘要与前几条注记
    python read_sigmf.py data/sv1-s02_s3 --png out.png   # 另存时频图（需要 matplotlib）

文件名前缀（stem）后面接 .sigmf-meta（元数据，JSON）与 .sigmf-data（样点）。
样点是复 int16 交织、小端（ci16_le）：I0 Q0 I1 Q1 ……
换成物理量：x = 码 / 32768 × 10^(cuav:full_scale_dBm / 20)，|x|² 的单位是 mW。
"""
from __future__ import annotations

import argparse
import json

import numpy as np


def load(stem: str) -> tuple[np.ndarray, dict]:
    """返回 (复样点，单位 √mW；元数据字典)。"""
    with open(stem + ".sigmf-meta", encoding="utf-8") as fh:
        meta = json.load(fh)
    g = meta["global"]
    if g["core:datatype"] != "ci16_le":
        raise ValueError(f"本示例只读 ci16_le，文件是 {g['core:datatype']}")
    raw = np.fromfile(stem + ".sigmf-data", dtype="<i2").astype(np.float32)
    amp = 10.0 ** (g["cuav:full_scale_dBm"] / 20.0)
    x = (raw[0::2] + 1j * raw[1::2]) * np.float32(amp / 32768.0)
    return x.astype(np.complex64), meta


def annotation_samples(x: np.ndarray, ann: dict) -> np.ndarray:
    """一条注记对应的那段样点。"""
    s0 = int(ann["core:sample_start"])
    return x[s0:s0 + int(ann["core:sample_count"])]


def power_dBm(x: np.ndarray) -> float:
    """平均功率（dBm）。"""
    return float(10.0 * np.log10(np.mean(np.abs(x.astype(np.complex128)) ** 2)))


def spectrogram(x: np.ndarray, nfft: int = 1024, rows: int = 600) -> np.ndarray:
    """峰值保持时频图（dBm）：nfft 点 Hann 窗，每行取一组帧上每个频点的最大值。"""
    w = np.hanning(nfft)
    n_frames = x.size // nfft
    rows = min(rows, n_frames)
    grp = n_frames // rows
    img = np.empty((rows, nfft))
    for r in range(rows):
        blk = x[nfft * grp * r: nfft * grp * (r + 1)].reshape(grp, nfft)
        p = np.abs(np.fft.fftshift(np.fft.fft(blk * w, axis=1), axes=1)) ** 2 / np.sum(w) ** 2
        img[r] = 10.0 * np.log10(np.max(p, axis=0) + 1e-30)
    return img


def main() -> int:
    ap = argparse.ArgumentParser(description="读取一段 SigMF 文件")
    ap.add_argument("stem", help="文件名前缀，例如 data/sv1-s02_s3")
    ap.add_argument("--png", help="另存时频图（需要 matplotlib）")
    a = ap.parse_args()
    x, meta = load(a.stem)
    g = meta["global"]
    fs = g["core:sample_rate"]
    fc = meta["captures"][0]["core:frequency"]
    print(f"{a.stem}：{g['cuav:observation_point']}，{fs / 1e6:g} MS/s @ {fc / 1e6:g} MHz，"
          f"{x.size} 个样点（{x.size / fs:g} s），平均功率 {power_dBm(x):.2f} dBm")
    print(f"可用频带 {g['cuav:usable_band_Hz'][0] / 1e6:.3f}–{g['cuav:usable_band_Hz'][1] / 1e6:.3f} MHz；"
          f"注记 {len(meta['annotations'])} 条")
    for ann in meta["annotations"][:5]:
        seg = annotation_samples(x, ann)
        lo, hi = ann.get("core:freq_lower_edge"), ann.get("core:freq_upper_edge")
        band = f"{lo / 1e6:.3f}–{hi / 1e6:.3f} MHz" if lo is not None else "—"
        print(f"  {ann['core:label']:<14} {ann['cuav:emitter_id']:<16} 样点 {ann['core:sample_start']}+{ann['core:sample_count']}"
              f"  {band}  capture={ann.get('cuav:capture')}  预算信噪比 {ann.get('cuav:snr_dB')} dB"
              f"  实测 {ann.get('cuav:snr_measured_dB')} dB  段内功率 {power_dBm(seg):.2f} dBm")
    if a.png:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        img = spectrogram(x)
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.imshow(img, aspect="auto", origin="upper", cmap="viridis",
                  extent=[(fc - fs / 2) / 1e6, (fc + fs / 2) / 1e6, x.size / fs, 0])
        ax.set_xlabel("Frequency (MHz)")
        ax.set_ylabel("Time (s)")
        fig.colorbar(ax.images[0], ax=ax, label="dBm (peak hold)")
        fig.savefig(a.png)
        print(f"时频图写到 {a.png}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
