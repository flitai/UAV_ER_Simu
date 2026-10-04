"""编写步骤：解算每个平台的位置，冻结回格子文件（试样集，D-092）。

- 视距格（传播 E1）：沿格子给的方位与高度，先按自由空间闭式求斜距，再用 `cuav_run --field`（与链路帧
  同一条 link_geometry + link_budget，D-080）读路损迭代，直到主辐射源的预算信噪比与目标差 ≤ 0.01 dB。
- 非视距格（传播 E3）：在格子高度上按环搜索（方位 1°、水平距离按 search.range_m 的步长），条件是
  几何上被楼挡住（line_of_sight = false）且刀口损耗不低于 search.min_diffraction_dB；在满足条件的点里取
  预算信噪比最接近目标的一个，平局取水平距离小的、再取方位小的。差不过 search.tol_dB 就报错，不放宽。
- 占位平台（off）：直接按格子给的方位与距离。

解算用的是主辐射源的 emission.center_Hz（跳频预设即第一跳）。结果写进各平台的 `resolved`
（经纬度到 1e-7 度、预算信噪比、路损、刀口损耗、视距），审阅后提交；生成时只读冻结值。
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile

from . import scenario as S

ROOT = S.ROOT
C0 = 299792458.0


def _engine() -> str:
    return os.environ.get("CUAV_RUN") or os.path.join(ROOT, "engine", "build", "cuav_run")


def field_points(doc: dict, cell: dict, emitter_id: str, prop_level: str, pts: list[list[float]]) -> list[dict]:
    """在给定点上对站 site 求主辐射源的链路几何与预算（cuav_run --field 的 points）。"""
    scen = S.build(doc, cell, positions={p["id"]: (doc["site"]["lon"], doc["site"]["lat"] + 0.01, p["alt_m"])
                                         for p in cell["platforms"]})
    rcv = doc["receivers"][cell["receiver"]]
    req = {"schema_version": "cuav-field-request/1", "emitter_id": emitter_id, "height_agl_m": 0, "res_m": 2000,
           "propagation": {"prop_level": prop_level},
           "detectors": {doc["site"]["id"]: {"nfft": 1024, "pfa": 1e-3, "band_lo_Hz": -0.45 * rcv["fs_Hz"],
                                             "band_hi_Hz": 0.45 * rcv["fs_Hz"]}},
           "points": pts}
    tmp = os.path.join(ROOT, "data", "tmp", "eval-resolve")
    os.makedirs(tmp, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=tmp) as d:
        sp = os.path.join(d, "scenario.json")
        with open(sp, "wb") as fh:
            fh.write(S.dumps(scen))
        rp = os.path.join(d, "request.json")
        with open(rp, "w", encoding="utf-8") as fh:
            json.dump(req, fh)
        p = subprocess.run([_engine(), "--field", os.path.relpath(rp, ROOT), "--scenario", os.path.relpath(sp, ROOT),
                            "--out", os.path.relpath(os.path.join(d, "grid.f32"), ROOT), "--scene-root", "data/scene"],
                           cwd=ROOT, capture_output=True, text=True, timeout=1800)
    if p.returncode != 0:
        raise RuntimeError(f"cuav_run --field 退出码 {p.returncode}：{p.stderr.strip()[-600:]}")
    for line in p.stdout.splitlines():
        e = json.loads(line)
        if e["type"] == "field":
            return [pt["sites"][doc["site"]["id"]] for pt in e["payload"]["points"]]
    raise RuntimeError("cuav_run --field 的 stdout 里没有 field 事件")


def _primary(platform: dict) -> dict:
    return next(e for e in platform["emitters"] if e["id"] == platform["primary"])


def _budget_snr(doc: dict, emitter: dict, path_loss_dB: float) -> float:
    site = doc["site"]
    noise = S.noise_density_dBm_Hz(site["nf_dB"]) + 10 * math.log10(S.emitter_bw(emitter))
    return emitter["tx_power_dBm"] + emitter["antenna_gain_dBi"] + site["antenna_gain_dBi"] - path_loss_dB - noise


def _freq(doc: dict, cell: dict, emitter_id: str) -> float:
    scen = S.build(doc, cell, positions={p["id"]: (0.0, 0.0, p["alt_m"]) for p in cell["platforms"]})
    return float(next(e for e in scen["emitters"] if e["id"] == emitter_id)["emission"]["center_Hz"])


def _record(doc: dict, emitter: dict, lon: float, lat: float, r: dict, range_m: float, az: float) -> dict:
    return {"lon": lon, "lat": lat, "range_m": round(range_m, 3), "azimuth_deg": az,
            "line_of_sight": bool(r["line_of_sight"]), "distance_m": round(r["distance_m"], 3),
            "path_loss_dB": round(r["path_loss_dB"], 4), "diffraction_dB": round(r["diffraction_dB"], 4),
            "snr_budget_dB": round(_budget_snr(doc, emitter, r["path_loss_dB"]), 4)}


def resolve_los(doc: dict, cell: dict, p: dict) -> dict:
    site = doc["site"]
    e = _primary(p)
    target_pl = S.target_path_loss_dB(site, e, p["snr_dB"])
    f = _freq(doc, cell, e["id"])
    dh = p["alt_m"] - site["alt_m"]
    slant = 10 ** ((target_pl - 20 * math.log10(4 * math.pi * f / C0)) / 20)
    az = float(p["azimuth_deg"])
    for _ in range(8):
        rng = math.sqrt(max(slant * slant - dh * dh, 1.0))
        lon, lat = S.lonlat_at(site, az, rng, p["alt_m"])
        r = field_points(doc, cell, e["id"], doc["propagation"][cell["propagation"]]["prop_level"],
                         [[lon, lat, p["alt_m"]]])[0]
        if abs(r["path_loss_dB"] - target_pl) <= 0.01:
            return _record(doc, e, lon, lat, r, rng, az)
        slant = r["distance_m"] * 10 ** ((target_pl - r["path_loss_dB"]) / 20)
    raise RuntimeError(f"格子 {cell['id']} 平台 {p['id']}：迭代 8 次没收敛到 0.01 dB")


def resolve_nlos(doc: dict, cell: dict, p: dict) -> dict:
    site = doc["site"]
    e = _primary(p)
    s = p["search"]
    r0, r1, dr = s["range_m"]
    cand = []
    k = 0
    while r0 + k * dr <= r1 + 1e-9:
        rng = r0 + k * dr
        for a in range(0, 360, int(s.get("azimuth_step_deg", 1))):
            lon, lat = S.lonlat_at(site, float(a), rng, p["alt_m"])
            cand.append((rng, float(a), lon, lat))
        k += 1
    res = field_points(doc, cell, e["id"], doc["propagation"][cell["propagation"]]["prop_level"],
                       [[c[2], c[3], p["alt_m"]] for c in cand])
    best = None
    for c, r in zip(cand, res):
        if r["line_of_sight"] or not r["valid"] or r["diffraction_dB"] < s["min_diffraction_dB"]:
            continue
        d = abs(_budget_snr(doc, e, r["path_loss_dB"]) - p["snr_dB"])
        key = (round(d, 9), c[0], c[1])
        if best is None or key < best[0]:
            best = (key, c, r)
    if best is None or best[0][0] > s["tol_dB"]:
        got = "没有满足条件的点" if best is None else f"最接近的差 {best[0][0]:.3f} dB"
        raise RuntimeError(f"格子 {cell['id']} 平台 {p['id']}：非视距搜索失败（{got}，线 {s['tol_dB']} dB）")
    _, c, r = best
    out = _record(doc, e, c[2], c[3], r, c[0], c[1])
    out["search_points"] = len(cand)
    return out


def resolve_cell(doc: dict, cell: dict) -> None:
    for p in cell["platforms"]:
        if p.get("off"):
            lon, lat = S.lonlat_at(doc["site"], float(p["azimuth_deg"]), float(p["range_m"]), p["alt_m"])
            p["resolved"] = {"lon": lon, "lat": lat, "range_m": float(p["range_m"]),
                             "azimuth_deg": float(p["azimuth_deg"])}
        elif "search" in p:
            p["resolved"] = resolve_nlos(doc, cell, p)
        else:
            p["resolved"] = resolve_los(doc, cell, p)
