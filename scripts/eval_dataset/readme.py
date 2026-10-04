"""数据手册的渲染：tools/eval_dataset/README.template.md 的占位符换成本集合的实际值（试样集，D-092）。"""
from __future__ import annotations

import os
import sys

from . import scenario as S

ROOT = S.ROOT
TEMPLATE = os.path.join(ROOT, "tools", "eval_dataset", "README.template.md")


def _mhz(x: float) -> str:
    return f"{x / 1e6:g}"


def segments_table(doc: dict, records: list[dict]) -> str:
    rows = ["| 段 | 内容 | 接收 | 传播 | 主辐射源信噪比目标 | S3 | S4 |", "|---|---|---|---|---|---|---|"]
    cells = {c["id"]: c for c in doc["cells"]}
    for r in records:
        c = cells[r["id"]]
        tgt = "；".join(f"{p['primary']} {p['snr_target_dB']:g} dB" for p in r["platforms"]) or "—"
        ops = {o["op_id"]: o for o in r["ops"]}
        fmt = lambda o: f"{_mhz(o['sample_rate_Hz'])} MS/s @ {_mhz(o['center_Hz'])} MHz"   # noqa: E731
        prop = "视距" if c["propagation"] == "los" else "非视距"
        rows.append(f"| `{S.scenario_id(doc, c)}` | {c['title']} | {c['receiver']} | {prop} | {tgt} | "
                    f"{fmt(ops['s3'])} | {fmt(ops['s4'])} |")
    return "\n".join(rows)


def hop_coverage(doc: dict, records: list[dict]) -> str:
    rows = ["| 段 | 遥控 | S4 里整段在内 / 跨边 / 在外 |", "|---|---|---|"]
    cells = {c["id"]: c for c in doc["cells"]}
    n = 0
    for r in records:
        for p in r["platforms"]:
            plat = next(x for x in cells[r["id"]]["platforms"] if x["id"] == p["platform"])
            e = next(x for x in plat["emitters"] if x["id"] == p["primary"])
            if "preset" not in e or not S.is_hopping(e["preset"]):
                continue
            c = p["s4_capture"]
            rows.append(f"| `{S.scenario_id(doc, cells[r['id']])}` | {e['equipment_model']}（{e['preset']}） | "
                        f"{c['full']} / {c['partial']} / {c['none']} |")
            n += 1
    return "\n".join(rows) if n else "（本集合没有跳频遥控段。）"


def render(doc: dict, records: list[dict]) -> str:
    with open(TEMPLATE, encoding="utf-8") as fh:
        text = fh.read()
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import iq_export_sigmf as X
    fm = doc.get("frontend_measured") or {}
    rep = {
        "NAME": doc["name"],
        "N_SEGMENTS": str(len(records)),
        "DURATION": f"{doc['duration_s']:g}",
        "SIGMF_VERSION": X.SIGMF_VERSION,
        "SEGMENTS_TABLE": segments_table(doc, records),
        "HOP_COVERAGE": hop_coverage(doc, records),
        "IQ_GAIN": f"{fm.get('iq_gain_imbalance_dB', 0):g}",
        "IQ_PHASE": f"{fm.get('iq_phase_imbalance_deg', 0):g}",
        "DC_REL": f"{-fm.get('dc_rel_noise_dB', 0):g}",
        "N_BG": str((fm.get("source") or {}).get("n_slices", 0)),
    }
    for k, v in rep.items():
        text = text.replace("{{" + k + "}}", v)
    if "{{" in text:
        raise ValueError("数据手册模板里有没替换的占位符")
    return text
