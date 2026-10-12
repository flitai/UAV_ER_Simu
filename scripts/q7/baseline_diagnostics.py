#!/usr/bin/env python3
"""《本方基准结果》两个不符合现象的诊断取数（Q-7，D-106）：写 `data/eval/<集合>/baseline-diagnostics.json`（入库）。

基准结果里有两个需要解释的现象，原因要从逐段的特征值看，而 `baseline.json` 只有汇总指标：
1. 低信噪比下图传被识别为跳频遥控——取一段（缺省 v20-los-p05）的特征与识别行，按识别结果分组统计；
2. DroneID 广播一段都没有识别对——取一段（缺省 o40-los-p30）里与 DroneID 广播真值同时出现的检测段。

要先保留这两段的运行目录（基准子命令只跑这两段时不改写 baseline.json，指标文件逐字节相同）：
    uv run --quiet --with numpy --with sigmf python scripts/gen_eval_dataset.py baseline --set formal-v1 \\
        --cells v20-los-p05,o40-los-p30 --keep-runs
    python3 scripts/q7/baseline_diagnostics.py [--set formal-v1]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LONG_S = 0.0005       # 「长段」：短于它的段是突发的边角碎片；图传突发 1.07 / 2.14 ms，DroneID 广播 0.643 ms


def rows(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def q3(v: list[float]) -> dict | None:
    """p10 / 中位数 / p90，取法与数据说明里的分位一致（排序后按下标取，不插值）。"""
    if not v:
        return None
    v = sorted(v)
    n = len(v)
    return {"p10": v[n // 10], "median": v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2]), "p90": v[(9 * n) // 10]}


def run_dir(set_id: str, cell: str) -> str:
    d = os.path.join(ROOT, "data", "runs", f"eval-{set_id}-{cell}-baseline")
    if not os.path.isdir(d):
        raise SystemExit(f"没有 {os.path.relpath(d, ROOT)}：先用 baseline --cells {cell} --keep-runs 跑这一段")
    return d


def check_same(set_id: str, cell: str, d: str) -> str:
    """保留下来的运行与基准结果是同一次计算：指标文件逐字节相同。"""
    a = os.path.join(d, "metrics.json")
    b = os.path.join(ROOT, "data", "eval", set_id, "baseline", "metrics", f"fv1-{cell}.metrics.json")
    ha, hb = (hashlib.sha256(open(p, "rb").read()).hexdigest() for p in (a, b))
    if ha != hb:
        raise SystemExit(f"{cell}：保留的运行与基准结果的指标文件不同")
    return ha


def joined(d: str) -> list[tuple[dict, dict]]:
    feats = {(f["site_id"], f["segment_id"]): f for f in rows(os.path.join(d, "features.jsonl"))}
    return [(r, feats[(r["site_id"], r["segment_id"])]) for r in rows(os.path.join(d, "recognitions.jsonl"))
            if (r["site_id"], r["segment_id"]) in feats]


def video_low_snr(set_id: str, cell: str, lib: dict) -> dict:
    d = run_dir(set_id, cell)
    sha = check_same(set_id, cell, d)
    m = json.load(open(os.path.join(d, "metrics.json"), encoding="utf-8"))["sites"][0]
    iv = {t["id"]: t["intervals"] for t in lib["templates"]}
    groups = {}
    for r, f in joined(d):
        if f["duration_s"] < LONG_S:
            continue
        g = groups.setdefault(f"{r['label']}|{r['template']}", {"label": r["label"], "template": r["template"], "segments": 0,
                                                                  "bw": [], "hop": [], "flat": [], "snr": []})
        g["segments"] += 1
        g["bw"].append(f["bandwidth_Hz"])
        g["flat"].append(f["spectral_flatness"])
        g["snr"].append(f["snr_dB"])
        if f["hop_from_prev_Hz"] is not None:
            g["hop"].append(abs(f["hop_from_prev_Hz"]))
    out = []
    vi, ui = iv["ofdm_video"], iv["ofdm_uplink"]
    for g in sorted(groups.values(), key=lambda g: -g["segments"]):
        out.append({"label": g["label"], "template": g["template"], "segments": g["segments"],
                    "bandwidth_Hz": q3(g["bw"]), "hop_from_prev_abs_Hz": q3(g["hop"]),
                    "spectral_flatness": q3(g["flat"]), "snr_dB": q3(g["snr"]),
                    "hop_known": len(g["hop"]),
                    "hop_in_video_interval": sum(vi["hop_from_prev_Hz"][0] <= h <= vi["hop_from_prev_Hz"][1] for h in g["hop"]),
                    "hop_in_uplink_interval": sum(ui["hop_from_prev_Hz"][0] <= h <= ui["hop_from_prev_Hz"][1] for h in g["hop"]),
                    "bandwidth_in_video_interval": sum(vi["bandwidth_Hz"][0] <= b <= vi["bandwidth_Hz"][1] for b in g["bw"])})
    tf = m["segments_tf"]
    return {"segment": f"fv1-{cell}", "metrics_sha256": sha, "long_segment_min_s": LONG_S,
            "bursts": {k: tf[k] for k in ("truth", "matched", "segments", "fragments", "false_segments")},
            "recognition": {k: m["recognition"][k] for k in ("evaluated", "accuracy")},
            "template_intervals": {"ofdm_video": {"hop_from_prev_Hz": vi["hop_from_prev_Hz"], "bandwidth_Hz": vi["bandwidth_Hz"]},
                                   "ofdm_uplink": {"hop_from_prev_Hz": ui["hop_from_prev_Hz"], "bandwidth_Hz": ui["bandwidth_Hz"]}},
            "groups": out}


def droneid(set_id: str, cell: str, lib: dict) -> dict:
    d = run_dir(set_id, cell)
    sha = check_same(set_id, cell, d)
    m = json.load(open(os.path.join(d, "metrics.json"), encoding="utf-8"))["sites"][0]
    truth = [t for t in rows(os.path.join(d, "truth.jsonl")) if t.get("label") == "droneid"]
    pairs = joined(d)
    bursts = []
    for t in truth:
        segs = []
        for r, f in pairs:
            if f["t_s"] < t["t_end_s"] and f["t_end_s"] > t["t_s"] and f["f_lo_Hz"] < t["center_Hz"] + 0.5 * t["bw_Hz"] \
                    and f["f_hi_Hz"] > t["center_Hz"] - 0.5 * t["bw_Hz"]:
                segs.append({"t_s": f["t_s"], "duration_s": f["duration_s"], "bandwidth_Hz": f["bandwidth_Hz"],
                             "spectral_flatness": f["spectral_flatness"], "hop_from_prev_Hz": f["hop_from_prev_Hz"],
                             "interval_from_prev_s": f["interval_from_prev_s"], "label": r["label"],
                             "template": r["template"], "result": r["result"], "posterior": r["posterior"]})
        bursts.append({"t_s": t["t_s"], "t_end_s": t["t_end_s"], "center_Hz": t["center_Hz"], "bw_Hz": t["bw_Hz"],
                       "segments": segs})
    iv = {t["id"]: t["intervals"] for t in lib["templates"]}
    pe = m["segments_tf"]["per_emitter"]
    did = next(k for k in pe if k.endswith("droneid"))
    return {"segment": f"fv1-{cell}", "metrics_sha256": sha, "droneid_emitter": {did: pe[did]},
            "bursts": bursts, "template_intervals": {k: iv[k] for k in ("droneid", "ofdm_video")}}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--set", default="formal-v1")
    ap.add_argument("--video-cell", default="v20-los-p05")
    ap.add_argument("--droneid-cell", default="o40-los-p30")
    a = ap.parse_args(argv)
    lib = json.load(open(os.path.join(ROOT, "models", "recognition", "library-v2.json"), encoding="utf-8"))
    doc = {"schema_version": "cuav-baseline-diagnostics/1", "set_id": a.set,
           "library_sha256": hashlib.sha256(open(os.path.join(ROOT, "models", "recognition", "library-v2.json"),
                                                 "rb").read()).hexdigest(),
           "video_low_snr": video_low_snr(a.set, a.video_cell, lib), "droneid": droneid(a.set, a.droneid_cell, lib),
           "reproduce": ["uv run --quiet --with numpy --with sigmf python scripts/gen_eval_dataset.py baseline --set "
                         f"{a.set} --cells {a.video_cell},{a.droneid_cell} --keep-runs",
                         f"python3 scripts/q7/baseline_diagnostics.py --set {a.set}"]}
    out = os.path.join(ROOT, "data", "eval", a.set, "baseline-diagnostics.json")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    print(f"写了 {os.path.relpath(out, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
