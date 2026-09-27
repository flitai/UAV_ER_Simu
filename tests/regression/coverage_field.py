#!/usr/bin/env python3
"""覆盖场与链路帧的跨侧对拍（D-080；D-079 的锚点搬到引擎侧）。

覆盖场（`cuav_run --field`）在任一点读出的路损，必须就是引擎给链路帧在那一点算的路损——
两边调的是同一个 link_geometry + link_budget。这里拿 E3 回归那次运行
（`tests/regression/e3_occlusion_chain.py` 写的 `data/runs/e3-occlusion`，golden-01、E3、
主模型自由空间）做对照：把每个与航迹同时刻的链路帧里目标的位置与离地高度作为逐点求值的点，
比 `path_loss_dB` 与视距判定。

核四件事：
  1. 逐点路损与链路帧逐时刻相同（判据 1e-9 dB：两边是同一个函数，差只能来自浮点打印往返）；
  2. 视距判定逐时刻相同，且至少有一个非视距时刻（否则没测到遮挡那一半）；
  3. 同一请求跑两次，网格文件逐字节相同（铁律 9 的复现对象是产物）；
  4. 网格 200 × 200、层数 = 1（合并）+ 站数，Pd 都在 [0, 1]。

**建筑集与那次运行都不入 git**。缺哪样就明说跳过、退出码 0，**不当作通过**（先例 D-073 ③）。
build-all.sh 里本脚本排在 e3_occlusion_chain.py 之后，所以正常构建下那次运行总是新的。

跑法（仓库根目录）：
    uv run --quiet python tests/regression/coverage_field.py [--engine engine/build/cuav_run]
"""
from __future__ import annotations

import argparse
import array
import hashlib
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

SCENARIO = "data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json"
BUILDINGS = "data/scene/beijing-yayuncun/buildings.geojson"
RUN = "data/runs/e3-occlusion"

ok = 0
bad = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global ok, bad
    if cond:
        ok += 1
        print(f"  通过  {name}" + (f"  —— {detail}" if detail else ""))
    else:
        bad += 1
        print(f"  不通过 {name}" + (f"  —— {detail}" if detail else ""))


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def run_field(engine: str, req: dict, out: str) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(req, f)
        req_path = f.name
    try:
        p = subprocess.run([engine, "--field", req_path, "--scenario", SCENARIO, "--out", out],
                           cwd=ROOT, capture_output=True, text=True, timeout=600)
    finally:
        os.unlink(req_path)
    if p.returncode != 0:
        raise RuntimeError(f"cuav_run --field 退出码 {p.returncode}：{p.stderr.strip()}")
    for line in p.stdout.splitlines():
        e = json.loads(line)
        if e["type"] == "field":
            return e["payload"]
    raise RuntimeError("stdout 里没有 field 事件")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.path.join(ROOT, "engine", "build", "cuav_run"))
    args = ap.parse_args()

    missing = [p for p in (args.engine, os.path.join(ROOT, BUILDINGS), os.path.join(ROOT, RUN, "links.jsonl"))
               if not os.path.exists(p)]
    if missing:
        print("跳过（不当作通过）：缺 " + "、".join(os.path.relpath(p, ROOT) for p in missing))
        return 0

    sc = json.load(open(os.path.join(ROOT, SCENARIO), encoding="utf-8"))
    terrain = sc.get("coordinate", {}).get("terrainHeight_m", 0.0)
    site = sc["sites"][0]
    half = 0.45 * site["receiver"]["fs_Hz"]
    links = read_jsonl(os.path.join(ROOT, RUN, "links.jsonl"))
    track = {r["t_s"]: r for r in read_jsonl(os.path.join(ROOT, RUN, "track.jsonl")) if r["id"] == "uav-1"}
    pairs = [(l, track[l["t_s"]]) for l in links if l["t_s"] in track]

    req = {
        "schema_version": "cuav-field-request/1",
        "emitter_id": "uav-1",
        "height_agl_m": 100.0,
        "res_m": 100.0,
        "propagation": {"prop_level": "E3"},
        "detectors": {site["id"]: {"nfft": 1024, "pfa": 1e-3, "band_lo_Hz": -half, "band_hi_Hz": half}},
        "points": [[t["lon"], t["lat"], t["alt_m"] - terrain] for _, t in pairs],
    }
    with tempfile.TemporaryDirectory() as tmp:
        a, b = os.path.join(tmp, "a.f32"), os.path.join(tmp, "b.f32")
        meta = run_field(args.engine, req, a)
        run_field(args.engine, req, b)
        ha = hashlib.sha256(open(a, "rb").read()).hexdigest()
        hb = hashlib.sha256(open(b, "rb").read()).hexdigest()
        grid = array.array("f")
        grid.frombytes(open(a, "rb").read())

    worst = 0.0
    los_same = True
    nlos = 0
    for (l, _), p in zip(pairs, meta["points"]):
        ps = p["sites"][site["id"]]
        worst = max(worst, abs(ps["path_loss_dB"] - l["path_loss_dB"]))
        los_same = los_same and (ps["line_of_sight"] == l["line_of_sight"])
        nlos += 0 if ps["line_of_sight"] else 1
    check("逐点路损与 E3 链路帧逐时刻相同（1e-9 dB）", len(pairs) >= 50 and worst <= 1e-9,
          f"{len(pairs)} 个时刻，最差 {worst:.3e} dB")
    check("视距判定逐时刻相同，且测到了非视距时刻", los_same and nlos > 0, f"非视距 {nlos} 个")
    check("同一请求跑两次，网格文件逐字节相同", ha == hb, ha[:16])
    n = meta["nx"] * meta["ny"]
    check("网格 200 × 200、层数 = 1（合并）+ 站数、Pd 都在 [0, 1]",
          meta["nx"] == 200 and meta["ny"] == 200 and len(meta["layers"]) == 1 + len(sc["sites"])
          and len(grid) == n * len(meta["layers"])
          and all(0.0 <= v <= 1.0 for v in grid),
          f"{meta['nx']} × {meta['ny']} × {len(meta['layers'])} 层，{meta['ms']:.0f} ms，计入 {meta['included_loss_terms']}")

    print(f"\n共 {ok + bad} 项，不通过 {bad} 项")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
