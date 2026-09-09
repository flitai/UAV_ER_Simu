#!/usr/bin/env python3
"""AOA 交叉定位的独立第二实现（D-053 §7.1；与引擎 `MultiSiteLocator(method=aoa)` 对拍）。

用途有两个：
  ① 逐值对拍——从 `bearings.jsonl` 重算，与 `positions.jsonl` 比，判据是相对误差 ≤ 1e-9；
  ② 覆盖率核对——真值落在 2σ 椭圆内的比例应接近 86.5%（二维 1 − exp(−2)，不是一维的 95%）。

浮点纪律（D-046 ⑧）：**显式循环累加**，不用 `sum()`（CPython 3.12 起是 Neumaier 补偿求和）、
不用 numpy 的成对求和——两者都与 C++ 的「acc = acc + x」不逐位相同。

跑法：
    uv run --quiet python algos/reference/aoa_fix.py data/runs/<task_id>
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

# WGS-84，与 geo/ 新写代码同口径（D-009：新代码统一严格 ENU）
_A = 6378137.0
_F = 1.0 / 298.257223563
_E2 = _F * (2.0 - _F)


def lla_to_ecef(lon_deg: float, lat_deg: float, alt_m: float):
    lon = math.radians(lon_deg)
    lat = math.radians(lat_deg)
    n = _A / math.sqrt(1.0 - _E2 * math.sin(lat) ** 2)
    return ((n + alt_m) * math.cos(lat) * math.cos(lon),
            (n + alt_m) * math.cos(lat) * math.sin(lon),
            (n * (1.0 - _E2) + alt_m) * math.sin(lat))


def ecef_to_lla(x: float, y: float, z: float):
    """Bowring 闭式，与 geo/geodesy.cpp 同法。"""
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    ep2 = _E2 / (1.0 - _E2)
    b = _A * math.sqrt(1.0 - _E2)
    th = math.atan2(_A * z, b * p)
    lat = math.atan2(z + ep2 * b * math.sin(th) ** 3, p - _E2 * _A * math.cos(th) ** 3)
    n = _A / math.sqrt(1.0 - _E2 * math.sin(lat) ** 2)
    alt = p / math.cos(lat) - n if abs(math.cos(lat)) > 1e-12 else z / math.sin(lat) - n * (1.0 - _E2)
    return math.degrees(lon), math.degrees(lat), alt


def to_enu(p, origin_lla):
    olon, olat, oalt = origin_lla
    ox, oy, oz = lla_to_ecef(olon, olat, oalt)
    dx, dy, dz = p[0] - ox, p[1] - oy, p[2] - oz
    slon, clon = math.sin(math.radians(olon)), math.cos(math.radians(olon))
    slat, clat = math.sin(math.radians(olat)), math.cos(math.radians(olat))
    return (-slon * dx + clon * dy,
            -slat * clon * dx - slat * slon * dy + clat * dz,
            clat * clon * dx + clat * slon * dy + slat * dz)


def from_enu(e, n, u, origin_lla):
    olon, olat, oalt = origin_lla
    ox, oy, oz = lla_to_ecef(olon, olat, oalt)
    slon, clon = math.sin(math.radians(olon)), math.cos(math.radians(olon))
    slat, clat = math.sin(math.radians(olat)), math.cos(math.radians(olat))
    x = -slon * e - slat * clon * n + clat * clon * u + ox
    y = clon * e - slat * slon * n + clat * slon * u + oy
    z = clat * n + slat * u + oz
    return ecef_to_lla(x, y, z)


def _wls(st, dist):
    """一遍加权最小二乘。dist 为 None 即等权。显式循环累加。"""
    a00 = a01 = a10 = a11 = b0 = b1 = 0.0
    for i, (x, y, th, sg) in enumerate(st):
        r = 1.0 if dist is None else dist[i]
        w = 1.0 / (r * r * sg * sg)
        a0 = math.cos(th)
        a1 = -math.sin(th)
        bi = a0 * x + a1 * y
        a00 = a00 + w * a0 * a0
        a01 = a01 + w * a0 * a1
        a10 = a10 + w * a1 * a0
        a11 = a11 + w * a1 * a1
        b0 = b0 + w * a0 * bi
        b1 = b1 + w * a1 * bi
    det = a00 * a11 - a01 * a10
    if abs(det) < 1e-12:
        return None
    x = (a11 * b0 - a01 * b1) / det
    y = (-a10 * b0 + a00 * b1) / det
    return x, y, (a11 / det, -a01 / det, a00 / det)


def covariance_to_ellipse(p00, p01, p11, n_obs):
    trace = max(p00 + p11, 0.0)
    rms = math.sqrt(trace / max(float(n_obs), 1.0))
    avg = (p00 + p11) / 2.0
    diff = (p00 - p11) / 2.0
    disc = math.sqrt(diff * diff + p01 * p01)
    l1 = max(avg + disc, 0.0)
    l2 = max(avg - disc, 0.0)
    return {
        "cep_m": 0.5887 * (math.sqrt(l1) + math.sqrt(l2)),
        "rms_trace_m": rms,
        "semi_major_m": 2.0 * math.sqrt(l1),
        "semi_minor_m": 2.0 * math.sqrt(l2),
        "rotation_deg": math.degrees(math.atan2(2.0 * p01, p00 - p11) / 2.0),
    }


def solve_plane(obs):
    """obs: [(x_m, y_m, bearing_deg, sigma_deg)]。与 geo/locate_aoa.cpp 同式。"""
    if len(obs) < 2:
        return None
    st = [(x, y, math.radians(b), math.radians(max(s, 0.1))) for x, y, b, s in obs]
    first = _wls(st, None)
    if first is None:
        return None
    x0, y0, _ = first
    dist = [max(math.hypot(x0 - s[0], y0 - s[1]), 100.0) for s in st]
    second = _wls(st, dist)
    if second is None:
        return None
    x, y, cov = second
    out = covariance_to_ellipse(cov[0], cov[1], cov[2], len(obs))
    out["x_m"], out["y_m"], out["cov"] = x, y, cov
    return out


def solve_from_bearings(rows):
    """一组同时刻同目标的测向行 → 位置解。剔除 use_policy = exclude 与 invalid 的行。"""
    used = [r for r in rows
            if r.get("use_policy") != "exclude" and r.get("df_result_state") != "invalid"]
    if len(used) < 2:
        return None
    origin = (used[0]["site_lon"], used[0]["site_lat"], used[0].get("site_alt_m", 0.0))
    obs = []
    for r in used:
        e, n, _ = to_enu(lla_to_ecef(r["site_lon"], r["site_lat"], r.get("site_alt_m", 0.0)), origin)
        obs.append((e, n, r["bearing_deg"], r["bearing_std_deg"]))
    s = solve_plane(obs)
    if s is None:
        return None
    lon, lat, _ = from_enu(s["x_m"], s["y_m"], 0.0, origin)
    s["lon"], s["lat"] = lon, lat
    s["sites"] = [r["site_id"] for r in used]
    return s


def _read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description="AOA 交叉定位参考实现，与引擎产物逐值对拍")
    ap.add_argument("run_dir", help="data/runs/<task_id>")
    ap.add_argument("--tol", type=float, default=1e-9, help="相对误差容差")
    args = ap.parse_args()

    bearings = _read_jsonl(os.path.join(args.run_dir, "bearings.jsonl"))
    ppath = os.path.join(args.run_dir, "positions.jsonl")
    positions = _read_jsonl(ppath) if os.path.exists(ppath) else []

    groups: dict[tuple, list] = {}
    for b in bearings:
        groups.setdefault((round(b["t_s"], 9), b["emitter_id"]), []).append(b)

    worst = 0.0
    checked = 0
    missing = 0
    for p in positions:
        if p.get("method") != "aoa" or p.get("state") == "invalid":
            continue
        g = groups.get((round(p["t_s"], 9), p["emitter_id"]))
        if not g:
            missing += 1
            continue
        s = solve_from_bearings(g)
        if s is None:
            missing += 1
            continue
        for key, got in (("lon", s["lon"]), ("lat", s["lat"]), ("cep_m", s["cep_m"]),
                         ("gdop", s["rms_trace_m"])):
            want = p[key]
            rel = abs(got - want) / max(abs(want), 1e-12)
            worst = max(worst, rel)
        for key, got in (("semi_major_m", s["semi_major_m"]), ("semi_minor_m", s["semi_minor_m"]),
                         ("rotation_deg", s["rotation_deg"])):
            want = p["ellipse"][key]
            rel = abs(got - want) / max(abs(want), 1e-12)
            worst = max(worst, rel)
        checked += 1

    print(f"对拍 {checked} 个定位解，最大相对误差 {worst:.3e}（容差 {args.tol:.0e}）"
          f"{f'，{missing} 个找不到对应测向行' if missing else ''}")
    return 0 if (checked > 0 and worst <= args.tol) else 1


if __name__ == "__main__":
    sys.exit(main())
