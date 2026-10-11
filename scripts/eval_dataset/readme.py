"""数据手册的渲染：tools/eval_dataset/README.template.md 的占位符换成本集合的实际值（试样集，D-092）。"""
from __future__ import annotations

import os
import sys

from . import scenario as S

ROOT = S.ROOT
TEMPLATE = os.path.join(ROOT, "tools", "eval_dataset", "README.template.md")
TEMPLATE_FORMAL = os.path.join(ROOT, "tools", "eval_dataset", "README.formal.template.md")


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


# ---------------------------------------------------------------- 正式集（Q-6，D-104）

GROUP_LABEL = {
    "v10": "DJI 图传 10 MHz + DroneID 广播", "v20": "DJI 图传 20 MHz", "up": "DJI 遥控上行（2.2 MHz 跳频）",
    "frsky": "FrSky D16 遥控（FCC）", "futaba": "Futaba S-FHSS 遥控",
    "o20": "5.8 GHz：DJI 图传 20 MHz + DroneID 广播", "o40": "5.8 GHz：DJI 图传 40 MHz + DroneID 广播",
}
PROP = {"los": "视距", "nlos": "非视距"}


def _snr(x: float) -> str:
    return f"{x:g}".replace("-", "−")


def matrix_table(doc: dict) -> str:
    """单源段的组成：行 = 信号组，列 = 传播 × 信噪比。"""
    from . import matrix as M
    have = {(c["group"]["preset_group"], c["group"]["propagation"], c["group"]["snr_dB"])
            for c in doc["cells"] if c.get("group", {}).get("kind") == "single"}
    head = "| 信号组 | 接收配置 | " + " | ".join(f"{PROP[p]} {_snr(x)} dB" for p in ("los", "nlos") for x in M.SNRS) + " |"
    rows = [head, "|" + "---|" * (2 + 2 * len(M.SNRS))]
    for key in M.SINGLE:
        rcv = next(c["receiver"] for c in doc["cells"] if c.get("group", {}).get("preset_group") == key)
        marks = ["●" if (key, p, x) in have else "—" for p in ("los", "nlos") for x in M.SNRS]
        rows.append(f"| {GROUP_LABEL[key]} | {rcv} | " + " | ".join(marks) + " |")
    return "\n".join(rows)


def _plat_desc(doc: dict, cell: dict) -> str:
    out = []
    for p in cell["platforms"]:
        ems = "、".join(f"{e['equipment_model']}（{e.get('preset', '—')}）" for e in p["emitters"])
        out.append(f"{p['name']}：{ems}")
    return "；".join(out)


def multi_table(doc: dict) -> str:
    rows = ["| 组合 | 平台与信号 | 接收配置 | S4 | 段 |", "|---|---|---|---|---|"]
    seen = {}
    for c in doc["cells"]:
        g = c.get("group", {})
        if g.get("kind") != "multi":
            continue
        seen.setdefault(g["preset_group"], []).append(c)
    labels = {"mxvrc": "图传 + 本机遥控", "mxco": "同频与邻频图传", "mx3rd": "图传 + 本机遥控 + 第三方遥控",
              "mx58": "5.8 GHz 图传 + 邻频图传"}
    for key, cs in seen.items():
        c0 = cs[0]
        segs = "、".join(f"`{S.scenario_id(doc, c)}`" for c in cs)
        rows.append(f"| {labels[key]} | {_plat_desc(doc, c0)} | {c0['receiver']} | {_s4_desc(doc, c0)} | {segs} |")
    return "\n".join(rows)


def _s4_desc(doc: dict, cell: dict) -> str:
    rcv = doc["receivers"][cell["receiver"]]
    s4 = cell["s4"]
    return f"{_mhz(rcv['fs_Hz'] / s4['decim'])} MS/s @ {_mhz(rcv['center_Hz'] + s4['f_shift_Hz'])} MHz"


def bg_table(doc: dict) -> str:
    rows = ["| 段 | 接收配置 | S4 | 接收机 |", "|---|---|---|---|"]
    for c in doc["cells"]:
        if c.get("group", {}).get("kind") != "background":
            continue
        ideal = c.get("impairments") is False
        rows.append(f"| `{S.scenario_id(doc, c)}` | {c['receiver']} | {_s4_desc(doc, c)} | "
                    f"{'理想（不含接收机非理想效应）' if ideal else '含接收机非理想效应'} |")
    return "\n".join(rows)


def omitted_table(doc: dict) -> str:
    om = doc.get("omitted") or []
    if not om:
        return "矩阵中的段全部生成。"
    rows = ["按矩阵应有、但本数据集没有生成的段如下。站址周边建筑较高，楼后阴影深，5.8 GHz 宽带图传在非视距位置上达不到这两档信噪比。",
            "", "| 段标识 | 原因 |", "|---|---|"]
    for o in om:
        rows.append(f"| `{doc['stem_prefix']}-{o['id']}` | {o['reason']} |")
    return "\n".join(rows)


