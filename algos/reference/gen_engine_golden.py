#!/usr/bin/env python3
"""生成引擎侧与参考实现对拍用的黄金基准（跨层一致性算例 ① 的引擎侧前置）。

## 为什么要在 Python 里复刻 C++ 的随机源

对拍要求两侧吃到**逐位相同的输入**。有两条路：把 C++ 生成的样点存成文件，或者两侧各自
从同一个种子生成。前者要往版本库里塞二进制夹具，且改一次参数就得重生成；后者只要
两边的发生器一致就行，代价是这里得复刻 xoshiro256++ 与 Box-Muller。选后者。

**这份复刻是对拍的一部分，改动即为基准变化（铁律 10）。** 它与
`engine/src/random.cpp` 必须逐行对应：splitmix64 播种、xoshiro256++ 递推、
uniform 取高 53 位、normal 用 Box-Muller 且缓存另一支、complex_normal 乘 1/√2 后转 float32。

## 精度口径

引擎内部按 `docs/iq-format.md` 用复 float32，参考实现用 float64。所以：

- **门限 η 两侧都是 float64 同算法**，判据取相对误差 1e-9（铁律 10 的黄金基准口径）。
- **逐帧检测量 Λ 受 float32 FFT 影响**，判据取相对误差 1e-5，并把实测值记进黄金文件，
  以后收紧了才知道是真的变好还是碰巧。
- **判决结果（是否超门限）要求逐帧一致**，允许的例外只有恰好卡在门限上的帧，
  黄金文件里记下这类帧的个数，非零就要解释。

用法：
    uv run --quiet --with numpy python algos/reference/gen_engine_golden.py \\
        -o engine/tests/golden/energy_detector.json

## 滑动模式（C-3，D-063）

`--mode sliding` 生成 `energy_detector_sliding.json`：输入 = 同一噪声流 + 一段门控单音，
单音按引擎 `ToneSource` 的公式逐样点复刻（`w = 2π·f/fs` 同一运算次序、`ph = w·idx + φ`、
`float32(A·cos)` / `float32(A·sin)`、门控 `start ≤ idx < stop`），与噪声在 complex64 里相加
（`AddMixer` 的 a + b，增益 1 时乘法被优化掉，逐位相同）。逐帧存全部 Λ、命中帧、段号、
暖机期的 noise_frames_used，C++ 侧 test_golden.cpp 逐帧对拍。**判决翻转会级联**（改变环
内容），所以 `borderline_frames` 必须为 0，生成器断言它；缺省 `--mode probe` 的输出与
既有文件逐字节相同（提交前 `git diff --exit-code` 守着）。

    uv run --quiet --with numpy python algos/reference/gen_engine_golden.py --mode sliding \\
        -o engine/tests/golden/energy_detector_sliding.json

## 特征模式（C-4）

`--mode features` 生成 `features.json`：输入 = 同一噪声流 + 四段门控单音（不同频偏、幅度、长短，
含一段只有两帧的弱单音）+ 一段门控白噪声（第二个种子 `--seed2`，全流生成再乘门，与 C++ 测试里的
门控噪声源逐位相同），按 C++ 测试的混合树同一结合顺序在 complex64 里相加；检测按 sliding，特征按
`features.py`。期望值是逐段的特征行；生成器断言没有 bin 卡在噪声闸或累积功率边界的 ±1e-4 内
（引擎 float32 FFT 与这里 float64 的差异会在那里翻转，与 `borderline_frames` 同一政策）。

    uv run --quiet --with numpy python algos/reference/gen_engine_golden.py --mode features \\
        -o engine/tests/golden/features.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import energy_detector as ed          # noqa: E402
import features as ft                 # noqa: E402

MASK64 = (1 << 64) - 1


class Xoshiro256pp:
    """与 engine/src/random.cpp 逐行对应的复刻。改这里必须同时改那里。"""

    def __init__(self, seed: int):
        x = seed & MASK64
        self.s = []
        for _ in range(4):
            x = (x + 0x9E3779B97F4A7C15) & MASK64
            z = x
            z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
            z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
            self.s.append(z ^ (z >> 31))
        self._spare = None

    @staticmethod
    def _rotl(x: int, k: int) -> int:
        return ((x << k) | (x >> (64 - k))) & MASK64

    def next_u64(self) -> int:
        s = self.s
        result = (self._rotl((s[0] + s[3]) & MASK64, 23) + s[0]) & MASK64
        t = (s[1] << 17) & MASK64
        s[2] ^= s[0]
        s[3] ^= s[1]
        s[1] ^= s[2]
        s[0] ^= s[3]
        s[2] ^= t
        s[3] = self._rotl(s[3], 45)
        return result

    def uniform(self) -> float:
        return (self.next_u64() >> 11) * (1.0 / 9007199254740992.0)

    def normal(self) -> float:
        if self._spare is not None:
            v, self._spare = self._spare, None
            return v
        u1 = 1.0 - self.uniform()
        u2 = self.uniform()
        r = math.sqrt(-2.0 * math.log(u1))
        theta = 6.283185307179586476925286766559 * u2
        self._spare = r * math.sin(theta)
        return r * math.cos(theta)

    def complex_normal(self) -> complex:
        k = 0.7071067811865475244
        re = np.float32(self.normal() * k)
        im = np.float32(self.normal() * k)
        return complex(re, im)


def tone_burst(n: int, fs: float, offset_Hz: float, amplitude: float,
               start_sample: int, stop_sample: int, phase_rad: float = 0.0) -> np.ndarray:
    """引擎 ToneSource 的逐样点复刻（engine/src/sources.cpp）：相位按绝对样点号闭式算，
    float64 求 cos / sin 后转 float32；门控区间外为零。运算次序与 C++ 相同。"""
    w = 2.0 * math.pi * offset_Hz / fs
    idx = np.arange(n, dtype=np.float64)
    ph = w * idx + phase_rad
    re = (amplitude * np.cos(ph)).astype(np.float32)
    im = (amplitude * np.sin(ph)).astype(np.float32)
    on = idx >= start_sample
    if stop_sample > 0:
        on &= idx < stop_sample
    out = np.zeros(n, dtype=np.complex64)
    out[on] = re[on] + 1j * im[on]
    return out


def write_sliding(args, noise: np.ndarray, mask: np.ndarray, m_bins: int, eta: float) -> int:
    n = noise.size
    tone = tone_burst(n, args.sample_rate, args.tone_offset, args.tone_amplitude,
                      args.tone_start_frame * args.nfft, args.tone_stop_frame * args.nfft)
    # AddMixer：a 路单音 + b 路噪声，complex64 相加（增益 1 时乘法被优化掉，逐位相同）
    x = (tone + noise).astype(np.complex64)
    power = ed.frame_bin_power(x, args.nfft)
    r = ed.sliding_from_power(power, mask, args.pfa, args.window_frames, args.merge_gap)
    lam = r["statistic"]
    borderline = int(np.count_nonzero(np.abs(lam / eta - 1.0) < 1e-5))
    if borderline:
        raise SystemExit(f"有 {borderline} 帧卡在门限 ±1e-5 内：滑动模式下一次判决翻转会级联，"
                         "换种子或幅度后重生成")
    hit = r["hit"]
    hit_frames = [int(k) for k in np.flatnonzero(hit)]
    burst = lam[args.tone_start_frame:args.tone_stop_frame]
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧能量检测器 sliding 模式与 algos/reference/energy_detector.py 的逐帧对拍基准（C-3，D-063）",
        "generator": "algos/reference/gen_engine_golden.py --mode sliding",
        "params": {
            "seed": args.seed, "nfft": args.nfft, "frames": args.frames,
            "sample_rate_Hz": args.sample_rate,
            "band_lo_Hz": args.band_lo, "band_hi_Hz": args.band_hi, "pfa": args.pfa,
            "noise_power": 1.0, "noise_mode": "sliding",
            "noise_window_frames": args.window_frames, "merge_gap_frames": args.merge_gap,
            "tone": {"offset_Hz": args.tone_offset, "amplitude": args.tone_amplitude,
                     "phase_rad": 0.0,
                     "start_sample": args.tone_start_frame * args.nfft,
                     "stop_sample": args.tone_stop_frame * args.nfft},
        },
        "tolerance": {
            "threshold_rel": 1e-9,
            "statistic_rel": 1e-5,
            "note": "门限 1e-9；逐帧检测量 1e-5（float32 FFT 与单音的 1 ulp 差异都在其内）；"
                    "命中、段号、noise_frames_used 逐帧完全相同——翻转会级联，所以 borderline 必须为 0",
        },
        "expected": {
            "m_bins": m_bins,
            "threshold": eta,
            "frames": int(lam.size),
            "hits": int(np.count_nonzero(hit)),
            "segments": r["segments"],
            "noise_stale_frames": r["noise_stale"],
            "ring_ever_full": bool(r["ring_ever_full"]),
            "borderline_frames": borderline,
            "lambda_mean_burst": float(burst.mean()),
            "lambda_max": float(lam.max()),
            "first_statistic": float(lam[0]),
            "statistic": [float(v) for v in lam],
            "hit_frames": hit_frames,
            "segment_id_of_hits": [int(r["segment_id"][k]) for k in hit_frames],
            "noise_frames_used_head": [int(v) for v in r["noise_frames_used"][:args.window_frames + 8]],
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"sliding 黄金基准：{lam.size} 帧，命中 {doc['expected']['hits']}，段 {r['segments']}，"
          f"陈旧 {r['noise_stale']}，突发内 Λ 均值 {burst.mean():.3f}，η {eta:.6f} → {args.out}")
    return 0


# 特征模式的突发计划（C-4）。写死在这里而不是命令行：它是黄金基准的一部分，改它就是改基准。
FEATURE_TONES = [
    # (频偏 Hz, 幅度, 起始帧, 终止帧)
    (50e3, 0.75, 1500, 1700),
    (-20e3, 0.6, 1800, 1806),
    (50e3, 0.75, 1900, 1950),
    (30e3, 0.3, 3000, 3002),
]
FEATURE_NOISE_BURST = (3.0, 2200, 2600)   # (功率, 起始帧, 终止帧)
FEATURE_PARAMS = {"nfft": None, "bandwidth_method": "occupied_99", "min_frames": 2,
                  "window_frames": 64, "noise_gate": 4.0}


def gated_noise(n: int, seed2: int, power: float, start_sample: int, stop_sample: int) -> np.ndarray:
    """C++ 测试里 GatedNoiseSource 的逐样点复刻：自带发生器、全流抽数、门外置零、门内乘 float32(√power)。"""
    rng = Xoshiro256pp(seed2)
    k = np.float32(math.sqrt(power))
    out = np.zeros(n, dtype=np.complex64)
    for i in range(n):
        c = rng.complex_normal()
        if start_sample <= i < stop_sample:
            out[i] = complex(np.float32(np.float32(c.real) * k), np.float32(np.float32(c.imag) * k))
    return out


def write_features(args, noise: np.ndarray, mask: np.ndarray, m_bins: int, eta: float) -> int:
    n = noise.size
    nfft = args.nfft
    # 混合树与 C++ 测试相同：prev = 噪声；逐个单音 mix(a = 单音, b = prev)；最后 mix(a = 门控噪声, b = prev)。
    # float32 加法可交换，只有结合顺序要一样。
    acc = noise.astype(np.complex64)
    tone_specs = []
    for off, amp, f0, f1 in FEATURE_TONES:
        t = tone_burst(n, args.sample_rate, off, amp, f0 * nfft, f1 * nfft)
        acc = (t + acc).astype(np.complex64)
        tone_specs.append({"offset_Hz": off, "amplitude": amp, "phase_rad": 0.0,
                           "start_sample": f0 * nfft, "stop_sample": f1 * nfft})
    p2, g0, g1 = FEATURE_NOISE_BURST
    g = gated_noise(n, args.seed2, p2, g0 * nfft, g1 * nfft)
    x = (g + acc).astype(np.complex64)

    power = ed.frame_bin_power(x, nfft)
    r = ed.sliding_from_power(power, mask, args.pfa, args.window_frames, args.merge_gap)
    lam = r["statistic"]
    borderline = int(np.count_nonzero(np.abs(lam / eta - 1.0) < 1e-5))
    if borderline:
        raise SystemExit(f"有 {borderline} 帧卡在门限 ±1e-5 内：换种子或幅度后重生成")
    fp = dict(FEATURE_PARAMS)
    fp["nfft"] = nfft
    rows, margins = ft.extract(x, args.sample_rate, 0.0, nfft, r, args.band_lo, args.band_hi,
                               bandwidth_method=fp["bandwidth_method"], min_frames=fp["min_frames"],
                               window_frames=fp["window_frames"], merge_gap_frames=args.merge_gap,
                               noise_gate=fp["noise_gate"], calibrated=True)
    if margins["min_gate_margin"] < 1e-4 or margins["min_cum_margin"] < 1e-4:
        raise SystemExit(f"有 bin 卡在噪声闸或累积功率边界 ±1e-4 内（{margins}）：换种子或幅度后重生成")
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧特征提取器与 algos/reference/features.py 的逐段对拍基准（C-4，10 报告 §4.3）",
        "generator": "algos/reference/gen_engine_golden.py --mode features",
        "params": {
            "seed": args.seed, "seed2": args.seed2, "nfft": nfft, "frames": args.frames,
            "sample_rate_Hz": args.sample_rate,
            "band_lo_Hz": args.band_lo, "band_hi_Hz": args.band_hi, "pfa": args.pfa,
            "noise_power": 1.0, "noise_mode": "sliding",
            "noise_window_frames": args.window_frames, "merge_gap_frames": args.merge_gap,
            "tones": tone_specs,
            "noise_burst": {"power": p2, "start_sample": g0 * nfft, "stop_sample": g1 * nfft},
            "feature": {"nfft": nfft, "bandwidth_method": fp["bandwidth_method"], "min_frames": fp["min_frames"],
                        "window_frames": fp["window_frames"], "merge_gap_frames": args.merge_gap,
                        "noise_gate": fp["noise_gate"], "window": "hann_periodic"},
        },
        "tolerance": {
            "exact": ["segment_id", "frames", "signal_bins", "quality", "overload", "has_dBm", "has_prev",
                      "t_s", "t_end_s", "duration_s", "duty", "bandwidth_Hz", "interval_from_prev_s"],
            "center_Hz_abs": 1e-3 * args.sample_rate / nfft,
            "hop_Hz_abs": 2e-3 * args.sample_rate / nfft,
            "flatness_abs": 1e-5,
            "dB_abs": 1e-4,
            "crest_rel": 1e-9,
            "note": "计数、时间、段号、质量、按 bin 计的带宽逐位相同；质心按千分之一 bin；平坦度 1e-5；"
                    "三个 dBm 与 snr 按 1e-4 dB（引擎 float32 FFT 对 numpy float64）；"
                    "峰均比只吃逐位相同的样点、double 累加，按 1e-9",
        },
        "expected": {
            "m_bins": m_bins,
            "threshold": eta,
            "frames": int(lam.size),
            "hits": int(np.count_nonzero(r["hit"])),
            "segments": r["segments"],
            "borderline_frames": borderline,
            "min_gate_margin": margins["min_gate_margin"],
            "min_cum_margin": margins["min_cum_margin"],
            "rows": rows,
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    full = sum(1 for q in rows if q["quality"] == "full")
    print(f"features 黄金基准：{lam.size} 帧，命中 {doc['expected']['hits']}，段 {r['segments']}，"
          f"特征行 {len(rows)}（full {full}），闸裕度 {margins['min_gate_margin']:.2e}，"
          f"边界裕度 {margins['min_cum_margin']:.2e} → {args.out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="生成引擎对拍黄金基准")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--seed", type=int, default=20260904)
    ap.add_argument("--nfft", type=int, default=256)
    ap.add_argument("--frames", type=int, default=4000)
    ap.add_argument("--noise-frames", type=int, default=1000)
    ap.add_argument("--sample-rate", type=float, default=1e6)
    ap.add_argument("--band-lo", type=float, default=-1e5)
    ap.add_argument("--band-hi", type=float, default=1e5)
    ap.add_argument("--pfa", type=float, default=1e-2)
    ap.add_argument("--mode", choices=("probe", "sliding", "features"), default="probe")
    ap.add_argument("--seed2", type=int, default=20260913, help="features：门控噪声突发的种子")
    ap.add_argument("--window-frames", type=int, default=256, help="sliding：环长 W")
    ap.add_argument("--merge-gap", type=int, default=2, help="sliding：突发合并空隙")
    ap.add_argument("--tone-offset", type=float, default=50e3, help="sliding：单音频偏 Hz")
    ap.add_argument("--tone-amplitude", type=float, default=0.75, help="sliding：单音幅度（线性）")
    ap.add_argument("--tone-start-frame", type=int, default=1500)
    ap.add_argument("--tone-stop-frame", type=int, default=2500)
    args = ap.parse_args(argv)

    n = args.frames * args.nfft
    rng = Xoshiro256pp(args.seed)
    x = np.empty(n, dtype=np.complex64)
    for i in range(n):
        x[i] = rng.complex_normal()

    band = ed.Band(args.band_lo, args.band_hi)
    mask = band.mask(args.nfft, args.sample_rate)
    m_bins = int(np.count_nonzero(mask))
    eta = ed.threshold_for_pfa(m_bins, args.pfa)

    if args.mode == "sliding":
        return write_sliding(args, x, mask, m_bins, eta)
    if args.mode == "features":
        return write_features(args, x, mask, m_bins, eta)

    power = ed.frame_bin_power(x, args.nfft)
    # 引擎按「先攒够 noise_frames 帧估噪声，再判决全部帧（含探针帧）」的顺序处理，
    # 这里照同样的顺序算，否则对拍的就不是同一件事
    noise = ed.estimate_noise_per_bin(power[:args.noise_frames])
    noise_band = float(noise[mask].sum())
    lam = power[:, mask].sum(axis=1) / noise_band
    hits = int(np.count_nonzero(lam > eta))
    borderline = int(np.count_nonzero(np.abs(lam / eta - 1.0) < 1e-5))

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧能量检测器与 algos/reference/energy_detector.py 的对拍基准",
        "generator": "algos/reference/gen_engine_golden.py",
        "params": {
            "seed": args.seed, "nfft": args.nfft, "frames": args.frames,
            "noise_frames": args.noise_frames, "sample_rate_Hz": args.sample_rate,
            "band_lo_Hz": args.band_lo, "band_hi_Hz": args.band_hi, "pfa": args.pfa,
            "noise_power": 1.0,
        },
        "tolerance": {
            "threshold_rel": 1e-9,
            "statistic_rel": 1e-5,
            "note": "门限两侧同为 float64 同算法，按黄金基准口径 1e-9；"
                    "逐帧检测量受引擎内部 float32 影响，按 1e-5；判决须逐帧一致",
        },
        "expected": {
            "m_bins": m_bins,
            "threshold": eta,
            "noise_band": noise_band,
            "frames": int(lam.size),
            "hits": hits,
            "hit_rate": hits / float(lam.size),
            "borderline_frames": borderline,
            "lambda_mean": float(lam.mean()),
            "lambda_max": float(lam.max()),
            "first_statistics": [float(v) for v in lam[:16]],
            "last_statistics": [float(v) for v in lam[-4:]],
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    e = doc["expected"]
    print(f"已写 {args.out}")
    print(f"  频点 {e['m_bins']}，门限 {e['threshold']:.12f}，帧 {e['frames']}，"
          f"命中 {e['hits']}（{e['hit_rate']:.4f}，目标 {args.pfa}）")
    print(f"  Λ 均值 {e['lambda_mean']:.6f}，最大 {e['lambda_max']:.4f}，"
          f"卡在门限附近的帧 {e['borderline_frames']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
