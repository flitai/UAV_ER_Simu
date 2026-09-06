"""旁挂清单的 schema、四态语义与校验。

规范是 `docs/iq-format.md` 第 4 节，本模块是它的实现。两者不一致时以规范为准，改本模块。
"""
from __future__ import annotations

import datetime as _dt
from typing import Any

MANIFEST_VERSION = "1.0"
PRODUCER_DEFAULT = "tools/iq_convert.py 0.1.0"

# 四态（铁律 15 / docs/iq-format.md 第 7 节）。not_applicable 不参与"取最差"。
VALID = "valid"
DEGRADED = "degraded"
INVALID = "invalid"
NOT_APPLICABLE = "not_applicable"
_SEVERITY = {VALID: 0, DEGRADED: 1, INVALID: 2}

# 04 §10.6 八项质检的键名，次序即原文次序。
CHECK_KEYS = (
    "length_format_metadata",
    "iq_order_endian_range",
    "dc_swap_imbalance",
    "clip_dropout_zero_gap",
    "spectrum_noise_bandwidth",
    "multichannel_alignment",
    "metadata_required_units",
    "hash_duplicate",
)

# 来源标注取值（docs/iq-format.md 第 4.3 节）。
FIELD_SOURCES = ("measured", "paper", "derived", "assumed", "absent")

TIME_BASES = ("logical_sim", "file_acquisition", "device_hw", "external")
# 绝对功率状态（docs/iq-format.md §4.2、§5；D-047）：estimated = 按论文参数或链路预算估算的常数，不冒充 calibrated
ABSOLUTE_POWER_STATES = ("calibrated", "estimated", "uncalibrated")
CALIBRATION_SOURCES = ("measured", "paper", "assumed", "model")
CONTINUITY_FLAGS = ("continuous", "segmented", "damaged", "unknown")
OBSERVATION_POINTS = tuple(f"S{i}" for i in range(7))

# 必填叶子字段：路径 → 允许的类型。None 表示允许 null。
REQUIRED_FIELDS: dict[str, tuple] = {
    "identity.data_id": (str,),
    "identity.created_utc": (str,),
    "identity.data_version": (str,),
    "identity.content_sha256": (str,),
    "identity.producer": (str,),
    "sampling.sample_format": (str,),
    "sampling.sample_rate_Hz": (int, float),
    "sampling.sample_count": (int,),
    "sampling.byte_order": (str,),
    "sampling.iq_layout": (str,),
    "sampling.internal_format": (str,),
    "frequency.center_frequency_Hz": (int, float),
    "frequency.effective_bandwidth_Hz": (int, float),
    "time.start_time": (str, type(None)),
    "time.time_basis": (str,),
    "time.continuity.flag": (str,),
    "channel.station_id": (str,),
    "channel.channel_id": (str,),
    "channel.antenna": (str, type(None)),
    "power.scale": (int, float, type(None)),
    "power.full_scale": (int, float),
    "power.gain_dB": (int, float, type(None)),
    "power.agc": (str,),
    "power.absolute_power": (str,),
    "quality.status": (str,),
    "origin.kind": (str,),
    "origin.dataset": (str, type(None)),
    "origin.source_file": (str, type(None)),
    "permission.owner": (str,),
    "permission.usage_scope": (str,),
    "permission.classification": (str,),
}

# field_sources 必须覆盖的叶子字段（docs/iq-format.md 第 4.3 节末尾的检验规则）。
FIELD_SOURCE_COVERAGE = (
    "sampling.sample_rate_Hz",
    "frequency.center_frequency_Hz",
    "frequency.effective_bandwidth_Hz",
    "time.start_time",
    "time.time_basis",
    "time.continuity.flag",
    "channel.station_id",
    "channel.channel_id",
    "channel.antenna",
    "power.scale",
    "power.gain_dB",
    "power.agc",
)


def worst(*states: str) -> str:
    """取最差的一档；not_applicable 不参与。全是 not_applicable 时返回 not_applicable。"""
    ranked = [s for s in states if s in _SEVERITY]
    if not ranked:
        return NOT_APPLICABLE
    return max(ranked, key=lambda s: _SEVERITY[s])


