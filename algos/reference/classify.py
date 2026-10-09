#!/usr/bin/env python3
"""模板匹配识别的参考实现（C-4；10 报告 §4.4；EM-S-04 §10.5 / §10.6 / §10.9 的 E2 工程模板加权匹配）。

引擎侧 `engine/src/recognition.cpp` 的 `TemplateClassifier::classify()` 与这里逐步同序，黄金基准
`engine/tests/golden/recognition.json`（本文件 `--write-golden` 生成）逐行对拍，两侧都是 float64 同算法，
后验与距离按相对误差 1e-9 比，标签与判决逐字相同。

口径：
- 区间外距离（EM-S-04 §10.5 区间形式）：对数域特征取 (ln 边界 − ln x) / log_scale，x 先按 log_floor 钳住，
  下界 0 与缺上界视为不设界；线性特征取 (边界 − x) / (半区间宽)。
- 综合距离 D_k = Σ_i w_ik·m_i·d_ik / Σ_i w_ik·m_i，m_i = 该特征在这一行里可用（bandwidth 要有信号 bin，
  hop / interval 要有上一段）；没有一个可用特征的模板不参与（似然 0）。
- L_k = exp(−D_k/2)，L_u = exp(−unknown_distance/2)，先验均匀，p_k = L_k / (Σ_j L_j + L_u)（模板按库里顺序求和）。
- 判决：max p ≥ accept_threshold 且领先次大 ≥ ambiguity_margin → known；领先不足 → ambiguous；否则 unknown
  （最近模板距离 > unknown_distance → unknown_novel，否则 unknown_ambiguous）；特征质量低于 min_quality →
  unknown_low_quality，不算后验。
- 接受门限缺省 0.5（10 报告 §4.4 写 0.6）：未知假设恒占一份似然 exp(−2) ≈ 0.135，四模板下正确类在 D = 0 时
  后验常只有 0.55–0.8——一段 0.5 s 的单音对 cw_beacon D = 0，后验 0.59，0.6 会把它判成 unknown；且 0.6 / 0.2 下
  ambiguous 不可达（p1 ≥ 0.6 蕴含领先 ≥ 0.2）。两条都写进模型卡 §2。

用法：
    uv run --quiet python algos/reference/classify.py --write-golden engine/tests/golden/recognition.json
    uv run --quiet python algos/reference/classify.py --write-golden-v2 engine/tests/golden/recognition_v2.json

库格式 /2（Q-4c，D-094；14 号报告 §8.6）：模板有唯一 id、标签可以重复——一个标签取它几个模板里似然最大的那一个
（不求和，免得模板多的标签先验被抬高），top_n 按标签排；识别行多写 template（获胜标签的那个模板）。
/1 每个标签一个模板，结果逐位不变。
"""
from __future__ import annotations

import argparse
import json
import math
import os

QUALITY_RANK = {"full": 3, "overload": 2, "short": 1, "low_snr": 0}


SCHEMAS = ("cuav-recognition-library/1", "cuav-recognition-library/2")


def load_library(path: str) -> dict:
    """读库。/1 与 /2 两种格式（/2：Q-4c，D-094——模板必有唯一 id、标签可重复、feature_basis）。
    结构校验以引擎为准（未知键、区间颠倒等由 recognition.cpp 的 load_library 拒），这里只取算法要用的量。"""
    with open(path, encoding="utf-8") as fh:
        lib = json.load(fh)
    if lib.get("schema") not in SCHEMAS:
        raise ValueError("模板库 schema 必须是 " + " / ".join(SCHEMAS))
    v2 = lib["schema"] == SCHEMAS[1]
    feats = []
    floors = lib["distance"].get("log_floor", {})
    for name in lib["feature_order"]:
        fd = lib["features"][name]
        log = fd["domain"] == "log"
        feats.append({"name": name, "log": log, "abs": bool(fd.get("abs", False)),
                      "floor": float(floors[name]) if log else 0.0})
    labels: list[str] = []
    for t in lib["templates"]:
        if t["label"] not in labels:
            labels.append(t["label"])
    return {"version": lib["library_version"], "log_scale": float(lib["distance"]["log_scale"]),
            "basis": lib["feature_basis"] if v2 else "frame", "has_ids": v2,
            "accept_threshold": float(lib["decision"]["accept_threshold"])
            if v2 and "accept_threshold" in lib.get("decision", {}) else None,
            "features": feats, "templates": lib["templates"], "labels": labels}


