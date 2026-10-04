"""格子文件（`cuav-eval-cells/1`）的读取与校验（试样集，D-092）。

格子文件入库（tests/regression/eval-dataset/<集合>.json），写的是**意图**：每格的接收配置、传播、
S4 怎么取、有哪些平台（每个平台一个位置、一组辐射源、主辐射源的信噪比目标）。平台的位置由
`gen_eval_dataset.py resolve` 解算后冻结进同一个文件的 `resolved` 段，审阅后提交；生成时只读冻结值，
不重新搜索——位置因此是数据，不随搜索代码的改动静默变化（铁律 10）。
"""
from __future__ import annotations

import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(_HERE))
CELLS_DIR = os.path.join(ROOT, "tests", "regression", "eval-dataset")

TOP_KEYS = {"schema_version", "set_id", "name", "stem_prefix", "set_seed", "duration_s", "created_at", "aoi_id",
            "notes", "site", "receivers", "chain", "propagation", "cfo", "frontend_measured", "cells"}
CELL_KEYS = {"id", "title", "receiver", "propagation", "s4", "plan_allow", "platforms"}
PLATFORM_KEYS = {"id", "name", "platform_type", "alt_m", "azimuth_deg", "snr_dB", "primary", "emitters", "search",
                 "range_m", "off", "resolved"}
EMITTER_KEYS = {"id", "name", "equipment_model", "preset", "waveform", "center_Hz", "bw_Hz", "tx_power_dBm",
                "antenna_gain_dBi", "frame_offset_s"}


class CellError(ValueError):
    pass


def path_of(set_id: str) -> str:
    return os.path.join(CELLS_DIR, f"{set_id}.json")


def load(set_id: str) -> dict:
    with open(path_of(set_id), encoding="utf-8") as fh:
        doc = json.load(fh)
    validate(doc)
    return doc


def save(doc: dict) -> None:
    """规范序列化：两格缩进、保留中文、末尾换行（与场景文件同一形式）。"""
    validate(doc)
    with open(path_of(doc["set_id"]), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(doc, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def _keys(obj: dict, allowed: set[str], where: str) -> None:
    extra = set(obj) - allowed
    if extra:
        raise CellError(f"{where} 里有不认识的键 {sorted(extra)}")


def validate(doc: dict) -> None:
    if doc.get("schema_version") != "cuav-eval-cells/1":
        raise CellError("schema_version 应为 cuav-eval-cells/1")
    _keys(doc, TOP_KEYS, "格子文件")
    seen = set()
    for c in doc["cells"]:
        _keys(c, CELL_KEYS, f"格子 {c.get('id')}")
        if c["id"] in seen:
            raise CellError(f"格子 id 重复：{c['id']}")
        seen.add(c["id"])
        if c["receiver"] not in doc["receivers"]:
            raise CellError(f"格子 {c['id']} 的接收配置 {c['receiver']} 不在 receivers 里")
        if c["propagation"] not in doc["propagation"]:
            raise CellError(f"格子 {c['id']} 的传播 {c['propagation']} 不在 propagation 里")
        ems = set()
        for p in c["platforms"]:
            _keys(p, PLATFORM_KEYS, f"格子 {c['id']} 平台 {p.get('id')}")
            for e in p["emitters"]:
                _keys(e, EMITTER_KEYS, f"格子 {c['id']} 辐射源 {e.get('id')}")
                if e["id"] in ems:
                    raise CellError(f"格子 {c['id']} 的辐射源 id 重复：{e['id']}")
                ems.add(e["id"])
                if ("preset" in e) == ("waveform" in e):
                    raise CellError(f"格子 {c['id']} 辐射源 {e['id']}：preset 与 waveform 恰给一个")
            if p.get("off"):
                continue
            if p.get("primary") not in {e["id"] for e in p["emitters"]}:
                raise CellError(f"格子 {c['id']} 平台 {p['id']} 的 primary 不是它的辐射源")
            if "snr_dB" not in p:
                raise CellError(f"格子 {c['id']} 平台 {p['id']} 缺 snr_dB")