def get_path(obj: dict, path: str) -> Any:
    cur: Any = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise KeyError(path)
        cur = cur[part]
    return cur


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_manifest(observation_point: str = "S4") -> dict:
    """空清单骨架，所有必填顶层键都在，内容由调用方填。"""
    if observation_point not in OBSERVATION_POINTS:
        raise ValueError(f"观测点必须是 S0–S6 之一，收到 {observation_point!r}")
    return {
        "manifest_version": MANIFEST_VERSION,
        "observation_point": observation_point,
        "identity": {"data_id": "", "created_utc": utc_now(), "data_version": "1.0.0",
                     "content_sha256": "", "producer": PRODUCER_DEFAULT},
        "sampling": {"sample_format": "ci16_le", "sample_rate_Hz": 0.0, "sample_count": 0,
                     "byte_order": "little", "iq_layout": "interleaved_IQ",
                     "internal_format": "cf32"},
        "frequency": {"center_frequency_Hz": 0.0, "effective_bandwidth_Hz": 0.0},
        "time": {"start_time": None, "time_basis": "file_acquisition",
                 "continuity": {"flag": "unknown", "note": ""}},
        "channel": {"station_id": "unknown", "channel_id": "", "antenna": None},
        "power": {"scale": None, "full_scale": 32768, "gain_dB": None, "agc": "unknown",
                  "absolute_power": "uncalibrated", "reason": ""},
        "quality": {"status": NOT_APPLICABLE,
                    "checks": {k: NOT_APPLICABLE for k in CHECK_KEYS}, "reasons": []},
        "origin": {"kind": "measured", "dataset": None, "doi": None, "source_file": None,
                   "source_sha256": None, "conversion": None},
        "model_trace": {"model_id": "", "model_version": "", "model_level": "",
                        "model_layer": "", "credibility": "", "parameter_version": "",
                        "confidence": None, "trace_id": ""},
        "truth": None,
        "permission": {"owner": "", "usage_scope": "", "classification": "unconfirmed",
                       "export_limit": None},
        "segments": [],
        "field_sources": {},
    }


