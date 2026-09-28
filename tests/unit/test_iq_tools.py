"""tools/ 的单元测试：转换脚本与摸底工具（04 §15.1 第一、二级）。

用合成 HDF5 夹具，不依赖那两个几十 GB 的公开数据集，可进 CI。真实数据上的验证是另一回事，
结论记在 WORKLOG，不在这里跑。

运行：
    uv run --project tools python -m unittest discover -s tests/unit -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

import h5py
import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "tools"))

import iq_convert                                  # noqa: E402
import iq_survey                                   # noqa: E402
from iq_format import calibration as CAL           # noqa: E402
from iq_format import manifest as M                # noqa: E402
from iq_format import readers, writer              # noqa: E402

FS = 32768.0
N = 24576          # 3 帧 8192，够跑频谱
NFFT_N = 8192 * 40  # 安静帧判据要够多帧才分得出十分位


def _codes(n, rng, amp=2000, dtype=np.float32):
    """生成合法的「浮点存整数」样点：值都是 2^-15 的整数倍。"""
    c = rng.integers(-amp, amp, size=n)
    return (c / FS).astype(dtype)


def _write_dronerfb(path, n=N, seed=1, dtype=np.float32, i=None, q=None):
    rng = np.random.default_rng(seed)
    i = _codes(n, rng, dtype=dtype) if i is None else i
    q = _codes(n, rng, dtype=dtype) if q is None else q
    with h5py.File(path, "w") as h:
        h.create_dataset("I", data=i.reshape(1, -1))
        h.create_dataset("Q", data=q.reshape(1, -1))
    return i, q


def _write_dronerfa(path, n=N, seed=2, i0=None, q0=None):
    rng = np.random.default_rng(seed)
    i0 = _codes(n, rng, dtype=np.float64) if i0 is None else i0
    q0 = _codes(n, rng, dtype=np.float64) if q0 is None else q0
    with h5py.File(path, "w") as h:
        h.create_dataset("RF0_I", data=i0.reshape(1, -1))
        h.create_dataset("RF0_Q", data=q0.reshape(1, -1))
        h.create_dataset("RF1_I", data=_codes(n, rng, amp=30, dtype=np.float64).reshape(1, -1))
        h.create_dataset("RF1_Q", data=_codes(n, rng, amp=30, dtype=np.float64).reshape(1, -1))
    return i0, q0


class TestWriterPrimitives(unittest.TestCase):
    def test_lossless_assertion_passes_for_int16_backed_floats(self):
        rng = np.random.default_rng(0)
        x = _codes(1000, rng)
        s = writer.assert_lossless(x)
        self.assertLess(s["max_quantisation_deviation"], 1e-6)
        self.assertLessEqual(s["peak_code"], 2000)

    def test_lossless_assertion_rejects_true_floats(self):
        """源不是 16 位整数底层时必须中止，不得四舍五入（铁律 10）。"""
        x = np.array([0.1234567, -0.7654321], dtype=np.float64)
        with self.assertRaises(writer.LossyConversionError):
            writer.assert_lossless(x)

    def test_interleave_is_iq_order_and_little_endian(self):
        i = np.array([1, 2], dtype=np.float64) / FS
        q = np.array([-1, -2], dtype=np.float64) / FS
        out = writer.interleave(i, q)
        self.assertEqual(out.dtype, np.dtype("<i2"))
        self.assertEqual(list(out), [1, -1, 2, -2])

    def test_ascii_filename_rule(self):
        with self.assertRaises(ValueError):
            writer.check_ascii_name("测试.iq")
        with self.assertRaises(ValueError):
            writer.check_ascii_name("has space.iq")
        writer.check_ascii_name("dronerfa_T0010_D00_S0101_RF0_S4.iq")

    def test_segmentation_and_readback(self):
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(3)
            data = writer.interleave(_codes(1000, rng), _codes(1000, rng))
            w = writer.SegmentedWriter(d, "seg_test", segment_samples=256)
            w.write_chunk(data[:2 * 300])
            w.write_chunk(data[2 * 300:])
            w.close()
            self.assertTrue(w.verify_readback())
            self.assertEqual(w.sample_count, 1000)
            idx = w.segment_index()
            self.assertEqual([s["sample_count"] for s in idx], [256, 256, 256, 232])
            self.assertEqual(sum(s["sample_count"] for s in idx), 1000)
            # 段边界不得丢样：拼回来必须逐位相同
            back = np.concatenate([np.fromfile(os.path.join(d, s["file"]), dtype="<i2")
                                   for s in idx])
            self.assertTrue(np.array_equal(back, data))

    def test_single_segment_keeps_plain_name(self):
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(4)
            w = writer.SegmentedWriter(d, "one", segment_samples=1 << 20)
            w.write_chunk(writer.interleave(_codes(10, rng), _codes(10, rng)))
            w.close()
            self.assertEqual(os.path.basename(w.paths()[0]), "one.iq")


class TestManifestSchema(unittest.TestCase):
    def test_worst_ignores_not_applicable(self):
        self.assertEqual(M.worst(M.VALID, M.NOT_APPLICABLE), M.VALID)
        self.assertEqual(M.worst(M.VALID, M.DEGRADED), M.DEGRADED)
        self.assertEqual(M.worst(M.DEGRADED, M.INVALID), M.INVALID)
        self.assertEqual(M.worst(M.NOT_APPLICABLE, M.NOT_APPLICABLE), M.NOT_APPLICABLE)

    def test_skeleton_alone_does_not_validate(self):
        """空骨架必须验不过：必填项为空正是要拦的（铁律 15）。"""
        self.assertTrue(M.validate(M.new_manifest()))

    def test_missing_field_source_is_reported(self):
        man = _minimal_valid_manifest()
        self.assertEqual(M.validate(man), [])
        man["field_sources"].pop("power.gain_dB")
        self.assertTrue(any("field_sources 未覆盖" in p for p in M.validate(man)))

    def test_bandwidth_over_sample_rate_is_reported(self):
        man = _minimal_valid_manifest()
        man["frequency"]["effective_bandwidth_Hz"] = man["sampling"]["sample_rate_Hz"] * 2
        self.assertTrue(any("超过采样率" in p for p in M.validate(man)))

    def test_status_must_equal_worst_of_checks(self):
        man = _minimal_valid_manifest()
        man["quality"]["checks"]["dc_swap_imbalance"] = M.DEGRADED
        man["quality"]["reasons"] = ["测试"]
        self.assertTrue(any("八项取最差" in p for p in M.validate(man)))

    def test_uncalibrated_requires_reason(self):
        man = _minimal_valid_manifest()
        man["power"]["reason"] = ""
        self.assertTrue(any("必须填 power.reason" in p for p in M.validate(man)))


def _minimal_valid_manifest() -> dict:
    man = M.new_manifest("S4")
    man["identity"].update({"data_id": "x", "content_sha256": "0" * 64})
    man["sampling"].update({"sample_rate_Hz": 80e6, "sample_count": 100})
    man["frequency"].update({"center_frequency_Hz": 2.44e9, "effective_bandwidth_Hz": 80e6})
    man["channel"]["channel_id"] = "CH0"
    man["power"]["reason"] = "缺标定常数"
    man["model_trace"].update({"model_id": "measured:test", "model_version": "1",
                               "model_level": "E4", "model_layer": "M3", "credibility": "V2",
                               "parameter_version": "p1", "trace_id": "t1"})
    man["permission"].update({"owner": "o", "usage_scope": "u"})
    man["quality"]["checks"] = {k: M.VALID for k in M.CHECK_KEYS}
    man["quality"]["status"] = M.VALID
    man["field_sources"] = {k: "paper" for k in M.FIELD_SOURCE_COVERAGE}
    return man


class TestReaders(unittest.TestCase):
    def test_dronerfb_layout_and_paper_provenance(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "A1_IN_S0_slice_43.mat")
            _write_dronerfb(p)
            src, = readers.open_source(p)
            self.assertEqual(src.dataset, "DroneRFb-DIR")
            self.assertEqual(src.sample_rate_Hz, 80e6)
            self.assertEqual(src.center_frequency_Hz, 2.44e9)
            self.assertEqual(src.truth["class_name"], "DJI Mavic 3 Pro")
            self.assertEqual(src.truth["visibility"], "LOS")     # IN = 视距，不是室内
            self.assertEqual(src.truth["distance_m"], 10.0)
            self.assertEqual(src.field_sources["sampling.sample_rate_Hz"], "paper")
            self.assertIsNone(src.gain_dB)

    def test_dronerfb_background_and_nlos(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "background_slice_7.mat")
            _write_dronerfb(p)
            src, = readers.open_source(p)
            self.assertEqual(src.truth["class_code"], "B")
            p2 = os.path.join(d, "C2_OUT_slice_3.mat")
            _write_dronerfb(p2)
            src2, = readers.open_source(p2)
            self.assertEqual(src2.truth["visibility"], "NLOS")   # OUT = 非视距
            self.assertIsNone(src2.truth["session"])

    def test_dronerfa_outdoor_distance_is_interval_not_point(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "T0010_D00_S0101.mat")
            _write_dronerfa(p)
            src, = readers.open_source(p)
            self.assertEqual(src.dataset, "DroneRFa")
            self.assertEqual(src.sample_rate_Hz, 100e6)
            self.assertEqual(src.center_frequency_Hz, 2.44e9)
            self.assertEqual(src.gain_dB, 50.0)
            self.assertEqual(src.truth["distance_range_m"], [20.0, 40.0])
            self.assertIsNone(src.truth["distance_point_m"])     # D-019：区间不得取点值
            self.assertEqual(src.continuity_flag, "damaged")

    def test_dronerfa_inverted_channel_mapping(self):
        """T10010 的 RF0 是 915 MHz，与其余文件相反（实测确认）。"""
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "T10010_S0000.mat")
            _write_dronerfa(p)
            src0, = readers.open_source(p, channel="RF0")
            src1, = readers.open_source(p, channel="RF1")
            self.assertEqual(src0.center_frequency_Hz, 915e6)
            self.assertEqual(src1.center_frequency_Hz, 2.44e9)
            self.assertIsNone(src0.truth["distance_bin"])        # 室内形态无 D 字段
            self.assertEqual(src0.truth["distance_point_m"], 2.0)

    def test_dronerfa_normal_mapping_differs(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "T0011_D10_S1100.mat")
            _write_dronerfa(p)
            src1, = readers.open_source(p, channel="RF1")
            self.assertEqual(src1.center_frequency_Hz, 5.8e9)
            self.assertEqual(src1.truth["band_state"], "switched")

    def test_unknown_layout_raises(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "weird.mat")
            with h5py.File(p, "w") as h:
                h.create_dataset("samples", data=np.zeros((1, 10)))
            with self.assertRaises(ValueError):
                readers.open_source(p)


class TestConvert(unittest.TestCase):
    def test_convert_dronerfb_roundtrip_is_bit_exact(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "A1_IN_S0_slice_1.mat")
            i, q = _write_dronerfb(src)
            out = os.path.join(d, "out")
            mans = iq_convert.convert_one(src, out, verbose=False)
            self.assertEqual(len(mans), 1)
            man = json.load(open(mans[0], encoding="utf-8"))
            self.assertEqual(M.validate(man), [])
            self.assertEqual(man["sampling"]["sample_count"], N)
            self.assertEqual(man["observation_point"], "S4")
            self.assertTrue(man["origin"]["conversion"]["readback_bitexact"])
            back = np.fromfile(os.path.join(out, man["identity"]["data_id"] + ".iq"),
                               dtype="<i2")
            self.assertTrue(np.array_equal(back[0::2], np.round(i * FS).astype(np.int16)))
            self.assertTrue(np.array_equal(back[1::2], np.round(q * FS).astype(np.int16)))

    def test_convert_marks_metadata_degraded_not_crash(self):
        """文件内零元数据 → degraded，不崩溃、不拿默认值顶替（铁律 15）。"""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "T0010_D01_S0001.mat")
            _write_dronerfa(src)
            out = os.path.join(d, "out")
            man = json.load(open(iq_convert.convert_one(src, out, verbose=False)[0],
                                 encoding="utf-8"))
            self.assertEqual(man["quality"]["checks"]["metadata_required_units"], M.DEGRADED)
            self.assertEqual(man["quality"]["status"], M.DEGRADED)
            self.assertTrue(man["quality"]["reasons"])
            self.assertEqual(man["quality"]["checks"]["multichannel_alignment"],
                             M.NOT_APPLICABLE)
            self.assertEqual(man["power"]["absolute_power"], "uncalibrated")
            self.assertIsNone(man["power"]["scale"])

    def test_convert_aborts_on_lossy_source_and_leaves_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "A1_IN_S0_slice_2.mat")
            bad = np.linspace(0.1, 0.2, N).astype(np.float32)
            _write_dronerfb(src, i=bad, q=bad)
            out = os.path.join(d, "out")
            with self.assertRaises(writer.LossyConversionError):
                iq_convert.convert_one(src, out, verbose=False)
            self.assertEqual([f for f in os.listdir(out) if f.endswith(".iq")], [])

    def test_converted_name_is_ascii_and_carries_observation_point(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "T10010_S0000.mat")
            _write_dronerfa(src)
            out = os.path.join(d, "out")
            man = json.load(open(iq_convert.convert_one(src, out, verbose=False)[0],
                                 encoding="utf-8"))
            name = man["identity"]["data_id"]
            self.assertTrue(name.endswith("_RF0_S4"))
            writer.check_ascii_name(name + ".iq")


def _table(source="model", fs_dBm=-1.6) -> dict:
    return {"schema": CAL.SCHEMA, "status": "prototype", "estimated_utc": "2026-09-06T00:00:00Z",
            "datasets": {"DroneRFb-DIR": {"dataset": "DroneRFb-DIR", "full_scale_dBm": fs_dBm,
                                          "source": source, "note": "测试"}}}


class TestCalibration(unittest.TestCase):
    """功率标定常数落进清单（D-047）：估算常数标 estimated 不冒充 calibrated，幂等，校验自洽。"""

    def test_apply_writes_estimated_and_validates(self):
        man = _minimal_valid_manifest()
        man["origin"]["dataset"] = "DroneRFb-DIR"
        self.assertTrue(CAL.apply(man, _table()))
        self.assertEqual(M.validate(man), [])
        self.assertEqual(man["power"]["absolute_power"], "estimated")
        self.assertAlmostEqual(man["power"]["calibration"]["full_scale_dBm"], -1.6)
        self.assertEqual(man["power"]["calibration"]["source"], "model")
        self.assertAlmostEqual(CAL.scale_to_dBm(man["power"]["scale"]), -1.6, places=9)
        self.assertEqual(man["field_sources"]["power.scale"], "derived")     # model → derived（枚举无 model）
        self.assertEqual(man["quality"]["status"], M.DEGRADED)                # 估算常数 = 降级
        self.assertEqual(man["quality"]["checks"]["metadata_required_units"], M.DEGRADED)
        self.assertIn("功率标定常数为估算值（来源：model）", man["quality"]["reasons"])

    def test_apply_is_idempotent_and_skips_unknown_dataset(self):
        man = _minimal_valid_manifest()
        man["origin"]["dataset"] = "DroneRFb-DIR"
        CAL.apply(man, _table())
        once = json.dumps(man, sort_keys=True)
        CAL.apply(man, _table())
        self.assertEqual(json.dumps(man, sort_keys=True), once)
        other = _minimal_valid_manifest()
        other["origin"]["dataset"] = "SomethingElse"
        before = json.dumps(other, sort_keys=True)
        self.assertFalse(CAL.apply(other, _table()))
        self.assertEqual(json.dumps(other, sort_keys=True), before)
        self.assertEqual(other["power"]["absolute_power"], "uncalibrated")

    def test_validate_rejects_inconsistent_or_bare_estimated(self):
        man = _minimal_valid_manifest()
        man["origin"]["dataset"] = "DroneRFb-DIR"
        CAL.apply(man, _table("paper", -50.0))
        self.assertEqual(man["field_sources"]["power.scale"], "paper")
        man["power"]["scale"] = 1e-3                      # 改一头不改另一头
        self.assertTrue(any("不自洽" in p for p in M.validate(man)))
        man["power"].pop("calibration")
        self.assertTrue(any("必须带 power.calibration" in p for p in M.validate(man)))
        man["power"]["absolute_power"] = "guessed"
        self.assertTrue(any("absolute_power 必须是" in p for p in M.validate(man)))

    def test_load_table_checks_schema_and_sources(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "calibration.json")
            bad = _table(); bad["datasets"]["DroneRFb-DIR"]["source"] = "guess"
            json.dump(bad, open(path, "w", encoding="utf-8"))
            with self.assertRaises(ValueError):
                CAL.load_table(path)
            json.dump(_table(), open(path, "w", encoding="utf-8"))
            self.assertEqual(CAL.load_table(path)["datasets"]["DroneRFb-DIR"]["full_scale_dBm"], -1.6)

    def test_convert_with_table_equals_refresh(self):
        """新转换带表 与 先转换再刷新 两条路径产出的清单逐字节相同（D-027 确定性重生成）。"""
        import apply_calibration
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "A1_IN_S0_slice_1.mat")
            _write_dronerfb(src)
            out1 = os.path.join(d, "o1"); out2 = os.path.join(d, "o2")
            table = _table()
            m1 = iq_convert.convert_one(src, out1, verbose=False, calibration=table)[0]
            m2 = iq_convert.convert_one(src, out2, verbose=False)[0]
            counts = apply_calibration.refresh(out2, table)
            self.assertEqual(counts["applied"], 1)
            a = json.load(open(m1, encoding="utf-8")); b = json.load(open(m2, encoding="utf-8"))
            for k in ("power", "quality", "field_sources"):
                self.assertEqual(a[k], b[k])
            self.assertEqual(a["power"]["absolute_power"], "estimated")
            self.assertEqual(apply_calibration.refresh(out2, table)["unchanged"], 1)   # 幂等


class TestSurvey(unittest.TestCase):
    def _convert(self, d, name="A1_IN_S0_slice_1.mat", **kw):
        src = os.path.join(d, name)
        if name.startswith("T"):
            _write_dronerfa(src, **kw)
        else:
            _write_dronerfb(src, **kw)
        out = os.path.join(d, "out")
        man_path = iq_convert.convert_one(src, out, verbose=False)[0]
        stem = json.load(open(man_path, encoding="utf-8"))["identity"]["data_id"]
        return os.path.join(out, stem + ".iq"), man_path

    def test_survey_on_clean_converted_file(self):
        with tempfile.TemporaryDirectory() as d:
            iq, man_path = self._convert(d)
            r = iq_survey.survey_file(iq)
            self.assertEqual(r.checks["length_format_metadata"], M.VALID)
            self.assertEqual(r.checks["iq_order_endian_range"], M.VALID)
            self.assertEqual(r.checks["dc_swap_imbalance"], M.VALID)
            self.assertEqual(r.checks["clip_dropout_zero_gap"], M.VALID)
            self.assertEqual(r.checks["spectrum_noise_bandwidth"], M.VALID)
            # 六项不适用、七项因采集参数来自论文而 degraded —— 这正是这两个数据集的形态
            self.assertEqual(r.checks["multichannel_alignment"], M.NOT_APPLICABLE)
            self.assertEqual(r.checks["metadata_required_units"], M.DEGRADED)
            self.assertEqual(r.status, M.DEGRADED)
            # 回填
            man = json.load(open(man_path, encoding="utf-8"))
            self.assertEqual(man["quality"]["checks"], r.checks)
            self.assertIn("survey", man)

    def test_survey_without_manifest_degrades_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as d:
            iq, man_path = self._convert(d)
            os.remove(man_path)
            r = iq_survey.survey_file(iq)
            self.assertEqual(r.checks["metadata_required_units"], M.DEGRADED)
            self.assertEqual(r.checks["length_format_metadata"], M.DEGRADED)
            self.assertIn(M.DEGRADED, r.checks.values())
            self.assertTrue(any("没有旁挂清单" in x for x in r.reasons))

    def test_survey_detects_iq_imbalance(self):
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(9)
            i = _codes(N, rng, amp=2000)
            q = _codes(N, rng, amp=4000)      # 幅度差一倍，标准差比约 0.5
            iq, _ = self._convert(d, i=i, q=q)
            r = iq_survey.survey_file(iq)
            self.assertEqual(r.checks["dc_swap_imbalance"], M.DEGRADED)
            self.assertTrue(any("标准差比" in x for x in r.reasons))
            self.assertLess(r.stats["std_ratio"], 0.8)

    def test_survey_judges_imbalance_on_quiet_frames_not_whole_file(self):
        """噪声路径不平衡、信号路径平衡时，整片比值会被强信号拉回 1，判据必须看安静帧。

        这是 DroneRFa 上实测到的真实形态（WORKLOG 2026-09-03 第五条日志）：
        背景片整片比值 0.72，含强信号的片整片比值 0.98–1.00，而安静帧一律偏离 1。
        """
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(21)
            n = NFFT_N
            # 噪声：I 支路幅度只有 Q 的 0.7 倍
            i = rng.integers(-700, 700, size=n).astype(np.float64)
            q = rng.integers(-1000, 1000, size=n).astype(np.float64)
            # 前一半叠加一个平衡的强信号，把整片比值拉回接近 1
            t = np.arange(n // 2)
            amp = 12000
            i[:n // 2] += np.round(amp * np.cos(2 * np.pi * 0.11 * t))
            q[:n // 2] += np.round(amp * np.sin(2 * np.pi * 0.11 * t))
            iq_path, _ = self._convert(d, i=(i / FS).astype(np.float32),
                                       q=(q / FS).astype(np.float32), n=n)
            r = iq_survey.survey_file(iq_path)
            self.assertGreater(r.stats["std_ratio"], 0.9)          # 整片被信号拉回
            self.assertLess(r.stats["std_ratio_quiet"], 0.85)      # 安静帧暴露真实不平衡
            self.assertEqual(r.checks["dc_swap_imbalance"], M.DEGRADED)
            self.assertTrue(any("安静帧" in x for x in r.reasons))

    def test_survey_detects_dc_offset(self):
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(10)
            i = _codes(N, rng, amp=1000) + 500 / FS
            q = _codes(N, rng, amp=1000)
            iq, _ = self._convert(d, i=i.astype(np.float32), q=q)
            r = iq_survey.survey_file(iq)
            self.assertEqual(r.checks["dc_swap_imbalance"], M.DEGRADED)
            self.assertTrue(any("直流偏置" in x for x in r.reasons))

    def test_survey_detects_clipping(self):
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(11)
            i = _codes(N, rng, amp=1000)
            i[:200] = 32767 / FS
            iq, _ = self._convert(d, i=i.astype(np.float32))
            r = iq_survey.survey_file(iq)
            self.assertIn(r.checks["clip_dropout_zero_gap"], (M.DEGRADED, M.INVALID))
            self.assertTrue(any("削顶" in x for x in r.reasons))

    def test_survey_detects_zero_gap(self):
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(12)
            i = _codes(N, rng, amp=1000)
            q = _codes(N, rng, amp=1000)
            i[5000:9000] = 0.0
            q[5000:9000] = 0.0
            iq, _ = self._convert(d, i=i.astype(np.float32), q=q.astype(np.float32))
            r = iq_survey.survey_file(iq)
            self.assertEqual(r.checks["clip_dropout_zero_gap"], M.DEGRADED)
            self.assertGreaterEqual(r.stats["longest_zero_run"], 4000 - 1)
            self.assertTrue(any("全零" in x for x in r.reasons))

    def test_survey_detects_tampering(self):
        """清单里的哈希与实际不符 → 第 8 项 invalid。"""
        with tempfile.TemporaryDirectory() as d:
            iq, man_path = self._convert(d)
            man = json.load(open(man_path, encoding="utf-8"))
            man["segments"][0]["sha256"] = "f" * 64
            json.dump(man, open(man_path, "w", encoding="utf-8"))
            r = iq_survey.survey_file(iq, write_back=False)
            self.assertEqual(r.checks["hash_duplicate"], M.INVALID)
            self.assertEqual(r.status, M.INVALID)

    def test_survey_detects_length_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            iq, man_path = self._convert(d)
            man = json.load(open(man_path, encoding="utf-8"))
            man["sampling"]["sample_count"] = 12345
            json.dump(man, open(man_path, "w", encoding="utf-8"))
            r = iq_survey.survey_file(iq, write_back=False)
            self.assertEqual(r.checks["length_format_metadata"], M.INVALID)

    def test_survey_flags_duplicate_content(self):
        with tempfile.TemporaryDirectory() as d:
            iq1, _ = self._convert(d, name="A1_IN_S0_slice_1.mat", seed=5)
            # 同样内容换个名字再转一次
            src2 = os.path.join(d, "A2_IN_S0_slice_1.mat")
            _write_dronerfb(src2, seed=5)
            man2 = iq_convert.convert_one(src2, os.path.join(d, "out"), verbose=False)[0]
            iq2 = os.path.join(os.path.dirname(man2),
                               json.load(open(man2, encoding="utf-8"))["identity"]["data_id"] + ".iq")
            seen: dict[str, str] = {}
            iq_survey.survey_file(iq1, seen_hashes=seen, write_back=False)
            r2 = iq_survey.survey_file(iq2, seen_hashes=seen, write_back=False)
            self.assertEqual(r2.checks["hash_duplicate"], M.DEGRADED)
            self.assertTrue(any("完全重复" in x for x in r2.reasons))


if __name__ == "__main__":
    unittest.main()
