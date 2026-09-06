"""功率标定常数表（data/iq/measured/calibration.json）与它在旁挂清单里的落点（决策 D-047）。

清单 `power.calibration = {full_scale_dBm, source, note, status, estimated_utc, table}`，
`power.scale = 10^(full_scale_dBm/20) / 32768`（量化码到 sqrt(mW) 的线性换算），
`power.absolute_power = "estimated"`（估算常数不冒充 calibrated），`field_sources["power.scale"]` 按来源映射。
引擎 FileReplaySource 只读 full_scale_dBm / source / note 三个键。

apply() 是幂等的：同一张表施加两次结果相同，tools/iq_convert.py（新转换）与 tools/apply_calibration.py
（刷新已有清单）共用它，保证两条路径产出的清单逐字节相同（D-027 的确定性重生成要求）。
"""
from __future__ import annotations

import json
import math
from typing import Any

from . import manifest as M

FULL_SCALE = 32768
SCHEMA = "cuav-calibration/1"
TABLE_REL_PATH = "data/iq/measured/calibration.json"
SOURCES = ("measured", "paper", "assumed", "model")
# docs/iq-format.md §4.3 的 field_sources 枚举没有 model：链路预算反推的常数按「推导」标
FIELD_SOURCE_OF = {"measured": "measured", "paper": "paper", "assumed": "assumed", "model": "derived"}


def load_table(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        table = json.load(fh)
    if table.get("schema") != SCHEMA:
        raise ValueError(f"标定常数表 schema 应为 {SCHEMA}，实为 {table.get('schema')!r}")
    for name, e in table.get("datasets", {}).items():
        if not isinstance(e.get("full_scale_dBm"), (int, float)) or isinstance(e.get("full_scale_dBm"), bool):
            raise ValueError(f"数据集 {name} 的 full_scale_dBm 不是数")
        if e.get("source") not in SOURCES:
            raise ValueError(f"数据集 {name} 的 source 必须是 {SOURCES} 之一")
    return table


def entry_for(man: dict, table: dict) -> dict | None:
    ds = (man.get("origin") or {}).get("dataset")
    return (table.get("datasets") or {}).get(ds)


def apply(man: dict, table: dict) -> bool:
    """把常数写进清单。数据集不在表里返回 False 且不改任何字段。"""
    e = entry_for(man, table)
    if e is None:
        return False
    fs = float(e["full_scale_dBm"])
    src = e["source"]
    power = man.setdefault("power", {})
    power["scale"] = 10 ** (fs / 20.0) / FULL_SCALE
    power["absolute_power"] = "estimated"
    power["calibration"] = {
        "full_scale_dBm": fs,
        "source": src,
        "note": e.get("note", ""),
        "status": table.get("status", "prototype"),
        "estimated_utc": table.get("estimated_utc"),
        "table": TABLE_REL_PATH,
    }
    power["reason"] = (f"功率标定常数为估算值（来源 {src}，{table.get('status', 'prototype')}），"
                       "不是设备标定记录；甲方数据到货后按 scripts/ds8_calibration.py 重估替换（D-047）")
    man.setdefault("field_sources", {})["power.scale"] = FIELD_SOURCE_OF[src]
    q = man.setdefault("quality", {})
    reasons = q.setdefault("reasons", [])
    tag = f"功率标定常数为估算值（来源：{src}）"
    if tag not in reasons:
        reasons.append(tag)
    checks = q.get("checks") or {}
    if checks.get("metadata_required_units") in (None, M.VALID):
        checks["metadata_required_units"] = M.DEGRADED
        q["checks"] = checks
    q["status"] = M.worst(q.get("status", M.VALID), M.DEGRADED)
    return True


def scale_to_dBm(scale: float) -> float:
    """power.scale 反算 full_scale_dBm，供核对。"""
    return 20.0 * math.log10(scale * FULL_SCALE)


def summary(man: dict) -> dict[str, Any] | None:
    c = (man.get("power") or {}).get("calibration")
    if not c:
        return None
    return {k: c.get(k) for k in ("full_scale_dBm", "source", "status", "estimated_utc")}
