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
            "notes", "site", "receivers", "chain", "propagation", "cfo", "frontend_measured", "cells", "purpose",
            "omitted"}
CELL_KEYS = {"id", "title", "receiver", "propagation", "s4", "plan_allow", "platforms", "duration_s", "impairments",
             "seed_from", "group"}
PLATFORM_KEYS = {"id", "name", "platform_type", "alt_m", "azimuth_deg", "snr_dB", "primary", "emitters", "search",
                 "range_m", "off", "resolved", "power_reduction"}
PURPOSES = ("sample", "formal")
# seed_from 的格子要与来源格逐字节生成同样的数据：这些集合级的键必须两边相同（正式集 Q-6，D-102）
GEN_KEYS = ("duration_s", "aoi_id", "site", "receivers", "chain", "propagation", "cfo", "frontend_measured")
# 来源格与本格可以不同的键：标识、标题、分组与 seed_from 本身；其余（接收配置、S4、平台与冻结位置）都要相同
SEED_FROM_FREE = {"id", "title", "group", "seed_from"}
EMITTER_KEYS = {"id", "name", "equipment_model", "preset", "waveform", "center_Hz", "bw_Hz", "tx_power_dBm",
                "antenna_gain_dBi", "frame_offset_s"}


class CellError(ValueError):
    pass


def path_of(set_id: str) -> str:
    return os.path.join(CELLS_DIR, f"{set_id}.json")


def load(set_id: str, _depth: int = 0) -> dict:
    with open(path_of(set_id), encoding="utf-8") as fh:
        doc = json.load(fh)
    validate(doc)
    if _depth == 0:
        check_seed_from(doc)
    return doc


def seed_basis(doc: dict, cell: dict) -> tuple[int, str]:
    """派生种子用的（集合种子，格子标识）。

    缺省是本集合的种子与本格标识；`seed_from: {set, cell, set_seed}` 的格子沿用来源格的，
    于是与来源格逐字节生成同样的数据（正式集包含样本集，D-102）。"""
    sf = cell.get("seed_from")
    if sf:
        return int(sf["set_seed"]), str(sf["cell"])
    return int(doc["set_seed"]), str(cell["id"])


def check_seed_from(doc: dict) -> None:
    """seed_from 的格子：来源集合的生成参数与来源格的内容（标识、标题、分组除外）都必须与本格相同，
    否则同一组种子生成的就不是同一份数据。"""
    sources: dict[str, dict] = {}
    for c in doc["cells"]:
        sf = c.get("seed_from")
        if not sf:
            continue
        if set(sf) != {"set", "cell", "set_seed"}:
            raise CellError(f"格子 {c['id']} 的 seed_from 应恰有 set、cell、set_seed 三个键")
        src = sources.get(sf["set"]) or load(sf["set"], _depth=1)
        sources[sf["set"]] = src
        if src["set_seed"] != sf["set_seed"]:
            raise CellError(f"格子 {c['id']}：seed_from.set_seed {sf['set_seed']} 与 {sf['set']} 的 {src['set_seed']} 不同")
        for k in GEN_KEYS:
            if src.get(k) != doc.get(k):
                raise CellError(f"格子 {c['id']}：集合级的 {k} 与来源集合 {sf['set']} 不同，生成的数据不会相同")
        sc = next((x for x in src["cells"] if x["id"] == sf["cell"]), None)
        if sc is None:
            raise CellError(f"格子 {c['id']}：来源集合 {sf['set']} 里没有格子 {sf['cell']}")
        a = {k: v for k, v in c.items() if k not in SEED_FROM_FREE}
        b = {k: v for k, v in sc.items() if k not in SEED_FROM_FREE}
        if a != b:
            diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
            raise CellError(f"格子 {c['id']} 与来源格 {sf['set']}/{sf['cell']} 在 {diff} 上不同")


def save(doc: dict) -> None:
    """规范序列化：两格缩进、保留中文、末尾换行（与场景文件同一形式）。"""
    validate(doc)
    check_seed_from(doc)
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
    if doc.get("purpose", "sample") not in PURPOSES:
        raise CellError(f"purpose 只能是 {PURPOSES}（缺省 sample）")
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
        if "duration_s" in c and not (isinstance(c["duration_s"], (int, float)) and c["duration_s"] > 0):
            raise CellError(f"格子 {c['id']} 的 duration_s 应为正数")
        if c["s4"] is not None and not isinstance(c["s4"], dict):
            raise CellError(f"格子 {c['id']} 的 s4 应为对象，或 null（不开 DDC、只出 S3）")
        if "impairments" in c and c["impairments"] is not False:
            raise CellError(f"格子 {c['id']} 的 impairments 只能写 false（关掉前端非理想与载频偏差）；缺省即打开")
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


def duration_s(doc: dict, cell: dict) -> float:
    """这一格的时长：格子自己的 duration_s（可选，校准集里 DroneID 那几格要跨几个 640 ms 周期）缺省取集合的。"""
    return cell.get("duration_s", doc["duration_s"])
