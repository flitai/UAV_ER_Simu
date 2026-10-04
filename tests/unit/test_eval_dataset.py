"""评测数据集生成件的单测（试样集，D-092）：scripts/eval_dataset/。

不跑引擎、不读实测数据。钉住：场景与链路规格逐字节可复现；种子是整数、各格各用途互不相同；
预设带宽照抄；跳频序列一秒不重复；DroneID 帧起点落在原生采样格点上；载频偏差按平台、在范围内；
前端不平衡的反解对正向模型精确；格子文件里冻结的位置齐全且与目标一致；格子文件的键白名单。

运行：uv run --quiet --with numpy --with scipy python -m unittest tests/unit/test_eval_dataset.py
"""
from __future__ import annotations

import copy
import json
import math
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from eval_dataset import cells as C  # noqa: E402
from eval_dataset import frontend as F  # noqa: E402
from eval_dataset import scenario as S  # noqa: E402
from eval_dataset import seeds  # noqa: E402

DOC = C.load("sample-v1")


class TestScenario(unittest.TestCase):

    def test_bytes_are_reproducible(self):
        for cell in DOC["cells"]:
            a = S.dumps(S.build(DOC, cell))
            b = S.dumps(S.build(copy.deepcopy(DOC), copy.deepcopy(cell)))
            self.assertEqual(a, b, cell["id"])
            self.assertEqual(S.chain_spec(DOC, cell, "x"), S.chain_spec(DOC, cell, "x"))

    def test_seeds_are_integers_and_distinct(self):
        got = []
        for cell in DOC["cells"]:
            for role in ("run", "scenario"):
                s = seeds.derive(DOC["set_seed"], cell["id"], role)
                self.assertIsInstance(s, int)
                self.assertTrue(0 <= s < 2 ** 53)
                got.append(s)
        self.assertEqual(len(got), len(set(got)))

    def test_preset_bandwidth_hops_and_droneid_grid(self):
        for cell in DOC["cells"]:
            scen = S.build(DOC, cell)
            acts = {a["emitter_id"]: a for a in scen["activities"] if a["event"] == "hop"}
            for e in scen["emitters"]:
                wf = e["emission"]["waveform"]
                if "preset_id" not in wf:
                    continue
                fam, raw = S.preset(wf["preset_id"])
                self.assertEqual(e["emission"]["bw_Hz"], raw["occupied_bw_Hz"], e["id"])
                if S.is_hopping(wf["preset_id"]):
                    seq = acts[e["id"]]["args"]["sequence"]
                    self.assertEqual(e["emission"]["center_Hz"], seq[0], "跳频源的中心频率是第一跳")
                    if fam == "ofdm":     # 上行：一秒的时隙数，不循环
                        self.assertEqual(len(seq), math.ceil(DOC["duration_s"] / raw["frame"]["slot_s"]))
                    else:                 # GFSK：协议的一整轮
                        self.assertEqual(len(seq), len(raw["hop"]["channels_Hz"]))
                if fam == "droneid" and "frame_offset_s" in wf:
                    n = wf["frame_offset_s"] * 15.36e6
                    self.assertEqual(n, round(n), "DroneID 帧起点要落在原生采样格点上")

    def test_cfo_per_platform_within_range(self):
        for cell in DOC["cells"]:
            scen = S.build(DOC, cell)
            by_em = {e["id"]: e["emission"].get("cfo_ppm") for e in scen["emitters"]}
            for p in cell["platforms"]:
                vals = {by_em[e["id"]] for e in p["emitters"]}
                self.assertEqual(len(vals), 1, f"{cell['id']} {p['id']}：同一平台的辐射源共用一个载频偏差")
                v = vals.pop()
                if p.get("off"):
                    self.assertIsNone(v)
                else:
                    self.assertLessEqual(abs(v), DOC["cfo"]["max_ppm"])

    def test_frozen_positions_present_and_on_target(self):
        for cell in DOC["cells"]:
            for p in cell["platforms"]:
                r = p.get("resolved")
                self.assertIsNotNone(r, f"{cell['id']} {p['id']} 没有冻结位置")
                if p.get("off"):
                    continue
                tol = p["search"]["tol_dB"] if "search" in p else 0.01
                self.assertLessEqual(abs(r["snr_budget_dB"] - p["snr_dB"]), tol + 1e-9, f"{cell['id']} {p['id']}")
                self.assertEqual(r["line_of_sight"], "search" not in p)
                if "search" in p:
                    self.assertGreaterEqual(r["diffraction_dB"], p["search"]["min_diffraction_dB"])


class TestFrontend(unittest.TestCase):

    def test_inversion_is_exact_against_forward_model(self):
        # 正向：y = I + j·g·Q·e^{jφ}（ReceiverFrontEnd 的 K1·x + K2·conj(x)）对独立同方差噪声的 r 与 ρ
        for g_dB, ph in ((0.5, 5.0), (-1.2, -3.0), (0.0053, -0.0069)):
            g = 10 ** (g_dB / 20)
            s, c = math.sin(math.radians(ph)), math.cos(math.radians(ph))
            vi, vq, cov = 1 + g * g * s * s, g * g * c * c, -g * g * s * c
            r, rho = math.sqrt(vi / vq), cov / math.sqrt(vi * vq)
            g2, ph2 = F.to_params(r, rho)
            self.assertAlmostEqual(g2, g_dB, places=12)
            self.assertAlmostEqual(ph2, ph, places=12)

    def test_frontend_values_frozen_with_source(self):
        fm = DOC["frontend_measured"]
        self.assertTrue(fm["use"])
        self.assertEqual(fm["source"]["grade"], "M")
        self.assertGreater(fm["source"]["n_slices"], 0)
        spec = S.chain_spec(DOC, DOC["cells"][0], "x")
        fe = spec["slots"]["rx_fe"]
        self.assertEqual(fe["iq_gain_imbalance_dB"], fm["iq_gain_imbalance_dB"])
        # 直流：比值 × 本方 ADC 输入端噪声功率（kT + nf + 10·log10 fs + 前端增益）
        rcv = DOC["receivers"][DOC["cells"][0]["receiver"]]
        noise = S.noise_density_dBm_Hz(DOC["site"]["nf_dB"]) + 10 * math.log10(rcv["fs_Hz"]) + fe["gain_dB"]
        self.assertAlmostEqual(10 * math.log10(fe["dc_offset_mW"]) - noise, fm["dc_rel_noise_dB"], places=4)


class TestCellsFile(unittest.TestCase):

    def test_unknown_keys_and_duplicate_ids_rejected(self):
        bad = copy.deepcopy(DOC)
        bad["cells"][0]["oops"] = 1
        with self.assertRaises(C.CellError):
            C.validate(bad)
        bad = copy.deepcopy(DOC)
        bad["cells"].append(copy.deepcopy(bad["cells"][0]))
        with self.assertRaises(C.CellError):
            C.validate(bad)

    def test_file_is_canonical(self):
        with open(C.path_of("sample-v1"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertEqual(text, json.dumps(json.loads(text), ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
