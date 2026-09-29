"""GFSK 族机型预设表 models/radiator/gfsk-presets-v1.json 的单测（Q-3，决策 D-089）。

三组：
  ① 不变量：直接调生成脚本的 validate()（与生成 C++ 前的核对是同一段代码）——寄存器复算、Carson 带宽、
     包不重叠、频点表、S-FHSS 规则；
  ② M 档出处：FrSky 预设里标 M 的数都能从 data/iq/measured/q0b-params.json（入库）逐项核回去——
     周期对间隔主峰、包长对时长中位、逐跳步进对跳步主峰、47 个频点扣掉公共偏置后对实测点；
  ③ 照实记录的差距：Futaba S-FHSS 与本地 T14SG 录音**不是一回事**（14 §3.1），这里把差距钉成断言，
     免得哪天有人把 S-FHSS 的数「调」向录音（铁律 10）。

用法：uv run --quiet python -m unittest tests/unit/test_gfsk_presets.py
只用标准库。
"""
from __future__ import annotations

import importlib.util
import json
import os
import statistics
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load(rel: str):
    with open(os.path.join(_ROOT, rel), "r", encoding="utf-8") as f:
        return json.load(f)


def _gen_module():
    path = os.path.join(_ROOT, "scripts", "gen_gfsk_presets.py")
    spec = importlib.util.spec_from_file_location("gen_gfsk_presets", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


TABLE = _load(os.path.join("models", "radiator", "gfsk-presets-v1.json"))
Q0B = _load(os.path.join("data", "iq", "measured", "q0b-params.json"))


def preset(pid: str) -> dict:
    for p in TABLE["presets"]:
        if p["id"] == pid:
            return p
    raise KeyError(pid)


def rc_link(source_id: str) -> dict:
    for s in Q0B["sources"]:
        if s["id"] == source_id:
            for l in s["groups"][0]["links"]:
                if l["role"] == "rc" and l.get("found"):
                    return l
    raise KeyError(source_id)


def top_peak(peaks: list) -> dict:
    return max(peaks, key=lambda p: p["frac"])


class Invariants(unittest.TestCase):
    def test_validate(self):
        items = _gen_module().validate(TABLE)
        self.assertEqual([it["p"]["id"] for it in items], ["frsky-d16v2-fcc", "futaba-sfhss"])

    def test_register_decoding_matches_mpm_comments(self):
        # MPM Futaba_cc2500.ino 的寄存器注释写着 128143 bps、38085.9 Hz、249938 Hz、2399999633 Hz
        g = _gen_module()
        regs = preset("futaba-sfhss")["registers"]
        self.assertEqual(round(g.symbol_rate(regs)), 128143)
        self.assertAlmostEqual(g.deviation(regs), 38085.9, delta=0.05)
        self.assertEqual(int(g.channel_spacing(regs)), 249938)
        self.assertEqual(int(g.base_freq(regs)), 2399999633)
        # FrSkyDVX_common.ino 的注释：「bitrate 70K->77K」
        fr = preset("frsky-d16v2-fcc")["registers"]
        self.assertEqual(round(g.symbol_rate(fr) / 1e3), 77)
        self.assertEqual(round(g.symbol_rate(dict(fr, MDMCFG3="0x61")) / 1e3), 70)

    def test_packet_durations(self):
        fr, sf = preset("frsky-d16v2-fcc"), preset("futaba-sfhss")
        self.assertAlmostEqual(219 / fr["symbol_rate_Hz"], 2.8454e-3, delta=1e-7)
        self.assertAlmostEqual(184 / sf["symbol_rate_Hz"], 1.4359e-3, delta=1e-7)

    def test_modulation_index(self):
        for pid, h in (("frsky-d16v2-fcc", 1.4845), ("futaba-sfhss", 0.5944)):
            p = preset(pid)
            self.assertAlmostEqual(2 * p["deviation_Hz"] / p["symbol_rate_Hz"], h, delta=1e-4, msg=pid)


class MeasuredProvenance(unittest.TestCase):
    """FrSky 预设的 M 档对 Q-0b 的 X20 录音（训练部分）。"""

    L = rc_link("dronerfa_frsky_x20")

    def test_period_against_interval_peak(self):
        pk = top_peak(self.L["interval_peaks_ms"])
        self.assertGreater(pk["frac"], 0.75)
        period_ms = preset("frsky-d16v2-fcc")["frame"]["period_s"] * 1e3
        self.assertLessEqual(abs(period_ms - pk["center"]) / pk["center"], 1e-3)

    def test_packet_length_against_duration(self):
        p = preset("frsky-d16v2-fcc")
        dur = p["frame"]["packets"][0]["n_bits"] / p["symbol_rate_Hz"]
        med = self.L["dur_s"]["median"]
        self.assertLessEqual(abs(dur - med) / med, 1e-3)
        # 比特数就是 round(实测时长 × R)
        self.assertEqual(p["frame"]["packets"][0]["n_bits"], round(med * p["symbol_rate_Hz"]))

    def test_step_against_hop_step_peak(self):
        p = preset("frsky-d16v2-fcc")
        pk = top_peak(self.L["hop_step_peaks_MHz"])
        self.assertGreater(pk["frac"], 0.7)
        self.assertLessEqual(abs(p["hop"]["step"] * 1.5 - pk["center"]) / pk["center"], 1e-3)

    def test_channels_against_measured_points(self):
        pts = self.L["freq_set"]["points_Hz"]
        ch = preset("frsky-d16v2-fcc")["hop"]["channels_Hz"]
        self.assertEqual(len(pts), len(ch))
        res = [a - b for a, b in zip(pts, ch)]
        off = statistics.median(res)
        # 公共偏置是器件晶振（−54 kHz，约 −22 ppm），属 Q-4 的 cfo_ppm，不进预设
        self.assertLess(abs(off + 54e3), 5e3)
        self.assertLessEqual(max(abs(r - off) for r in res), 1e4)

    def test_off_grid_points_are_the_fcc_exceptions(self):
        # 实测两个偏栅格点落在 j = 18 / 44，正是 MPM FrSkyX2 FCC 例外表的 CC2500 信道 90 / 220
        pts = self.L["freq_set"]["points_Hz"]
        grid = [2404e6 + 1.5e6 * j - 54e3 for j in range(47)]
        off = [j for j in range(47) if abs(pts[j] - grid[j]) > 3e5]
        self.assertEqual(off, [18, 44])
        self.assertEqual([5 * j for j in off], [90, 220])


class RecordedGap(unittest.TestCase):
    """S-FHSS 与本地 T14SG 录音的差距：照实钉住，不调参（14 §3.1、D-089）。"""

    def test_t14sg_is_not_sfhss(self):
        L = rc_link("dronerfa_futaba_t14sg")
        sf = preset("futaba-sfhss")
        # 录音 36 点、约 2.04 MHz 间距；S-FHSS 30 点、1.4996 MHz
        self.assertEqual(L["freq_set"]["n_points"], 36)
        self.assertEqual(len(sf["hop"]["channels_Hz"]), 30)
        # 录音 −10 dB 宽 1.32 MHz，是 S-FHSS Carson 带宽的 6 倍以上
        self.assertGreater(L["bw10_Hz"]["median"], 6 * sf["occupied_bw_Hz"])
        # 录音单包 1.93 ms，S-FHSS 1.44 ms
        self.assertGreater(L["dur_s"]["median"], 1.3 * 184 / sf["symbol_rate_Hz"])


if __name__ == "__main__":
    unittest.main()
