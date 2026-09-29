"""机型预设表 models/radiator/presets-v1.json 的单测（Q-2，决策 D-088）。

三组：
  ① 不变量：直接调生成脚本的 validate()（与生成 C++ 前的核对是同一段代码）；
  ② M 档出处：表里每个标 M 的数都能从 data/iq/measured/q0b-params.json（入库）逐项复算出来——
     改了提取结果却没改预设、或者手抄错了，这里当场红；
  ③ 独立核对：图传的时隙概率只拟合了占空与长突发占比，**每秒突发数没参与拟合**，
     它与实测对得上是一个独立的旁证（A/D/F/G 族 5% 内、C/E 族 10% 内）。
     Mavic 3 的 5.8 GHz 预测 300 次 / 秒对实测 259，差 16%，照实写进模型卡，不在这里放宽断言。

用法：uv run --quiet python -m unittest tests/unit/test_radiator_presets.py
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
    path = os.path.join(_ROOT, "scripts", "gen_radiator_presets.py")
    spec = importlib.util.spec_from_file_location("gen_radiator_presets", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PRESETS = _load(os.path.join("models", "radiator", "presets-v1.json"))
Q0B = _load(os.path.join("data", "iq", "measured", "q0b-params.json"))


def preset(pid: str) -> dict:
    for p in PRESETS["presets"]:
        if p["id"] == pid:
            return p
    raise KeyError(pid)


def group(source_id: str, g: str) -> dict:
    for s in Q0B["sources"]:
        if s["id"] == source_id:
            for gg in s["groups"]:
                if gg["group"] == g:
                    return gg
    raise KeyError((source_id, g))


def link(gg: dict, role: str) -> dict:
    for l in gg["links"]:
        if l["role"] == role and l.get("found"):
            return l
    raise KeyError(role)


def peak_frac(peaks: list, lo: float, hi: float) -> float:
    return sum(p["frac"] for p in peaks if lo <= p["center"] < hi)


def long_share(gg: dict, split_ms: float) -> float:
    pk = gg["video"]["dur_peaks_ms"]
    short = peak_frac(pk, 0.0, split_ms)
    long_ = peak_frac(pk, split_ms, 99.0)
    return long_ / (short + long_)


class Invariants(unittest.TestCase):
    def test_generator_validate(self):
        items = _gen_module().validate(PRESETS)
        self.assertEqual(len(items), len(PRESETS["presets"]))

    def test_droneid_burst_is_643_23_us(self):
        items = {it["p"]["id"]: it for it in _gen_module().validate(PRESETS)}
        n = items["dji-droneid"]["bursts"][0]["length"]
        self.assertEqual(n, 9880)
        self.assertAlmostEqual(n / 15.36e6, 643.229166666e-6, delta=1e-15)

    def test_uplink_burst_lengths(self):
        items = {it["p"]["id"]: it for it in _gen_module().validate(PRESETS)}
        self.assertEqual(items["dji-uplink-1m"]["bursts"][0]["length"], 7680)   # 0.500 ms
        self.assertEqual(items["dji-uplink-2m"]["bursts"][0]["length"], 7680)
        self.assertEqual(items["dji-uplink-4m"]["bursts"][0]["length"], 8417)   # 0.548 ms


class MeasuredProvenance(unittest.TestCase):
    """标 M 的数必须能从 Q-0b 的产物逐项复算。"""

    def test_video_family_a(self):
        gs = [group("dronerfb_dji", g) for g in "ADFG"]
        duty = round(statistics.median(g["video"]["duty_per_block"]["median"] for g in gs), 4)
        lam = round(statistics.median(long_share(g, 1.6) for g in gs), 4)
        for pid in ("dji-video-20m-a", "dji-video-10m"):
            fit = preset(pid)["frame_fit"]
            self.assertEqual(fit["duty"], duty, pid)
            self.assertEqual(fit["long_share"], lam, pid)
        meas = preset("dji-video-20m-a")["frame_fit"]["measured_bursts_per_s"]
        for g, gg in zip("ADFG", gs):
            self.assertEqual(meas[g], gg["video"]["bursts_per_s_by_visibility"]["LOS"])

    def test_video_family_c(self):
        gs = [group("dronerfb_dji", g) for g in "CE"]
        duty = round(statistics.median(g["video"]["duty_per_block"]["median"] for g in gs), 4)
        lam = round(statistics.median(long_share(g, 1.04) for g in gs), 4)
        fit = preset("dji-video-20m-c")["frame_fit"]
        self.assertEqual(fit["duty"], duty)
        self.assertEqual(fit["long_share"], lam)

    def test_video_40m_mavic3(self):
        gg = group("dronerfa_mavic3_5g8", "all")
        fit = preset("dji-video-40m")["frame_fit"]
        self.assertEqual(fit["duty"], gg["video"]["duty_per_block"]["median"])
        self.assertEqual(fit["long_share"], round(long_share(gg, 1.6), 4))

    def _uplink(self, pid: str, groups: str):
        gs = [link(group("dronerfb_dji", g), "uplink") for g in groups]
        p = preset(pid)
        f10 = round(statistics.median(peak_frac(l["interval_peaks_ms"], 9.0, 11.0) for l in gs), 4)
        self.assertEqual(p["frame_fit"]["interval_10ms_share"], f10)
        rep = round(statistics.median(peak_frac(l["hop_step_peaks_MHz"], 0.0, 0.1) for l in gs), 4)
        self.assertEqual(p["hop_repeat_prob"], rep)
        # 单跳宽度：(2K+1)·Δf 取离实测 −10 dB 宽度最近的奇数个子载波
        bw10 = statistics.median(l["bw10_peaks_MHz"][0]["center"] * 1e6 for l in gs)
        n = p["half_subcarriers"] * 2 + 1
        self.assertLessEqual(abs(n * 15e3 - bw10), 15e3)
        # 跳频栅格落在实测频点跨度之内（首末点各差不超过半个间距）
        grid = p["hop_grid"]
        lo = min(l["freq_set"]["min_Hz"] for l in gs)
        hi = max(l["freq_set"]["max_Hz"] for l in gs)
        last = grid["start_Hz"] + grid["spacing_Hz"] * (grid["n_points"] - 1)
        self.assertLessEqual(abs(grid["start_Hz"] - lo), grid["spacing_Hz"] / 2)
        self.assertLessEqual(abs(last - hi), grid["spacing_Hz"] / 2)

    def test_uplink_1m(self):
        self._uplink("dji-uplink-1m", "CE")

    def test_uplink_2m(self):
        self._uplink("dji-uplink-2m", "AG")

    def test_uplink_4m(self):
        self._uplink("dji-uplink-4m", "DF")


class IndependentCheck(unittest.TestCase):
    """每秒突发数没参与拟合：它对得上实测，是模型结构（时隙 + 概率）的旁证。"""

    def _check(self, pid: str, tol: float):
        fit = preset(pid)["frame_fit"]
        meas = statistics.median(fit["measured_bursts_per_s"].values())
        rel = abs(fit["predicted_bursts_per_s"] - meas) / meas
        self.assertLessEqual(rel, tol, f"{pid}：预测 {fit['predicted_bursts_per_s']} 对实测中位 {meas}")

    def test_family_a(self):
        self._check("dji-video-20m-a", 0.05)

    def test_family_c(self):
        self._check("dji-video-20m-c", 0.10)


if __name__ == "__main__":
    unittest.main()
