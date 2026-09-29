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


# --- 带限噪声（C-8 / G-6，D-069）--------------------------------------------
#
# 与 engine/src/dsp.cpp 的 butterworth_lp4 / biquad2_step / impulse_power_gain 逐字同序。
# 递推那三行是契约，改一个加号就是基准变化（铁律 10）。

def butterworth_lp4(fc_Hz: float, fs_Hz: float):
    """4 阶巴特沃斯低通的两节双二阶系数（双线性 + 频率预畸变）。"""
    q = (0.76536686473017956, 1.8477590650225735)   # 2·sin((2i+1)·π/8)
    K = math.tan(math.pi * fc_Hz / fs_Hz)
    K2 = K * K
    out = []
    for i in range(2):
        D = 1.0 + q[i] * K + K2
        out.append({"b0": K2 / D, "b1": 2.0 * K2 / D, "b2": K2 / D,
                    "a1": 2.0 * (K2 - 1.0) / D, "a2": (1.0 - q[i] * K + K2) / D})
    return out


def biquad2_step(f, state, x):
    """转置直接 II 型。三行的次序与 C++ 逐字相同。state 是 4 个复数，原地更新。"""
    for i in range(2):
        y = f[i]["b0"] * x + state[2 * i]
        state[2 * i] = f[i]["b1"] * x - f[i]["a1"] * y + state[2 * i + 1]
        state[2 * i + 1] = f[i]["b2"] * x - f[i]["a2"] * y
        x = y
    return x


def impulse_power_gain(f):
    """Σ|h[n]|² 与稳定所需样点数；判据「连续 16 个样点 h² ≤ 1e-20·acc」，上限 2^22。"""
    state = [0j] * 4
    acc = 0.0
    quiet = 0
    for n in range(1 << 22):
        x = 1.0 + 0j if n == 0 else 0j
        y = biquad2_step(f, state, x)
        p = y.real * y.real
        acc += p
        if n >= 16 and p <= 1e-20 * acc:
            quiet += 1
            if quiet >= 16:
                return acc, n + 1
        else:
            quiet = 0
    raise SystemExit("带限滤波器的冲激响应没有收敛")


def write_scene_noise(args) -> int:
    """SceneEmitterSource 的 noise 分支：带限 + 单位功率归一 + 频率搬移。"""
    fs, fc = args.sn_fs, args.sn_bw / 2.0
    f = butterworth_lp4(fc, fs)
    gain, settle = impulse_power_gain(f)
    g = 1.0 / math.sqrt(gain)

    rng = Xoshiro256pp(args.sn_seed)
    state = [0j] * 4
    warm = min(settle, 1 << 16)          # init() 里丢掉的冷启动瞬态，与 C++ 同法
    for _ in range(warm):
        z = rng.complex_normal()
        biquad2_step(f, state, complex(z.real, z.imag))

    n = args.sn_samples
    two_pi = 2.0 * math.pi
    dphi = two_pi * args.sn_offset / fs
    phase = 0.0
    out = np.empty(n, dtype=np.complex64)
    for i in range(n):
        z = rng.complex_normal()
        y = biquad2_step(f, state, complex(z.real, z.imag))
        zr, zi = y.real * g, y.imag * g
        c, sp = math.cos(phase), math.sin(phase)
        out[i] = np.complex64(complex(np.float32(zr * c - zi * sp), np.float32(zr * sp + zi * c)))
        phase += dphi
        if phase >= two_pi:
            phase -= two_pi
        elif phase < 0.0:
            phase += two_pi

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧 SceneEmitterSource 的 noise 带限与频率搬移对拍基准（C-8 / G-6，D-069）",
        "generator": "algos/reference/gen_engine_golden.py --mode scene_noise",
        "params": {"fs_Hz": fs, "bw_Hz": args.sn_bw, "offset_Hz": args.sn_offset,
                   "seed": args.sn_seed, "samples": n},
        "tolerance": {"coeff_rel": 1e-9, "gain_rel": 1e-9, "sample_rel": 1e-6,
                      "note": "系数与功率增益两侧都是 float64 同算法同序；逐样点因引擎存 complex64 放到 1e-6"},
        "filter": {"sections": f, "power_gain": gain, "n_settle": settle,
                   "gain_norm": g},
        "samples": [[float(v.real), float(v.imag)] for v in out],
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"写出 {args.out}：{n} 个样点，功率增益 {gain:.12g}，稳定 {settle} 个样点")
    return 0