def feature_value(row: dict, fdef: dict):
    """返回 (可用, 值)，与引擎 feature_value 同规则。分子带口径的行里占空比与峰均比是 null（无定义），按缺失算。"""
    n = fdef["name"]
    if n == "bandwidth_Hz":
        if int(row.get("signal_bins", 0)) == 0:
            return False, 0.0
        return True, float(row["bandwidth_Hz"])
    if n in ("duty", "crest_factor_dB") and row.get(n) is None:
        return False, 0.0
    if n in ("duration_s", "duty", "spectral_flatness", "center_Hz", "snr_dB", "crest_factor_dB"):
        return True, float(row[n])
    if n == "hop_from_prev_Hz":
        if not row.get("has_prev", False):
            return False, 0.0
        v = float(row["hop_from_prev_Hz"])
        return True, (abs(v) if fdef["abs"] else v)
    if n == "interval_from_prev_s":
        if not row.get("has_prev", False):
            return False, 0.0
        return True, float(row["interval_from_prev_s"])
    if n in ("band_power_dBm", "peak_dBm"):
        if not row.get("has_dBm", False):
            return False, 0.0
        return True, float(row[n])
    return False, 0.0


def interval_distance(fdef: dict, log_scale: float, x: float, lo: float, hi) -> float:
    if fdef["log"]:
        lx = math.log(max(x, fdef["floor"]))
        if lo > 0.0:
            ll = math.log(lo)
            if lx < ll:
                return (ll - lx) / log_scale
        if hi is not None:
            lu = math.log(hi)
            if lx > lu:
                return (lx - lu) / log_scale
        return 0.0
    s = 0.5 * (hi - lo)
    if x < lo:
        return (lo - x) / s
    if x > hi:
        return (x - hi) / s
    return 0.0


def classify_row(row: dict, lib: dict, accept_threshold: float | None = None, ambiguity_margin: float = 0.2,
                 unknown_distance: float = 4.0, min_quality: str = "short") -> dict:
    # 接受门限没给就取库自己的（/2 的 decision.accept_threshold），库也没有取 0.5——与引擎 configure 同规则
    if accept_threshold is None:
        accept_threshold = lib.get("accept_threshold") or 0.5
    r = {"t_s": row["t_s"], "t_end_s": row["t_end_s"], "segment_id": row["segment_id"],
         "evidence_quality": row["quality"], "library_version": lib["version"]}
    if QUALITY_RANK[row["quality"]] < QUALITY_RANK[min_quality]:
        r.update({"label": "unknown", "result": "unknown", "unknown_kind": "unknown_low_quality",
                  "posterior": 0.0, "distance": None, "top_n": []})
        return r
    tpls = lib["templates"]
    D = [math.inf] * len(tpls)
    L = [0.0] * len(tpls)
    usable = [False] * len(tpls)
    for k, t in enumerate(tpls):
        num = 0.0
        den = 0.0
        for fdef in lib["features"]:
            name = fdef["name"]
            if name not in t["intervals"]:
                continue
            ok, x = feature_value(row, fdef)
            if not ok:
                continue
            lo, hi = t["intervals"][name]
            d = interval_distance(fdef, lib["log_scale"], x, float(lo), None if hi is None else float(hi))
            w = float(t["weights"][name])
            num = num + w * d
            den = den + w
        if den > 0.0:
            D[k] = num / den
            L[k] = math.exp(-D[k] / 2.0)
            usable[k] = True
    # 按标签归并：一个标签取它几个模板里似然最大的那一个（并列取库序在前的）。/1 每个标签一个模板，归并前后逐位相同。
    labels = lib["labels"]
    best = {}
    for k, t in enumerate(tpls):
        if not usable[k]:
            continue
        b = best.get(t["label"])
        if b is None or L[k] > L[b]:
            best[t["label"]] = k
    LL = [L[best[lab]] if lab in best else 0.0 for lab in labels]
    Lu = math.exp(-unknown_distance / 2.0)
    denom = 0.0
    for i in range(len(labels)):
        denom = denom + LL[i]
    denom = denom + Lu
    p = [LL[i] / denom for i in range(len(labels))]
    pu = Lu / denom
    order = sorted(range(len(labels)), key=lambda i: -p[i])   # 稳定排序：并列保持库序
    top = []
    for i in order:
        if labels[i] not in best:
            continue
        top.append({"label": labels[i], "posterior": p[i], "distance": D[best[labels[i]]]})
        if len(top) == 3:
            break
    min_d = math.inf
    for k in range(len(tpls)):
        if usable[k] and D[k] < min_d:
            min_d = D[k]
    p1 = top[0]["posterior"] if top else 0.0
    p2 = top[1]["posterior"] if len(top) > 1 else 0.0
    r["top_n"] = top
    if top and p1 >= accept_threshold:
        r["label"] = top[0]["label"]
        r["posterior"] = p1
        r["distance"] = top[0]["distance"]
        r["result"] = "known" if (p1 - p2 >= ambiguity_margin) else "ambiguous"
        r["unknown_kind"] = None
        if lib.get("has_ids"):
            r["template"] = tpls[best[top[0]["label"]]]["id"]
    else:
        r["label"] = "unknown"
        r["posterior"] = pu
        r["distance"] = None if math.isinf(min_d) else min_d
        r["result"] = "unknown"
        r["unknown_kind"] = "unknown_novel" if (math.isinf(min_d) or min_d > unknown_distance) else "unknown_ambiguous"
    return r


