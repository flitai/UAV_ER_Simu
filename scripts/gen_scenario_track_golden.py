#!/usr/bin/env python3
"""把 cuav_run --scenario-track 的事件流转成航迹黄金基准（06 备忘录 §9C G-1 / G-4）。

--scenario-track 不发 progress、不按墙钟节流，stdout 逐字节可复现，所以它本身就是生成器；
本脚本只做「事件流 → 基准文件」的整形，不做任何数值处理。

用法：
    uv run --quiet python scripts/gen_scenario_track_golden.py \
        --scenario data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json \
        --rate 2 --out tests/golden/scenario-track-golden-01.json

只用标准库。路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="生成航迹黄金基准")
    ap.add_argument("--scenario", required=True, help="场景文件，仓库相对路径")
    ap.add_argument("--rate", type=float, default=2.0, help="采样率（赫兹），缺省 2")
    ap.add_argument("--out", required=True, help="输出的基准文件，仓库相对路径")
    ap.add_argument("--engine", default=os.path.join("engine", "build", "cuav_run"))
    a = ap.parse_args(argv)

    engine = os.path.join(_ROOT, a.engine)
    if not os.path.exists(engine):
        print(f"找不到引擎可执行文件 {a.engine}，先构建 engine", file=sys.stderr)
        return 2

    cmd = [engine, "--scenario-track", a.scenario, "--track-rate", repr(a.rate)]
    proc = subprocess.run(cmd, cwd=_ROOT, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout, file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        return proc.returncode

    samples, summary = [], None
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        ev = json.loads(line)
        if ev["type"] == "entity":
            p = ev["payload"]
            samples.append({"t_s": ev["t_s"], "id": p["id"], "lon": p["lon"], "lat": p["lat"],
                            "alt_m": p["alt_m"], "heading_deg": p["heading_deg"],
                            "speed_mps": p["speed_mps"], "tx_on": p["tx_on"],
                            "center_Hz": p["center_Hz"]})
        elif ev["type"] == "task.state":
            summary = ev["payload"]
    if summary is None:
        print("事件流里没有 task.state，生成失败", file=sys.stderr)
        return 3

    golden = {
        "schema_version": "cuav-scenario-track/1",
        "scenario_id": summary["scenario_id"],
        "scenario_sha256": summary["scenario_sha256"],
        "aoi_id": summary["aoi_id"],
        "track_rate_Hz": summary["track_rate_Hz"],
        "duration_s": summary["duration_s"],
        "engine_version": summary["engine_version"],
        "generator": f"scripts/gen_scenario_track_golden.py --scenario {a.scenario} --rate {a.rate!r}",
        "tolerance": {
            "position_deg": 1e-6,
            "alt_m": 1e-3,
            "note": "浏览器预览（G-4）与 C++ 必须在此容差内一致；同一平台的 C++ 侧应逐位相同",
        },
        "entities": sorted({s["id"] for s in samples}),
        "sample_count": len(samples),
        "samples": samples,
    }
    out = os.path.join(_ROOT, a.out)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(golden, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"写出 {a.out}：{len(samples)} 个样点，{len(golden['entities'])} 个实体")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
