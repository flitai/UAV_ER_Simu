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
