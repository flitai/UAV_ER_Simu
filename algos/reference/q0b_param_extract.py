#!/usr/bin/env python3
"""Q-0b：从公开实测数据提取波形预设的时序与谱形参数（14 号报告 §7.1；06 §9K；T-0 探针回用）。

Q-2（OFDM 图传与 DroneID）、Q-3（GFSK 跳频遥控）的机型预设里有一类参数没有公开出处：
**图传的突发时长、间隔与占空，遥控的突发时长、间隔、单跳带宽与跳频点分布**。本脚本从本地两批
公开数据的**训练部分**里把它们量出来，作为预设表的 M 档（本方实测提取）参数，也是 Q-5 对照报告
的实测基线。

## 口径（`docs/emitter-template.md` §5 的落地，阈值写在下面的常数里）

1. **时频图**：1024 点汉宁窗、不重叠；再按 4 帧 × 3 频点平滑成一个「格」（80 MS/s 时约 51 µs、
   100 MS/s 时约 41 µs，即 §5 的「约 50 µs 帧」）。
2. **底噪**：每个频点取平滑后功率在时间维的第 10 百分位（§5 第 1 条的「10% 分位」，改为逐频点——
   接收机抗混叠滤波让带边比带中低几分贝，全带一个数会把带边的信号漏掉）。
3. **占用**：高出底噪 6 dB 的格（§5 第 4 条）。纯噪声上实测：噪声格越过这条线的比例约 0.4%，
   相对真实噪声均值的等效门限约 +4 dB（汉宁窗相邻频点相关，3 频点平滑实际没有平均掉那么多）；
   孤立的噪声格凑不够 MIN_CELLS 格，不会成突发（`test_q0b_param_extract.py` 的纯噪声用例量这几个数）。
4. **突发**：占用格的四连通分量；分量按每格的频率跨度在时间上切开（一段宽的图传接一段窄的弱信号时
   不并成一个突发）；贴着块边界的突发记「截断」，不进时长统计。
5. **精化**：粗检的时长只准到一格，0.4 ms 的突发差一格就是 12%。精化在原始样点上做：把突发所在频段
   用频域矩形窗滤出来，按「超出底噪的能量 ÷ 平台超出功率」算**能量等效时长**，按能量重心定中点。
   这个量对 OFDM 的起伏不敏感（求和而不是找过零点），合成夹具上误差 < 1%。
6. **带宽**：突发内的超出功率谱（减去同频点的噪声均值）上取 99% 占用带宽、−10 dB 宽度与 −3 dB 宽度。
   −10 dB 宽度与 2026-09-28 那一轮粗测（Mavic 3 的 34.5 MHz）同口径。
7. **图传用「覆盖率」而不是「带内功率」判开关**：图传频段内有一个 2 MHz 的强遥控跳频点时，带内功率
   会被它顶过门限；覆盖率（频段内被占用的频点比例 ≥ 60%）不会。
8. **连续性**：DroneRFa 每 1000 万点（0.1 s）内连续、块间有连续性损伤（清单 `time.continuity`），
   故按块处理，**间隔只在块内算**，不跨块拼接（铁律 3）。DroneRFb 一片 50 ms 内连续。
9. **只用训练部分**：先按 `holdout.manifest.json` 剔除验收集，再用 `tools/freeze_holdout.py` 同一
   判据（`data_id` 与内容哈希）复核交集为零，否则中止。

## 谁是谁（角色窗口）

同一段录音里有图传、遥控、WiFi、蓝牙。**窗口只用来认「哪个突发是哪路信号」，取得很宽**，量出来的数
不能由窗口决定（例如遥控时长窗 0.1–3 ms，量出来的中位数落在 0.4 ms 附近，与窗口无关）。窗口的依据
（论文原文、目视）写在 `SOURCES` 里，随结果写进 JSON。同一窗口对**同站背景**（DroneRFb 的背景片、
DroneRFa 的 `T0000`）也跑一遍，得到「背景里也会落进这个窗口的突发」的速率，作为污染量照实报告。

全部数字是**原型阶段验证值**（D-028）：公开数据集只用于验证技术途径，甲方数据到货后按同一脚本重跑。

跑法（开发机 10 进程约 6 min，需要 data/iq/measured；两次运行逐字节相同）：
    uv run --quiet --with numpy --with scipy python algos/reference/q0b_param_extract.py \\
        --json data/iq/measured/q0b-params.json --report data/iq/measured/q0b-params-report.md
单测（合成夹具，不读数据）：
    uv run --quiet --with numpy --with scipy python tests/unit/test_q0b_param_extract.py
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field

import numpy as np
from scipy import fft as sfft
from scipy import ndimage

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "tools"))

VERSION = "0.1.0"

# ---------------------------------------------------------------- 口径常数（§5 的落地）

NFFT = 1024               # 时频图点数
CELL_FRAMES = 4           # 一格的帧数（80 MS/s 时 51.2 µs）
FREQ_SMOOTH = 3           # 一格的频点数（滑动平均，不降分辨率）
FLOOR_PCT = 10.0          # 底噪分位（§5 第 1 条）
THRESH_DB = 6.0           # 占用门限（§5 第 4 条）
MIN_CELLS = 4             # 分量至少这么多格，才算突发（滤掉孤立的噪声格）
SPAN_TOL_BINS = 3         # 按频率跨度在时间上切分量的容差（频点）
SPAN_TOL_FRAC = 0.25      # 同上，按宽度的比例，取两者较大者
SPAN_SUSTAIN = 3          # 跨度要连续偏离这么多格才切
MIN_COARSE_SNR_DB = 8.0   # 粗检功率高出底噪不到这么多的分量不精化
NEIGHBOR_MIN = 0.1        # 同频段邻居的功率不到自己这个比例就不管它（弱的拖尾、远处的碎片）
COVER_ON = 0.60           # 图传开关：频段内被占用的频点比例
VIDEO_MIN_CELLS = 3       # 图传突发至少这么多格（约 0.15 ms），更短的是覆盖率抖动的碎片
VIDEO_MIN_SNR_DB = 6.0    # 图传突发的带内信噪比不到这个数，不进时长与谱形统计（只计数）
PAD_CELLS = 2             # 精化时突发两侧各多取几格
PLATEAU_FRAC = 0.90       # 能量等效时长迭代时，平台取上一轮估出的突发的中间这么多（见 _energy_duration）
BW_RES_FRAC = 1 / 64      # 带宽测量的频率分辨率 ≈ 粗测带宽 × 此数
PAPR_CCDF = 1e-3          # 峰均比取 CCDF 的这个概率点（14 §7.2）
PAPR_MIN_SNR_DB = 15.0    # 带内信噪比不够时峰均比被噪声压低，不进统计
DRONERFA_BLOCK = 10_000_000   # DroneRFa 连续块长（清单 time.continuity.note）


# ---------------------------------------------------------------- 时频图

@dataclass
class TFMap:
    fs: float
    fc: float
    nfft: int
    frames: np.ndarray        # [帧, 频点] 原始功率 |X|²/Σw²（频率已居中）
    cells: np.ndarray         # [格, 频点] 平滑功率
    floor: np.ndarray         # [频点] 平滑功率的第 10 百分位
    mask: np.ndarray          # [格, 频点] 占用
    noise_mean: np.ndarray    # [频点] 未占用格上的原始功率均值（精化时换算带内噪声用）

    @property
    def cell_s(self) -> float:
        return CELL_FRAMES * self.nfft / self.fs

    @property
    def bin_Hz(self) -> float:
        return self.fs / self.nfft

    def bin_freq(self, k: float) -> float:
        """频点号（可带小数）→ 绝对频率。"""
        return self.fc + (k - self.nfft / 2) * self.bin_Hz

    def freq_bin(self, f: float) -> float:
        return (f - self.fc) / self.bin_Hz + self.nfft / 2


def tf_map(x: np.ndarray, fs: float, fc: float, nfft: int = NFFT) -> TFMap:
    n_frames = x.size // nfft
    n_cells = n_frames // CELL_FRAMES
    n_frames = n_cells * CELL_FRAMES
    w = np.hanning(nfft)
    frames = np.empty((n_frames, nfft), dtype=np.float32)
    step = 4096   # 分批做 FFT，免得 1000 万点一次占两份复数内存
    for a in range(0, n_frames, step):
        b = min(a + step, n_frames)
        seg = x[a * nfft:b * nfft].reshape(b - a, nfft)
        X = sfft.fftshift(sfft.fft(seg * w, axis=1), axes=1)
        frames[a:b] = (X.real ** 2 + X.imag ** 2) / np.sum(w * w)
    cells = frames.reshape(n_cells, CELL_FRAMES, nfft).mean(axis=1)
    cells = ndimage.uniform_filter1d(cells, FREQ_SMOOTH, axis=1, mode="nearest")
    floor = np.percentile(cells, FLOOR_PCT, axis=0)
    mask = cells > floor * 10 ** (THRESH_DB / 10)
    # 噪声均值：该频点未被占用的格里的原始帧功率均值
    quiet = ~np.repeat(mask, CELL_FRAMES, axis=0)
    cnt = quiet.sum(axis=0)
    s = np.where(quiet, frames, 0.0).sum(axis=0)
    noise_mean = np.where(cnt > 0, s / np.maximum(cnt, 1), floor)
    return TFMap(fs, fc, nfft, frames, cells.astype(np.float32), floor, mask, noise_mean)


# ---------------------------------------------------------------- 粗检：分量与切分

@dataclass
class Blob:
    c0: int            # 起始格（含）
    c1: int            # 结束格（不含）
    k0: int            # 最低频点（含）
    k1: int            # 最高频点（不含）
    cells: int         # 占用格数
    truncated: bool    # 贴着块边界
    power: float       # 格内平滑功率均值（比邻居强弱用）


def _split_by_span(lo: np.ndarray, hi: np.ndarray) -> list[tuple[int, int]]:
    """按每格频率跨度的**持续**突变把一个分量在时间上切开，返回 [(起, 止)]（下标相对分量首格）。

    跨度先按 5 格中值平滑：高信噪比的突发（40 dB 以上）自身的频谱裙边会让逐格跨度抖动一两个频点，
    不平滑会把一个突发切成碎片（实测：DroneRFb 视距片里一半遥控突发被切短）。要连着 SPAN_SUSTAIN
    格都偏离当前段的中位跨度才切。"""
    n = lo.size
    if n < 2 * SPAN_SUSTAIN:
        return [(0, n)]
    los = ndimage.median_filter(lo.astype(float), size=5, mode="nearest")
    his = ndimage.median_filter(hi.astype(float), size=5, mode="nearest")
    out, start = [], 0
    for i in range(SPAN_SUSTAIN, n - SPAN_SUSTAIN + 1):
        if i - start < SPAN_SUSTAIN:
            continue
        ref_lo, ref_hi = float(np.median(los[start:i])), float(np.median(his[start:i]))
        tol = max(SPAN_TOL_BINS, SPAN_TOL_FRAC * (ref_hi - ref_lo))
        if all(abs(los[j] - ref_lo) > tol or abs(his[j] - ref_hi) > tol
               for j in range(i, i + SPAN_SUSTAIN)):
            out.append((start, i))
            start = i
    out.append((start, n))
    return out


def blobs(tf: TFMap) -> list[Blob]:
    lab, n = ndimage.label(tf.mask)
    if n == 0:
        return []
    out: list[Blob] = []
    n_cells = tf.mask.shape[0]
    for sl_idx, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        sub = lab[sl] == sl_idx
        if sub.sum() < MIN_CELLS:
            continue
        r_any = np.nonzero(sub.any(axis=1))[0]
        lo = np.array([np.argmax(sub[r]) for r in r_any])
        hi = np.array([sub.shape[1] - np.argmax(sub[r][::-1]) for r in r_any])
        for a, b in _split_by_span(lo, hi):
            rows = r_any[a:b]
            c0 = sl[0].start + int(rows[0])
            c1 = sl[0].start + int(rows[-1]) + 1
            k0 = sl[1].start + int(np.median(lo[a:b]))
            k1 = sl[1].start + int(np.median(hi[a:b]))
            part = sub[rows[0]:rows[-1] + 1]
            cells = int(part.sum())
            if cells < MIN_CELLS or k1 <= k0:
                continue
            power = float(np.mean(tf.cells[c0:c1, k0:k1]))
            out.append(Blob(c0, c1, k0, k1, cells, c0 == 0 or c1 >= n_cells, power))
    out.sort(key=lambda b: (b.c0, b.k0))
    return out


# ---------------------------------------------------------------- 精化：时长、带宽、峰均比

@dataclass
class Burst:
    t0_s: float            # 起点（相对块首）
    dur_s: float           # 能量等效时长
    f_center_Hz: float     # 超出功率谱的重心
    obw99_Hz: float        # 99% 占用带宽
    bw10_Hz: float         # −10 dB 宽度
    bw3_Hz: float          # −3 dB 宽度
    flatness: float        # 带内（−10 dB 宽度内）谱平坦度
    snr_dB: float          # 带内信噪比（平台超出功率 / 带内噪声）
    papr_dB: float | None  # 突发内 CCDF 在 1e-3 处；信噪比不足时为 None
    truncated: bool
    coarse_bw_Hz: float    # 粗检的频率跨度（选角色用）
    contested: bool = False    # 贴着更强的同频段信号，时长不进统计


def band_noise(tf: TFMap, k0: int, k1: int) -> float:
    """[k0, k1) 频点的矩形滤波后，时域每样点的噪声功率。

    `frames` 归一成 |X|²/Σw²，白噪声下每个频点的期望恰为每样点总功率 σ²，于是矩形滤出 B 个频点后
    的噪声功率 = (1/N)·Σ 频点噪声均值。有色噪声（带边滚降）下同一式子逐频点成立。"""
    return float(np.sum(tf.noise_mean[k0:k1]) / tf.nfft)


def _bandpass(seg: np.ndarray, fs: float, f_lo: float, f_hi: float) -> np.ndarray:
    """频域矩形窗滤出 [f_lo, f_hi]（相对基带，Hz）。"""
    n = sfft.next_fast_len(seg.size)
    X = sfft.fft(seg, n)
    f = sfft.fftfreq(n, 1 / fs)
    X[(f < f_lo) | (f > f_hi)] = 0
    return sfft.ifft(X)[:seg.size]


def _psd_metrics(core: np.ndarray, tf: TFMap, f_lo: float, f_hi: float, coarse_bw: float,
                 robust: bool) -> dict | None:
    """突发核心段的超出功率谱 → 中心、99% 占用带宽、−10 / −3 dB 宽度、平坦度。

    robust：逐频点取各帧的**中位数**而不是均值（宽带信道用：频段里夹着一个强跳频点时，均值谱的峰
    会被它顶起来）。复高斯型信号（OFDM、噪声）的逐帧功率服从指数分布，中位数 = ln2 × 均值，
    于是噪声也按 ln2 × 噪声均值扣，超出量与均值谱只差一个常数因子，不影响带宽与重心。"""
    fs, nfft = tf.fs, tf.nfft
    res = max(coarse_bw * BW_RES_FRAC, fs / (1 << 20))
    m = 1 << int(math.ceil(math.log2(fs / res)))
    while m > core.size and m > nfft:
        m //= 2
    k = core.size // m
    if k < 1:
        return None
    wm = np.hanning(m)
    Xc = sfft.fftshift(sfft.fft(core[:k * m].reshape(k, m) * wm, axis=1), axes=1)
    pw = (Xc.real ** 2 + Xc.imag ** 2) / np.sum(wm * wm)
    fb = (np.arange(m) - m / 2) * fs / m
    nm = np.interp(fb, (np.arange(nfft) - nfft / 2) * tf.bin_Hz, tf.noise_mean)
    if robust and k >= 5:
        ex = np.median(pw, axis=0) - math.log(2) * nm
    else:
        ex = np.mean(pw, axis=0) - nm
    j0 = max(0, int(round((f_lo + fs / 2) / fs * m)))
    j1 = min(m, int(round((f_hi + fs / 2) / fs * m)))
    raw = ex[j0:j1]
    band = np.clip(raw, 0, None)
    if band.sum() <= 0 or raw.sum() <= 0:
        return None
    fbb = fb[j0:j1]
    f_center = float(np.sum(fbb * band) / np.sum(band))
    # 99% 占用带宽用**不截断**的超出谱累加：扣掉噪声均值后，信号外的频点是零均值起伏，累加里自己
    # 抵消；截成非负再累加会把保护带里的正起伏全算成信号，窄信号上偏宽一倍（合成 GFSK 实测 330 对 150 kHz）
    c = np.cumsum(raw) / np.sum(raw)
    lo_i = int(np.argmax(c >= 0.005))
    hi_i = int(len(c) - 1 - np.argmax(c[::-1] <= 0.995))
    obw99 = float(fbb[min(len(fbb) - 1, hi_i + 1)] - fbb[lo_i])
    sm = ndimage.uniform_filter1d(band, max(1, int(round(0.02 * (j1 - j0)))))
    top = float(sm.max())

    def width(db: float) -> tuple[float, int, int]:
        above = np.nonzero(sm >= top * 10 ** (-db / 10))[0]
        return float(fbb[above[-1]] - fbb[above[0]]) + fs / m, int(above[0]), int(above[-1]) + 1

    bw10, a10, b10 = width(10.0)
    bw3, _, _ = width(3.0)
    inb = np.clip(band[a10:b10], 1e-30, None)
    flat = float(np.exp(np.mean(np.log(inb))) / np.mean(inb))
    # 带内噪声（按 −10 dB 宽度）：信噪比用
    nin = float(np.sum(nm[j0 + a10:j0 + b10]) / m)
    sig = float(np.sum(band) / m) / (math.log(2) if robust and k >= 5 else 1.0)
    return {"f_center": f_center, "obw99": obw99, "bw10": bw10, "bw3": bw3, "flat": flat,
            "noise_in_bw": nin, "sig_power": sig}


def _energy_duration(excess: np.ndarray, core0: int, core1: int, unit: int, edge: int
                     ) -> tuple[float, float, float] | None:
    """能量等效时长：Σ超出量 ÷ 平台超出量。返回 (时长, 重心, 平台)，单位都是 excess 的下标。

    第一轮的平台取粗检区间向内各收四分之一格数（至少留一半）。粗检边界可能差一格，平台就会混进
    一段噪声或丢掉一段信号，所以再迭代两轮：平台改取上一轮估出的突发的**中间 PLATEAU_FRAC**，再去掉
    两端各 edge 个下标（滤波器或细时频帧的过渡段）。两头都是实测逼出来的：
    ① 平台要取得满——OFDM 每个符号里各子载波的值是固定的，一个突发里的平均功率按三分之一段看就差
       ±3%，只取中间 80% 会把这份起伏带进时长（合成图传夹具 −0.3 ~ −1.7%）；
    ② 又不能取满——平台窗一旦伸出突发，混进来的噪声把平台压低、时长抬高，而抬高的时长又撑宽了窗：
       「时长 ≥ 真值」的每个值都是这个迭代的不动点（合成跳频夹具实测偏长 6.6%）。取 90%，只要上一轮
       偏长不超过 11%，窗就还在突发里，迭代回到唯一的不动点。
    unit 是一格的下标数。"""
    idx = np.arange(excess.size)
    e_tot = float(np.sum(excess))
    if e_tot <= 0:
        return None
    shrink = min(unit, (core1 - core0) // 4)
    a, b = core0 + shrink, core1 - shrink
    dur = cen = plat = 0.0
    for _ in range(3):
        a, b = max(0, int(round(a))), min(excess.size, int(round(b)))
        if b - a < 2:
            return None
        plat = float(np.mean(excess[a:b]))
        if plat <= 0:
            return None
        dur = e_tot / plat
        cen = float(np.sum(idx * excess) / e_tot)
        half = max(0.5 * PLATEAU_FRAC * dur - edge, 0.25 * dur)
        a, b = cen - half, cen + half
    return dur, cen, plat


def refine(x: np.ndarray, tf: TFMap, c0: int, c1: int, k0: int, k1: int,
           lim_c0: int, lim_c1: int, truncated: bool) -> Burst | None:
    """在原始样点上精化一个跳频类突发（窄、孤立）。[lim_c0, lim_c1) 是同频段邻居给的边界。

    频域矩形窗滤出突发所在频段，按超出底噪的能量算等效时长。"""
    fs, nfft = tf.fs, tf.nfft
    cell_n = CELL_FRAMES * nfft
    guard = max(2, int(0.1 * (k1 - k0)))
    kb0, kb1 = max(0, k0 - guard), min(nfft, k1 + guard)
    f_lo = (kb0 - nfft / 2) * tf.bin_Hz
    f_hi = (kb1 - nfft / 2) * tf.bin_Hz
    w0 = max(lim_c0, c0 - PAD_CELLS)
    w1 = min(lim_c1, c1 + PAD_CELLS)
    s0, s1 = w0 * cell_n, min(w1 * cell_n, x.size)
    seg = x[s0:s1].astype(np.complex128)
    y = _bandpass(seg, fs, f_lo, f_hi)
    p = y.real ** 2 + y.imag ** 2
    ed = _energy_duration(p - band_noise(tf, kb0, kb1), (c0 - w0) * cell_n,
                          (c1 - w0) * cell_n, cell_n, int(math.ceil(4 * fs / (f_hi - f_lo))))
    if ed is None:
        return None
    dur_n, centroid, plat = ed
    a, b = max(0, int(centroid - 0.4 * dur_n)), int(centroid + 0.4 * dur_n)
    met = _psd_metrics(seg[a:b], tf, f_lo, f_hi, (k1 - k0) * tf.bin_Hz, robust=False)
    if met is None:
        return None
    return _make_burst(tf, s0, dur_n, centroid, met, p[a:b], truncated, (k1 - k0) * tf.bin_Hz)


def _make_burst(tf: TFMap, s0: int, dur_n: float, centroid: float, met: dict,
                p_core: np.ndarray | None, truncated: bool, coarse_bw: float) -> Burst:
    """带内信噪比 = 频段内超出功率 ÷ −10 dB 宽度内的噪声功率。"""
    snr_dB = (10 * math.log10(met["sig_power"] / met["noise_in_bw"])
              if met["noise_in_bw"] > 0 and met["sig_power"] > 0 else float("inf"))
    papr = None
    if p_core is not None and snr_dB >= PAPR_MIN_SNR_DB and p_core.size >= 10 / PAPR_CCDF:
        papr = float(10 * math.log10(np.quantile(p_core, 1 - PAPR_CCDF) / np.mean(p_core)))
    return Burst((s0 + centroid - dur_n / 2) / tf.fs, dur_n / tf.fs, tf.fc + met["f_center"],
                 met["obw99"], met["bw10"], met["bw3"], met["flat"], snr_dB, papr, truncated,
                 coarse_bw)


# ---------------------------------------------------------------- 宽带信道（图传）：覆盖率判开关

def channel_runs(tf: TFMap, k0: int, k1: int) -> list[tuple[int, int]]:
    """固定频段 [k0, k1) 上按覆盖率判开关，返回开的格区间 [(c0, c1)]。

    只隔一格的两段并成一段：弱信号（非视距图传，带内信噪比 10 dB 上下）的覆盖率在 60% 线附近抖，
    不并会把一个突发切成一串细条（实测：DroneRFb 非视距片）。图传突发之间的真实间隙都在 0.1 ms 以上
    （两格），不会被并掉。短于 VIDEO_MIN_CELLS 格的段记作碎片，不精化。"""
    on = tf.mask[:, k0:k1].mean(axis=1) >= COVER_ON
    on = ndimage.binary_closing(on, structure=np.ones(3, bool)) | on
    edges = np.flatnonzero(np.diff(np.concatenate([[0], on.astype(np.int8), [0]])))
    return [(int(a), int(b)) for a, b in zip(edges[0::2], edges[1::2]) if b - a >= VIDEO_MIN_CELLS]


def _fine_nfft(fs: float, bw: float) -> int:
    """细时频图点数：让频段里至少约 12 个频点，时间分辨率尽量细。"""
    return max(16, 1 << int(math.ceil(math.log2(12 * fs / bw))))


def _band_median(seg: np.ndarray, fs: float, f_lo: float, f_hi: float, nf: int) -> np.ndarray:
    """每 nf 点一帧（不重叠、汉宁窗），取完全落在 [f_lo, f_hi] 内的频点功率的中位数。"""
    k = seg.size // nf
    w = np.hanning(nf)
    X = sfft.fftshift(sfft.fft(seg[:k * nf].reshape(k, nf) * w, axis=1), axes=1)
    fb = (np.arange(nf) - nf / 2) * fs / nf
    sel = (fb - fs / nf / 2 >= f_lo) & (fb + fs / nf / 2 <= f_hi)
    P = (X[:, sel].real ** 2 + X[:, sel].imag ** 2) / np.sum(w * w)
    return np.median(P, axis=1)


def _exp_median_factor(k: int) -> float:
    """k 个独立单位均值指数变量的样本中位数的期望（numpy 的偶数取中间两个的平均）。

    指数分布的第 i 个次序统计量期望 = Σ_{j=k−i+1}^{k} 1/j。"""
    def order(i: int) -> float:
        return sum(1.0 / j for j in range(k - i + 1, k + 1))
    if k % 2:
        return order((k + 1) // 2)
    return 0.5 * (order(k // 2) + order(k // 2 + 1))


def channel_bursts(x: np.ndarray, tf: TFMap, k0: int, k1: int) -> tuple[list[Burst], dict]:
    """宽带信道逐突发精化。返回 (突发, 过程信息)。

    时长不用带内能量求和，而用**细时频图上频段内频点功率的中位数**做能量等效：频段里夹着一个
    占一两个频点的强跳频点时，求和会被它顶起来（合成夹具上实测偏长 20%），中位数不会。复高斯型信号
    逐频点功率服从指数分布，中位数与均值成比例，故「超出量 ÷ 平台」仍是能量等效时长。"""
    fs, nfft = tf.fs, tf.nfft
    cell_n = CELL_FRAMES * nfft
    f_lo = (k0 - nfft / 2) * tf.bin_Hz
    f_hi = (k1 - nfft / 2) * tf.bin_Hz
    nf = _fine_nfft(fs, f_hi - f_lo)
    runs = channel_runs(tf, k0, k1)
    n = tf.mask.shape[0]
    # 噪声的中位数水平：频段完全安静的格上实测；安静格不够时按指数分布次序统计量解析
    cover = tf.mask[:, k0:k1].mean(axis=1)
    quiet = np.flatnonzero(cover == 0)[:400]
    if quiet.size >= 5:
        vals = [np.mean(_band_median(x[c * cell_n:(c + 1) * cell_n].astype(np.complex128),
                                     fs, f_lo, f_hi, nf)) for c in quiet]
        m_noise, noise_src = float(np.mean(vals)), "quiet_cells"
    else:
        fb = (np.arange(nf) - nf / 2) * fs / nf
        sel = (fb - fs / nf / 2 >= f_lo) & (fb + fs / nf / 2 <= f_hi)
        mu = float(np.mean(np.interp(fb[sel], (np.arange(nfft) - nfft / 2) * tf.bin_Hz,
                                     tf.noise_mean)))
        m_noise, noise_src = mu * _exp_median_factor(int(sel.sum())), "analytic"
    out = []
    for i, (a, b) in enumerate(runs):
        lim0 = runs[i - 1][1] + (a - runs[i - 1][1]) // 2 if i > 0 else 0
        lim1 = b + (runs[i + 1][0] - b + 1) // 2 if i + 1 < len(runs) else n
        w0, w1 = max(lim0, a - PAD_CELLS), min(lim1, b + PAD_CELLS)
        s0, s1 = w0 * cell_n, min(w1 * cell_n, x.size)
        seg = x[s0:s1].astype(np.complex128)
        med = _band_median(seg, fs, f_lo, f_hi, nf)
        u = cell_n // nf
        ed = _energy_duration(med - m_noise, (a - w0) * u, (b - w0) * u, u, 2)
        if ed is None:
            continue
        dur_f, cen_f, _ = ed
        dur_n, centroid = dur_f * nf, (cen_f + 0.5) * nf
        ca, cb = max(0, int(centroid - 0.4 * dur_n)), int(centroid + 0.4 * dur_n)
        met = _psd_metrics(seg[ca:cb], tf, f_lo, f_hi, f_hi - f_lo, robust=True)
        if met is None:
            continue
        y = _bandpass(seg[ca:cb], fs, f_lo, f_hi)
        out.append(_make_burst(tf, s0, dur_n, centroid, met, y.real ** 2 + y.imag ** 2,
                               a == 0 or b >= n, f_hi - f_lo))
    return out, {"fine_nfft": nf, "noise_median_source": noise_src, "runs": runs}


def find_channels(tf: TFMap, bl: list[Blob], min_bw_Hz: float, f_lo: float, f_hi: float,
                  min_duty: float = 0.02) -> list[tuple[int, int]]:
    """在 [f_lo, f_hi] 里找宽带信道：宽突发的频率跨度按重叠聚成簇，每簇取跨度的中位数。"""
    cands = []
    for b in bl:
        bw = (b.k1 - b.k0) * tf.bin_Hz
        fc = tf.bin_freq((b.k0 + b.k1) / 2)
        if bw >= min_bw_Hz and f_lo <= fc <= f_hi:
            cands.append(b)
    groups: list[list[Blob]] = []
    for b in sorted(cands, key=lambda b: b.k0):
        for g in groups:
            lo = np.median([q.k0 for q in g])
            hi = np.median([q.k1 for q in g])
            ov = min(hi, b.k1) - max(lo, b.k0)
            if ov > 0.6 * min(hi - lo, b.k1 - b.k0):
                g.append(b)
                break
        else:
            groups.append([b])
    n_cells = tf.mask.shape[0]
    out: list[tuple[int, int]] = []
    # 开的时间长的簇先认；与已认下的信道重叠超过自身宽度 30% 的簇丢掉（弱图传的跨度不稳，
    # 同一个信道会被拆成两个互相重叠的簇）
    for g in sorted(groups, key=lambda g: -sum(q.c1 - q.c0 for q in g)):
        if sum(q.c1 - q.c0 for q in g) / n_cells < min_duty:
            continue
        k0 = int(np.median([q.k0 for q in g]))
        k1 = int(np.median([q.k1 for q in g]))
        if any(min(k1, b1) - max(k0, b0) > 0.3 * (k1 - k0) for b0, b1 in out):
            continue
        out.append((k0, k1))
    return sorted(out)


# ---------------------------------------------------------------- 跳频类：逐个分量精化

def hop_bursts(x: np.ndarray, tf: TFMap, bl: list[Blob], bw_range: tuple[float, float],
               f_range: tuple[float, float] | None = None,
               dur_range: tuple[float, float] | None = None,
               exclude: list[tuple[int, int, list[tuple[int, int]]]] = ()) -> list[Burst]:
    """粗检带宽落在 bw_range 的分量逐个精化。

    exclude：宽带信道 (k0, k1, 开的格区间)。频率上一半以上落在信道里、**且**时间上与信道的某个
    突发重叠的分量跳过（那多半是图传突发自己的碎片）；落在信道频段里但在图传间隙中的跳频点照收。
    dur_range：按精化后的时长筛（秒）。粗检信噪比不到 MIN_COARSE_SNR_DB 的分量不精化（省时间，
    也挡掉成片的弱碎片：DroneRFb 一片 50 ms 里有五百多个弱分量，绝大多数是远处 WiFi 与蓝牙的边角）。"""
    out = []
    for i, b in enumerate(bl):
        bw = (b.k1 - b.k0) * tf.bin_Hz
        if not (bw_range[0] <= bw <= bw_range[1]):
            continue
        fc = tf.bin_freq((b.k0 + b.k1) / 2)
        if f_range and not (f_range[0] <= fc <= f_range[1]):
            continue
        if b.power < float(np.mean(tf.floor[b.k0:b.k1])) * 10 ** (MIN_COARSE_SNR_DB / 10):
            continue
        if any(min(k1, b.k1) - max(k0, b.k0) > 0.5 * (b.k1 - b.k0)
               and any(min(r1, b.c1) > max(r0, b.c0) for r0, r1 in runs)
               for k0, k1, runs in exclude):
            continue
        # 同频段的时间邻居：功率不到自己 NEIGHBOR_MIN 的不管（例如遥控突发后面弱 20 dB 的回传拖尾，
        # 它漏进来的能量不到一个样点）；其余的，精化取样不越过它们的中点，贴着（间隔不到 PAD_CELLS 格
        # 或时间上重叠）的记「争用」——两个信号在时频上挨着，谁的边界在哪儿说不清，时长不进统计
        lim0, lim1 = 0, tf.mask.shape[0]
        contested = False
        for o in bl:
            if o is b or min(o.k1, b.k1) <= max(o.k0, b.k0):
                continue
            near = (o.c1 <= b.c0 and b.c0 - o.c1 <= PAD_CELLS) or (o.c0 >= b.c1 and o.c0 - b.c1 <= PAD_CELLS) \
                or (min(o.c1, b.c1) > max(o.c0, b.c0))
            if o.power < NEIGHBOR_MIN * b.power:
                continue
            if near:
                contested = True
            if o.c1 <= b.c0:
                lim0 = max(lim0, o.c1 + (b.c0 - o.c1) // 2)
            elif o.c0 >= b.c1:
                lim1 = min(lim1, b.c1 + (o.c0 - b.c1 + 1) // 2)
        br = refine(x, tf, b.c0, b.c1, b.k0, b.k1, lim0, lim1, b.truncated)
        if br is None:
            continue
        if dur_range and not (dur_range[0] <= br.dur_s <= dur_range[1]):
            continue
        br.contested = contested
        out.append(br)
    return out


# ---------------------------------------------------------------- 统计与聚类

def quantiles(vals, scale: float = 1.0, nd: int = 6) -> dict:
    """稳健统计：n、中位数、10/25/75/90 分位、最小、最大；数值按 scale 换单位并保留 nd 位有效数字。"""
    v = np.asarray([a for a in vals if a is not None and math.isfinite(a)], dtype=float) * scale
    if v.size == 0:
        return {"n": 0}

    def r(a: float) -> float:
        return float(f"{a:.{nd}g}")
    p = np.percentile(v, [10, 25, 50, 75, 90])
    return {"n": int(v.size), "median": r(p[2]), "p10": r(p[0]), "p25": r(p[1]), "p75": r(p[3]),
            "p90": r(p[4]), "min": r(v.min()), "max": r(v.max())}


def histogram_peaks(vals, bin_w: float, top: int = 5, min_frac: float = 0.05) -> list[dict]:
    """按 bin_w 分箱找局部峰（计数 ≥ 总数的 min_frac），每峰给中心（峰邻域内样本的中位数）与计数。

    图传突发时长不是一个连续分布，而是落在几档上（DroneRFb 实测 ≈ 0.5 / 1.08 / 2.1 ms），
    只报中位数会丢掉这个结构。"""
    v = np.asarray(list(vals), dtype=float)
    if v.size == 0:
        return []
    edges = np.arange(0.0, v.max() + 2 * bin_w, bin_w)
    h, _ = np.histogram(v, edges)
    hs = np.convolve(h, [1, 1, 1], mode="same")
    peaks = [i for i in range(len(hs)) if hs[i] >= min_frac * v.size
             and hs[i] == hs[max(0, i - 2):i + 3].max()
             and (i == 0 or hs[i] > hs[i - 1] or hs[i - 1] != hs[i])]
    out, used = [], set()
    for i in sorted(peaks, key=lambda i: -hs[i]):
        if any(abs(i - j) <= 2 for j in used):
            continue
        used.add(i)
        lo, hi = edges[max(0, i - 1)], edges[min(len(edges) - 1, i + 2)]
        sel = v[(v >= lo) & (v < hi)]
        out.append({"center": float(f"{np.median(sel):.6g}"), "count": int(sel.size),
                    "frac": float(f"{sel.size / v.size:.4g}")})
        if len(out) >= top:
            break
    return sorted(out, key=lambda d: d["center"])


def freq_set(centers, tol: float) -> dict:
    """把跳频点中心按间隔 > tol 切成簇，报点数、跨度、间距。"""
    c = np.sort(np.asarray(list(centers), dtype=float))
    if c.size == 0:
        return {"n_bursts": 0}
    cuts = np.flatnonzero(np.diff(c) > tol) + 1
    groups = np.split(c, cuts)
    pts = np.array([np.median(g) for g in groups])
    sp = np.diff(pts)
    spread = float(np.median([np.ptp(g) for g in groups if g.size > 1])) if any(g.size > 1 for g in groups) else 0.0

    def r(a: float) -> float:
        return float(f"{a:.7g}")
    return {"n_bursts": int(c.size), "n_points": int(pts.size), "tol_Hz": r(tol),
            "min_Hz": r(pts.min()), "max_Hz": r(pts.max()), "span_Hz": r(pts.max() - pts.min()),
            "spacing_min_Hz": r(sp.min()) if sp.size else None,
            "spacing_median_Hz": r(np.median(sp)) if sp.size else None,
            "within_point_spread_median_Hz": r(spread),
            "points_Hz": [r(a) for a in pts] if pts.size <= 120 else None}


# ---------------------------------------------------------------- 数据源（谁是谁）

MS = 1e-3
MHZ = 1e6

SOURCES = [
    {
        "id": "dronerfb_dji",
        "dataset": "DroneRFb-DIR",
        "batch": "dronerfb",
        "what": "DJI 六型（A Mavic 3 Pro / C Mini 2 SE / D Mini 4 Pro / E Mini 3 / F Air 3 / G Air 2S），"
                "80 MS/s @ 2440 MHz，每片 50 ms，距接收机 10 m，视距 / 非视距",
        "select": {"split": "train", "exclude_class": ["B"]},
        "group_by": "class_letter",
        "background": {"split": "train", "class": ["B"]},
        "video": {"f_range_Hz": [2450e6, 2480e6], "min_bw_Hz": 10e6,
                  "probe_band_Hz": [2457.5e6, 2470e6],
                  "why": "论文 §2.2：「图传信号带宽 20 MHz，频率位置接近 2.48 GHz」（统一配置）；"
                         "probe_band 取两种信道位置（2453.5–2471.5 / 2457.5–2475.5 MHz）的公共部分，"
                         "做不依赖突发检测的视距 / 非视距信噪比对照"},
        "links": [{"role": "uplink", "bw_range_Hz": [0.5e6, 12e6],
                   "why": "论文 §3.1：飞控信号「每一帧的频率都是随机的，但带宽和持续时长固定」；"
                          "按 (−10 dB 宽度, 时长) 二维直方图里相对背景片超出最多的一格认出"}],
    },
    {
        "id": "dronerfa_mavic3_5g8",
        "dataset": "DroneRFa",
        "batch": "dronerfa",
        "what": "DJI Mavic 3（T1010）RF1，100 MS/s @ 5800 MHz，室内固定距接收机约 2 m",
        "select": {"class": ["T1010"], "channel": "RF1"},
        "group_by": None,
        "background": None,
        "video": {"f_range_Hz": [5750e6, 5850e6], "min_bw_Hz": 20e6,
                  "why": "2026-09-28 粗测：5780–5815 MHz 约 35 MHz 宽的突发（14 报告 §7.2）"},
        "links": [{"role": "uplink_5g8", "bw_range_Hz": [0.5e6, 12e6],
                   "why": "目视：图传频段外 1–3 MHz 宽的短突发；5.8 GHz 没有同站背景，按密度最高的一格认出"}],
    },
    {
        "id": "dronerfa_avata_uplink",
        "dataset": "DroneRFa",
        "batch": "dronerfa",
        "what": "DJI AVATA（T1110）切换档 S1xxx 的 RF0，100 MS/s @ 2440 MHz，室内固定约 2 m",
        "select": {"class": ["T1110"], "channel": "RF0", "band_state": "switched"},
        "group_by": None,
        "background": {"class": ["T0000"], "channel": "RF0"},
        "video": None,
        "links": [{"role": "uplink", "bw_range_Hz": [0.5e6, 14e6],
                   "why": "2026-09-28 粗测：切换档 2.4 GHz 上的跳频短突发，与 RFUAV 表 4 Avata 2 相符"}],
    },
    {
        "id": "dronerfa_frsky_x20",
        "dataset": "DroneRFa",
        "batch": "dronerfa",
        "what": "FrSky X20（T10010）RF1，100 MS/s @ 2440 MHz（该机型通道映射相反：RF1 才是 2.4 GHz）",
        "select": {"class": ["T10010"], "channel": "RF1"},
        "group_by": None,
        "background": {"class": ["T0000"], "channel": "RF0"},
        "video": None,
        "links": [{"role": "rc", "bw_range_Hz": [0.05e6, 3e6],
                   "why": "目视：窄带长突发、频点逐跳递增（ACCST / ACCESS 类 GFSK 跳频）"}],
    },
    {
        "id": "dronerfa_futaba_t14sg",
        "dataset": "DroneRFa",
        "batch": "dronerfa",
        "what": "Futaba T14SG（T10110）RF0，100 MS/s @ 2440 MHz；录的是哪种协议（FASST / FASSTest / "
                "S-FHSS）没有记录，只比时序与带宽（14 报告 §3.1）",
        "select": {"class": ["T10110"], "channel": "RF0"},
        "group_by": None,
        "background": {"class": ["T0000"], "channel": "RF0"},
        "video": None,
        "links": [{"role": "rc", "bw_range_Hz": [0.05e6, 5e6],
                   "why": "目视：1–2 MHz 宽、约 2 ms 的跳频突发"}],
    },
    {
        "id": "dronerfa_phantom4pro",
        "dataset": "DroneRFa",
        "batch": "dronerfa",
        "what": "DJI Phantom 4 Pro（T0010）RF0，100 MS/s @ 2440 MHz，户外 20–150 m",
        "select": {"class": ["T0010"], "channel": "RF0"},
        "group_by": None,
        "background": {"class": ["T0000"], "channel": "RF0"},
        "video_select": {"band_state": "initial"},
        "video": {"f_range_Hz": [2425e6, 2465e6], "min_bw_Hz": 6e6,
                  "why": "目视：2440–2450 MHz 约 10 MHz 宽、约 10 ms 开 / 5 ms 关的图传；只用初始档——"
                         "切换档（S1xxx）图传离开 2.4 GHz"},
        "links": [{"role": "uplink", "bw_range_Hz": [0.3e6, 5e6],
                   "why": "目视：窄带短突发"}],
    },
    {
        "id": "dronerfa_matrice200",
        "dataset": "DroneRFa",
        "batch": "dronerfa",
        "what": "DJI MATRICE 200（T0011）RF0，100 MS/s @ 2440 MHz，户外 20–150 m",
        "select": {"class": ["T0011"], "channel": "RF0"},
        "group_by": None,
        "background": {"class": ["T0000"], "channel": "RF0"},
        "video_select": {"band_state": "initial"},
        "video": {"f_range_Hz": [2425e6, 2465e6], "min_bw_Hz": 6e6,
                  "why": "目视：与 Phantom 4 Pro 同形的 10 MHz 图传"},
        "links": [{"role": "uplink", "bw_range_Hz": [0.3e6, 5e6], "why": "目视：窄带短突发"}],
    },
]

MODE_MIN_SNR_DB = 12.0     # 认角色（找二维直方图的峰）只用这么强的突发（5.8 GHz 的遥控多在 10–20 dB）
ROLE_MIN_SNR_DB = 10.0     # 进统计的突发至少这么强
MODE_BW_FACTOR = 1.35      # 角色窗：−10 dB 宽度在峰值的 [1/1.35, 1.35] 倍内
MODE_DUR_FACTOR = 3.0      # 角色窗：时长在峰值的 [1/3, 3] 倍内（宽，量出来的分布不被它截）
GRID_RATIO = 1.25          # 二维直方图对数格的公比
SPECIFIC_BG_RATIO = 0.05   # 「机型特有」：背景里的突发率不到本组的 5%
CORE_DUR_TOL = 0.10        # 核心突发：时长在峰值 ±10% 内（间隔、跳步、频点集合只用核心突发）


@dataclass
class Rec:
    data_id: str
    path: str
    batch: str
    truth: dict
    channel_id: str
    content_sha256: str


def load_index(batch: str) -> list[Rec]:
    d = os.path.join(_ROOT, "data", "iq", "measured", batch)
    with open(os.path.join(d, "index.manifest.json"), encoding="utf-8") as fh:
        idx = json.load(fh)
    return [Rec(r["data_id"], os.path.join(d, r["data_id"] + ".manifest.json"), batch,
                r.get("truth") or {}, r.get("channel_id", ""), r.get("content_sha256", ""))
            for r in idx["products"]]


def select(recs: list[Rec], rule: dict) -> list[Rec]:
    out = []
    for r in recs:
        t = r.truth
        if "split" in rule and t.get("split") != rule["split"]:
            continue
        if "exclude_class" in rule and t.get("class_code", "")[:1] in rule["exclude_class"]:
            continue
        if "class" in rule and t.get("class_code") not in rule["class"] \
                and t.get("class_code", "")[:1] not in rule["class"]:
            continue
        if "channel" in rule and r.channel_id != rule["channel"]:
            continue
        if "band_state" in rule and t.get("band_state") != rule["band_state"]:
            continue
        out.append(r)
    return sorted(out, key=lambda r: r.data_id)


def load_holdout() -> tuple[set[str], set[str], str]:
    path = os.path.join(_ROOT, "data", "iq", "measured", "holdout.manifest.json")
    with open(path, "rb") as fh:
        raw = fh.read()
    doc = json.loads(raw)
    import hashlib
    return ({r["data_id"] for r in doc["holdout"]},
            {r["content_sha256"] for r in doc["holdout"] if r.get("content_sha256")},
            hashlib.sha256(raw).hexdigest())


def drop_holdout(recs: list[Rec], ids: set[str], hashes: set[str]) -> tuple[list[Rec], list[str]]:
    """剔除验收集（按 data_id 与内容哈希，与 `tools/freeze_holdout.py --check` 同一判据）。"""
    keep, dropped = [], []
    for r in recs:
        if r.data_id in ids or (r.content_sha256 and r.content_sha256 in hashes):
            dropped.append(r.data_id)
        else:
            keep.append(r)
    return keep, dropped


# ---------------------------------------------------------------- 逐录音处理

def analyse_block(x: np.ndarray, fs: float, fc: float, video: dict | None,
                  link_bw: tuple[float, float]) -> dict:
    tf = tf_map(x, fs, fc)
    bl = blobs(tf)
    out = {"seconds": tf.mask.shape[0] * tf.cell_s, "channels": [], "hops": [], "probe_snr_dB": None}
    ex = []
    if video and video.get("probe_band_Hz"):
        # 不依赖突发检测的信噪比：固定频段内逐帧平均功率，取最强 20% 帧的均值相对噪声均值（线性域扣噪声）
        k0 = int(round(tf.freq_bin(video["probe_band_Hz"][0])))
        k1 = int(round(tf.freq_bin(video["probe_band_Hz"][1])))
        band = np.sort(tf.frames[:, k0:k1].mean(axis=1))[::-1]
        top = float(np.mean(band[:max(1, band.size // 5)]))
        noise = float(np.mean(tf.noise_mean[k0:k1]))
        out["probe_snr_dB"] = 10 * math.log10(max(top / noise - 1.0, 1e-3))
    if video:
        for k0, k1 in find_channels(tf, bl, video["min_bw_Hz"], *video["f_range_Hz"]):
            bursts, info = channel_bursts(x, tf, k0, k1)
            out["channels"].append({"f_lo_Hz": tf.bin_freq(k0), "f_hi_Hz": tf.bin_freq(k1),
                                    "bursts": bursts, "noise_median_source": info["noise_median_source"]})
            ex.append((k0, k1, info["runs"]))
    out["hops"] = hop_bursts(x, tf, bl, link_bw, exclude=ex)
    return out


def analyse_record(rec: Rec, video: dict | None, link_bw: tuple[float, float]) -> list[dict]:
    """一段录音 → 逐连续块的结果。DroneRFb 一片即一块；DroneRFa 每 1000 万点一块（块间不连续）。"""
    from iq_format import store
    p = store.open_product(rec.path)
    fs, fc = p.sample_rate_Hz, p.center_frequency_Hz
    block = DRONERFA_BLOCK if rec.batch == "dronerfa" else p.sample_count
    out = []
    for start in range(0, p.sample_count, block):
        n = min(block, p.sample_count - start)
        if n < 64 * CELL_FRAMES * NFFT:
            continue
        res = analyse_block(p.read(start, n), fs, fc, video, link_bw)
        res["data_id"] = rec.data_id
        res["visibility"] = rec.truth.get("visibility")
        out.append(res)
    return out


# ---------------------------------------------------------------- 角色识别与聚合

def _grid(lo: float, hi: float) -> np.ndarray:
    return lo * GRID_RATIO ** np.arange(int(math.ceil(math.log(hi / lo) / math.log(GRID_RATIO))) + 1)


BW_GRID = _grid(0.03e6, 20e6)
DUR_GRID = _grid(0.02e-3, 20e-3)


def _rate_map(blocks: list[dict]) -> tuple[np.ndarray, float]:
    secs = sum(b["seconds"] for b in blocks)
    pts = [(h.bw10_Hz, h.dur_s) for b in blocks for h in b["hops"]
           if h.snr_dB >= MODE_MIN_SNR_DB and not h.truncated and not h.contested]
    if not pts:
        return np.zeros((BW_GRID.size - 1, DUR_GRID.size - 1)), secs
    a = np.array(pts)
    H, _, _ = np.histogram2d(a[:, 0], a[:, 1], bins=[BW_GRID, DUR_GRID])
    return H / max(secs, 1e-9), secs


def find_mode(blocks: list[dict], bg_blocks: list[dict] | None) -> dict | None:
    """认角色：(−10 dB 宽度, 时长) 二维对数直方图里，**背景里几乎没有**（背景率 ≤ 本组的
    SPECIFIC_BG_RATIO）的格中**超出背景的占空时间**最多的一格（3×3 求和找峰）。没有背景录音时取
    占空时间最多的一格。

    两条都是实测逼出来的：① 按占空时间（突发率 × 时长）而不是按突发个数——Phantom 4 Pro 录音里
    0.07 ms、0.3 MHz 的小包每秒上百个，按个数会把它们认成遥控；② 要求背景里几乎没有——DroneRFb 的
    机型片与背景片不是同一时刻录的，蓝牙的活跃程度两边不同（1.2 MHz / 2.6 ms 的长包在 Mini 2 SE 片里
    每秒 50 个、背景片里 7 个），只按「超出多少」会把它认成遥控。前几名候选连同突发率、背景率写进
    结果，认的过程可复核。"""
    R, _ = _rate_map(blocks)
    Rb = _rate_map(bg_blocks)[0] if bg_blocks else np.zeros_like(R)
    dur_c = np.sqrt(DUR_GRID[:-1] * DUR_GRID[1:])
    air = (R - Rb) * dur_c[None, :]
    score = ndimage.uniform_filter(air, size=3, mode="constant") * 9
    if score.max() <= 0:
        return None

    def describe(i: int, j: int) -> dict | None:
        lo_b, hi_b = BW_GRID[max(0, i - 1)], BW_GRID[min(BW_GRID.size - 1, i + 2)]
        lo_d, hi_d = DUR_GRID[max(0, j - 1)], DUR_GRID[min(DUR_GRID.size - 1, j + 2)]
        sel = [h for b in blocks for h in b["hops"] if h.snr_dB >= MODE_MIN_SNR_DB and not h.truncated
               and not h.contested and lo_b <= h.bw10_Hz < hi_b and lo_d <= h.dur_s < hi_d]
        if not sel:
            return None
        sl = (slice(max(0, i - 1), i + 2), slice(max(0, j - 1), j + 2))
        return {"bw10_Hz": float(f"{np.median([h.bw10_Hz for h in sel]):.6g}"),
                "dur_s": float(f"{np.median([h.dur_s for h in sel]):.6g}"),
                "rate_per_s": float(f"{R[sl].sum():.4g}"),
                "background_rate_per_s": float(f"{Rb[sl].sum():.4g}"),
                "excess_airtime": float(f"{score[i, j]:.4g}")}

    order = np.argsort(score.ravel())[::-1]
    picked: list[tuple[int, int]] = []
    cands = []
    for flat in order:
        i, j = np.unravel_index(int(flat), score.shape)
        if score[i, j] <= 0 or len(cands) >= 6:
            break
        if any(abs(i - a) <= 2 and abs(j - b) <= 2 for a, b in picked):
            continue
        d = describe(i, j)
        if d:
            d["specific"] = bool(bg_blocks is None
                                 or d["background_rate_per_s"] <= SPECIFIC_BG_RATIO * d["rate_per_s"])
            picked.append((i, j))
            cands.append(d)
    if not cands:
        return None
    chosen = next((c for c in cands if c["specific"]), cands[0])
    rule = ("无背景录音：取占空时间最多的一格" if bg_blocks is None else
            "背景率 ≤ 本组 5% 的格中占空时间超出最多的一格" if chosen["specific"] else
            "没有背景里几乎不出现的格，退回占空时间超出最多的一格")
    return {**{k: v for k, v in chosen.items() if k != "specific"}, "rule": rule,
            "candidates": cands}


def in_role(h: Burst, mode: dict) -> bool:
    return (mode["bw10_Hz"] / MODE_BW_FACTOR <= h.bw10_Hz <= mode["bw10_Hz"] * MODE_BW_FACTOR
            and mode["dur_s"] / MODE_DUR_FACTOR <= h.dur_s <= mode["dur_s"] * MODE_DUR_FACTOR
            and h.snr_dB >= ROLE_MIN_SNR_DB)


def in_core(h: Burst, mode: dict) -> bool:
    return abs(h.dur_s - mode["dur_s"]) <= CORE_DUR_TOL * mode["dur_s"] and not h.truncated


def summarize_link(blocks: list[dict], bg_blocks: list[dict] | None, role: str) -> dict:
    mode = find_mode(blocks, bg_blocks)
    if mode is None:
        return {"role": role, "found": False}
    secs = sum(b["seconds"] for b in blocks)
    # 「核心」= 时长在峰值 ±CORE_DUR_TOL 内的角色突发。间隔、跳步只在相邻两个核心突发之间算：
    # 角色窗是宽的（不截分布），会混进同宽度的蓝牙包，拿它们算间隔会把间隔拉碎。
    members, core, intervals, gaps, steps = [], [], [], [], []
    snr_by_vis: dict[str, list[float]] = {}
    for b in blocks:
        hs = sorted((h for h in b["hops"] if in_role(h, mode)), key=lambda h: h.t0_s)
        members += hs
        cs = [h for h in hs if in_core(h, mode)]
        core += cs
        snr_by_vis.setdefault(b.get("visibility") or "—", []).extend(h.snr_dB for h in cs)
        for u, v in zip(cs, cs[1:]):
            intervals.append(v.t0_s - u.t0_s)
            gaps.append(v.t0_s - (u.t0_s + u.dur_s))
            steps.append(v.f_center_Hz - u.f_center_Hz)
    clean = [h for h in members if not h.truncated and not h.contested]
    bg_rate = bg_core = None
    if bg_blocks:
        bsecs = max(sum(b["seconds"] for b in bg_blocks), 1e-9)
        bg_rate = sum(1 for b in bg_blocks for h in b["hops"] if in_role(h, mode)) / bsecs
        bg_core = sum(1 for b in bg_blocks for h in b["hops"] if in_role(h, mode) and in_core(h, mode)) / bsecs
    rate = len(members) / max(secs, 1e-9)
    rate_core = len(core) / max(secs, 1e-9)
    return {
        "role": role, "found": True, "mode": mode,
        "window": {"bw10_Hz": [float(f"{mode['bw10_Hz'] / MODE_BW_FACTOR:.6g}"),
                               float(f"{mode['bw10_Hz'] * MODE_BW_FACTOR:.6g}")],
                   "dur_s": [float(f"{mode['dur_s'] / MODE_DUR_FACTOR:.6g}"),
                             float(f"{mode['dur_s'] * MODE_DUR_FACTOR:.6g}")],
                   "min_snr_dB": ROLE_MIN_SNR_DB},
        "rate_per_s": float(f"{rate:.4g}"),
        "background_rate_per_s": None if bg_rate is None else float(f"{bg_rate:.4g}"),
        "contamination_ratio": None if bg_rate is None or rate == 0 else float(f"{bg_rate / rate:.3g}"),
        "core_dur_tol": CORE_DUR_TOL,
        "n_core": len(core),
        "core_rate_per_s": float(f"{rate_core:.4g}"),
        "core_contamination_ratio": None if bg_core is None or rate_core == 0
        else float(f"{bg_core / rate_core:.3g}"),
        "n_members": len(members),
        "n_excluded_truncated": sum(1 for h in members if h.truncated),
        "n_excluded_contested": sum(1 for h in members if h.contested and not h.truncated),
        "dur_s": quantiles([h.dur_s for h in clean]),
        "dur_peaks_ms": histogram_peaks([h.dur_s * 1e3 for h in clean], 0.02),
        "bw10_Hz": quantiles([h.bw10_Hz for h in clean]),
        "bw10_peaks_MHz": histogram_peaks([h.bw10_Hz / 1e6 for h in clean], 0.25),
        "obw99_Hz": quantiles([h.obw99_Hz for h in clean]),
        "bw3_Hz": quantiles([h.bw3_Hz for h in clean]),
        "flatness": quantiles([h.flatness for h in clean], nd=4),
        "snr_dB": quantiles([h.snr_dB for h in members], nd=4),
        "core_snr_dB_by_visibility": {k: quantiles(v, nd=4) for k, v in sorted(snr_by_vis.items())},
        "papr_dB": quantiles([h.papr_dB for h in clean], nd=4),
        "interval_s": quantiles(intervals),
        "interval_peaks_ms": histogram_peaks([v * 1e3 for v in intervals], 0.1),
        "gap_s": quantiles(gaps),
        "hop_step_abs_Hz": quantiles([abs(v) for v in steps]),
        "hop_step_peaks_MHz": histogram_peaks([v / 1e6 for v in steps if v > 0], 0.2, top=6),
        "freq_set": freq_set([h.f_center_Hz for h in core], 0.3 * mode["bw10_Hz"]),
    }


def summarize_video(blocks: list[dict]) -> dict:
    """图传统计。信道表、占空、按视距的信噪比用全部突发；时长、间隔与谱形只用带内信噪比
    ≥ VIDEO_MIN_SNR_DB 的突发（间隔要求相邻两个都够）。"""
    chans: dict[tuple[float, float], dict] = {}
    durs, gaps, intervals, duty, snr_by_vis = [], [], [], [], {}
    probe_by_vis: dict[str, list[float]] = {}
    rate_by_vis: dict[str, list[float]] = {}
    all_b = []
    for b in blocks:
        vis = b.get("visibility") or "—"
        if b.get("probe_snr_dB") is not None:
            probe_by_vis.setdefault(vis, []).append(b["probe_snr_dB"])
        rate_by_vis.setdefault(vis, [0.0, 0.0])
        rate_by_vis[vis][0] += sum(len(c["bursts"]) for c in b["channels"])
        rate_by_vis[vis][1] += b["seconds"]
        on = 0.0
        for c in b["channels"]:
            key = (round(c["f_lo_Hz"] / 0.5e6) * 0.5, round(c["f_hi_Hz"] / 0.5e6) * 0.5)
            e = chans.setdefault(key, {"f_lo_MHz": key[0], "f_hi_MHz": key[1], "blocks": 0, "bursts": 0})
            e["blocks"] += 1
            e["bursts"] += len(c["bursts"])
            bs = sorted(c["bursts"], key=lambda z: z.t0_s)
            on += sum(z.dur_s for z in bs)
            all_b += bs
            ok = [z.snr_dB >= VIDEO_MIN_SNR_DB for z in bs]
            durs += [z.dur_s for z, o in zip(bs, ok) if o and not z.truncated]
            for i in range(len(bs) - 1):
                if ok[i] and ok[i + 1]:
                    intervals.append(bs[i + 1].t0_s - bs[i].t0_s)
                    gaps.append(bs[i + 1].t0_s - (bs[i].t0_s + bs[i].dur_s))
            for z in bs:
                snr_by_vis.setdefault(b.get("visibility") or "—", []).append(z.snr_dB)
        duty.append(on / b["seconds"])
    clean = [z for z in all_b if not z.truncated and z.snr_dB >= VIDEO_MIN_SNR_DB]
    return {
        "n_bursts": len(all_b), "n_excluded_truncated": sum(1 for z in all_b if z.truncated),
        "n_excluded_low_snr": sum(1 for z in all_b if not z.truncated and z.snr_dB < VIDEO_MIN_SNR_DB),
        "channels": sorted(chans.values(), key=lambda e: (-e["bursts"], e["f_lo_MHz"]))[:12],
        "dur_s": quantiles(durs),
        "dur_peaks_ms": histogram_peaks([d * 1e3 for d in durs], 0.02),
        "gap_s": quantiles(gaps),
        "interval_s": quantiles(intervals),
        "duty_per_block": quantiles(duty, nd=4),
        "center_Hz": quantiles([z.f_center_Hz for z in clean], nd=7),
        "bw10_Hz": quantiles([z.bw10_Hz for z in clean]),
        "bw10_peaks_MHz": histogram_peaks([z.bw10_Hz / 1e6 for z in clean], 0.5),
        "obw99_Hz": quantiles([z.obw99_Hz for z in clean]),
        "bw3_Hz": quantiles([z.bw3_Hz for z in clean]),
        "flatness": quantiles([z.flatness for z in clean], nd=4),
        "papr_dB": quantiles([z.papr_dB for z in clean], nd=4),
        "snr_dB_by_visibility": {k: quantiles(v, nd=4) for k, v in sorted(snr_by_vis.items())},
        "probe_top20_snr_dB_by_visibility": {k: quantiles(v, nd=4) for k, v in sorted(probe_by_vis.items())},
        "bursts_per_s_by_visibility": {k: float(f"{n / max(t, 1e-9):.4g}") for k, (n, t) in sorted(rate_by_vis.items())},
    }


# ---------------------------------------------------------------- DroneRFb 机型数核实（06 §9K Q-0b 顺带项）

PAPER_DRONERFB = {
    "source": "任俊宇 等，DroneRFb-DIR，电子与信息学报 47(3)，表 2 与 §2.3",
    "types": 6, "individuals_per_type": 3,
    "train_labels": 13, "train_slices": 2177, "test_labels": 19, "test_slices": 2513,
}


def dronerfb_census(recs: list[Rec]) -> dict:
    """本地索引与论文表 2 / §2.3 逐项对数。类码字母 A–G 是七个，但 B 是背景不是机型。"""
    drones = [r for r in recs if r.truth.get("class_code", "B") != "B"]
    types = sorted({r.truth["class_code"][0] for r in drones})
    indiv = {t: sorted({r.truth["class_code"] for r in drones if r.truth["class_code"][0] == t}) for t in types}
    train = [r for r in recs if r.truth.get("split") == "train"]
    test = [r for r in recs if r.truth.get("split") == "test"]
    local = {
        "types": len(types), "type_letters": types,
        "type_names": {t: next(r.truth.get("class_name") for r in drones if r.truth["class_code"][0] == t)
                       for t in types},
        "individuals_per_type": sorted({len(v) for v in indiv.values()}),
        "train_labels": len({r.truth.get("class_code") for r in train}), "train_slices": len(train),
        "test_labels": len({r.truth.get("class_code") for r in test}), "test_slices": len(test),
        "background_code": "B",
    }
    agree = (local["types"] == PAPER_DRONERFB["types"]
             and local["individuals_per_type"] == [PAPER_DRONERFB["individuals_per_type"]]
             and all(local[k] == PAPER_DRONERFB[k] for k in
                     ("train_labels", "train_slices", "test_labels", "test_slices")))
    return {"paper": PAPER_DRONERFB, "local": local, "agree": agree,
            "note": "本地是六型 × 3 个体 + 背景，与论文一致；此前「本地七型」是把类码字母 A–G 七个都当成了机型，"
                    "其中 B 是背景"}


# ---------------------------------------------------------------- 主流程

def _analyse_job(args):
    rec, video, link_bw = args
    return analyse_record(rec, video, link_bw)


def run(sources: list[dict], workers: int, limit: int | None) -> dict:
    from concurrent.futures import ProcessPoolExecutor
    sys.path.insert(0, os.path.join(_ROOT, "tools"))
    import freeze_holdout
    ids, hashes, holdout_sha = load_holdout()
    index = {b: load_index(b) for b in {s["batch"] for s in sources}}
    doc: dict = {
        "schema": "cuav-q0b-params/1",
        "producer": f"algos/reference/q0b_param_extract.py {VERSION}",
        "status": "原型阶段验证值（D-028）：公开数据集只用于验证技术途径，甲方数据到货后按同一脚本重跑",
        "method": {
            "nfft": NFFT, "cell_frames": CELL_FRAMES, "freq_smooth_bins": FREQ_SMOOTH,
            "floor_percentile": FLOOR_PCT, "threshold_dB": THRESH_DB, "min_cells": MIN_CELLS,
            "cover_on": COVER_ON, "min_coarse_snr_dB": MIN_COARSE_SNR_DB,
            "mode_min_snr_dB": MODE_MIN_SNR_DB, "role_min_snr_dB": ROLE_MIN_SNR_DB,
            "mode_bw_factor": MODE_BW_FACTOR, "mode_dur_factor": MODE_DUR_FACTOR,
            "specific_bg_ratio": SPECIFIC_BG_RATIO, "core_dur_tol": CORE_DUR_TOL,
            "plateau_frac": PLATEAU_FRAC,
            "papr_ccdf": PAPR_CCDF, "papr_min_snr_dB": PAPR_MIN_SNR_DB,
            "dronerfa_block_samples": DRONERFA_BLOCK,
            "duration": "能量等效时长：超出底噪的能量 ÷ 平台超出功率（图传用细时频图频段内中位数，跳频类用矩形带通求和）",
            "bandwidth": "突发核心段超出功率谱：99% 占用带宽、−10 dB 宽度、−3 dB 宽度",
            "intervals": "同一连续块内相邻同角色突发的起点差；DroneRFa 块间不连续，不跨块",
            "limit_per_group": limit,
        },
        "holdout": {"manifest": "data/iq/measured/holdout.manifest.json", "manifest_sha256": holdout_sha},
        "sources": [],
    }
    if "dronerfb" in index:
        doc["dronerfb_census"] = dronerfb_census(index["dronerfb"])

    cache: dict = {}
    all_used: list[Rec] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for src in sources:
            t_src = time.time()
            recs = select(index[src["batch"]], src["select"])
            recs, dropped = drop_holdout(recs, ids, hashes)
            groups: dict[str, list[Rec]] = {}
            for r in recs:
                g = r.truth.get("class_code", "")[:1] if src["group_by"] == "class_letter" else "all"
                groups.setdefault(g, []).append(r)
            if limit:
                groups = {g: v[::max(1, len(v) // limit)][:limit] for g, v in groups.items()}
            bg = []
            if src["background"]:
                bg, bg_dropped = drop_holdout(select(index[src["batch"]], src["background"]), ids, hashes)
                dropped += bg_dropped
                if limit:
                    bg = bg[::max(1, len(bg) // limit)][:limit]
            link_bw = (min(l["bw_range_Hz"][0] for l in src["links"]),
                       max(l["bw_range_Hz"][1] for l in src["links"]))
            todo = [r for v in groups.values() for r in v] + bg
            vkey = json.dumps(src["video"], sort_keys=True)
            jobs = [(r, src["video"], link_bw) for r in todo if (r.data_id, vkey, link_bw) not in cache]
            for r, res in zip([j[0] for j in jobs], pool.map(_analyse_job, jobs, chunksize=1)):
                cache[(r.data_id, vkey, link_bw)] = res
            all_used += todo
            bg_blocks = [blk for r in bg for blk in cache[(r.data_id, vkey, link_bw)]] or None

            out_groups = []
            vsel = src.get("video_select")
            for g, rs in sorted(groups.items()):
                blocks = [blk for r in rs for blk in cache[(r.data_id, vkey, link_bw)]]
                vrecs = select(rs, vsel) if vsel else rs
                vblocks = [blk for r in vrecs for blk in cache[(r.data_id, vkey, link_bw)]]
                vis: dict[str, int] = {}
                for r in rs:
                    vis[r.truth.get("visibility") or "—"] = vis.get(r.truth.get("visibility") or "—", 0) + 1
                out_groups.append({
                    "group": g,
                    "class_names": sorted({r.truth.get("class_name", "") for r in rs}),
                    "n_records": len(rs), "n_by_visibility": vis, "n_blocks": len(blocks),
                    "observed_s": float(f"{sum(b['seconds'] for b in blocks):.6g}"),
                    "video": summarize_video(vblocks) if src["video"] else None,
                    "video_records": None if not vsel else len(vrecs),
                    "links": [summarize_link(blocks, bg_blocks, l["role"]) for l in src["links"]],
                    "data_ids": [r.data_id for r in rs],
                })
            doc["sources"].append({
                "id": src["id"], "dataset": src["dataset"], "what": src["what"],
                "select": src["select"], "video_rule": src["video"],
                "video_select": src.get("video_select"),
                "link_rules": src["links"],
                "holdout_dropped": sorted(dropped),
                "background": None if not bg else {
                    "select": src["background"], "n_records": len(bg),
                    "observed_s": float(f"{sum(b['seconds'] for b in bg_blocks):.6g}"),
                    "video": summarize_video(bg_blocks) if src["video"] else None,
                    "data_ids": [r.data_id for r in bg]},
                "groups": out_groups,
            })
            print(f"  {src['id']}: {len(todo)} 段录音，{time.time() - t_src:.0f} s", flush=True)

    # 复核：用冻结工具的同一判据查一遍实际用到的全部产物（背景也算），交集必须为零
    uniq = sorted({r.path for r in all_used})
    rc = freeze_holdout.check(uniq)
    if rc != 0:
        raise SystemExit("用到的产物与验收集相交，结果作废（铁律 10 / holdout-freeze-at-ingest）")
    doc["holdout"]["checked_products"] = len(uniq)
    doc["holdout"]["intersection"] = 0
    return doc


# ---------------------------------------------------------------- 报告

def _mhz(v: float | None, nd: int = 2) -> str:
    return "—" if v is None else f"{v / 1e6:.{nd}f}"


def _ms(q: dict, key: str = "median", nd: int = 3) -> str:
    return "—" if not q.get("n") else f"{q[key] * 1e3:.{nd}f}"


def _peaks(pk: list[dict], unit: str = "ms") -> str:
    return " / ".join(f"{p['center']:.3g}（{p['frac'] * 100:.0f}%）" for p in pk) or "—"


def write_report(doc: dict, path: str) -> None:
    L = []
    w = L.append
    w("# Q-0b 实测参数提取报告")
    w("")
    w(f"> 由 `{doc['producer']}` 生成，**不要手改**；重跑命令见脚本头。{doc['status']}。")
    w("> 依据：14 号报告 §7.1、06 §9K Q-0b、`docs/emitter-template.md` §5。")
    w("")
    w("## 1. 口径与样本")
    w("")
    m = doc["method"]
    w(f"- 时频图 {m['nfft']} 点汉宁、不重叠；一格 = {m['cell_frames']} 帧 × {m['freq_smooth_bins']} 频点；"
      f"底噪逐频点取时间维第 {m['floor_percentile']:g} 百分位，高出 {m['threshold_dB']:g} dB 为占用。")
    w(f"- 时长：{m['duration']}。带宽：{m['bandwidth']}。间隔：{m['intervals']}。")
    w(f"- 图传开关：频段内被占用的频点比例 ≥ {m['cover_on']:.0%}。")
    w(f"- 遥控类角色：(−10 dB 宽度, 时长) 二维对数直方图（公比 {GRID_RATIO}）里，只数信噪比 ≥ {m['mode_min_snr_dB']:g} dB 的突发；"
      f"在**同站背景里几乎没有**（背景率 ≤ 本组 {m['specific_bg_ratio']:.0%}）的格中取**占空时间**（突发率 × 时长）超出背景最多的一格，"
      "没有背景录音时取占空时间最多的一格；前几名候选写在 JSON 的 `mode.candidates`。"
      f"角色窗 = 宽度在峰值的 1/{m['mode_bw_factor']}–{m['mode_bw_factor']} 倍、"
      f"时长在 1/{m['mode_dur_factor']:g}–{m['mode_dur_factor']:g} 倍、信噪比 ≥ {m['role_min_snr_dB']:g} dB。"
      "贴着块边界的（截断）与贴着同频段另一信号的（争用）突发不进时长统计。")
    w(f"- 峰均比：突发内 CCDF 在 {m['papr_ccdf']:g} 处，只取带内信噪比 ≥ {m['papr_min_snr_dB']:g} dB 的突发。")
    h = doc["holdout"]
    w(f"- **验收集**：选样时按 `holdout.manifest.json`（sha256 `{h['manifest_sha256'][:12]}…`）剔除，"
      f"再用 `tools/freeze_holdout.py` 同一判据复核实际用到的 {h['checked_products']} 个产物，交集 **{h['intersection']}**。")
    if m.get("limit_per_group"):
        w(f"- **本次是抽样运行**：每组至多 {m['limit_per_group']} 段录音。")
    w("")
    c = doc.get("dronerfb_census")
    if c:
        w("## 2. DroneRFb 机型数核实")
        w("")
        w("| 项 | 论文 | 本地索引 |")
        w("|---|---|---|")
        p, l = c["paper"], c["local"]
        w(f"| 机型数 | {p['types']} | {l['types']}（{'、'.join(f'{k} {v}' for k, v in l['type_names'].items())}） |")
        w(f"| 每型个体数 | {p['individuals_per_type']} | {'、'.join(map(str, l['individuals_per_type']))} |")
        w(f"| 训练集标签 / 片段 | {p['train_labels']} / {p['train_slices']} | {l['train_labels']} / {l['train_slices']} |")
        w(f"| 测试集标签 / 片段 | {p['test_labels']} / {p['test_slices']} | {l['test_labels']} / {l['test_slices']} |")
        w("")
        w(f"结论：{'一致' if c['agree'] else '**不一致**'}。{c['note']}。出处：{p['source']}。")
        w("")
    w("## 3. 图传")
    w("")
    w("| 数据源 | 组 | 段 / 块 | 信道（MHz，最常见） | −10 dB 宽度 MHz（峰） | 99% 带宽 MHz | 时长中位 ms（p10–p90） | 时长峰 ms（占比） | 间隔中位 ms | 占空（块中位） | 峰均比 dB | 平坦度 |")
    w("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for s in doc["sources"]:
        for g in s["groups"]:
            v = g["video"]
            if not v:
                continue
            ch = v["channels"][0] if v["channels"] else None
            w(f"| {s['id']} | {g['group']} | {g['n_records']} / {g['n_blocks']} | "
              f"{'—' if not ch else f'{ch['f_lo_MHz']:g}–{ch['f_hi_MHz']:g}'} | "
              f"{_mhz(v['bw10_Hz'].get('median'))}（{_peaks(v['bw10_peaks_MHz'])}） | {_mhz(v['obw99_Hz'].get('median'))} | "
              f"{_ms(v['dur_s'])}（{_ms(v['dur_s'], 'p10')}–{_ms(v['dur_s'], 'p90')}） | {_peaks(v['dur_peaks_ms'])} | "
              f"{_ms(v['interval_s'])} | {v['duty_per_block'].get('median', '—')} | "
              f"{v['papr_dB'].get('median', '—')} | {v['flatness'].get('median', '—')} |")
    w("")
    rows = [(s, g) for s in doc["sources"] for g in s["groups"]
            if g["video"] and len(g["video"]["snr_dB_by_visibility"]) > 1]
    if rows:
        w("带内信噪比按视距 / 非视距（中位数，dB）。论文 §2.2 称两者「大致相差 20 dB」。三种量法："
          "① 图传逐检出突发；② 遥控上行逐核心突发；③ **不依赖突发检测**：固定频段（`probe_band_Hz`）里"
          "每片最强 20% 帧的带内信噪比。另列每秒检出的图传突发数，看非视距是不是因为弱突发检不出而偏高：")
        w("")
        w("| 组 | ① 视距 | ① 非视距 | 差 | ② 视距 | ② 非视距 | 差 | ③ 视距 | ③ 非视距 | 差 | 图传突发 / s 视距 · 非视距 |")
        w("|---|---|---|---|---|---|---|---|---|---|---|")
        for s, g in rows:
            sv = g["video"]["snr_dB_by_visibility"]
            a, b = sv.get("LOS", {}).get("median"), sv.get("NLOS", {}).get("median")
            lk = next((l for l in g["links"] if l.get("found")), None)
            su = lk["core_snr_dB_by_visibility"] if lk else {}
            c, d = su.get("LOS", {}).get("median"), su.get("NLOS", {}).get("median")
            pv = g["video"]["probe_top20_snr_dB_by_visibility"]
            e, f = pv.get("LOS", {}).get("median"), pv.get("NLOS", {}).get("median")
            rv = g["video"]["bursts_per_s_by_visibility"]
            w(f"| {g['group']} | {a} | {b} | {'—' if a is None or b is None else f'{a - b:.1f}'} | "
              f"{c} | {d} | {'—' if c is None or d is None else f'{c - d:.1f}'} | "
              f"{e} | {f} | {'—' if e is None or f is None else f'{e - f:.1f}'} | "
              f"{rv.get('LOS', '—')} · {rv.get('NLOS', '—')} |")
        w("")
    w("## 4. 遥控上行与第三方遥控")
    w("")
    w("| 数据源 | 组 | 角色 | 峰：−10 dB 宽度 MHz / 时长 ms | 突发数（剔除截断 / 争用） | 时长中位 ms（p10–p90） | 时长峰 ms | 99% 带宽 MHz | 间隔中位 ms（峰） | 频点数 / 跨度 MHz / 最小间距 MHz | 背景污染比 |")
    w("|---|---|---|---|---|---|---|---|---|---|---|")
    for s in doc["sources"]:
        for g in s["groups"]:
            for l in g["links"]:
                if not l.get("found"):
                    w(f"| {s['id']} | {g['group']} | {l['role']} | 未找到 | | | | | | | |")
                    continue
                fsx = l["freq_set"]
                w(f"| {s['id']} | {g['group']} | {l['role']} | {_mhz(l['mode']['bw10_Hz'])} / {l['mode']['dur_s'] * 1e3:.3f} | "
                  f"{l['n_members']}（{l['n_excluded_truncated']} / {l['n_excluded_contested']}） | "
                  f"{_ms(l['dur_s'])}（{_ms(l['dur_s'], 'p10')}–{_ms(l['dur_s'], 'p90')}） | {_peaks(l['dur_peaks_ms'])} | "
                  f"{_mhz(l['obw99_Hz'].get('median'))} | {_ms(l['interval_s'], nd=2)}（{_peaks(l['interval_peaks_ms'])}） | "
                  f"{fsx.get('n_points', '—')} / {_mhz(fsx.get('span_Hz'), 1)} / {_mhz(fsx.get('spacing_min_Hz'), 3)} | "
                  f"{'无背景' if l['contamination_ratio'] is None else l['contamination_ratio']} |")
    w("")
    w("「背景污染比」= 同站背景录音里落进同一角色窗的突发率 ÷ 本组的突发率；「无背景」表示该接收配置没有同站背景录音"
      "（DroneRFa 的 5.8 GHz 通道只转了机型文件）。")
    w("")
    w("跳频点与跳步（只用核心突发；频点按间隔 > 0.3 × 单跳宽度切簇，跳步 = 块内相邻两个核心突发的中心频率差，只统计正向）：")
    w("")
    w("| 数据源 | 组 | 核心突发数（核心污染比） | 频点数 | 最低–最高 MHz | 间距中位 MHz | 簇内离散中位 kHz | 正向跳步峰 MHz（占比） |")
    w("|---|---|---|---|---|---|---|---|")
    for s in doc["sources"]:
        for g in s["groups"]:
            for l in g["links"]:
                if not l.get("found"):
                    continue
                fsx = l["freq_set"]
                cc = l["core_contamination_ratio"]
                w(f"| {s['id']} | {g['group']} | {l['n_core']}（{'无背景' if cc is None else cc}） | {fsx.get('n_points', '—')} | "
                  f"{_mhz(fsx.get('min_Hz'), 2)}–{_mhz(fsx.get('max_Hz'), 2)} | {_mhz(fsx.get('spacing_median_Hz'), 3)} | "
                  f"{(fsx.get('within_point_spread_median_Hz') or 0) / 1e3:.0f} | {_peaks(l['hop_step_peaks_MHz'])} |")
    w("")
    w("## 5. 限制")
    w("")
    w("- 公开数据集只有片级标签，**「哪个突发是图传、哪个是遥控」是按上面的规则认的**，不是标注；规则与依据随结果写在 JSON 的 `video_rule` / `link_rules` 里。")
    w("- DroneRFb 每片 50 ms，长于 50 ms 的图案周期看不到；DroneRFa 每 0.1 s 一个连续块，间隔不跨块。")
    w("- DroneRFa 录音大多室内固定、距接收机约 2 m（Phantom 4 Pro / MATRICE 200 为户外），接收机近场的强信号会带出发射机本身的频谱裙边，−10 dB 宽度对它敏感，99% 带宽更稳。")
    w("- 同一段录音里两路信号在时频上挨着时，边界说不清，这类突发只计数、不进时长统计（「争用」列）。")
    w("- Futaba T14SG 录的是哪种协议没有记录；DroneRFa 的 5.8 GHz 只有 Mavic 3 一型。")
    w("")
    w("样本清单（`data_id`）在同名 JSON 的 `sources[].groups[].data_ids` 与 `sources[].background.data_ids`。")
    w("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Q-0b 实测参数提取（14 报告 §7.1）")
    ap.add_argument("--json", default=os.path.join(_ROOT, "data/iq/measured/q0b-params.json"))
    ap.add_argument("--report", default=os.path.join(_ROOT, "data/iq/measured/q0b-params-report.md"))
    ap.add_argument("--source", action="append", help="只跑这些数据源（id，可多次给）")
    ap.add_argument("--limit", type=int, default=None, help="每组至多这么多段录音（抽样调试用）")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument("--from-json", help="不重算，只按已有的 JSON 重写报告（改了报告措辞时用）")
    args = ap.parse_args(argv)
    if args.from_json:
        with open(args.from_json, encoding="utf-8") as fh:
            write_report(json.load(fh), args.report)
        print(f"按 {os.path.relpath(args.from_json, _ROOT)} 重写 {os.path.relpath(args.report, _ROOT)}")
        return 0
    srcs = [s for s in SOURCES if not args.source or s["id"] in args.source]
    t0 = time.time()
    doc = run(srcs, args.workers, args.limit)
    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    write_report(doc, args.report)
    print(f"写出 {os.path.relpath(args.json, _ROOT)} 与 {os.path.relpath(args.report, _ROOT)}，"
          f"{time.time() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