def validate(man: dict) -> list[str]:
    """按 docs/iq-format.md 第 4 节校验清单结构。返回问题列表，空列表表示通过。

    只做结构与取值域检查，不碰样点数据；样点一侧的检查在 iq_survey.py。
    """
    problems: list[str] = []

    if man.get("manifest_version") != MANIFEST_VERSION:
        problems.append(f"manifest_version 应为 {MANIFEST_VERSION}，实为 {man.get('manifest_version')!r}")
    if man.get("observation_point") not in OBSERVATION_POINTS:
        problems.append(f"observation_point 应为 S0–S6，实为 {man.get('observation_point')!r}")

    for path, types in REQUIRED_FIELDS.items():
        try:
            v = get_path(man, path)
        except KeyError:
            problems.append(f"必填字段缺失：{path}")
            continue
        if isinstance(v, bool) or not isinstance(v, types):
            problems.append(f"字段类型不符：{path} = {v!r}")
            continue
        if types == (str,) and not v:
            problems.append(f"必填字段为空串：{path}")

    # 固定取值
    fixed = {"sampling.sample_format": "ci16_le", "sampling.byte_order": "little",
             "sampling.iq_layout": "interleaved_IQ", "sampling.internal_format": "cf32"}
    for path, want in fixed.items():
        try:
            got = get_path(man, path)
        except KeyError:
            continue
        if got != want:
            problems.append(f"{path} 必须固定为 {want!r}，实为 {got!r}")

    # 取值域
    try:
        if get_path(man, "time.time_basis") not in TIME_BASES:
            problems.append(f"time.time_basis 必须是 {TIME_BASES} 之一")
    except KeyError:
        pass
    try:
        if get_path(man, "time.continuity.flag") not in CONTINUITY_FLAGS:
            problems.append(f"time.continuity.flag 必须是 {CONTINUITY_FLAGS} 之一")
    except KeyError:
        pass
    try:
        if get_path(man, "power.full_scale") != 32768:
            problems.append("power.full_scale 必须为 32768")
    except KeyError:
        pass
    try:
        ap = get_path(man, "power.absolute_power")
        if ap not in ABSOLUTE_POWER_STATES:
            problems.append(f"power.absolute_power 必须是 {ABSOLUTE_POWER_STATES} 之一，实为 {ap!r}")
        if ap == "uncalibrated" and not man["power"].get("reason"):
            problems.append("power.absolute_power 为 uncalibrated 时必须填 power.reason")
        if ap == "estimated":
            # 估算常数（D-047）：必须带 calibration 与来源，scale 与 full_scale_dBm 要自洽，不许只改一头
            c = man["power"].get("calibration")
            if not isinstance(c, dict) or not isinstance(c.get("full_scale_dBm"), (int, float)) \
                    or isinstance(c.get("full_scale_dBm"), bool) or c.get("source") not in CALIBRATION_SOURCES:
                problems.append("power.absolute_power 为 estimated 时必须带 power.calibration{full_scale_dBm, source}")
            else:
                sc = man["power"].get("scale")
                want = 10 ** (float(c["full_scale_dBm"]) / 20.0) / 32768
                if not isinstance(sc, (int, float)) or isinstance(sc, bool) or abs(sc - want) > 1e-9 * abs(want):
                    problems.append("power.scale 与 power.calibration.full_scale_dBm 不自洽")
    except KeyError:
        pass

    # 数值合理性
    try:
        fs = get_path(man, "sampling.sample_rate_Hz")
        bw = get_path(man, "frequency.effective_bandwidth_Hz")
        if fs <= 0:
            problems.append("sampling.sample_rate_Hz 必须大于 0")
        elif bw > fs:
            problems.append(f"有效带宽 {bw} 超过采样率 {fs}（docs/iq-format.md 第 2 节）")
    except KeyError:
        pass
    try:
        if get_path(man, "sampling.sample_count") <= 0:
            problems.append("sampling.sample_count 必须大于 0")
    except KeyError:
        pass

    # 质量状态
    q = man.get("quality", {})
    checks = q.get("checks", {})
    missing = [k for k in CHECK_KEYS if k not in checks]
    if missing:
        problems.append(f"quality.checks 缺项：{missing}")
    bad = {k: v for k, v in checks.items()
           if v not in (VALID, DEGRADED, INVALID, NOT_APPLICABLE)}
    if bad:
        problems.append(f"quality.checks 取值非四态：{bad}")
    if q.get("status") not in (VALID, DEGRADED, INVALID, NOT_APPLICABLE):
        problems.append(f"quality.status 取值非四态：{q.get('status')!r}")
    if q.get("status") in (DEGRADED, INVALID) and not q.get("reasons"):
        problems.append("quality.status 非 valid 时 quality.reasons 不得为空")
    if checks and q.get("status") in _SEVERITY:
        expect = worst(*(checks.get(k, NOT_APPLICABLE) for k in CHECK_KEYS))
        if expect != q.get("status"):
            problems.append(f"quality.status 应为八项取最差 {expect!r}，实为 {q.get('status')!r}")

    # 模型追溯八件套（铁律 8、D-012）
    for k in ("model_id", "model_version", "model_level", "model_layer", "credibility",
              "parameter_version", "trace_id"):
        if not man.get("model_trace", {}).get(k):
            problems.append(f"model_trace.{k} 不得为空（铁律 8）")
    layer = man.get("model_trace", {}).get("model_layer")
    if layer and layer not in ("M1", "M2", "M3"):
        problems.append(f"model_trace.model_layer 必须是 M1/M2/M3，实为 {layer!r}")
    cred = man.get("model_trace", {}).get("credibility")
    if cred and cred not in tuple(f"V{i}" for i in range(1, 6)):
        problems.append(f"model_trace.credibility 必须是 V1–V5，实为 {cred!r}")

    # 来源标注覆盖（第 4.3 节检验规则）
    fs_map = man.get("field_sources", {})
    for path in FIELD_SOURCE_COVERAGE:
        if path not in fs_map:
            problems.append(f"field_sources 未覆盖 {path}")
        elif fs_map[path] not in FIELD_SOURCES:
            problems.append(f"field_sources[{path}] 取值非法：{fs_map[path]!r}")

    # 分段索引与样点数一致
    segs = man.get("segments", [])
    if segs:
        total = sum(s.get("sample_count", 0) for s in segs)
        try:
            if total != get_path(man, "sampling.sample_count"):
                problems.append(f"分段样点数合计 {total} 与 sampling.sample_count 不符")
        except KeyError:
            pass

    return problems
