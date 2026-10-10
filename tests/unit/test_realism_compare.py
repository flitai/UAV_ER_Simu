"""真实感对照（Q-5，D-096；14 号报告 §7.3）的单测：合成夹具，不读数据集、不跑引擎。

- 同一把尺子：`block_bursts` 与 Q-0b 的 `analyse_block` 量出的突发逐字段相同；
- KS 距离、判定线、谱形均方根差、跳频点判定按 §7.3 的定义；
- 平均谱形：矩形谱带限噪声突发的带内归一谱是平的、带外压得下去；
- 配对表与格子集 realism-v1 一致（预设、格子、变体、自检）。

运行：
    uv run --quiet --with numpy --with scipy python -m unittest tests/unit/test_realism_compare.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import unittest

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "algos", "reference"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import q0b_param_extract as q  # noqa: E402
import realism_compare as R  # noqa: E402
from test_q0b_param_extract import bl_noise, cnoise, ofdm  # noqa: E402

FS = 80e6
FC = 2440e6


def video_fixture(seed: int = 7, snr_dB: float = 20.0, wave: str = "ofdm") -> tuple[np.ndarray, list]:
    """20 ms：18 MHz 宽的突发串，中心偏 +22.5 MHz；间隙里一个 2 MHz 的跳频点。噪声每样点功率 1。"""
    rng = np.random.default_rng(seed)
    n = int(20e-3 * FS)
    t = np.arange(n) / FS
    bursts = [(0.5e-3, 1.1e-3), (2.6e-3, 2.1e-3), (6.0e-3, 1.1e-3), (8.9e-3, 1.1e-3), (11.8e-3, 2.1e-3),
              (15.0e-3, 1.1e-3), (17.6e-3, 1.1e-3)]
    gate = np.zeros(n)
    for a, d in bursts:
        gate[int(round(a * FS)):int(round((a + d) * FS))] = 1
    occ = 921 * FS / 4096
    sig = ofdm(rng, n) if wave == "ofdm" else bl_noise(rng, n, FS, occ)
    x = cnoise(rng, n) + math.sqrt(10 ** (snr_dB / 10) * occ / FS) * sig * np.exp(2j * math.pi * 22.5e6 * t) * gate
    i0, i1 = int(1.8e-3 * FS), int(2.3e-3 * FS)
    x[i0:i1] += math.sqrt(10 ** 2.5 * 2e6 / FS) * bl_noise(rng, i1 - i0, FS, 2e6) * np.exp(2j * math.pi * -10e6 * t[i0:i1])
    return x.astype(np.complex64), bursts


VIDEO = {"f_range_Hz": [2450e6, 2480e6], "min_bw_Hz": 10e6}


class TestSameRuler(unittest.TestCase):
    """对照脚本自己的一块处理必须与 Q-0b 的 analyse_block 量出同样的突发（逐字段）。"""

    def test_block_bursts_equals_analyse_block(self):
        x, _ = video_fixture()
        ref = q.analyse_block(x, FS, FC, VIDEO, (0.5e6, 12e6))
        tf, channels, hops = R.block_bursts(x, FS, FC, VIDEO, (0.5e6, 12e6))
        self.assertEqual(len(channels), len(ref["channels"]))
        self.assertGreater(len(channels), 0)
        for a, b in zip(channels, ref["channels"]):
            self.assertEqual((a["f_lo_Hz"], a["f_hi_Hz"]), (b["f_lo_Hz"], b["f_hi_Hz"]))
            self.assertEqual(a["bursts"], b["bursts"])
        self.assertEqual(hops, ref["hops"])
        self.assertGreater(len(hops), 0)


class TestKs(unittest.TestCase):

    def test_values(self):
        self.assertEqual(R.ks_distance([1, 2, 3], [1, 2, 3]), 0.0)
        self.assertEqual(R.ks_distance([1, 2, 3], [10, 11]), 1.0)
        self.assertAlmostEqual(R.ks_distance([1, 2, 3], [2, 3, 4]), 1 / 3)
        self.assertIsNone(R.ks_distance([], [1.0]))

    def test_symmetric(self):
        rng = np.random.default_rng(3)
        a, b = rng.normal(0, 1, 500), rng.normal(0.3, 1, 700)
        self.assertEqual(R.ks_distance(a, b), R.ks_distance(b, a))


class TestLines(unittest.TestCase):
    """判定线就是 14 §7.3 那张表；线上算「一致」。"""

    def test_table_matches_report(self):
        self.assertEqual({k: (v["measure"], v["line"]) for k, v in R.LINES.items()}, {
            "obw99_Hz": ("rel_median", 0.05), "bw10_Hz": ("rel_median", 0.05), "dur_s": ("rel_median", 0.05),
            "flatness": ("abs_median", 0.05), "papr_dB": ("abs_median", 0.5), "interval_s": ("ks", 0.2),
            "shape": ("rms_dB", 1.0), "hops": ("points_and_span", 0.05)})

    def test_rel_median(self):
        self.assertEqual(R.compare("dur_s", [1.0] * 5, [1.04] * 5)["verdict"], "一致")
        self.assertEqual(R.compare("dur_s", [1.0] * 5, [1.06] * 5)["verdict"], "有差距")
        self.assertAlmostEqual(R.compare("dur_s", [2.0] * 3, [1.9] * 3)["rel"], -0.05)

    def test_abs_median_and_ks(self):
        self.assertEqual(R.compare("flatness", [0.80] * 3, [0.84] * 3)["verdict"], "一致")
        self.assertEqual(R.compare("flatness", [0.80] * 3, [0.86] * 3)["verdict"], "有差距")
        c = R.compare("interval_s", [1, 2, 3, 4, 5], [1, 2, 3, 4, 50])
        self.assertAlmostEqual(c["ks"], 0.2)
        self.assertEqual(c["verdict"], "一致")
        self.assertEqual(R.compare("papr_dB", [8.0], [])["verdict"], "无法比较")
        self.assertNotIn("verdict", R.compare("snr_dB", [1.0], [2.0]))

    def test_shape_rms_only_in_band(self):
        grid = np.arange(-10, 11) * 1e6
        a = np.zeros(grid.size)
        b = np.where(np.abs(grid) <= 4e6, 1.0, 30.0)
        self.assertAlmostEqual(R.shape_rms(a, b, grid, 8e6), 1.0)

    def test_hops(self):
        m = {"n_points": 47, "span_Hz": 69e6}
        self.assertEqual(R.hop_compare(m, {"n_points": 47, "span_Hz": 71e6})["verdict"], "一致")
        self.assertEqual(R.hop_compare(m, {"n_points": 46, "span_Hz": 69e6})["verdict"], "有差距")
        self.assertEqual(R.hop_compare(m, {"n_points": 47, "span_Hz": 75e6})["verdict"], "有差距")
        self.assertEqual(R.hop_compare(m, {"n_bursts": 0})["verdict"], "无法比较")


class TestMeanShape(unittest.TestCase):
    """矩形谱的带限噪声突发：带内归一的平均谱在带内是平的（核心段汉宁窗的裙边只在带边几个频点里）。"""

    @classmethod
    def setUpClass(cls):
        x, cls.bursts = video_fixture(seed=21, snr_dB=25.0, wave="noise")
        cls.pair = {"id": "v", "kind": "video", "psd_res_Hz": 78125.0, "psd_span_Hz": 15e6}
        cls.grid = R.psd_grid(cls.pair)
        cfg = {"video": VIDEO, "link_bw": (0.5e6, 12e6),
               "extractors": [{"id": "v", "kind": "video", "band_Hz": 16e6, "res": 78125.0, "grid": cls.grid}]}
        cls.res = R.extract(x, FS, FC, cfg)["v"]
        col = R.pool_column([{"res": {"v": cls.res}}], "v")
        cls.shape = col["shape_dB"]

    def test_every_burst_contributes(self):
        self.assertEqual(self.res["n_psd"], len(self.bursts))
        self.assertEqual(self.res["n_psd_skipped"], 0)

    def test_flat_in_band_and_low_outside(self):
        """线按估计量自己的起伏定：每个频点取约 69–131 帧的中位数，指数分布的样本中位数相对标准差
        ≈ 1.44/√n，7 个突发平均后约 0.07，即每频点约 0.3 dB。故均方根 ≤ 0.4 dB、最大 ≤ 1.2 dB（4σ）；
        倾斜看左右两半均值之差（各约 96 个频点平均，σ ≈ 0.03 dB），≤ 0.1 dB。"""
        inb = np.abs(self.grid) <= 7.5e6
        self.assertLess(R.shape_rms(np.zeros(self.grid.size), self.shape, self.grid, 15e6), 0.4)
        self.assertLess(float(np.max(np.abs(self.shape[inb]))), 1.2)
        tilt = float(np.mean(self.shape[inb & (self.grid > 0)]) - np.mean(self.shape[inb & (self.grid < 0)]))
        self.assertLess(abs(tilt), 0.1)
        outb = np.abs(self.grid) >= 11e6
        self.assertLess(float(np.nanmax(self.shape[outb])), -15.0)

    def test_intervals_inside_block(self):
        starts = [a for a, _ in self.bursts]
        want = np.diff(starts)
        got = np.asarray(self.res["intervals"])
        self.assertEqual(got.size, want.size)
        self.assertLess(float(np.max(np.abs(got - want))), 0.05 * float(np.min(want)))


class TestSpecImage(unittest.TestCase):

    def test_range_and_rows(self):
        x, _ = video_fixture(seed=5)
        img = R.spec_image(x, FS, rows=100)
        self.assertEqual(img.shape[1], q.NFFT)
        self.assertLessEqual(img.shape[0], x.size // q.NFFT)
        self.assertGreaterEqual(img.shape[0], 100)
        self.assertGreaterEqual(float(img.min()), 0.0)
        self.assertLessEqual(float(img.max()), R.SPEC_RANGE_DB)


class TestPairsMatchCells(unittest.TestCase):
    """配对表、变体与自检的格子都在 realism-v1 里，预设对得上。"""

    def test_presets(self):
        with open(os.path.join(_ROOT, "tests", "regression", "eval-dataset", "realism-v1.json"), encoding="utf-8") as fh:
            cells = {c["id"]: c for c in json.load(fh)["cells"]}
        for item in R.PAIRS + R.SELFCHECKS:
            presets = [e["preset"] for p in cells[item["cell"]]["platforms"] for e in p["emitters"]]
            self.assertEqual(presets, [item["preset"]], item["id"])
        for cid in R.VARIANTS:
            presets = [e["preset"] for p in cells[cid]["platforms"] for e in p["emitters"]]
            self.assertEqual(presets, ["dji-video-20m-a"], cid)

    def test_independence_and_columns(self):
        for p in R.PAIRS:
            self.assertEqual(p["independent"], p["main"] == "holdout", p["id"])
            self.assertIn(p["block_s"], (0.05, 0.1))
            self.assertEqual(p["block_s"], 0.05 if p["source"] == "dronerfb_dji" else 0.1, p["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