def _row(seg, t0, dur, bw, bins, duty, flat, quality="full", prev=None, **extra) -> dict:
    d = {"t_s": t0, "t_end_s": t0 + dur, "duration_s": dur, "segment_id": seg, "frames": 10,
         "center_Hz": 2.44e9, "bandwidth_Hz": bw, "signal_bins": bins, "has_dBm": True,
         "band_power_dBm": -60.0, "peak_dBm": -65.0, "snr_dB": 12.0, "spectral_flatness": flat,
         "crest_factor_dB": 9.0, "duty": duty, "overload": False, "quality": quality,
         "has_prev": prev is not None,
         "interval_from_prev_s": prev[0] if prev else 0.0, "hop_from_prev_Hz": prev[1] if prev else 0.0}
    d.update(extra)
    return d


def golden_rows() -> list[dict]:
    """手造的特征行，覆盖四类中心、缺上一段、开放集、低质量、短段与线性 / 对数区间两侧的越界。"""
    return [
        _row(0, 0.0, 2.0, 2000.0, 3, 1.0, 0.05),                                  # cw 中心
        _row(1, 3.0, 1.5, 8e6, 800, 0.95, 0.9),                                    # video 中心
        _row(2, 5.0, 0.01, 100e3, 20, 0.2, 0.6, prev=(0.1, 0.0)),                  # telemetry：跳频差 0
        _row(3, 5.2, 0.005, 200e3, 40, 0.3, 0.6, prev=(0.02, 1.2e6)),              # rc_hopping
        _row(4, 6.0, 0.01, 100e3, 20, 0.3, 0.6),                                   # 没有上一段：telemetry 与 rc 同距 → 后验分摊
        _row(5, 7.0, 0.2, 5e5, 100, 0.7, 0.4, prev=(0.5, 50e3)),                   # 谁都不像 → unknown
        _row(6, 8.0, 0.002, 30e3, 4, 0.1, 0.5, quality="short", prev=(0.05, 3e3)), # short 仍算（min_quality = short）
        _row(7, 9.0, 0.002, 0.0, 0, 0.1, 0.5, quality="low_snr"),                  # low_snr → 直接 unknown_low_quality
        _row(8, 10.0, 0.9, 12e3, 2, 0.85, 0.15, prev=(1.0, 0.0)),                  # cw 但时长在下界附近、占空比在区间内
        _row(9, 12.0, 30.0, 25e6, 2000, 1.0, 0.95, prev=(2.0, 1e6)),               # video 大上界内、hop 与 interval 不计
        _row(10, 13.0, 0.05, 20e3, 4, 0.02, 0.3, prev=(0.005, 20e3)),              # telemetry 全部在区间端点
        _row(11, 14.0, 0.5, 100e3, 20, 0.5, 0.9, prev=(0.3, 0.0)),                 # 介于 telemetry 与 video 之间
        _row(12, 15.0, 100.0, 1e5, 20, 0.0, 0.99, prev=(5.0, 0.0)),                # 离谁都远 → unknown_novel
    ]


