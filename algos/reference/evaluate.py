#!/usr/bin/env python3
"""真值与评价的参考实现（C-5，D-067；10 报告 §4.5、附录 C）——与引擎 `engine/src/evaluation.cpp` 逐步同序。

两个用途：
  ① 逐值对拍——读 `data/runs/<task_id>/{detections,recognitions,truth}.jsonl` 独立重算，与 `metrics.json`
     的每一节比（整数逐位、浮点相对误差 ≤ 1e-9、null 对 null），有差退出码 1；
  ② 生成黄金基准——`--write-golden engine/tests/golden/metrics.json`：纯 Python 造一组确定性的
     检测 / 识别 / 真值行与期望指标，引擎单测把同一组行喂给 `evaluate()` 逐值比。

口径（两侧共同的契约，改动即基准变化，铁律 10）：
  帧真值   帧中点 t_s + frame_dt/2 落在任一 in_band 真值区间内即有信号（区间先取并集）
  突发匹配 overlap / min(len_det, len_truth) ≥ match_overlap；发现时延 = 首个匹配检测段起点 − 真值起点，钳到 ≥ 0
  识别真值 与检测段重叠最大的真值段的标签（并列取 t_s 早者、再 emitter_id 字典序）
  ROC      统计量升序，门限取 sorted[⌊i·(n−1)/(P−1)⌋] 去重，判决用严格大于（与检测器同）
  分母为零 的比值一律 None（落盘 null）

浮点纪律（D-046 ⑧）：**显式循环累加**，不用 `sum()`（CPython 3.12 起是 Neumaier 补偿求和）、不用 numpy。

跑法：
    uv run --quiet python algos/reference/evaluate.py data/runs/<task_id> [--json out.json]
    uv run --quiet python algos/reference/evaluate.py --write-golden engine/tests/golden/metrics.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

BASE_LABELS = ["video_link", "telemetry_burst", "rc_hopping", "cw_beacon"]


def _ratio(num: int, den: int):
    return None if den == 0 else num / den


def _truth_key(r: dict):
    return (r["t_s"], r.get("emitter_id") or "", r["t_end_s"], r.get("label") or "")


def evaluate(det_rows: list[dict], rec_rows: list[dict], truth_rows: list[dict], params: dict) -> dict:
    """纯函数。params: truth_source, match_overlap, roc_points, frame_dt_s, threshold(可 None), has_rec。"""
    dt = float(params["frame_dt_s"])
    thr = params.get("threshold")
    det = sorted(det_rows, key=lambda r: (r["frame_index"], r["t_s"]))
    truth = sorted(truth_rows, key=_truth_key)
    rec = sorted(rec_rows, key=lambda r: (r["segment_id"], r["t_s"]))

    out: dict = {"frames": {}, "segments": {}, "roc": {}, "recognition": {}, "quality": {}}
    out["quality"]["truth_rows"] = len(truth)
    out["segments"]["truth_out_of_band"] = 0
    for r in truth:
        if not r.get("in_band", True):
            out["segments"]["truth_out_of_band"] += 1

    # ---- 帧级：in_band 真值区间取并集，帧中点落在里面即有信号
    ivs = sorted(((r["t_s"], r["t_end_s"]) for r in truth if r.get("in_band", True)))
    merged: list[list[float]] = []
    for a, b in ivs:
        if merged and a <= merged[-1][1]:
            if b > merged[-1][1]:
                merged[-1][1] = b
        else:
            merged.append([a, b])
    on = [False] * len(det)
    j = 0
    for i, d in enumerate(det):
        mid = d["t_s"] + dt * 0.5
        while j < len(merged) and merged[j][1] <= mid:
            j += 1
        on[i] = j < len(merged) and merged[j][0] <= mid
    tp = fp = fn = tn = truth_on = overload = 0
    threshold_varies = False
    for i, d in enumerate(det):
        hit = bool(d["hit"])
        if on[i]:
            truth_on += 1
        if hit and on[i]:
            tp += 1
        elif hit and not on[i]:
            fp += 1
        elif not hit and on[i]:
            fn += 1
        else:
            tn += 1
        if d.get("overload"):
            overload += 1
        if thr is not None and d["threshold"] != thr:
            threshold_varies = True
    f = out["frames"]
    f.update(total=len(det), truth_on=truth_on, tp=tp, fp=fp, fn=fn, tn=tn)
    f["pd"] = _ratio(tp, tp + fn)
    f["pfa"] = _ratio(fp, fp + tn)
    f["precision"] = _ratio(tp, tp + fp)
    f["recall"] = f["pd"]
    if f["precision"] is not None and f["recall"] is not None:
        s = f["precision"] + f["recall"]
        f["f1"] = 2.0 * f["precision"] * f["recall"] / s if s > 0.0 else 0.0
    else:
        f["f1"] = None
    out["quality"]["overload_frames"] = overload

    # ---- 检测段
    segs: dict[int, dict] = {}
    hits_without_segment = 0
    for d in det:
        if not d["hit"]:
            continue
        sid = d.get("segment_id")
        if sid is None or sid < 0:
            hits_without_segment += 1
            continue
        s = segs.get(sid)
        if s is None:
            segs[sid] = {"id": sid, "start": d["t_s"], "end": d["t_s"] + dt, "matched": False, "best": -1, "best_ov": 0.0}
        else:
            s["start"] = min(s["start"], d["t_s"])
            s["end"] = max(s["end"], d["t_s"] + dt)
    seg_list = [segs[k] for k in sorted(segs)]
    out["segments"]["detected"] = len(seg_list)

    # ---- 突发匹配
    truth_idx = [i for i, r in enumerate(truth) if r.get("in_band", True)]
    out["segments"]["truth"] = len(truth_idx)
    truth_matched = [False] * len(truth)
    first_det_start = [None] * len(truth)
    false_segments = 0
    for s in seg_list:
        len_d = s["end"] - s["start"]
        for ti in truth_idx:
            r = truth[ti]
            ov = min(s["end"], r["t_end_s"]) - max(s["start"], r["t_s"])
            if ov <= 0.0:
                continue
            len_min = min(len_d, r["t_end_s"] - r["t_s"])
            ratio = ov / len_min if len_min > 0.0 else 0.0
            if ratio < params["match_overlap"]:
                continue
            s["matched"] = True
            truth_matched[ti] = True
            if first_det_start[ti] is None or s["start"] < first_det_start[ti]:
                first_det_start[ti] = s["start"]
            if ov > s["best_ov"]:
                s["best_ov"] = ov
                s["best"] = ti
        if not s["matched"]:
            false_segments += 1
    acc = 0.0
    n_delay = 0
    mx = None
    matched = 0
    for ti in truth_idx:
        if not truth_matched[ti]:
            continue
        matched += 1
        delay = first_det_start[ti] - truth[ti]["t_s"]
        if delay < 0.0:
            delay = 0.0
        acc = acc + delay
        n_delay += 1
        if mx is None or delay > mx:
            mx = delay
    sg = out["segments"]
    sg["matched"] = matched
    sg["false_segments"] = false_segments
    sg["pd_segment"] = _ratio(matched, len(truth_idx))
    sg["detect_delay_s"] = {"mean": None if n_delay == 0 else acc / n_delay, "max": mx}

    # ---- ROC
    stats = sorted(d["statistic"] for d in det)
    n = len(stats)
    off_total = len(det) - truth_on

    def point_at(tau: float) -> dict:
        c_on = c_off = 0
        for i, d in enumerate(det):
            if not (d["statistic"] > tau):
                continue
            if on[i]:
                c_on += 1
            else:
                c_off += 1
        return {"threshold": tau, "pd": _ratio(c_on, truth_on), "pfa": _ratio(c_off, off_total)}

    points = []
    if n > 0:
        P = max(int(params["roc_points"]), 1)
        taus: list[float] = []
        for i in range(P):
            idx = 0 if P == 1 else (i * (n - 1)) // (P - 1)
            tau = stats[idx]
            if taus and taus[-1] == tau:
                continue
            taus.append(tau)
        points = [point_at(t) for t in taus]
    out["roc"]["points"] = points
    out["roc"]["working_point"] = point_at(thr) if (thr is not None and n > 0) else {"threshold": thr, "pd": None, "pfa": None}

    # ---- 识别
    rg = out["recognition"]
    if not params.get("has_rec", False):
        rg.update(state="not_applicable", labels=[], confusion=[], evaluated=0, unmatched=0,
                  accuracy=None, per_class=[], unknown_rate=None, ambiguous_rate=None)
    else:
        pairs = []
        extra = set()
        unmatched = evaluated = unknown_count = ambiguous_count = 0
        for r in rec:
            s = segs.get(r["segment_id"])
            if s is None or not s["matched"] or s["best"] < 0:
                unmatched += 1
                continue
            t_label = truth[s["best"]]["label"]
            p_label = "unknown" if r["result"] == "unknown" else r["label"]
            pairs.append((t_label, p_label))
            evaluated += 1
            if r["result"] == "unknown":
                unknown_count += 1
            if r["result"] == "ambiguous":
                ambiguous_count += 1
            extra.add(t_label)
            extra.add(p_label)
        for ti in truth_idx:
            extra.add(truth[ti]["label"])
        labels = list(BASE_LABELS)
        for l in labels:
            extra.discard(l)
        extra.discard("unknown")
        labels += sorted(extra)
        labels.append("unknown")
        pos = {l: i for i, l in enumerate(labels)}
        conf = [[0] * len(labels) for _ in labels]
        for t_label, p_label in pairs:
            conf[pos[t_label]][pos[p_label]] += 1
        diag = 0
        for i in range(len(labels) - 1):
            diag += conf[i][i]
        per_class = []
        for i in range(len(labels) - 1):
            support = predicted = 0
            for jx in range(len(labels)):
                support += conf[i][jx]
                predicted += conf[jx][i]
            tpc = conf[i][i]
            prec = _ratio(tpc, predicted)
            recl = _ratio(tpc, support)
            if prec is not None and recl is not None:
                s2 = prec + recl
                f1 = 2.0 * prec * recl / s2 if s2 > 0.0 else 0.0
            else:
                f1 = None
            per_class.append({"label": labels[i], "support": support, "precision": prec, "recall": recl, "f1": f1})
        rg.update(state="valid", labels=labels, confusion=conf, evaluated=evaluated, unmatched=unmatched,
                  accuracy=_ratio(diag, evaluated), per_class=per_class,
                  unknown_rate=_ratio(unknown_count, evaluated), ambiguous_rate=_ratio(ambiguous_count, evaluated))

    # ---- 状态（只复算引擎 evaluate() 自己给的那几条；组件层追加的原因不在这里）
    state = "valid"
    reasons = []
    if params.get("truth_source") == "none":
        state = "not_applicable"
        reasons.append("未配置真值来源（truth_source = none），指标不适用，只有计数")
    if len(det) == 0:
        state = "invalid"
        reasons.append("没有收到任何检测行")
    if threshold_varies:
        state = "degraded" if state in ("valid", "not_applicable") else state
        reasons.append("检测门限在运行中变化，ROC 工作点按首帧门限计")
    if hits_without_segment > 0:
        state = "degraded" if state in ("valid", "not_applicable") else state
        reasons.append(f"有 {hits_without_segment} 个命中帧没有突发编号，未参与突发级指标")
    out["state"] = state
    out["reasons"] = reasons
    return out


# ---------------------------------------------------------------- 逐值比对

def compare(expected, actual, path: str, diffs: list[str], rel: float = 1e-9, abs_tol: float = 1e-12) -> None:
    """按 expected 的结构比；数值按相对误差，null 对 null，列表按位。"""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            diffs.append(f"{path}: 期望对象，实际 {type(actual).__name__}")
            return
        for k, v in expected.items():
            if k not in actual:
                diffs.append(f"{path}.{k}: 实际缺键")
                continue
            compare(v, actual[k], f"{path}.{k}", diffs, rel, abs_tol)
        return
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            diffs.append(f"{path}: 长度 {len(expected) if isinstance(expected, list) else '?'} 对 {len(actual) if isinstance(actual, list) else '?'}")
            return
        for i, (e, a) in enumerate(zip(expected, actual)):
            compare(e, a, f"{path}[{i}]", diffs, rel, abs_tol)
        return
    if expected is None or actual is None:
        if expected is not actual:
            diffs.append(f"{path}: {expected!r} 对 {actual!r}")
        return
    if isinstance(expected, bool) or isinstance(actual, bool):
        if expected != actual:
            diffs.append(f"{path}: {expected!r} 对 {actual!r}")
        return
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if isinstance(expected, int) and isinstance(actual, int):
            if expected != actual:
                diffs.append(f"{path}: {expected} 对 {actual}")
            return
        e, a = float(expected), float(actual)
        if math.isnan(e) or math.isnan(a):
            diffs.append(f"{path}: NaN 不该出现在落盘文件里")
            return
        err = abs(e - a)
        if err > abs_tol and err > rel * max(abs(e), abs(a)):
            diffs.append(f"{path}: {e!r} 对 {a!r}（差 {err:.3e}）")
        return
    if expected != actual:
        diffs.append(f"{path}: {expected!r} 对 {actual!r}")


def read_jsonl(path: str) -> list[dict]:
    rows: list[dict] = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def check_run(run_dir: str, out_json: str | None) -> int:
    with open(os.path.join(run_dir, "metrics.json"), encoding="utf-8") as fh:
        metrics = json.load(fh)
    if metrics.get("schema_version") != "cuav-metrics/1":
        print("metrics.json 的 schema_version 不是 cuav-metrics/1", file=sys.stderr)
        return 2
    det_all = read_jsonl(os.path.join(run_dir, "detections.jsonl"))
    rec_all = read_jsonl(os.path.join(run_dir, "recognitions.jsonl"))
    truth_all = read_jsonl(os.path.join(run_dir, "truth.jsonl"))
    report = {"task_id": metrics.get("task_id"), "sections": []}
    total_diffs: list[str] = []
    for sec in metrics.get("sites", []):
        node_id = sec["node_id"]
        site_id = sec.get("site_id")
        det = [r for r in det_all if r.get("site_id") == site_id] if site_id else det_all
        rec = [r for r in rec_all if r.get("site_id") == site_id] if site_id else rec_all
        truth = [r for r in truth_all if r.get("node_id") == node_id]
        params = {
            "truth_source": sec["params"]["truth_source"],
            "match_overlap": sec["params"]["match_overlap"],
            "roc_points": sec["params"]["roc_points"],
            "frame_dt_s": sec["detector"]["frame_dt_s"],
            "threshold": sec["detector"].get("threshold"),
            "has_rec": sec["recognition"]["state"] != "not_applicable",
        }
        mine = evaluate(det, rec, truth, params)
        diffs: list[str] = []
        for key in ("frames", "segments", "roc", "recognition"):
            compare(mine[key], sec[key], f"{node_id}.{key}", diffs)
        compare(mine["quality"]["overload_frames"], sec["quality"]["overload_frames"], f"{node_id}.quality.overload_frames", diffs)
        compare(mine["quality"]["truth_rows"], sec["quality"]["truth_rows"], f"{node_id}.quality.truth_rows", diffs)
        report["sections"].append({"node_id": node_id, "site_id": site_id, "detections": len(det), "recognitions": len(rec),
                                   "truth": len(truth), "diffs": diffs, "recomputed": mine})
        total_diffs += diffs
        fr = sec["frames"]
        print(f"{node_id:>14s} site={site_id or '-':8s} 检测行 {len(det)} 识别行 {len(rec)} 真值行 {len(truth)} | "
              f"pd={fr['pd']} pfa={fr['pfa']} f1={fr['f1']} acc={sec['recognition']['accuracy']} | 差异 {len(diffs)}")
    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    for d in total_diffs:
        print("  ✗ " + d)
    print("逐值一致" if not total_diffs else f"共 {len(total_diffs)} 处不一致")
    return 0 if not total_diffs else 1


# ---------------------------------------------------------------- 黄金基准

class Lcg:
    """64 位线性同余，纯整数——生成器不依赖任何浮点库的实现细节。"""

    def __init__(self, seed: int) -> None:
        self.x = seed & 0xFFFFFFFFFFFFFFFF

    def uniform(self) -> float:
        self.x = (self.x * 6364136223846793005 + 1442695040888963407) & 0xFFFFFFFFFFFFFFFF
        return (self.x >> 11) / 9007199254740992.0


def segments_from_hits(hits: list[bool], merge_gap: int) -> list:
    """与检测器同律：命中帧之间的非命中帧数 ≤ merge_gap 即同段；非命中帧 None。"""
    ids: list = [None] * len(hits)
    seg = -1
    last_hit = None
    for i, h in enumerate(hits):
        if not h:
            continue
        if last_hit is None or i - last_hit - 1 > merge_gap:
            seg += 1
        ids[i] = seg
        last_hit = i
    return ids


def golden_case() -> tuple[list[dict], list[dict], list[dict], dict]:
    fs, nfft = 1e6, 256
    dt = nfft / fs
    n_frames = 600
    eta = 1.1
    truth = [
        {"t_s": 0.02, "t_end_s": 0.05, "emitter_id": "e-cw", "label": "cw_beacon", "waveform": "tone",
         "center_Hz": 2.4405e9 + 48828.125, "bw_Hz": 400e3, "in_band": True},
        {"t_s": 0.03, "t_end_s": 0.04, "emitter_id": "e-oob", "label": "video_link", "waveform": "noise",
         "center_Hz": 2.4415e9, "bw_Hz": 1e6, "in_band": False},
        {"t_s": 0.11, "t_end_s": 0.14, "emitter_id": "e-video", "label": "video_link", "waveform": "noise",
         "center_Hz": 2.4405e9, "bw_Hz": 2e6, "in_band": True},
        {"t_s": 0.146, "t_end_s": 0.1495, "emitter_id": "e-noise", "label": "noise", "waveform": "noise",
         "center_Hz": 2.4405e9 - 100e3, "bw_Hz": 50e3, "in_band": True},   # 库里没有的额外标签
    ]
    for k in range(4):   # 四个不与帧边界对齐的突发窗
        a = 0.06 + k * 0.012
        truth.append({"t_s": a, "t_end_s": a + 0.0041, "emitter_id": "e-tele", "label": "telemetry_burst",
                      "waveform": "burst", "center_Hz": 2.4405e9 - 97656.25, "bw_Hz": 200e3, "in_band": True})
    # 重叠的同类真值：cw 段内另一个源短暂同频
    truth.append({"t_s": 0.045, "t_end_s": 0.048, "emitter_id": "e-cw2", "label": "cw_beacon", "waveform": "tone",
                  "center_Hz": 2.4405e9 + 48828.125, "bw_Hz": 400e3, "in_band": True})

    def signal_at(mid: float) -> bool:
        return any(r["t_s"] <= mid < r["t_end_s"] for r in truth)   # 含频段外那段：它在 IQ 里确实有能量

    rng = Lcg(20260914)
    stats, hits = [], []
    for i in range(n_frames):
        mid = i * dt + dt * 0.5
        u = rng.uniform()
        lam = 1.0 + 0.8 * u if signal_at(mid) else 0.6 + 0.55 * u
        stats.append(lam)
        hits.append(lam > eta)
    seg_ids = segments_from_hits(hits, 2)
    det = []
    for i in range(n_frames):
        det.append({"frame_index": i, "start_sample": i * nfft, "t_s": i * dt, "statistic": stats[i], "threshold": eta,
                    "hit": hits[i], "segment_id": seg_ids[i], "overload": 100 <= i < 106})
    # 识别行：按段中点所在的真值给标签，再做几处扰动
    rec = []
    seen = set()
    for i in range(n_frames):
        sid = seg_ids[i]
        if sid is None or sid in seen:
            continue
        seen.add(sid)
        frames = [k for k in range(n_frames) if seg_ids[k] == sid]
        t0, t1 = frames[0] * dt, frames[-1] * dt + dt
        mid = 0.5 * (t0 + t1)
        inside = [r for r in truth if r["in_band"] and r["t_s"] <= mid < r["t_end_s"]]
        label = inside[0]["label"] if inside else "video_link"
        result = "known"
        if sid % 5 == 4:
            label, result = "unknown", "unknown"
        elif sid % 7 == 6:
            label, result = "rc_hopping", "ambiguous"
        rec.append({"t_s": t0, "t_end_s": t1, "segment_id": sid, "label": label, "result": result})
    params = {"truth_source": "scenario", "match_overlap": 0.5, "roc_points": 32, "frame_dt_s": dt,
              "threshold": eta, "has_rec": True}
    return det, rec, truth, params


def write_golden(path: str) -> int:
    det, rec, truth, params = golden_case()
    expected = evaluate(det, rec, truth, params)
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧 evaluate() 与 algos/reference/evaluate.py 的逐值对拍基准（C-5，10 报告 §4.5 / 附录 C）",
        "generator": "algos/reference/evaluate.py --write-golden",
        "params": params,
        "tolerance": {"rel": 1e-9, "abs": 1e-12,
                      "note": "两侧同为 float64 同算法、同一累加顺序；整数与标签逐位相同，null 对 null"},
        "inputs": {"detections": det, "recognitions": rec, "truth": truth},
        "expected": expected,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    f, s, r = expected["frames"], expected["segments"], expected["recognition"]
    print(f"帧 {f['total']}：tp {f['tp']} fp {f['fp']} fn {f['fn']} tn {f['tn']}，pd {f['pd']:.4f} pfa {f['pfa']:.4f} f1 {f['f1']:.4f}")
    print(f"段：真值 {s['truth']}（频段外 {s['truth_out_of_band']}）检测 {s['detected']} 匹配 {s['matched']} 虚警段 {s['false_segments']}，"
          f"pd_segment {s['pd_segment']:.4f}，时延均值 {s['detect_delay_s']['mean']:.6f} 最大 {s['detect_delay_s']['max']:.6f}")
    print(f"识别：评价 {r['evaluated']} 未匹配 {r['unmatched']} 准确率 {r['accuracy']:.4f} 未知率 {r['unknown_rate']:.4f} 存疑率 {r['ambiguous_rate']:.4f}；标签 {r['labels']}")
    print(f"ROC 点数 {len(expected['roc']['points'])}，工作点 pd {expected['roc']['working_point']['pd']:.4f} pfa {expected['roc']['working_point']['pfa']:.4f}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="真值与评价参考实现：对拍 metrics.json 或生成黄金基准")
    ap.add_argument("run_dir", nargs="?", help="data/runs/<task_id>")
    ap.add_argument("--json", help="把逐节的重算结果与差异写到该文件")
    ap.add_argument("--write-golden", help="生成黄金基准到该路径")
    args = ap.parse_args(argv)
    if args.write_golden:
        return write_golden(args.write_golden)
    if not args.run_dir:
        ap.print_help()
        return 1
    return check_run(args.run_dir, args.json)


if __name__ == "__main__":
    raise SystemExit(main())
