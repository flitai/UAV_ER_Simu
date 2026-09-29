"""Q-1 导出工具的单测（合成运行目录，不跑引擎）：tools/iq_export_sigmf.py。

06 §9K Q-1 的验收在这里按件钉住：S3 导出读回与 cf32 逐样点相等（无损）；S4 差 ≤ 半个量化步；
SigMF 官方校验器通过（装了 sigmf 包才跑，否则明说跳过）；同输入逐字节复现。另外钉住：
不在 ADC 格点上的 S3 数据中止而不是四舍五入、重量化余量不足即降级、削顶照实计数、真值的样点换算与
引擎同一取整口径、有向天线时预算信噪比写 null 不拿峰值增益顶替、没跑完的运行与对不上的框图拒绝导出。

组件目录取入库的黄金基准 tests/golden/component-catalog.json（CI 保证它与引擎逐字节相同），场景用夹具，
所以不需要引擎二进制。真引擎上的端到端在 tests/regression/iq_export_sigmf.py。

运行：uv run --quiet --with numpy --with sigmf python tests/unit/test_iq_export_sigmf.py
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "tools"))

import iq_export_sigmf as X   # noqa: E402

try:
    import sigmf   # noqa: F401
    HAVE_SIGMF = True
except ImportError:
    HAVE_SIGMF = False

CATALOG = {c["type"]: c for c in json.load(open(os.path.join(_ROOT, "tests", "golden", "component-catalog.json"),
                                                 encoding="utf-8"))["components"]}
FS_DBM = -20.0
AMP = 10 ** (FS_DBM / 20)

SCENARIO = {
    "scenario_id": "fixture-01",
    "sites": [{"id": "site-1"}],
    "emitters": [{"id": "uav-1", "platform_type": "multirotor", "equipment_model": "夹具机",
                  "emission": {"center_Hz": 2.44e9, "bw_Hz": 2e6, "tx_power_dBm": 27}}],
}


def diagram(op_node: str, antenna_pattern: str = "omni", bits: str | None = None) -> dict:
    adc = {"full_scale_dBm": FS_DBM}
    if bits:
        adc["bits"] = bits
    return {
        "schema_version": "cuav-diagram/1", "diagram_id": "fixture-run",
        "scenario_ref": {"scenario_id": "fixture-01", "sha256": "0" * 64},
        "nodes": [
            {"id": "scn", "type": "ScenarioSource", "scene_binding": {"scenario_id": "fixture-01", "site_id": "site-1"},
             "params": {"sample_rate_Hz": 1e6}},
            {"id": "tx", "type": "SceneEmitterSource", "scene_binding": {"scenario_id": "fixture-01", "entity_id": "uav-1"},
             "params": {}},
            {"id": "tx_ant", "type": "AntennaGain", "params": {"role": "tx", "gain_dBi": 2}},
            {"id": "ch", "type": "SceneBoundChannel", "scene_binding": {"scenario_id": "fixture-01", "entity_id": "uav-1"},
             "params": {}},
            {"id": "rx_ant", "type": "AntennaGain", "params": {"role": "rx", "gain_dBi": 3, "pattern": antenna_pattern}},
            {"id": "rx_fe", "type": "ReceiverFrontEnd", "params": {"nf_dB": 6, "gain_dB": 20}},
            {"id": "adc", "type": "AdcQuantizer", "params": adc},
            {"id": "ddc", "type": "DDC", "params": {"decim": 2}},
        ],
        "edges": [
            {"id": "e1", "from": {"node": "tx", "port": "out"}, "to": {"node": "tx_ant", "port": "in"}},
            {"id": "e2", "from": {"node": "scn", "port": "link:uav-1"}, "to": {"node": "tx_ant", "port": "scene"}},
            {"id": "e3", "from": {"node": "tx_ant", "port": "out"}, "to": {"node": "ch", "port": "in"}},
            {"id": "e4", "from": {"node": "ch", "port": "out"}, "to": {"node": "rx_ant", "port": "in"}},
            {"id": "e5", "from": {"node": "rx_ant", "port": "out"}, "to": {"node": "rx_fe", "port": "in"}},
            {"id": "e6", "from": {"node": "rx_fe", "port": "out"}, "to": {"node": "adc", "port": "in"}},
            {"id": "e7", "from": {"node": "adc", "port": "out"}, "to": {"node": "ddc", "port": "in"}},
        ],
        "observation_points": [{"id": "obs", "node": op_node, "port": "out", "products": ["iq"]}],
        "run": {"seed": 1, "duration_s": 1},
    }


def make_run(tmp: str, samples: np.ndarray, fs: float, op_node: str = "adc", run_state: str = "finished",
             truth: list[dict] | None = None, **dkw) -> tuple[str, str]:
    run = os.path.join(tmp, "run")
    os.makedirs(os.path.join(run, "obs"), exist_ok=True)
    d = diagram(op_node, **dkw)
    dpath = os.path.join(run, "diagram.json")
    with open(dpath, "w", encoding="utf-8") as fh:
        json.dump(d, fh)
    with open(os.path.join(run, "events.jsonl"), "w", encoding="utf-8") as fh:
        for p in ({"diagram_id": "fixture-run", "engine_version": "0.1.0", "seed": 1, "seed_source": "diagram",
                   "run_state": "running"},
                  {"diagram_id": "fixture-run", "run_state": run_state, "result": "valid"}):
            fh.write(json.dumps({"seq": 1, "task_id": "fixture-run", "type": "task.state", "t_s": 0.0,
                                 "payload": p}) + "\n")
    samples.astype(np.complex64).tofile(os.path.join(run, "obs", "iq.cf32"))
    with open(os.path.join(run, "obs", "iq.index.json"), "w", encoding="utf-8") as fh:
        json.dump({"kind": "iq", "samples": int(samples.size), "sample_rate_Hz": fs, "center_Hz": 2.44e9,
                   "start_sample": 0, "t0_s": 0.0, "scale": "sqrt_mW", "calibration": {"source": "model"},
                   "clipped_samples": 0, "state": "valid", "state_reasons": [], "trace": {"model_id": "EM-B-11"}}, fh)
    with open(os.path.join(run, "links.jsonl"), "w", encoding="utf-8") as fh:
        for k in range(10):
            fh.write(json.dumps({"link_id": "site-1-uav-1", "valid_from_s": 0.1 * k, "valid_to_s": 0.1 * k + 0.05,
                                 "distance_m": 1000.0, "line_of_sight": True, "path_loss_dB": 100.0,
                                 "doppler_Hz": 50.0}) + "\n")
    with open(os.path.join(run, "truth.jsonl"), "w", encoding="utf-8") as fh:
        for r in truth or []:
            fh.write(json.dumps(r) + "\n")
    return run, dpath


def adc_grid(n: int, bits: int, rng: np.random.Generator) -> np.ndarray:
    """与引擎 AdcQuantizer 同式的格点：码 × 2A/2^bits，码 ∈ [−2^(b−1), 2^(b−1) − 1]，float32 存。"""
    lsb = 2 * AMP / 2 ** bits
    c = rng.integers(-2 ** (bits - 1), 2 ** (bits - 1), size=(n, 2)).astype(np.float64)
    v = (c * lsb).astype(np.float32)
    return v[:, 0] + 1j * v[:, 1]


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cuav_q1_")
        self._orig = (X.find_scenario, X.engine_catalog)
        X.find_scenario = lambda sid, sha: ("fixture", SCENARIO)
        X.engine_catalog = lambda v: CATALOG

    def tearDown(self):
        X.find_scenario, X.engine_catalog = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def out(self, name: str = "out") -> str:
        return os.path.join(self.tmp, name)


class TestS3Lossless(_Base):

    def test_readback_is_bit_exact_for_each_bit_depth(self):
        rng = np.random.default_rng(1)
        for bits in (8, 12, 14, 16):
            with self.subTest(bits=bits):
                x = adc_grid(20000, bits, rng)
                run, dpath = make_run(os.path.join(self.tmp, f"b{bits}"), x, 1e6, bits=str(bits))
                res = X.export_run(run, self.out(f"o{bits}"), dpath)
                self.assertTrue(res[0]["lossless"])
                codes = np.fromfile(os.path.join(self.out(f"o{bits}"), res[0]["stem"] + ".sigmf-data"), dtype="<i2")
                back = (codes.astype(np.float64) / 32768 * AMP).astype(np.float32)
                raw = np.fromfile(os.path.join(run, "obs", "iq.cf32"), dtype="<f4")
                self.assertTrue(np.array_equal(back, raw))
                # 8–16 位的每个电平都是 int16 的整数码：码 = ADC 码 × 2^(16−bits)
                self.assertTrue(np.all(codes % (1 << (16 - bits)) == 0))

    def test_off_grid_data_aborts_instead_of_rounding(self):
        rng = np.random.default_rng(2)
        x = adc_grid(5000, 14, rng)
        x[123] += np.complex64(0.3 * 2 * AMP / 2 ** 14)          # 挪开 0.3 个 ADC 步长 = 1.2 个 int16 码
        run, dpath = make_run(self.tmp, x, 1e6)
        with self.assertRaises(X.ExportError) as cm:
            X.export_run(run, self.out(), dpath)
        self.assertIn("格点", str(cm.exception))


class TestS4Requantization(_Base):

    def test_readback_within_half_code_and_valid_margin(self):
        rng = np.random.default_rng(3)
        n = 50000
        x = ((rng.standard_normal(n) + 1j * rng.standard_normal(n)) * AMP * 0.05).astype(np.complex64)
        run, dpath = make_run(self.tmp, x, 5e5, op_node="ddc")
        r = X.export_run(run, self.out(), dpath)[0]
        self.assertFalse(r["lossless"])
        self.assertEqual(r["export_clipped"], 0)
        self.assertLessEqual(r["max_readback_error_codes"], 0.5)
        codes = np.fromfile(os.path.join(self.out(), r["stem"] + ".sigmf-data"), dtype="<i2").astype(np.float64)
        raw = np.fromfile(os.path.join(run, "obs", "iq.cf32"), dtype="<f4").astype(np.float64)
        self.assertLessEqual(float(np.max(np.abs(codes / 32768 * AMP - raw))), 0.5 * AMP / 32768 * (1 + 1e-6))
        # 余量 = (kT + nf + 增益 + 10·log10 fs) − 10·log10((A/32768)²/6)
        floor = 10 * math.log10(1.380649e-23 * 290 * 1e3) + 6 + 20 + 10 * math.log10(5e5)
        qn = 10 * math.log10((AMP / 32768) ** 2 / 6)
        self.assertAlmostEqual(r["requant_margin_dB"], round(floor - qn, 4), places=4)
        self.assertEqual(r["state"], "valid")

    def test_clipping_counted_and_low_margin_degrades(self):
        rng = np.random.default_rng(4)
        n = 10000
        x = ((rng.standard_normal(n) + 1j * rng.standard_normal(n)) * AMP * 0.01).astype(np.complex64)
        x[:30] = np.complex64(AMP * 1.5 + 0j)                    # 30 个样点超满量程
        run, dpath = make_run(self.tmp, x, 5e5, op_node="ddc")
        # 前端增益压到 −60 dB：底噪逼近导出量化噪声，余量不足 20 dB
        d = json.load(open(dpath, encoding="utf-8"))
        for node in d["nodes"]:
            if node["id"] == "rx_fe":
                node["params"]["gain_dB"] = -60
        json.dump(d, open(dpath, "w", encoding="utf-8"))
        r = X.export_run(run, self.out(), dpath)[0]
        self.assertEqual(r["export_clipped"], 30)
        self.assertLess(r["requant_margin_dB"], 20.0)
        self.assertEqual(r["state"], "degraded")
        meta = json.load(open(os.path.join(self.out(), r["stem"] + ".sigmf-meta"), encoding="utf-8"))
        reasons = " ".join(meta["global"]["cuav:quality"]["reasons"])
        self.assertIn("export_requantization", reasons)
        self.assertIn("export_clip", reasons)


class TestAnnotations(_Base):

    def truth(self):
        return [{"t_s": 0.2500004, "t_end_s": 0.5000006, "emitter_id": "uav-1", "label": "telemetry_burst",
                 "waveform": "burst", "center_Hz": 2.4405e9, "bw_Hz": 2e6, "site_id": "site-1"},
                {"t_s": 0.1, "t_end_s": 0.2, "emitter_id": "uav-1", "label": "cw_beacon", "waveform": "tone",
                 "center_Hz": 2.44e9, "bw_Hz": 1e5, "site_id": "site-2"},            # 别的站：不进本观测点
                {"t_s": 5.0, "t_end_s": 6.0, "emitter_id": "uav-1", "label": "cw_beacon", "waveform": "tone",
                 "center_Hz": 2.44e9, "bw_Hz": 1e5, "site_id": "site-1"}]            # 录制时间外

    def test_sample_conversion_and_budget_snr(self):
        rng = np.random.default_rng(5)
        fs = 1e6
        run, dpath = make_run(self.tmp, adc_grid(int(fs), 14, rng), fs, truth=self.truth())
        r = X.export_run(run, self.out(), dpath)[0]
        self.assertEqual(r["annotations"], 1)
        self.assertEqual(r["truth_rows_site"], 2)
        self.assertEqual(r["outside_capture"], 1)
        a = json.load(open(os.path.join(self.out(), r["stem"] + ".sigmf-meta"), encoding="utf-8"))["annotations"][0]
        # 与引擎 geo::sample_at 同式：floor(t·fs + 0.5)
        self.assertEqual(a["core:sample_start"], 250000)
        self.assertEqual(a["core:sample_count"], 500001 - 250000)
        self.assertEqual(a["core:freq_lower_edge"], 2.4395e9)
        self.assertEqual(a["core:freq_upper_edge"], 2.4415e9)
        self.assertEqual(a["core:label"], "telemetry_burst")
        # 预算信噪比：27 + 2 + 3 − 100 − (kT + 6 + 10·log10 2e6)。段中点 0.3750005 s 取帧中点最近的链路帧：
        # 0.4 s 那帧（中点 0.425，差 0.0499995）比 0.3 s 那帧（中点 0.325，差 0.0500005）近
        want = 27 + 2 + 3 - 100 - (10 * math.log10(1.380649e-23 * 290 * 1e3) + 6 + 10 * math.log10(2e6))
        self.assertAlmostEqual(a["cuav:snr_dB"], want, places=5)
        self.assertEqual(a["cuav:snr_basis"], "link_budget")
        self.assertEqual(a["cuav:link_frame_t_s"], 0.4)
        self.assertNotIn("core:comment", a)            # 不写解释句（14 §5.3）

    def test_directional_antenna_gives_null_snr_not_peak_gain(self):
        rng = np.random.default_rng(6)
        run, dpath = make_run(self.tmp, adc_grid(1000000, 14, rng), 1e6, truth=self.truth(),
                              antenna_pattern="directional")
        r = X.export_run(run, self.out(), dpath)[0]
        a = json.load(open(os.path.join(self.out(), r["stem"] + ".sigmf-meta"), encoding="utf-8"))["annotations"][0]
        self.assertIsNone(a["cuav:snr_dB"])
        self.assertTrue(a["cuav:snr_basis"].startswith("directional_antenna"))


class TestRefusals(_Base):

    def test_unfinished_run(self):
        rng = np.random.default_rng(7)
        run, dpath = make_run(self.tmp, adc_grid(1000, 14, rng), 1e6, run_state="failed")
        with self.assertRaises(X.ExportError):
            X.export_run(run, self.out(), dpath)

    def test_wrong_diagram(self):
        rng = np.random.default_rng(8)
        run, dpath = make_run(self.tmp, adc_grid(1000, 14, rng), 1e6)
        d = json.load(open(dpath, encoding="utf-8"))
        d["diagram_id"] = "someone-else"
        json.dump(d, open(dpath, "w", encoding="utf-8"))
        with self.assertRaises(X.ExportError):
            X.export_run(run, self.out(), dpath)

    def test_op_before_adc_is_refused(self):
        rng = np.random.default_rng(9)
        run, dpath = make_run(self.tmp, adc_grid(1000, 14, rng), 1e6, op_node="rx_fe")
        with self.assertRaises(X.ExportError) as cm:
            X.export_run(run, self.out(), dpath)
        self.assertIn("ADC 之后", str(cm.exception))


class TestDeterminismAndSigmf(_Base):

    def test_two_exports_are_byte_identical(self):
        rng = np.random.default_rng(10)
        run, dpath = make_run(self.tmp, adc_grid(30000, 14, rng), 1e6)
        a = X.export_run(run, self.out("a"), dpath)[0]
        b = X.export_run(run, self.out("b"), dpath)[0]
        for ext in (".sigmf-data", ".sigmf-meta", ".cuav-links.jsonl"):
            ha = hashlib.sha256(open(os.path.join(self.out("a"), a["stem"] + ext), "rb").read()).hexdigest()
            hb = hashlib.sha256(open(os.path.join(self.out("b"), b["stem"] + ext), "rb").read()).hexdigest()
            self.assertEqual(ha, hb, ext)

    def test_meta_has_no_machine_paths_and_no_datetime(self):
        rng = np.random.default_rng(11)
        run, dpath = make_run(self.tmp, adc_grid(1000, 14, rng), 1e6)
        r = X.export_run(run, self.out(), dpath)[0]
        text = open(os.path.join(self.out(), r["stem"] + ".sigmf-meta"), encoding="utf-8").read()
        self.assertNotIn(self.tmp, text)
        self.assertNotIn("/Users/", text)
        self.assertNotIn("core:datetime", text)       # 逻辑仿真没有绝对时间，缺就是缺（铁律 3）

    @unittest.skipUnless(HAVE_SIGMF, "没装 sigmf 包：用 uv run --with sigmf 跑这条（开发期工具，不进交付包）")
    def test_official_validator_passes(self):
        rng = np.random.default_rng(12)
        run, dpath = make_run(self.tmp, adc_grid(20000, 14, rng), 1e6)
        res = X.export_run(run, self.out(), dpath)
        X.validate_with_sigmf(self.out(), [r["stem"] for r in res])


if __name__ == "__main__":
    unittest.main(verbosity=2)