def write_golden(path: str, library: str) -> int:
    lib = load_library(library)
    params = {"accept_threshold": 0.5, "ambiguity_margin": 0.2, "unknown_distance": 4.0, "min_quality": "short"}
    rows = golden_rows()
    expected = [classify_row(r, lib, **params) for r in rows]
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧模板匹配识别器与 algos/reference/classify.py 的逐行对拍基准（C-4，10 报告 §4.4）",
        "generator": "algos/reference/classify.py --write-golden",
        "library": os.path.relpath(library, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")).replace(os.sep, "/"),
        "library_version": lib["version"],
        "params": params,
        "tolerance": {"rel": 1e-9, "note": "两侧同为 float64 同算法；后验与距离按相对误差 1e-9，标签、判决、unknown_kind、top_n 的顺序逐字相同"},
        "rows": rows,
        "expected": expected,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    for r, e in zip(rows, expected):
        print(f"seg {r['segment_id']:2d} {r['quality']:8s} → {e['result']:9s} {e['label']:16s} p={e['posterior']:.4f} "
              f"D={'—' if e['distance'] is None else f'{e['distance']:.3f}'} {e['unknown_kind'] or ''}")
    return 0


def _sb(seg, t0, dur, bw, flat, prev=None, quality="full", bins=40) -> dict:
    """分子带口径的手造特征行（Q-4c）：占空比与峰均比是 null。"""
    d = _row(seg, t0, dur, bw, bins, None, flat, quality=quality, prev=prev)
    d.update({"basis": "subband", "duty": None, "crest_factor_dB": None,
              "f_lo_Hz": 2.44e9 - bw / 2.0, "f_hi_Hz": 2.44e9 + bw / 2.0})
    return d


def golden_rows_v2() -> list[dict]:
    """库格式 /2 的手造行（Q-4c，D-094）：同一标签两个模板、同频重发、占空比缺失、开放集、低质量。"""
    return [
        _sb(0, 0.0, 0.00107, 18e6, 0.9, prev=(0.002, 0.0)),            # 宽突发 → video_link / wide_burst
        _sb(1, 0.01, 2.0, 2e6, 0.95),                                     # 宽连续：duty 缺失，只靠带宽与时长 → video_link / wide_continuous
        _sb(2, 0.02, 0.0005, 2.2e6, 0.9, prev=(0.0035, 9e6)),            # 中宽跳频 → rc_hopping / mid_hop
        _sb(3, 0.03, 0.0005, 2.2e6, 0.9, prev=(0.0035, 3.0)),            # 同频重发：跳频差落到 1 Hz 下限（测试库的下界故意不含 0）
        _sb(4, 0.04, 0.0028, 2e5, 0.6, prev=(0.004, 4.5e6)),             # 窄跳频 → rc_hopping / narrow_hop
        _sb(5, 0.05, 0.00064, 9e6, 0.95),                                 # 0.64 ms、9 MHz → droneid（与宽突发相邻）
        _sb(6, 0.06, 0.0008, 9e6, 0.95, prev=(0.001, 0.0)),              # 介于 droneid 与宽突发之间 → 歧义或二者之一
        _sb(7, 0.07, 0.2, 5e4, 0.3, prev=(0.5, 0.0)),                    # 离谁都远 → unknown_novel
        _sb(8, 0.08, 0.00002, 3e5, 0.9, quality="short", prev=(0.01, 2e6)),   # short 仍算
        _sb(9, 0.09, 0.0001, 0.0, 0.5, quality="low_snr", bins=0),       # low_snr → unknown_low_quality
    ]


def write_golden_v2(path: str, library: str) -> int:
    lib = load_library(library)
    params = {"accept_threshold": 0.5, "ambiguity_margin": 0.2, "unknown_distance": 4.0, "min_quality": "short"}
    rows = golden_rows_v2()
    expected = [classify_row(r, lib, **params) for r in rows]
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    doc = {
        "schema": "cuav-engine-golden/1",
        "purpose": "引擎侧模板匹配识别器在库格式 /2 下与 algos/reference/classify.py 的逐行对拍基准（Q-4c，D-094）："
                   "同一标签多个模板取似然大的、分子带口径的占空比缺失、识别行写 template",
        "generator": "algos/reference/classify.py --write-golden-v2",
        "library": os.path.relpath(library, root).replace(os.sep, "/"),
        "library_version": lib["version"],
        "feature_basis": lib["basis"],
        "params": params,
        "tolerance": {"rel": 1e-9, "note": "两侧同为 float64 同算法；后验与距离按相对误差 1e-9，标签、模板、判决、unknown_kind、top_n 的顺序逐字相同"},
        "rows": rows,
        "expected": expected,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    for r, e in zip(rows, expected):
        print(f"seg {r['segment_id']:2d} {r['quality']:8s} → {e['result']:9s} {e['label']:12s} {e.get('template') or '':16s} "
              f"p={e['posterior']:.4f} D={'—' if e['distance'] is None else f'{e['distance']:.3f}'} {e['unknown_kind'] or ''}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="模板匹配识别参考实现")
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--library", default=os.path.join(here, "..", "..", "models", "recognition", "library-v1.json"))
    ap.add_argument("--write-golden", help="生成黄金基准到该路径")
    ap.add_argument("--write-golden-v2", help="生成库格式 /2 的黄金基准到该路径（库缺省取测试专用库）")
    args = ap.parse_args(argv)
    if args.write_golden:
        return write_golden(args.write_golden, args.library)
    if args.write_golden_v2:
        lib = args.library
        if lib == ap.get_default("library"):
            lib = os.path.join(here, "..", "..", "engine", "tests", "golden", "recognition_v2_library.json")
        return write_golden_v2(args.write_golden_v2, lib)
    ap.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
