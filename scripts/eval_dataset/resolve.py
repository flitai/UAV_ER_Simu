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


def resolve_nlos(doc: dict, cell: dict, p: dict, avoid: list[tuple[float, float]] | None = None) -> dict:
    """在格子高度上按环搜索被楼挡住、刀口损耗不低于下限的点，取预算信噪比最接近目标的一个。

    正式集（D-104）另有三项，样本集的格子不用：
    - `altitudes_m`：依次试这些高度，取第一个能在容差内对上目标的；
    - `max_tx_power_dBm`：所有高度在标称功率下都对不上时，选所需上调最小的高度，把发射功率上调到恰好够
      （向上取到 0.1 dB），不超过该值；上调量记在 `power_raise_dB`；
    - `min_separation_m`：与本格已解出的平台的水平距离不小于该值（多源格免得几个平台解到同一个点）。"""
    site = doc["site"]
    e = _primary(p)
    s = p["search"]
    r0, r1, dr = s["range_m"]
    a0, a1 = s.get("azimuth_range_deg", [0, 360])
    alts = s.get("altitudes_m", [p["alt_m"]])
    sep = float(s.get("min_separation_m", 0.0))
    nominal = _budget_snr(doc, e, 0.0)
    per_alt = []
    for alt in alts:
        cand = []
        k = 0
        while r0 + k * dr <= r1 + 1e-9:
            rng = r0 + k * dr
            for a in range(int(a0), int(a1), int(s.get("azimuth_step_deg", 1))):
                lon, lat = S.lonlat_at(site, float(a), rng, alt)
                if sep and any(_dist_m(lon, lat, q) < sep for q in (avoid or [])):
                    continue
                cand.append((rng, float(a), lon, lat))
            k += 1
        res = field_points(doc, cell, e["id"], doc["propagation"][cell["propagation"]]["prop_level"],
                           [[c[2], c[3], alt] for c in cand])
        ok = [(c, r, nominal - r["path_loss_dB"]) for c, r in zip(cand, res)
              if not r["line_of_sight"] and r["valid"] and r["diffraction_dB"] >= s["min_diffraction_dB"]]
        per_alt.append((alt, ok, len(cand)))

    def pick(ok: list, raise_dB: float):
        best = None
        for c, r, snr in ok:
            d = abs(snr + raise_dB - p["snr_dB"])
            key = (round(d, 9), c[0], c[1])
            if best is None or key < best[0]:
                best = (key, c, r)
        return best

    for alt, ok, n in per_alt:                           # 先在标称功率下依次试各高度
        best = pick(ok, 0.0)
        if best is not None and best[0][0] <= s["tol_dB"]:
            return _finish(doc, e, p, best, alt, 0.0, n * len(alts))
    cap = s.get("max_tx_power_dBm")
    if cap is not None:                                  # 都对不上：选所需上调最小的高度
        tops = [(p["snr_dB"] - max(x[2] for x in ok), -alt, alt, ok, n) for alt, ok, n in per_alt if ok]
        if tops:
            need, _, alt, ok, n = min(tops)
            raise_dB = math.ceil(need * 10 - 1e-9) / 10
            if 0 < raise_dB and e["tx_power_dBm"] + raise_dB <= cap + 1e-9:
                best = pick(ok, raise_dB)
                if best is not None and best[0][0] <= s["tol_dB"]:
                    return _finish(doc, e, p, best, alt, raise_dB, n * len(alts))
    tops = [f"{alt} m 最高 {max(x[2] for x in ok):.1f} dB" for alt, ok, _ in per_alt if ok] or ["没有满足条件的点"]
    raise RuntimeError(f"格子 {cell['id']} 平台 {p['id']}：非视距搜索失败（目标 {p['snr_dB']} dB；标称功率下 {'，'.join(tops)}；"
                       f"线 {s['tol_dB']} dB）")


def _dist_m(lon: float, lat: float, q: tuple[float, float]) -> float:
    import aoa_fix
    e, n, _ = aoa_fix.to_enu(aoa_fix.lla_to_ecef(lon, lat, 0.0), (q[0], q[1], 0.0))
    return math.hypot(e, n)


def _finish(doc: dict, e: dict, p: dict, best, alt: float, raise_dB: float, n_points: int) -> dict:
    _, c, r = best
    out = _record(doc, e, c[2], c[3], r, c[0], c[1])
    if raise_dB:
        out["snr_budget_dB"] = round(out["snr_budget_dB"] + raise_dB, 4)
        out["power_raise_dB"] = raise_dB
    if "altitudes_m" in p["search"]:
        out["alt_m"] = alt
    out["search_points"] = n_points
    return out


def resolve_cell(doc: dict, cell: dict, missing_only: bool = False) -> None:
    if cell.get("seed_from"):
        return                                           # 位置随来源格，已在格子文件里（cells.check_seed_from 核过）
    placed: list[tuple[float, float]] = [(p["resolved"]["lon"], p["resolved"]["lat"]) for p in cell["platforms"]
                                          if p.get("resolved")]
    for p in cell["platforms"]:
        if missing_only and p.get("resolved"):
            continue
        if p.get("off"):
            lon, lat = S.lonlat_at(doc["site"], float(p["azimuth_deg"]), float(p["range_m"]), p["alt_m"])
            p["resolved"] = {"lon": lon, "lat": lat, "range_m": float(p["range_m"]),
                             "azimuth_deg": float(p["azimuth_deg"])}
        elif "search" in p:
            p["resolved"] = resolve_nlos(doc, cell, p, avoid=placed)
        else:
            p["resolved"] = resolve_los(doc, cell, p)
        placed.append((p["resolved"]["lon"], p["resolved"]["lat"]))
