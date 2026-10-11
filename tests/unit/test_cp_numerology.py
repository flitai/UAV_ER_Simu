"""cp_numerology（D-102）的单测：合成夹具，不读数据集、不跑引擎。

运行：uv run --quiet --with numpy --with scipy python -m unittest tests/unit/test_cp_numerology.py
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "algos", "reference"))

import cp_numerology as C  # noqa: E402

SLOT = C.SIM_PATTERNS["per_slot"]
FIRST = C.SIM_PATTERNS["first_only"]


class TestSubcarrierSpacing(unittest.TestCase):
    def test_15k(self):
        b, fs, bw = C.synth_bursts(FIRST, 8, seed=2)
        r = C.estimate(b, fs, bw, with_ts=False)
        self.assertAlmostEqual(r["scs_kHz"], 15.0, delta=0.01)
        self.assertGreater(r["peak_over_median"], 4.0)

    def test_30k(self):
        # 30 kHz：原生率 61.44 MS/s，循环前缀取同样的原生样点数（时长减半），
        # 有用符号只有一半长：峰应在 33.33 µs，不在 66.67 µs
        b, fs, bw = C.synth_bursts(FIRST, 8, scs_Hz=30e3, half_sc=300, seed=3)
        r = C.estimate(b, fs, bw, with_ts=False)
        self.assertAlmostEqual(r["scs_kHz"], 30.0, delta=0.02)

    def test_narrowband_not_fooled_by_sidelobes(self):
        # 上行那样窄而短的突发：±37 个子载波（1.125 MHz）、7 个符号；搜索下限随带宽放宽后仍应找到 15 kHz
        b, fs, bw = C.synth_bursts([160] + [144] * 6, 60, half_sc=37, seed=4)
        r = C.estimate(b, fs, bw, with_ts=False)
        self.assertGreaterEqual(r["lag_min"], C.LAG_MIN_MAINLOBES * fs / bw - 1)
        self.assertAlmostEqual(r["scs_kHz"], 15.0, delta=0.05)


class TestCpPattern(unittest.TestCase):
    def test_slot_pattern_reads_longer_period(self):
        b1, fs, bw = C.synth_bursts(FIRST, 12, seed=5)
        b2, _, _ = C.synth_bursts(SLOT, 12, seed=6)
        t1 = C.estimate(b1, fs, bw)["Ts_us"]
        t2 = C.estimate(b2, fs, bw)["Ts_us"]
        # 只有首符号长：14 个符号的周期 = 2048 + 144 个原生样点 = 71.354 µs，读数应靠近它
        self.assertAlmostEqual(t1, (2048 + 144) / 30.72e6 * 1e6, delta=0.02)
        # 按时隙排布：每 7 个符号多一个长循环前缀，读数应明显更长
        self.assertGreater(t2 - t1, 0.03)

    def test_lag_min_floor(self):
        b, fs, bw = C.synth_bursts(FIRST, 2, seed=7)
        self.assertEqual(C.estimate(b, fs, bw, with_ts=False)["lag_min"], C.LAG_MIN)


if __name__ == "__main__":
    unittest.main()