def write_ddc(args) -> int:
    """DDC：数控振荡混频 + 抗混叠低通 + 抽取（04 §7.7；M-2，D-070）。

    输入不入二进制夹具，由种子按配方复现，两侧各存一份 sha256 对账（同 probe / sliding 的做法）。
    配方三项按固定次序相加，float32 逐步舍入，与引擎侧的 Complex(float) 加法逐位一致：
        噪声（xoshiro256++ complex_normal）+ 通带单音 + 门控的阻带单音
    """
    import hashlib
    import struct
    import ddc as ddc_ref

    fs = args.ddc_fs
    n = args.ddc_samples

    rng = Xoshiro256pp(args.ddc_seed)
    noise = np.empty(n, dtype=np.complex64)
    for i in range(n):
        noise[i] = rng.complex_normal()
    t_pass = tone_burst(n, fs, args.ddc_tone_pass, args.ddc_tone_amp, 0, 0)
    t_stop = tone_burst(n, fs, args.ddc_tone_stop, args.ddc_tone_amp,
                        args.ddc_gate_start, args.ddc_gate_stop)
    x = (noise + t_pass + t_stop).astype(np.complex64)

    raw = b"".join(struct.pack("<ff", float(v.real), float(v.imag)) for v in x)
    in_sha = hashlib.sha256(raw).hexdigest()

    with open(os.path.join(ddc_ref._ROOT, ddc_ref.TABLE_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()
    tab = ddc_ref.load_table()

    cases = [("d1", 1, args.ddc_shift), ("d2", 2, args.ddc_shift),
             ("d4", 4, args.ddc_shift), ("d20", 20, 0.0)]
    keep = args.ddc_keep
    expected = {}
    for cid, d, shift in cases:
        y = ddc_ref.run(x, d, shift, fs, block=4096, table=tab)
        gd = tab[d]["group_delay"]
        want = (n - 1 - gd) // d + 1 if n > gd else 0
        assert y.size == want, (cid, y.size, want)
        energy = float(np.sum(np.abs(y.astype(np.complex128)) ** 2))
        expected[cid] = {
            "decim": d,
            "f_shift_Hz": shift,
            "sample_rate_out_Hz": fs / d,
            "group_delay_in": gd,
            "ntaps": tab[d]["ntaps"],
            "n_out": int(y.size),
            "n_out_formula": f"({n} - 1 - {gd}) // {d} + 1",
            "tail_dropped_in": int(n - ((y.size - 1) * d + gd + 1)) if y.size else n,
            "energy_out": energy,
            "head": [[float(v.real), float(v.imag)] for v in y[:keep]],
            "tail": [[float(v.real), float(v.imag)] for v in y[-16:]],
        }

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧 DDC 与 algos/reference/ddc.py 的对拍基准（M-2，D-070）；"
                   "三方互证的第二实现一方，MATLAB 一方在 ddc.matlab.json（可选）",
        "generator": "algos/reference/gen_engine_golden.py --mode ddc",
        "fir": {
            "version": "lp_v1",
            "table_source": ddc_ref.TABLE_REL.replace(os.sep, "/"),
            "table_sha256": table_sha,
            "entries": {str(d): {"ntaps": tab[d]["ntaps"],
                                 "group_delay_in": tab[d]["group_delay"],
                                 "half": [float(v) for v in tab[d]["h"][: (tab[d]["ntaps"] + 1) // 2]]}
                        for _, d, _ in cases},
        },
        "params": {
            "sample_rate_Hz": fs,
            "seed": args.ddc_seed,
            "samples": n,
            "tone_passband_Hz": args.ddc_tone_pass,
            "tone_stopband_Hz": args.ddc_tone_stop,
            "tone_amplitude": args.ddc_tone_amp,
            "gate_start": args.ddc_gate_start,
            "gate_stop": args.ddc_gate_stop,
            "keep_head": keep,
            "recipe": "x[i] = complex_normal() + tone(f_pass) + tone(f_stop, 门控 [gate_start, gate_stop))，"
                      "三项按此次序相加、每步 float32；tone 与引擎 ToneSource 同式（相位按绝对样点号闭式算）",
        },
        "input": {
            "sha256_f32_interleaved": in_sha,
            "head": [[float(v.real), float(v.imag)] for v in x[:64]],
        },
        "expected": {"python": expected},
        "tolerance": {
            "coeff_rel": 0.0,
            "sample_rel": 1e-6,
            "energy_rel": 1e-9,
            "scalar_exact": ["n_out", "group_delay_in", "ntaps", "tail_dropped_in",
                             "sample_rate_out_Hz"],
            "note": "系数是同一份冻结表，必须逐位相同（coeff_rel = 0）。逐样点放到 1e-6："
                    "两侧都是 float64 同算法同序，唯一的分歧是 cos/sin 的末位（各家 libm 不是正确舍入），"
                    "而输出按 docs/iq-format.md 存成 complex64，float32 的 eps 就是 1.2e-7——"
                    "这是存储精度的下限，不是放宽铁律 10。",
        },
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"写出 {args.out}：{n} 个输入样点，{len(cases)} 个算例，"
          f"表 sha256 {table_sha[:16]}…，输入 sha256 {in_sha[:16]}…")
    return 0


def _m3_input(seed: int, n: int, fs: float, tones) -> "np.ndarray":
    """M-3 两个模式共用的输入配方：噪声 + 若干单音，按次序相加、每步 float32。

    **输入不由两侧各自算闭式，而是由复刻的整数随机源生成、再存一份 sha256 对账**
    （同 probe / sliding / ddc 的做法）。理由在 M-3 第 5 步踩实过一次：让两边各自算
    `sin(0.00021·n² − 0.07·n + 0.9)` 这样的闭式，clang 在 -O2 下会把多项式收缩成 FMA，
    相位差 4.5e-13；而这两个值恰好骑在一个 float32 舍入边界的两侧，存成 float32 后差
    一整个 ulp（1.5e-8），再经滤波器数千倍的相消放大成 1.5e-9，看着就像算法不一致。
    共享输入必须共享**比特**，不能共享**公式**。
    """
    rng = Xoshiro256pp(seed)
    x = np.empty(n, dtype=np.complex64)
    for i in range(n):
        x[i] = rng.complex_normal()
    for f, amp, g0, g1 in tones:
        x = (x + tone_burst(n, fs, f, amp, g0, g1)).astype(np.complex64)
    return x


def _m3_head_tail(y, keep: int):
    return ([[float(v.real), float(v.imag)] for v in y[:keep]],
            [[float(v.real), float(v.imag)] for v in y[-16:]])


def write_channelizer(args) -> int:
    """多相 FFT 信道化（04 §7.7、§15.2 算例 8；M-3，D-071）。

    两个尺度、两份期望，刻意分开（这是 M-3 规划期核出来的一条）：

      * `expected.python` 是**组件**尺度：输出按 docs/iq-format.md 存 complex64，
        判据 1e-6 —— 引擎的 cuav::Complex 就是 float32，eps 1.2e-7，这是存储精度的下限。
      * `kernel_check` 是**算法核**尺度：给出若干条显式窗口（double），MATLAB 与 Coder 产物
        对同一批窗口各算一遍，判据才是 06 §9D 写的 1e-9。拿组件输出去套 1e-9 是套不上的，
        那不是算法不准，是 float32 存不下。

    窗口作为**显式数据**写进黄金文件，三方谁也不再各自算一遍公式。
    """
    import hashlib
    import struct
    import channelizer as ch_ref

    fs = args.chan_fs
    n = args.chan_samples
    tab = ch_ref.load_table()

    # 三个单音：分别落在低、中、高三个不同的子信道中心附近，且都不在同一路上
    tones = [(args.chan_tone1, args.chan_tone_amp, 0, 0),
             (args.chan_tone2, args.chan_tone_amp, 0, 0),
             (args.chan_tone3, args.chan_tone_amp, args.chan_gate_start, args.chan_gate_stop)]
    x = _m3_input(args.chan_seed, n, fs, tones)
    raw = b"".join(struct.pack("<ff", float(v.real), float(v.imag)) for v in x)
    in_sha = hashlib.sha256(raw).hexdigest()

    with open(os.path.join(ch_ref._ROOT, ch_ref.TABLE_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()

    # (子信道数, 界面编号)。取到带边那一路（j = 0）与零频那一路（j = M/2），两端都盖到
    cases = [("m4_j1", 4, 1), ("m4_j2", 4, 2), ("m8_j0", 8, 0), ("m8_j5", 8, 5), ("m16_j8", 16, 8)]
    keep = args.chan_keep
    expected = {}
    for cid, m, j in cases:
        y = ch_ref.run(x, m, j, block=4096, table=tab)
        e = tab[m]
        gd = e["group_delay"]
        want = (n - 1 - gd) // m + 1 if n > gd else 0
        assert y.size == want, (cid, y.size, want)
        head, tail = _m3_head_tail(y, keep)
        expected[cid] = {
            "channels": m,
            "select_channel": j,
            "raw_bin": ch_ref.raw_bin(j, m),
            "sample_rate_out_Hz": fs / m,
            "center_offset_Hz": ch_ref.center_offset_Hz(j, m, fs),
            "group_delay_in": gd,
            "ntaps": e["ntaps"],
            "pad_to": e["pad_to"],
            "n_out": int(y.size),
            "n_out_formula": f"({n} - 1 - {gd}) // {m} + 1",
            "tail_dropped_in": int(n - ((y.size - 1) * m + gd + 1)) if y.size else n,
            "energy_out": float(np.sum(np.abs(y.astype(np.complex128)) ** 2)),
            "head": head,
            "tail": tail,
        }

    # 算法核尺度：显式窗口 + 全部 M 路的 double 输出
    kc = []
    for m in args.chan_kernel_channels:
        e = tab[m]
        P = e["pad_to"]
        hr = [float(v) for v in e["h"][::-1]]
        for w_idx, m_out in enumerate(args.chan_kernel_outputs):
            p = m_out * m + e["group_delay"]
            win = []
            for t in range(P):
                k = p - P + 1 + t
                v = x[k] if 0 <= k < n else np.complex64(0)
                win.append([float(v.real), float(v.imag)])
            # 直接式逐路算一遍（double），不走多相
            wv = np.array([complex(a, b) for a, b in win], dtype=np.complex128)
            hh = e["h"]
            out = []
            for kbin in range(m):
                acc = 0.0 + 0.0j
                nn = np.arange(P, dtype=np.float64)
                acc = np.sum(hh * wv[::-1] * np.exp(2j * math.pi * kbin * nn / m))
                acc *= np.exp(-2j * math.pi * kbin * p / m)
                out.append([float(acc.real), float(acc.imag)])
            kc.append({
                "channels": m,
                "m_out": m_out,
                "p_in": p,
                "pad_to": P,
                "taps_reversed": hr,
                "window_forward": win,
                "expected_bins": out,
            })

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧 Channelizer 与 algos/reference/channelizer.py 的对拍基准（M-3，D-071）；"
                   "三方互证的第二实现一方，MATLAB 一方在 channelizer.matlab.json",
        "generator": "algos/reference/gen_engine_golden.py --mode channelizer",
        "fir": {
            "version": "pfb_v1",
            "table_source": ch_ref.TABLE_REL.replace(os.sep, "/"),
            "table_sha256": table_sha,
        },
        "params": {
            "sample_rate_Hz": fs,
            "seed": args.chan_seed,
            "samples": n,
            "tones_Hz": [args.chan_tone1, args.chan_tone2, args.chan_tone3],
            "tone_amplitude": args.chan_tone_amp,
            "gate_start": args.chan_gate_start,
            "gate_stop": args.chan_gate_stop,
            "keep_head": keep,
            "recipe": "x[i] = complex_normal() + tone1 + tone2 + tone3（第三个门控），"
                      "按此次序相加、每步 float32；tone 与引擎 ToneSource 同式",
        },
        "input": {
            "sha256_f32_interleaved": in_sha,
            "head": [[float(v.real), float(v.imag)] for v in x[:64]],
        },
        "expected": {"python": expected},
        "kernel_check": kc,
        "tolerance": {
            "coeff_rel": 0.0,
            "sample_rel": 1e-6,
            "energy_rel": 1e-9,
            "kernel_rel": 1e-9,
            "scalar_exact": ["n_out", "group_delay_in", "ntaps", "pad_to", "raw_bin",
                             "tail_dropped_in", "sample_rate_out_Hz"],
            "note": "两个尺度分开：expected.python 是组件尺度，输出存 complex64，"
                    "float32 的 eps 就是 1.2e-7，所以 sample_rel = 1e-6（存储精度的下限，"
                    "不是放宽铁律 10）；kernel_check 是算法核尺度，double 进 double 出，"
                    "判据才是 06 §9D 的 1e-9。拿组件输出去套 1e-9 套不上，那不是算法不准。",
        },
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"写出 {args.out}：{n} 个输入样点，{len(cases)} 个算例，{len(kc)} 条核对窗口，"
          f"表 sha256 {table_sha[:16]}…，输入 sha256 {in_sha[:16]}…")
    return 0


def write_rx_filter(args) -> int:
    """接收滤波（04 §7.5、§15.2 算例 5；M-3，D-071）。

    组件尺度的输出（群时延已扣除）+ 算法核尺度的显式块（因果输出，群时延未扣）。
    两者差的正好是封装层要扣掉的那 gd 个样点，黄金文件把两边都记下来，
    「扣没扣」于是成为可核对的事实而不是约定。
    """
    import hashlib
    import struct
    import rx_filter as rx_ref

    fs = args.rx_fs
    n = args.rx_samples
    tab = rx_ref.load_table()

    tones = [(args.rx_tone_pass, args.rx_tone_amp, 0, 0),
             (args.rx_tone_stop, args.rx_tone_amp, args.rx_gate_start, args.rx_gate_stop)]
    x = _m3_input(args.rx_seed, n, fs, tones)
    raw = b"".join(struct.pack("<ff", float(v.real), float(v.imag)) for v in x)
    in_sha = hashlib.sha256(raw).hexdigest()

    with open(os.path.join(rx_ref._ROOT, rx_ref.TABLE_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()

    keep = args.rx_keep
    expected = {}
    for r in args.rx_bw_rels:
        e = rx_ref.lookup(tab, r)
        assert e is not None, r
        y = rx_ref.run(x, r, block=4096, table=tab)
        gd = e["group_delay"]
        assert y.size == n - gd, (r, y.size, n - gd)
        head, tail = _m3_head_tail(y, keep)
        expected[f"bw{int(round(r * 100))}"] = {
            "bw_rel": r,
            "ntaps": e["ntaps"],
            "group_delay_in": gd,
            "n_out": int(y.size),
            "n_out_formula": f"{n} - {gd}",
            "energy_out": float(np.sum(np.abs(y.astype(np.complex128)) ** 2)),
            "head": head,
            "tail": tail,
        }

    # 算法核尺度：一整块因果输出，群时延**未**扣除；抽头零填充到表内最大抽头数
    nmax = max(e["ntaps"] for e in tab.values())
    kc = []
    for r in args.rx_kernel_bw_rels:
        e = rx_ref.lookup(tab, r)
        L = args.rx_kernel_block
        h_pad = [float(v) for v in e["h"]] + [0.0] * (nmax - e["ntaps"])
        blk = x[:L].astype(np.complex128)
        hh = np.asarray(h_pad, dtype=np.float64)
        caus = np.convolve(blk, hh)[:L]           # zi = 0 的因果输出
        kc.append({
            "bw_rel": r,
            "ntaps": e["ntaps"],
            "ntaps_padded": nmax,
            "group_delay_in": e["group_delay"],
            "block": L,
            "taps_padded": h_pad,
            "input_block": [[float(v.real), float(v.imag)] for v in blk],
            "expected_causal": [[float(v.real), float(v.imag)] for v in caus],
            "note": "因果输出，群时延未扣；峰值在 n0 + gd。封装层丢掉最前面 gd 个，"
                    "于是输出样点 m 对应输入样点 m（08 §8 口径二）。"
                    "输入块是**显式数据**（float32 精确可表示，JSON 往返无损），"
                    "三方谁也不再各自跑一遍随机源 —— 共享输入必须共享比特不能共享公式。",
        })

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧 RxFilter 与 algos/reference/rx_filter.py 的对拍基准（M-3，D-071）；"
                   "三方互证的第二实现一方，MATLAB 一方在 rx_filter.matlab.json",
        "generator": "algos/reference/gen_engine_golden.py --mode rx_filter",
        "fir": {
            "version": "rx_v1",
            "table_source": rx_ref.TABLE_REL.replace(os.sep, "/"),
            "table_sha256": table_sha,
        },
        "params": {
            "sample_rate_Hz": fs,
            "seed": args.rx_seed,
            "samples": n,
            "tone_passband_Hz": args.rx_tone_pass,
            "tone_stopband_Hz": args.rx_tone_stop,
            "tone_amplitude": args.rx_tone_amp,
            "gate_start": args.rx_gate_start,
            "gate_stop": args.rx_gate_stop,
            "keep_head": keep,
            "recipe": "x[i] = complex_normal() + tone(f_pass) + tone(f_stop, 门控)，"
                      "按此次序相加、每步 float32；tone 与引擎 ToneSource 同式",
        },
        "input": {
            "sha256_f32_interleaved": in_sha,
            "head": [[float(v.real), float(v.imag)] for v in x[:64]],
        },
        "expected": {"python": expected},
        "kernel_check": kc,
        "tolerance": {
            "coeff_rel": 0.0,
            "sample_rel": 1e-6,
            "energy_rel": 1e-9,
            "kernel_rel": 1e-9,
            "scalar_exact": ["n_out", "group_delay_in", "ntaps"],
            "note": "同 channelizer：组件尺度 1e-6（complex64 的存储下限），算法核尺度 1e-9。",
        },
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"写出 {args.out}：{n} 个输入样点，{len(expected)} 个算例，{len(kc)} 条核对块，"
          f"表 sha256 {table_sha[:16]}…，输入 sha256 {in_sha[:16]}…")
    return 0


def write_ofdm(args) -> int:
    """原生采样率 OFDM 调制（Q-2，D-088）：algos/reference/ofdm_ref.py 与引擎 ofdm.cpp 的对拍。

    只做**算法核尺度**（double 进 double 出，判据 1e-9，同 D-071 ③）。每个算例存若干个符号：
    子载波值（显式数据，MATLAB 一方直接读它做 ofdmmod）与该符号带 CP 的时域样点。
    子载波值本身由整数随机源定出（Xoshiro 的 next_u64 → 电平表），三方共享的是比特。
    """
    import hashlib
    import ofdm_ref

    doc_p = ofdm_ref.load_presets()
    with open(os.path.join(ofdm_ref._ROOT, ofdm_ref.PRESETS_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()

    plan = [("dji-droneid", 0, [3, 8]), ("dji-uplink-2m", 0, [0, 1]),
            ("dji-video-10m", 0, [1]), ("dji-video-20m-a", 0, [2])]
    cases = []
    for pid, variant, syms in plan:
        p = ofdm_ref.Preset(doc_p, pid)
        y, carriers = ofdm_ref.burst(p, variant, args.ofdm_seed, want_carriers=True)
        cps = p.bursts[variant]["cp"]
        symbols = []
        for s in syms:
            start = sum(p.fft + c for c in cps[:s])
            seg = y[start: start + cps[s] + p.fft]
            symbols.append({
                "symbol": s,
                "start": start,
                "cp": cps[s],
                "zc_root": p.bursts[variant]["zc"][s],
                "carriers": [[c.real, c.imag] for c in carriers[s]],
                "samples": [[float(v.real), float(v.imag)] for v in seg],
            })
        cases.append({
            "preset": pid, "variant": variant, "seed": args.ofdm_seed,
            "fft_size": p.fft, "half_subcarriers": p.K, "gain": p.gain,
            "burst_length": int(len(y)), "symbols": symbols,
        })

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "原生采样率 OFDM 调制的对拍基准（Q-2，D-088）：引擎 engine/src/ofdm.cpp 对 "
                   "algos/reference/ofdm_ref.py（numpy ifft）；MATLAB 一方读本文件的子载波值做 ofdmmod，"
                   "写 ofdm.matlab.json",
        "generator": "algos/reference/gen_engine_golden.py --mode ofdm",
        "presets": {"source": ofdm_ref.PRESETS_REL.replace(os.sep, "/"), "sha256": table_sha},
        "contract": "子载波 k = -K..-1,+1..+K；数据：每突发 Xoshiro256pp(seed)，逐数据符号逐子载波一个 next_u64，"
                    "低 b 位给 I、再往上 b 位给 Q；ZC 删去中间一项；x[n] = g·Σ X_k·e^{+j2πkn/N}，g = 1/√(2K)；"
                    "先 CP（符号尾部）再符号本体",
        "cases": cases,
        "tolerance": {
            "kernel_rel": 1e-9,
            "note": "max|差| / 该符号样点的均方根；carriers 须逐位相同（整数随机源 + 同一电平表）",
        },
    }
    # 一对 [实, 虚] 占一行：indent=1 会把两万多个数各占一行，文件翻倍而 diff 更难读
    arrays = {}
    for ci, c in enumerate(cases):
        for si, sym in enumerate(c["symbols"]):
            for key in ("carriers", "samples"):
                tag = f"@@{ci}_{si}_{key}@@"
                arrays[tag] = sym[key]
                sym[key] = tag
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    for tag, pairs in arrays.items():
        body = ",\n".join(json.dumps(pr) for pr in pairs)
        text = text.replace(json.dumps(tag), "[\n" + body + "\n]", 1)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
    print(f"写出 {args.out}：{len(cases)} 个算例，预设表 sha256 {table_sha[:16]}…")
    return 0


def write_rsmp(args) -> int:
    """OFDM 有理重采样（Q-2，D-088）：Coder 核 + 封装 对 algos/reference/resampler.py（直接型）。

    两部分，都是 double 进 double 出（算法核尺度，判据 1e-9）：
      kernel_check：每个抽取比 M 一拍，窗口是显式数据（Xoshiro 的复正态，逐项写进文件），
                    期望输出由直接型算出。MATLAB 一方读同一个窗口。
      burst：一个真实的上行 OFDM 突发（dji-uplink-2m，原生 15.36 MS/s）放在原生序号 n0 处，
             M = 24 重采样到 80 MS/s，存支撑开头与结尾两段输出。
    """
    import hashlib
    import ofdm_ref
    import resampler as rs

    tab = rs.load_table()
    with open(os.path.join(rs._ROOT, rs.TABLE_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()
    L, T = tab["L"], tab["T"]
    rng = Xoshiro256pp(args.rsmp_seed)
    kc = []
    for M in tab["M"]:
        c = 3
        win = np.array([complex(rng.normal(), rng.normal()) for _ in range(M + T)])
        y = rs.window_cycle(win, M, c, tab)
        kc.append({"M": M, "cycle": c, "window_start": c * M - T // 2,
                   "window": [[v.real, v.imag] for v in win],
                   "expected": [[v.real, v.imag] for v in y]})

    doc_p = ofdm_ref.load_presets()
    p = ofdm_ref.Preset(doc_p, "dji-uplink-2m")
    x = ofdm_ref.burst(p, 0, args.rsmp_seed)
    n0 = args.rsmp_burst_start
    M = 24
    m_lo = -((-(n0 * L - tab["gd"])) // M)              # 支撑的保守下界：ceil((n0·L − gd)/M)
    m_hi = ((n0 + x.size + T) * L - tab["gd"] - 1) // M + 1   # 窗口仍碰到最后一个原生样点的最后一个 m，再 +1
    head = rs.resample(x, n0, M, m_lo, m_lo + args.rsmp_keep, tab)
    tail = rs.resample(x, n0, M, m_hi - args.rsmp_keep, m_hi, tab)
    burst = {"preset": "dji-uplink-2m", "variant": 0, "seed": args.rsmp_seed, "native_start": n0,
             "native_length": int(x.size), "M": M, "support": [m_lo, m_hi],
             "head_start": m_lo, "head": [[v.real, v.imag] for v in head],
             "tail_start": m_hi - args.rsmp_keep, "tail": [[v.real, v.imag] for v in tail]}

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "OFDM 有理重采样的对拍基准（Q-2，D-088）：Coder 核（models/radiator/coder/）+ 封装 "
                   "engine/src/resampler.cpp 对 algos/reference/resampler.py（直接型）；"
                   "MATLAB 一方读 kernel_check 的窗口，写 rsmp.matlab.json",
        "generator": "algos/reference/gen_engine_golden.py --mode rsmp",
        "fir": {"version": "rsmp_v1", "table_source": rs.TABLE_REL.replace(os.sep, "/"), "table_sha256": table_sha},
        "time_anchor": "站点样点 m ↔ 原型序号 m·M + gd（gd = L·T/2），即原生时刻 m·M/L；窗口 = 原生 c·M − T/2 起 M+T 个",
        "kernel_check": kc,
        "burst": burst,
        "tolerance": {"kernel_rel": 1e-9,
                      "note": "max|差| / 期望值的均方根；double 进 double 出，不承诺逐位（两侧累加次序不同）"},
    }
    arrays = {}
    for i, e in enumerate(kc):
        for key in ("window", "expected"):
            tag = f"@@k{i}_{key}@@"
            arrays[tag] = e[key]
            e[key] = tag
    for key in ("head", "tail"):
        tag = f"@@b_{key}@@"
        arrays[tag] = burst[key]
        burst[key] = tag
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    for tag, pairs in arrays.items():
        text = text.replace(json.dumps(tag), "[\n" + ",\n".join(json.dumps(pr) for pr in pairs) + "\n]", 1)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
    print(f"写出 {args.out}：{len(kc)} 拍核对、突发支撑 {m_hi - m_lo} 个站点样点，表 sha256 {table_sha[:16]}…")
    return 0


def write_ofdm_frame(args) -> int:
    """帧排布（Q-2，D-088 ⑤）：geo/src/ofdm_frame.cpp 对 algos/reference/ofdm_ref.py 的 frame_bursts()。

    每个预设铺 N 个时隙，整张突发表按「slot,start_n,variant」逐行拼成文本取 sha256——两侧逐位相同
    才对得上（全是整数与一次 double 比较，不存在容差）。另存前 40 条便于看出错在哪，以及统计量
    （占空、每秒突发数、长突发占比、间隔分位数）供模型卡与实测对照。
    """
    import hashlib
    import ofdm_ref

    doc_p = ofdm_ref.load_presets()
    with open(os.path.join(ofdm_ref._ROOT, ofdm_ref.PRESETS_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()
    cases = []
    for p in doc_p["presets"]:
        pre = ofdm_ref.Preset(doc_p, p["id"])
        slot_n = int(round(p["frame"]["slot_s"] * pre.fs))
        for emitter_id, offset_n in (("uav-1", 0), ("uav-2", 7 * slot_n // 3)):
            n_slots = args.frame_slots if p["frame"]["slot_s"] < 0.1 else 2000
            end_n = offset_n + n_slots * slot_n
            bs = ofdm_ref.frame_bursts(doc_p, p["id"], args.frame_seed, emitter_id, offset_n, end_n)
            text = "".join(f"{k},{s},{v}\n" for k, s, _, v in bs)
            span_s = (end_n - offset_n) / pre.fs
            on = sum(b[2] for b in bs)
            iv = np.diff([b[1] for b in bs]) / pre.fs * 1e3 if len(bs) > 1 else np.array([0.0])
            longs = sum(1 for b in bs if b[3] == 1) if len(pre.bursts) > 1 else 0
            cases.append({
                "preset": p["id"], "emitter_id": emitter_id, "seed": args.frame_seed,
                "offset_n": offset_n, "end_n": end_n, "slots": n_slots,
                "n_bursts": len(bs), "sha256_lines": hashlib.sha256(text.encode("ascii")).hexdigest(),
                "first": [[k, s, v] for k, s, _, v in bs[:40]],
                "stats": {
                    "duty": on / (end_n - offset_n),
                    "bursts_per_s": len(bs) / span_s,
                    "long_share": longs / len(bs) if bs else None,
                    "interval_ms_quantiles": {q: float(np.quantile(iv, float(q) / 100)) for q in ("10", "25", "50", "75", "90")},
                },
            })
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "OFDM 帧排布的对拍基准（Q-2，D-088 ⑤）：geo/src/ofdm_frame.cpp 对 algos/reference/ofdm_ref.py",
        "generator": "algos/reference/gen_engine_golden.py --mode ofdm_frame",
        "presets": {"source": ofdm_ref.PRESETS_REL.replace(os.sep, "/"), "sha256": table_sha},
        "line_format": "每个突发一行 \"slot,start_n,variant\\n\"（十进制、无空格），整张表拼接后取 sha256",
        "cases": cases,
        "tolerance": {"exact": True, "note": "全是整数与同一条比较，逐位相同，没有容差"},
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    for c in cases:
        st = c["stats"]
        print(f"{c['preset']:<16} {c['emitter_id']}：{c['n_bursts']:>6} 个突发、占空 {st['duty']:.4f}、"
              f"{st['bursts_per_s']:.1f} 次/秒、长突发占比 {st['long_share']}、间隔中位 {st['interval_ms_quantiles']['50']:.3f} ms")
    return 0


def write_scene_ofdm(args) -> int:
    """SceneEmitterSource 的 OFDM 路径（Q-2，D-088）：组件尺度的对拍基准（complex64，判据 1e-6）。

    整条路径逐步复刻，与引擎共享的只有比特（预设表、系数表、种子）：
      帧排布 ofdm_ref.frame_bursts → 突发载荷种子 mix64(key ^ mix64(时隙)) → 原生调制 ofdm_ref.burst
      → 直接型重采样（resampler.py 的公式，放到全局原生序列上）→ 单位功率补偿 1/√c
      → 相位累加器（弧度、逐样点加、单次回卷）→ float32。
    场景是 engine/tests/fixtures/ofdm-emitter.scenario.json 的 video 辐射源（10 MHz 图传、偏 +1.3 MHz、
    无活动）；共享随机流 Xoshiro256pp(7) 取一个数建私有子流，私有子流再取一个数作载荷键——与单测同式。
    """
    import ofdm_ref
    import resampler as rs

    doc_p = ofdm_ref.load_presets()
    pid, eid, sc_seed = "dji-video-10m", "video", 20260929
    fs, fc, f_em = 80e6, 2.44e9, 2.4413e9
    N = args.so_samples
    tab = rs.load_table()
    L, T, gd, h = tab["L"], tab["T"], tab["gd"], tab["h"]
    M = 24
    p = ofdm_ref.Preset(doc_p, pid)
    sub_seed = Xoshiro256pp(7).next_u64()
    key = Xoshiro256pp(sub_seed).next_u64()
    end_n = N * M // L + T + 2
    bursts = ofdm_ref.frame_bursts(doc_p, pid, sc_seed, eid, 0, end_n)
    native = np.zeros(end_n + 200000, dtype=np.complex128)
    for (slot, start, length, v) in bursts:
        seed = ofdm_ref.mix64(key ^ ofdm_ref.mix64(slot))
        native[start:start + length] = ofdm_ref.burst(p, v, seed)
    # 单位功率常数：滤波器在各子载波频点 |H/L|² 的均值（与引擎同一累加次序）
    acc = 0.0
    for i in range(2 * p.K):
        f = p.k_of(i) / p.fft
        H = 0j
        for n in range(h.size):
            ang = -2.0 * math.pi * f * n / L
            H += h[n] * complex(math.cos(ang), math.sin(ang))
        acc += (H.real * H.real + H.imag * H.imag) / (L * L)
    c = acc / (2 * p.K)
    gain = 1.0 / math.sqrt(c)
    sup = []
    for (slot, start, length, v) in bursts:
        a = start * L - gd
        m_lo = (a + M - 1) // M if a >= 0 else -((-a) // M)
        m_hi = ((start + length + T) * L - gd - 1) // M + 1
        sup.append((m_lo, m_hi))
    dphi = 2.0 * math.pi * (f_em - fc) / fs
    two_pi = 2.0 * math.pi
    phase = 0.0
    out = np.zeros(N, dtype=np.complex64)
    k = 0
    for m in range(N):
        while k < len(sup) and sup[k][1] <= m:
            k += 1
        if k < len(sup) and sup[k][0] <= m:
            pp = m * M + gd
            n_hi, n_lo = pp // L, -((-(pp - h.size + 1)) // L)
            y = 0j
            for n in range(max(n_lo, 0), n_hi + 1):
                y += h[pp - L * n] * native[n]
            y *= gain
            cc, sp = math.cos(phase), math.sin(phase)
            out[m] = complex(np.float32(y.real * cc - y.imag * sp), np.float32(y.real * sp + y.imag * cc))
        phase += dphi
        if phase >= two_pi:
            phase -= two_pi
        elif phase < 0.0:
            phase += two_pi
    first = max(sup[0][0], 0)          # 首个突发从原生 0 起时支撑下界是负的（滤波拖尾伸到流开始之前）
    keep = args.so_keep
    energy = float(np.sum(np.abs(out.astype(np.complex128)) ** 2))
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "SceneEmitterSource 的 OFDM 路径对拍基准（Q-2，D-088），组件尺度（complex64）",
        "generator": "algos/reference/gen_engine_golden.py --mode scene_ofdm",
        "scenario": "engine/tests/fixtures/ofdm-emitter.scenario.json",
        "entity_id": eid, "preset": pid, "sample_rate_Hz": fs, "center_frequency_Hz": fc,
        "shared_seed": 7, "total_samples": N, "decim": M,
        "unit_power_c": c, "n_bursts": len(bursts),
        "supports": [[a, b] for a, b in sup],
        "segments": [
            {"start": first, "samples": [[float(v.real), float(v.imag)] for v in out[first:first + keep]]},
            {"start": sup[0][1] - keep, "samples": [[float(v.real), float(v.imag)] for v in out[sup[0][1] - keep:sup[0][1]]]},
        ],
        "energy": energy,
        "tolerance": {"sample_rel": 1e-6, "energy_rel": 1e-6,
                      "note": "组件输出存 complex64（eps 1.2e-7），判据 1e-6；算法核那一层的 1e-9 由 rsmp / ofdm 两份基准守"},
    }
    arrays = {}
    for i, seg in enumerate(doc["segments"]):
        tag = f"@@seg{i}@@"
        arrays[tag] = seg["samples"]
        seg["samples"] = tag
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    for tag, pairs in arrays.items():
        text = text.replace(json.dumps(tag), "[\n" + ",\n".join(json.dumps(pr) for pr in pairs) + "\n]", 1)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
    print(f"写出 {args.out}：{N} 个样点、{len(bursts)} 个突发、c = {c:.12f}、能量 {energy:.6f}")
    return 0


def write_gfsk(args) -> int:
    """GFSK / 2-FSK 调制核（Q-3，D-089）：引擎 engine/src/gfsk.cpp 对 algos/reference/gfsk_ref.py 的
    **独立**高精度实现（mpmath 40 位、全部符号直接求和、不截窗口、不裂项）。

    只做**算法核尺度**（double 进 double 出，判据 1e-9 圈）。每个算例存：调制参数、比特（预设算例由
    packet_bits 按种子生成，引擎须逐位复现）、一组包内时刻 τ 与该时刻的相位（圈）与瞬时频率（Hz）。
    τ 含随机点、符号边界、包前包后；2-FSK 的瞬时频率在符号边界上是跳变，那几点只比相位（频率记 null）。
    另加一个不在预设表里的 BT = 0.5 算例，窗口 K = 4（预设的 BT = 1 是 K = 3），两条路径都盖到。
    """
    import hashlib
    import gfsk_ref

    doc_p = gfsk_ref.load_presets()
    with open(os.path.join(gfsk_ref._ROOT, gfsk_ref.PRESETS_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()

    rng = np.random.default_rng(args.gfsk_seed)
    cases = []
    plan = [("frsky-d16v2-fcc", None), ("futaba-sfhss", None), ("frsky-d16v2-fcc", 0.5)]
    for pid, bt_override in plan:
        p = gfsk_ref.Preset(doc_p, pid)
        n = p.packets[0][1]
        bits = gfsk_ref.packet_bits(p, n, args.gfsk_seed)
        gaussian = 1 if bt_override is not None else p.gaussian
        bt = bt_override if bt_override is not None else p.bt
        T = 1.0 / p.R
        taus = sorted(set(
            [float(t) for t in rng.uniform(-3 * T, (n + 3) * T, args.gfsk_points)] +
            [0.0, 1 * T, 2 * T, 40 * T, 63.5 * T, (n - 1) * T, n * T, (n + 0.5) * T, -0.5 * T]))
        ph = [gfsk_ref.phase_cycles_mp(gaussian, bt, p.R, p.fdev, bits, t) for t in taus]
        fq = []
        for t in taus:
            s_ = t * p.R
            if not gaussian and abs(s_ - round(s_)) < 1e-6:
                fq.append(None)
            else:
                fq.append(gfsk_ref.inst_freq_mp(gaussian, bt, p.R, p.fdev, bits, t))
        cases.append({
            "name": pid if bt_override is None else f"{pid}-bt{bt_override}",
            "preset": pid, "seed": args.gfsk_seed, "n_bits": n,
            "gaussian": gaussian, "bt": bt, "symbol_rate_Hz": p.R, "deviation_Hz": p.fdev,
            "bits": "".join("1" if b > 0 else "0" for b in bits),
            "tau_s": taus, "phase_cycles": ph, "inst_freq_Hz": fq,
        })

    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "GFSK / 2-FSK 调制核的对拍基准（Q-3，D-089）：引擎 engine/src/gfsk.cpp（窗口裂项的闭式）对 "
                   "algos/reference/gfsk_ref.py 的 mpmath 不截断全和；MATLAB 一方读本文件的比特与时刻，"
                   "写 gfsk.matlab.json",
        "generator": "algos/reference/gen_engine_golden.py --mode gfsk",
        "presets": {"source": gfsk_ref.PRESETS_REL.replace(os.sep, "/"), "sha256": table_sha},
        "contract": "比特：前导 1010…（起于 1）+ 同步字高位先发 + Xoshiro256pp(seed) 每 64 位一个 next_u64 高位先用；"
                    "'1' → +f_dev；包外 a = 0；相位 ψ = (f_dev/R)·Σ_k a_k·P(τR − k) 圈，P 为 [0,1) 矩形"
                    "（GFSK 再卷 σ = √ln2/(2π·BT) 的高斯核）的积分",
        "cases": cases,
        "tolerance": {
            "phase_cycles_abs": 1e-9,
            "inst_freq_abs_over_deviation": 1e-9,
            "note": "bits 须逐位相同（整数随机源）；inst_freq 为 null 的点是 2-FSK 的符号边界（跳变点），只比相位",
        },
    }
    arrays = {}
    for ci, c in enumerate(cases):
        for key in ("tau_s", "phase_cycles", "inst_freq_Hz"):
            tag = f"@@{ci}_{key}@@"
            arrays[tag] = c[key]
            c[key] = tag
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    for tag, vals in arrays.items():
        body = ",\n".join(json.dumps(v) for v in vals)
        text = text.replace(json.dumps(tag), "[\n" + body + "\n]", 1)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
    print(f"写出 {args.out}：{len(cases)} 个算例，每例 {len(taus)} 个时刻，GFSK 预设表 sha256 {table_sha[:16]}…")
    return 0


def write_gfsk_frame(args) -> int:
    """GFSK 族的帧排布（Q-3，D-089）：geo/src/gfsk_frame.cpp 对 algos/reference/gfsk_ref.py 的 frame_bursts()。

    时刻是 double 的算术（t0 = (offset + k·period) + packet.offset，t1 = t0 + n_bits/R），两侧同式同序，
    判据是**逐位**：整张包表按 <int64 frame, int32 packet, double t0, double t1> 小端拼接后的 sha256 相同。
    帧起点故意取一个不在任何栅格上的值。
    """
    import hashlib
    import gfsk_ref

    doc_p = gfsk_ref.load_presets()
    with open(os.path.join(gfsk_ref._ROOT, gfsk_ref.PRESETS_REL), "rb") as fh:
        table_sha = hashlib.sha256(fh.read()).hexdigest()
    cases = []
    for pid in ("frsky-d16v2-fcc", "futaba-sfhss"):
        p = gfsk_ref.Preset(doc_p, pid)
        bs = gfsk_ref.frame_bursts(p, args.gfsk_frame_offset, args.gfsk_frame_end)
        pick = lambda b: {"frame": b[0], "packet": b[1], "index": b[2], "t0_s": b[3], "t1_s": b[4], "n_bits": b[5]}
        cases.append({"preset": pid, "frame_offset_s": args.gfsk_frame_offset, "end_s": args.gfsk_frame_end,
                      "n_bursts": len(bs), "first": [pick(b) for b in bs[:3]], "last": pick(bs[-1]),
                      "table_sha256": gfsk_ref.frame_table_sha256(bs)})
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "GFSK 族帧排布的对拍基准（Q-3，D-089）：geo::GfskSchedule 对 gfsk_ref.frame_bursts()，逐位",
        "generator": "algos/reference/gen_engine_golden.py --mode gfsk_frame",
        "presets": {"source": gfsk_ref.PRESETS_REL.replace(os.sep, "/"), "sha256": table_sha},
        "contract": "t0 = (frame_offset_s + k·period_s) + packets[q].offset_s；t1 = t0 + n_bits / R；起点 < end_s 的包全列；"
                    "表指纹 = 逐包 struct.pack('<qidd', k, q, t0, t1) 拼接的 sha256",
        "cases": cases,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    print(f"写出 {args.out}：" + "，".join(f"{c['preset']} {c['n_bursts']} 包" for c in cases))
    return 0


def write_scene_gfsk(args) -> int:
    """SceneEmitterSource 的 GFSK 路径（Q-3，D-089）：组件尺度的对拍基准（complex64，判据 1e-6）。

    整条路径逐步复刻，与引擎共享的只有比特（预设表、种子）：
      帧排布 gfsk_ref.frame_bursts → 支撑 [sample_at(t0), sample_at(t1)) → 包载荷种子 mix64(key ^ mix64(包序号))
      → 比特 gfsk_ref.packet_bits → 闭式相位 ψ(m/fs − t0)（gfsk_ref.Modulator，与 C++ 同式同序）
      → exp(j·(载波相位 + 2π·frac ψ)) → 相位累加器（弧度、逐样点加、单次回卷）→ float32。
    场景是 engine/tests/fixtures/gfsk-emitter.scenario.json 的两个定频辐射源（无活动，频偏为常数）：
    frsky 走 GFSK 路径，sfhss 走 2-FSK 路径、帧起点 2.1 ms。共享随机流 Xoshiro256pp(7) 取一个数建私有子流，
    私有子流再取一个数作载荷键——与单测、与 OFDM 路径同式。
    """
    import gfsk_ref

    doc_p = gfsk_ref.load_presets()
    fs, fc = 80e6, 2.44e9
    N = args.sg_samples
    two_pi = 2.0 * math.pi
    sub_seed = Xoshiro256pp(7).next_u64()
    key = Xoshiro256pp(sub_seed).next_u64()
    cases = []
    for eid, pid, f_em, off in (("frsky", "frsky-d16v2-fcc", 2.4413e9, 0.0), ("sfhss", "futaba-sfhss", 2.4387e9, 0.0021)):
        p = gfsk_ref.Preset(doc_p, pid)
        mod = gfsk_ref.Modulator.of(p)
        bursts = gfsk_ref.frame_bursts(p, off, N / fs)
        sup = [(int(t0 * fs + 0.5) if t0 > 0.0 else 0, int(t1 * fs + 0.5)) for (_k, _q, _i, t0, t1, _nb) in bursts]
        dphi = two_pi * (f_em - fc) / fs
        phase = 0.0
        out = np.zeros(N, dtype=np.complex64)
        k = 0
        cache = (-1, None, None)
        for m in range(N):
            while k < len(sup) and sup[k][1] <= m:
                k += 1
            if k < len(sup) and sup[k][0] <= m:
                _fr, _q, idx, t0, _t1, nb = bursts[k]
                if cache[0] != idx:
                    a = gfsk_ref.packet_bits(p, nb, gfsk_ref.mix64(key ^ gfsk_ref.mix64(idx)))
                    cache = (idx, a, gfsk_ref.prefix_sums(a))
                psi = mod.phase_cycles(cache[1], cache[2], m / fs - t0)
                ang = phase + two_pi * (psi - math.floor(psi))
                out[m] = complex(np.float32(math.cos(ang)), np.float32(math.sin(ang)))
            phase += dphi
            if phase >= two_pi:
                phase -= two_pi
            elif phase < 0.0:
                phase += two_pi
        keep = args.sg_keep
        m0, m1 = sup[0]
        energy = float(np.sum(np.abs(out.astype(np.complex128)) ** 2))
        cases.append({
            "entity_id": eid, "preset": pid, "emitter_center_Hz": f_em, "frame_offset_s": off,
            "n_bursts": len(bursts), "supports": [[a, b] for a, b in sup],
            "segments": [
                {"start": m0, "samples": [[float(v.real), float(v.imag)] for v in out[m0:m0 + keep]]},
                {"start": m1 - keep, "samples": [[float(v.real), float(v.imag)] for v in out[m1 - keep:m1]]},
            ],
            "energy": energy,
        })
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "SceneEmitterSource 的 GFSK 路径对拍基准（Q-3，D-089），组件尺度（complex64）",
        "generator": "algos/reference/gen_engine_golden.py --mode scene_gfsk",
        "scenario": "engine/tests/fixtures/gfsk-emitter.scenario.json",
        "sample_rate_Hz": fs, "center_frequency_Hz": fc, "shared_seed": 7, "total_samples": N,
        "cases": cases,
        "tolerance": {"sample_abs": 1e-6, "energy_rel": 1e-6,
                      "note": "恒包络，样点模为 1，判据取绝对差 1e-6（complex64 的 eps 1.2e-7）；算法核那一层的 1e-9 由 gfsk.json 守"},
    }
    arrays = {}
    for ci, c in enumerate(doc["cases"]):
        for si, seg in enumerate(c["segments"]):
            tag = f"@@{ci}_{si}@@"
            arrays[tag] = seg["samples"]
            seg["samples"] = tag
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    for tag, pairs in arrays.items():
        text = text.replace(json.dumps(tag), "[\n" + ",\n".join(json.dumps(pr) for pr in pairs) + "\n]", 1)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
    print(f"写出 {args.out}：{N} 个样点；" + "，".join(f"{c['entity_id']} {c['n_bursts']} 包、能量 {c['energy']:.3f}"
                                                  for c in cases))
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
    ap.add_argument("--mode", choices=("probe", "sliding", "features", "scene_noise", "ddc",
                                      "channelizer", "rx_filter", "ofdm", "rsmp", "ofdm_frame", "scene_ofdm", "gfsk",
                                      "gfsk_frame", "scene_gfsk"),
                    default="probe")
    ap.add_argument("--seed2", type=int, default=20260913, help="features：门控噪声突发的种子")
    ap.add_argument("--window-frames", type=int, default=256, help="sliding：环长 W")
    ap.add_argument("--merge-gap", type=int, default=2, help="sliding：突发合并空隙")
    ap.add_argument("--tone-offset", type=float, default=50e3, help="sliding：单音频偏 Hz")
    ap.add_argument("--tone-amplitude", type=float, default=0.75, help="sliding：单音幅度（线性）")
    ap.add_argument("--tone-start-frame", type=int, default=1500)
    ap.add_argument("--tone-stop-frame", type=int, default=2500)
    ap.add_argument("--sn-fs", type=float, default=1e6, help="scene_noise：采样率")
    ap.add_argument("--sn-bw", type=float, default=2e5, help="scene_noise：emission.bw_Hz")
    ap.add_argument("--sn-offset", type=float, default=1e5, help="scene_noise：基带频偏 Hz")
    ap.add_argument("--sn-seed", type=int, default=20260915, help="scene_noise：私有子流种子")
    ap.add_argument("--sn-samples", type=int, default=4096, help="scene_noise：存多少个样点")
    ap.add_argument("--ddc-fs", type=float, default=1e7, help="ddc：输入采样率")
    ap.add_argument("--ddc-samples", type=int, default=32768, help="ddc：输入样点数")
    ap.add_argument("--ddc-seed", type=int, default=20260916, help="ddc：噪声种子")
    ap.add_argument("--ddc-shift", type=float, default=-2.5e6, help="ddc：频移 Hz")
    ap.add_argument("--ddc-tone-pass", type=float, default=-2.3e6, help="ddc：通带单音（绝对基带频率）")
    ap.add_argument("--ddc-tone-stop", type=float, default=1.7e6, help="ddc：阻带单音（绝对基带频率）")
    ap.add_argument("--ddc-tone-amp", type=float, default=0.5, help="ddc：两个单音的幅度")
    ap.add_argument("--ddc-gate-start", type=int, default=8192, help="ddc：阻带单音门控起点")
    ap.add_argument("--ddc-gate-stop", type=int, default=24576, help="ddc：阻带单音门控终点")
    ap.add_argument("--ddc-keep", type=int, default=1024, help="ddc：每个算例存多少个输出样点")
    # channelizer（M-3）：单音落在 10 MS/s 下 M=8 的三个不同子信道里
    ap.add_argument("--chan-fs", type=float, default=1e7, help="channelizer：输入采样率")
    ap.add_argument("--chan-samples", type=int, default=32768, help="channelizer：输入样点数")
    ap.add_argument("--chan-seed", type=int, default=20260917, help="channelizer：噪声种子")
    ap.add_argument("--chan-tone1", type=float, default=-3.75e6, help="channelizer：单音一")
    ap.add_argument("--chan-tone2", type=float, default=-1.25e6, help="channelizer：单音二")
    ap.add_argument("--chan-tone3", type=float, default=1.25e6, help="channelizer：单音三（门控）")
    ap.add_argument("--chan-tone-amp", type=float, default=0.5, help="channelizer：单音幅度")
    ap.add_argument("--chan-gate-start", type=int, default=8192)
    ap.add_argument("--chan-gate-stop", type=int, default=24576)
    ap.add_argument("--chan-keep", type=int, default=1024, help="channelizer：每个算例存多少输出样点")
    ap.add_argument("--chan-kernel-channels", type=int, nargs="+", default=[4, 8],
                    help="channelizer：算法核尺度核对哪些子信道数")
    ap.add_argument("--chan-kernel-outputs", type=int, nargs="+", default=[0, 137],
                    help="channelizer：算法核尺度核对哪几个输出样点")
    # rx_filter（M-3）
    ap.add_argument("--rx-fs", type=float, default=1e7, help="rx_filter：输入采样率")
    ap.add_argument("--rx-samples", type=int, default=32768, help="rx_filter：输入样点数")
    ap.add_argument("--rx-seed", type=int, default=20260918, help="rx_filter：噪声种子")
    ap.add_argument("--rx-tone-pass", type=float, default=1.0e6, help="rx_filter：通带单音")
    ap.add_argument("--rx-tone-stop", type=float, default=4.7e6, help="rx_filter：阻带单音")
    ap.add_argument("--rx-tone-amp", type=float, default=0.5)
    ap.add_argument("--rx-gate-start", type=int, default=8192)
    ap.add_argument("--rx-gate-stop", type=int, default=24576)
    ap.add_argument("--rx-keep", type=int, default=1024)
    ap.add_argument("--rx-bw-rels", type=float, nargs="+", default=[0.3, 0.5, 0.8])
    # 0.2 档抽头 57 = 表内最大值（不补零），0.8 档 55（末尾补两个零）：两条路径都盖到
    ap.add_argument("--rx-kernel-bw-rels", type=float, nargs="+", default=[0.2, 0.8])
    ap.add_argument("--rx-kernel-block", type=int, default=1024)
    ap.add_argument("--ofdm-seed", type=int, default=20260929, help="ofdm：突发载荷种子")
    ap.add_argument("--rsmp-seed", type=int, default=20260930, help="rsmp：窗口与突发的种子")
    ap.add_argument("--rsmp-burst-start", type=int, default=1000, help="rsmp：突发的原生起点")
    ap.add_argument("--rsmp-keep", type=int, default=400, help="rsmp：支撑首尾各存多少个站点样点")
    ap.add_argument("--frame-seed", type=int, default=20260904, help="ofdm_frame：场景 seed")
    ap.add_argument("--frame-slots", type=int, default=100000, help="ofdm_frame：每个预设铺多少时隙")
    ap.add_argument("--so-samples", type=int, default=200000, help="scene_ofdm：输出样点数（80 MS/s 下 2.5 ms）")
    ap.add_argument("--so-keep", type=int, default=512, help="scene_ofdm：首个突发支撑的首尾各存多少样点")
    ap.add_argument("--gfsk-seed", type=int, default=20260930, help="gfsk：载荷种子与随机时刻")
    ap.add_argument("--gfsk-points", type=int, default=160, help="gfsk：每个算例的随机时刻数")
    ap.add_argument("--gfsk-frame-offset", type=float, default=0.00123, help="gfsk_frame：帧起点（秒）")
    ap.add_argument("--gfsk-frame-end", type=float, default=60.0, help="gfsk_frame：铺到多少秒")
    ap.add_argument("--sg-samples", type=int, default=480000, help="scene_gfsk：输出样点数（80 MS/s 下 6 ms）")
    ap.add_argument("--sg-keep", type=int, default=512, help="scene_gfsk：首个包的首尾各存多少样点")
    args = ap.parse_args(argv)

    if args.mode == "scene_noise":
        return write_scene_noise(args)
    if args.mode == "ddc":
        return write_ddc(args)
    if args.mode == "channelizer":
        return write_channelizer(args)
    if args.mode == "rx_filter":
        return write_rx_filter(args)
    if args.mode == "ofdm":
        return write_ofdm(args)
    if args.mode == "rsmp":
        return write_rsmp(args)
    if args.mode == "ofdm_frame":
        return write_ofdm_frame(args)
    if args.mode == "scene_ofdm":
        return write_scene_ofdm(args)
    if args.mode == "gfsk":
        return write_gfsk(args)
    if args.mode == "gfsk_frame":
        return write_gfsk_frame(args)
    if args.mode == "scene_gfsk":
        return write_scene_gfsk(args)

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