def power_table(doc: dict) -> str:
    rows = ["| 段 | 平台 | 发射功率/dBm | 相对标称/dB | 原因 |", "|---|---|---|---|---|"]
    n = 0
    for c in doc["cells"]:
        for p in c["platforms"]:
            red = p.get("power_reduction")
            rai = (p.get("resolved") or {}).get("power_raise_dB")
            if not red and not rai:
                continue
            tx = S.tx_power_dBm(p, next(e for e in p["emitters"] if e["id"] == p["primary"]))
            if red:
                why, delta = "视距距离超过无线电视距的 80%", -red["dB"]
            else:
                why, delta = "非视距位置在标称功率下达不到目标", rai
            rows.append(f"| `{S.scenario_id(doc, c)}` | {p['name']} | {tx:g} | {_signed(delta, 1)} | {why} |")
            n += 1
    return "\n".join(rows) if n else "本数据集没有调整发射功率的段。"


def sample_relation(doc: dict, extra: dict) -> str:
    rel = extra.get("sample_relation")
    if not rel:
        return "本数据集与样本集没有共用的段。"
    n = len(rel["identical"]) + len(rel["different"])
    lines = [f"样本集的 {n} 段按原配置（同一组随机数种子、同一位置）收入本数据集，段标识按本数据集的规则重新命名，对应关系如下。"]
    if rel["identical"]:
        lines.append(f"其中 {len(rel['identical'])} 段不含 DJI 图传，数据文件与样本集逐字节相同。")
    if rel["different"]:
        same = all(x.get("same_starts") for x in rel["different"])
        lines.append(f"另 {len(rel['different'])} 段含 DJI 图传，与样本集不同：本数据集按经实测核实的循环前缀排布生成图传（见第 6 章），"
                     "样本集生成时图传只在突发的首个符号使用长循环前缀。"
                     + ("两者的注记条数、每条注记的辐射源、起始样点与类别都相同，只有图传突发的长度不同。" if same else
                        "两者的图传突发排布有差异。"))
    rows = ["", "", "| 本数据集的段 | 样本集的段 | 数据文件 |", "|---|---|---|"]
    for x in sorted(rel["identical"] + rel["different"], key=lambda x: x["sample_segment"]):
        same = x in rel["identical"]
        rows.append(f"| `{x['segment']}` | `{x['sample_segment']}` | {'逐字节相同' if same else '图传的循环前缀排布不同'} |")
    return "".join(lines) + "\n".join(rows)


def _formal_reps(doc: dict, records: list[dict], extra: dict) -> dict:
    from . import matrix as M
    cells = {c["id"]: c for c in doc["cells"]}
    ex = next((c for c in doc["cells"] if c["id"] == "v20-los-p30"), doc["cells"][0])
    co = [abs(p["snr_measured_dB_mean_lin_s3"] - p["snr_budget_dB_median"]) for r in records
          if cells[r["id"]].get("group", {}).get("preset_group") == "mxco" and _los(doc, r)
          for p in r["platforms"] if p.get("snr_measured_dB_mean_lin_s3") is not None]
    ver = extra.get("verify") or {}
    return {
        "SAMPLE_NAME": M.SAMPLE_NAME,
        "EXAMPLE_STEM": S.scenario_id(doc, ex),
        "EXAMPLE_PNG": f"{ex['id']}_s3.png",
        "PRESETS_VERSION": extra.get("presets_version") or "—",
        "MATRIX_TABLE": matrix_table(doc),
        "MULTI_TABLE": multi_table(doc),
        "BG_TABLE": bg_table(doc),
        "OMITTED_TABLE": omitted_table(doc),
        "SAMPLE_RELATION": sample_relation(doc, extra),
        "POWER_TABLE": power_table(doc),
        "CO_ADJ_DIFF": f"{max(co):.2f}" if co else "—",
        "N_VERIFY": str(len(ver.get("cells", []))),
        "VERIFY_LIST": "、".join(f"`{S.scenario_id(doc, cells[c])}`" for c in ver.get("cells", [])) or "—",
    }


def render(doc: dict, records: list[dict], meta: dict | None = None) -> str:
    """meta 可给 engine_version；正式集另给 presets_version、verify（抽检的格与结果）、sample_relation。"""
    formal = doc.get("purpose", "sample") == "formal"
    with open(TEMPLATE_FORMAL if formal else TEMPLATE, encoding="utf-8") as fh:
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
    if formal:
        rep.update(_formal_reps(doc, records, meta))
    for k, v in rep.items():
        text = text.replace("{{" + k + "}}", v)
    if "{{" in text:
        raise ValueError("数据手册模板里有没替换的占位符")
    return text
