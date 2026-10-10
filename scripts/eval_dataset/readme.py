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
    rows = ["| 段 | 内容 | 接收配置 | 传播 | 主辐射源信噪比目标 | S3 | S4 |", "|---|---|---|---|---|---|---|"]
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
    rows = ["| 段 | 遥控器（机型预设） | S4 中全部在内 / 跨越边界 / 全部在外（次） |", "|---|---|---|"]
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


def _signed(x: float, nd: int = 2) -> str:
    """带正负号的差值；负号用「−」。"""
    s = f"{x:+.{nd}f}"
    return s.replace("-", "−")


def _los(doc: dict, rec: dict) -> bool:
    cells = {c["id"]: c for c in doc["cells"]}
    return cells[rec["id"]]["propagation"] == "los"


def qa_table(doc: dict, records: list[dict]) -> str:
    """各段的核查数值：注记条数、S4 质量状态与重量化余量、主辐射源的两种信噪比及其差。"""
    rows = ["| 段 | 传播 | S3 注记条数 | S4 质量状态 | S4 重量化余量/dB | 主辐射源 | 链路预算信噪比（中位数）/dB | "
            "S3 实测信噪比（线性平均）/dB | 差/dB |",
            "|---|---|---|---|---|---|---|---|---|"]
    cells = {c["id"]: c for c in doc["cells"]}
    for r in records:
        ops = {o["op_id"]: o for o in r["ops"]}
        sid = S.scenario_id(doc, cells[r["id"]])
        prop = "视距" if _los(doc, r) else "非视距"
        state = {"valid": "有效", "degraded": "降级", "invalid": "无效"}.get(ops["s4"]["state"], ops["s4"]["state"])
        margin = ops["s4"].get("requant_margin_dB")
        head = (f"| `{sid}` | {prop} | {ops['s3']['annotations']} | {state} | "
                f"{'—' if margin is None else f'{margin:.1f}'} | ")
        plats = [p for p in r["platforms"] if p.get("snr_target_dB") is not None]
        if not plats:
            rows.append(head + "— | — | — | — |")
            continue
        for i, p in enumerate(plats):
            b, m = p["snr_budget_dB_median"], p["snr_measured_dB_mean_lin_s3"]
            lead = head if i == 0 else "| | | | | | "
            rows.append(lead + f"`{p['primary']}` | {b:.2f} | {m:.2f} | {_signed(m - b)} |")
    return "\n".join(rows)


def render(doc: dict, records: list[dict], meta: dict | None = None) -> str:
    """meta 可给 engine_version；不给时版本一栏写「—」。"""
    with open(TEMPLATE, encoding="utf-8") as fh:
        text = fh.read()
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import iq_export_sigmf as X
    meta = meta or {}
    fm = doc.get("frontend_measured") or {}
    margins = [o["requant_margin_dB"] for r in records for o in r["ops"] if o.get("requant_margin_dB") is not None]
    los = [abs(p["snr_measured_dB_mean_lin_s3"] - p["snr_budget_dB_median"]) for r in records if _los(doc, r)
           for p in r["platforms"] if p.get("snr_target_dB") is not None]
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
        "ENGINE_VERSION": meta.get("engine_version") or "—",
        "EXPORTER_VERSION": X.VERSION,
        "REQ_MIN": f"{min(margins):.1f}" if margins else "—",
        "REQ_MAX": f"{max(margins):.1f}" if margins else "—",
        "LOS_MAX_DIFF": f"{max(los):.2f}" if los else "—",
        "QA_TABLE": qa_table(doc, records),
    }
    for k, v in rep.items():
        text = text.replace("{{" + k + "}}", v)
    if "{{" in text:
        raise ValueError("数据手册模板里有没替换的占位符")
    return text
