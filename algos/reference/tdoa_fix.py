#!/usr/bin/env python3
"""TDOA 双曲定位的独立第二实现（D-053 §7.1；与引擎 `MultiSiteLocator(method=tdoa)` 对拍）。

与 `aoa_fix.py` 同法：显式循环累加（D-046 ⑧），不用 `sum()`、不用 numpy 的成对求和。

它读的是引擎落盘的 `positions.jsonl`（含各站的参与情况与参考站）与场景里的站钟，
按同一套公式重算并逐值比。**到达时间量测本身不落盘**（它是隐含节点的中间量），
所以这里从定位解反推不了；对拍的是「给定同一组站址与残差时几何量算得对不对」——
即协方差、椭圆、CEP、GDOP 四项。要逐值对拍位置本身，需先把 ToaReport 落盘（留待需要时）。

跑法：
    uv run --quiet python algos/reference/tdoa_fix.py data/runs/<task_id>
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aoa_fix import covariance_to_ellipse, ecef_to_lla, lla_to_ecef, to_enu  # noqa: E402

C = 299792458.0


def _inv2(a: float, b: float, c: float):
    det = a * c - b * b
    if abs(det) < 1e-12:
        return None
    return c / det, -b / det, a / det, det


def gdop_of(sites_xy, ref: int, x: float, y: float) -> float:
    """不加权几何矩阵的 √trace((HᵀH)⁻¹)。显式循环累加。"""
    r0 = math.hypot(x - sites_xy[ref][0], y - sites_xy[ref][1]) or 1e-6
    u0x = (x - sites_xy[ref][0]) / r0
    u0y = (y - sites_xy[ref][1]) / r0
    g00 = g01 = g11 = 0.0
    for i, (px, py) in enumerate(sites_xy):
        if i == ref:
            continue
        ri = math.hypot(x - px, y - py) or 1e-6
        hx = (x - px) / ri - u0x
        hy = (y - py) / ri - u0y
        g00 = g00 + hx * hx
        g01 = g01 + hx * hy
        g11 = g11 + hy * hy
    inv = _inv2(g00, g01, g11)
    if inv is None:
        return float("inf")
    return math.sqrt(max(inv[0] + inv[2], 0.0))


def check_run(run_dir: str, tol: float) -> int:
    ppath = os.path.join(run_dir, "positions.jsonl")
    if not os.path.exists(ppath):
        print(f"没有 {ppath}")
        return 1
    with open(ppath, encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh if line.strip()]
    rows = [r for r in rows if r.get("method") in ("tdoa", "aoa_tdoa") and r.get("state") != "invalid"]
    if not rows:
        print("没有时差定位的解可对拍")
        return 1

    # 站址从测向报告里取（它们同属一次运行，站址一致）
    bpath = os.path.join(run_dir, "bearings.jsonl")
    site_pos: dict[str, tuple] = {}
    if os.path.exists(bpath):
        with open(bpath, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                b = json.loads(line)
                site_pos[b["site_id"]] = (b["site_lon"], b["site_lat"], b.get("site_alt_m", 0.0))

    worst_gdop = 0.0
    worst_ell = 0.0
    checked = 0
    for r in rows:
        sites = r["participating_sites"]
        if any(s not in site_pos for s in sites):
            continue
        origin = (r["enu_origin"]["lon"], r["enu_origin"]["lat"], r["enu_origin"]["alt_m"])
        xy = []
        for s in sites:
            e, n, _ = to_enu(lla_to_ecef(*site_pos[s]), origin)
            xy.append((e, n))
        fx, fy, _ = to_enu(lla_to_ecef(r["lon"], r["lat"], 0.0), origin)
        ref = sites.index(r["reference_site"])
        g = gdop_of(xy, ref, fx, fy)
        if math.isfinite(g) and r["gdop"] > 0:
            worst_gdop = max(worst_gdop, abs(g - r["gdop"]) / r["gdop"])

        # 协方差 → 椭圆 / CEP：引擎落了 cov_m2，这里独立算一遍椭圆
        cov = r["cov_m2"]
        e2 = covariance_to_ellipse(cov[0], cov[1], cov[2], len(sites))
        for key, got in (("semi_major_m", e2["semi_major_m"]),
                         ("semi_minor_m", e2["semi_minor_m"]),
                         ("rotation_deg", e2["rotation_deg"])):
            want = r["ellipse"][key]
            worst_ell = max(worst_ell, abs(got - want) / max(abs(want), 1e-12))
        worst_ell = max(worst_ell, abs(e2["cep_m"] - r["cep_m"]) / max(abs(r["cep_m"]), 1e-12))
        checked += 1

    # 两个量的容差不同，理由不同：
    #   椭圆与 CEP 直接由落盘的 cov_m2 算出，不经任何坐标换算，判据是严格的 1e-9；
    #   GDOP 要先把落盘的经纬度换回站心平面，而本参考的 ENU → 经纬度 → ENU 往返在 2 km 处
    #   丢约 1 cm（回代时高程按 0 处理），GDOP 对位置的敏感度使它体现为 1e-6 量级。
    #   这是**参考实现自身的坐标往返误差**，不是两侧算法有差别——把 GDOP 也卡在 1e-9
    #   只会逼人去改容差或改参考，不会发现真问题。
    gdop_tol = 1e-5
    ok = checked > 0 and worst_gdop <= gdop_tol and worst_ell <= tol
    print(f"对拍 {checked} 个时差解：椭圆与 CEP 最大相对误差 {worst_ell:.3e}（容差 {tol:.0e}），"
          f"GDOP 最大相对误差 {worst_gdop:.3e}（容差 {gdop_tol:.0e}，受参考实现的经纬度往返限制）")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="TDOA 定位参考实现，与引擎产物逐值对拍")
    ap.add_argument("run_dir", help="data/runs/<task_id>")
    ap.add_argument("--tol", type=float, default=1e-9)
    args = ap.parse_args()
    return check_run(args.run_dir, args.tol)


if __name__ == "__main__":
    sys.exit(main())
