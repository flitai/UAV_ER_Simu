#!/usr/bin/env python3
"""识别库 v2 的生成规则单测（Q-4c，D-094；14 号报告 §8.6）。

钉住三件事：
  ① 入库的 library-v2.json 就是生成器由入库的统计表与 Q-0b 实测按规则算出来的（逐字节）；
  ② 每个进库的区间都盖住校准集合成特征的 [p2.5, p97.5] 与实测各组的 [p10, p90]，且只往宽里放了规则写的量；
  ③ library-v1.json 一个字节没动（v1 守既有基准）。

跑法：uv run --quiet python -m unittest tests/unit/test_recognition_library.py
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import gen_recognition_library as G  # noqa: E402

LIB_V1_SHA256 = "9d605b67b62a96996c35e1a1934082d7f4a58d19126a468cad9d68291e3d6e07"


def load(rel: str) -> dict:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return json.load(fh)


class RecognitionLibraryV2(unittest.TestCase):
    def setUp(self) -> None:
        self.lib = load(G.OUT)
        self.cal = load(G.CALIB)
        self.q0b = load(G.Q0B)

    def test_regenerates_byte_identical(self) -> None:
        with open(os.path.join(ROOT, G.OUT), encoding="utf-8") as fh:
            self.assertEqual(fh.read(), G.dumps(G.build()))

    def test_calibration_hash_recorded(self) -> None:
        self.assertEqual(self.lib["calibration"]["sha256"], G.sha256(G.CALIB))

    def test_intervals_cover_calibration_and_measured(self) -> None:
        for t in self.lib["templates"]:
            s = self.cal["templates"][t["id"]]
            for f, (lo, hi) in t["intervals"].items():
                fs = s["features"][f]
                self.assertGreaterEqual(fs["available_frac"], G.AVAILABLE_MIN, f"{t['id']} {f}")
                want_lo, want_hi = fs["p2.5"], fs["p97.5"]
                m = G.measured_range(self.q0b, t["id"], f)
                if m is not None:
                    want_lo, want_hi = min(want_lo, m[0]), max(want_hi, m[1])
                    self.assertEqual(t["provenance"][f], "S+M")
                else:
                    self.assertEqual(t["provenance"][f], "S")
                self.assertLessEqual(lo, want_lo, f"{t['id']} {f} 下界")
                self.assertGreaterEqual(hi, want_hi, f"{t['id']} {f} 上界")
                if f in G.LOG_FEATURES:
                    # 往外放的量不超过 e^0.3 再加一位有效数字的取整
                    self.assertLessEqual(hi, want_hi * math.exp(G.LOG_SCALE) * (1 + 10 ** (1 - G.SIG)))
                    if lo > 0.0:
                        self.assertGreaterEqual(lo, want_lo / math.exp(G.LOG_SCALE) * (1 - 10 ** (1 - G.SIG)))
                else:
                    self.assertLessEqual(hi, min(1.0, want_hi + G.LINEAR_PAD) + 1e-6)
                    self.assertGreaterEqual(lo, max(0.0, want_lo - G.LINEAR_PAD) - 1e-6)
            # 可用比例不到 80% 的特征一项也没进
            for f in G.FEATURE_ORDER:
                if s["features"][f]["available_frac"] < G.AVAILABLE_MIN:
                    self.assertNotIn(f, t["intervals"], f"{t['id']} {f}")

    def test_measured_groups_exclude_unmodelled_sources(self) -> None:
        used = {sid for groups in G.MEASURED.values() for sid, _, _ in groups}
        for excluded in ("dronerfa_phantom4pro", "dronerfa_matrice200", "dronerfa_avata_uplink", "dronerfa_futaba_t14sg"):
            self.assertNotIn(excluded, used)

    def test_v1_untouched(self) -> None:
        with open(os.path.join(ROOT, "models", "recognition", "library-v1.json"), "rb") as fh:
            self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), LIB_V1_SHA256)

    def test_format(self) -> None:
        self.assertEqual(self.lib["schema"], "cuav-recognition-library/2")
        self.assertEqual(self.lib["feature_basis"], "subband")
        ids = [t["id"] for t in self.lib["templates"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn("duty", self.lib["feature_order"])


if __name__ == "__main__":
    unittest.main()
