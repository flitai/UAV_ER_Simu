#!/usr/bin/env python3
"""E3 建筑遮挡接进帧生产端之后的回归（D3-5，决策 D-074；07 报告 §1.5）。

跑的是**保存下来的典型链路** `tests/regression/diagrams/chain-golden-01-e3.json`
（由 `cd web && npx tsx src/chain/examples/_gen.ts golden-01-e3` 生成），
它与全合成那份逐参数相同，只把传播档位提到 E3。

核五件事：
  1. 视距由建筑几何给出，不再恒真——golden-01 起飞点在楼后，约 7 秒后过顶转视距；
  2. 三段式的前两段走出来了：起飞被挡、过顶转视距（07 §1.5 的可见效果）；
  3. 恒等式 `path_loss_dB = free_space_dB + extra_loss_dB` 在 E3 下照旧成立；
  4. `included_loss_terms` 含 `diffraction`，且 `diffraction_dB` 与 `extra_loss_dB` 对得上；
  5. 07 §1.5 调研给的锚点复现：起飞点约 210 m / 37 dB。

**建筑集不入 git**（`data/**`）。缺数据时明说跳过、退出码 0，**不当作通过**（先例 D-073 ③）。

跑法（仓库根目录）：
    uv run --quiet python tests/regression/e3_occlusion_chain.py [--engine engine/build/cuav_run]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

DIAGRAM = "tests/regression/diagrams/chain-golden-01-e3.json"
SCENARIO = "data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json"
BUILDINGS = "data/scene/beijing-yayuncun/buildings.geojson"
SCENE_ROOT = "data/scene"

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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.path.join(ROOT, "engine", "build", "cuav_run"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "runs", "e3-occlusion"))
    args = ap.parse_args()

    if not os.path.exists(args.engine):
        print(f"跳过：引擎不在 {args.engine}，先 cmake --build engine/build")
        return 0
    if not os.path.exists(os.path.join(ROOT, BUILDINGS)):
        print(f"跳过：{BUILDINGS} 不在盘上（data/** 不入 git），E3 要真实建筑集。**这不是通过**。")
        return 0

    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    cmd = [args.engine, "--run", DIAGRAM, "--out", os.path.relpath(args.out, ROOT),
           "--task-id", "e3-occlusion", "--scenario", SCENARIO, "--scene-root", SCENE_ROOT,
           "--library-root", "models/recognition"]
    print("$ " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:])
        print(f"引擎退出码 {r.returncode}")
        return 1

    rows = [json.loads(l) for l in open(os.path.join(args.out, "links.jsonl"), encoding="utf-8")]
    if not rows:
        print("links.jsonl 是空的")
        return 1

    nlos = [r for r in rows if not r["line_of_sight"]]
    los = [r for r in rows if r["line_of_sight"]]
    check("视距不再恒真：既有被挡的帧也有视距帧", len(nlos) > 0 and len(los) > 0,
          f"非视距 {len(nlos)}/{len(rows)}，视距窗口 t {los[0]['t_s']:.1f}–{los[-1]['t_s']:.1f} s")

    # 三段式：起飞被挡 → 过顶视距。这条航线 20 秒只走得到前两段，末端那段要跑满 180 秒。
    check("三段式的前两段：起飞被挡、过顶转视距",
          not rows[0]["line_of_sight"] and los[0]["t_s"] > rows[0]["t_s"],
          f"t=0 被挡 {rows[0]['diffraction_dB']:.2f} dB，t={los[0]['t_s']:.1f} s 起转视距")

    # **「line_of_sight = !blocked 与损耗大小无关」这条性质不在这里验**：这条航线上被挡的帧
    # 全都挡得很深（最小 {:.1f} dB），一帧掠射也没有，拿它来验等于拿碰巧没有反例的数据当证据。
    # 该性质由 engine/tests/test_occlusion.cpp 里**特意构造**的掠射几何钉着（墙高扫到刚擦视线）。
    print("  事实  这条航线上被挡的帧最小损耗 {:.2f} dB —— 没有掠射帧，"
          "「与损耗大小无关」那条性质由单测的构造几何验".format(
              min(r["diffraction_dB"] for r in nlos)))

    worst = max(abs(r["path_loss_dB"] - r["free_space_dB"] - r["extra_loss_dB"]) for r in rows)
    check("恒等式 path = free_space + extra 在 E3 下照旧成立", worst < 1e-9,
          f"最大偏差 {worst:.3e} dB")

    worst_d = max(abs(r.get("diffraction_dB", 0.0) - r["extra_loss_dB"]) for r in rows)
    check("刀口损耗就是这一档的全部附加损耗（没开别的效应）", worst_d < 1e-9,
          f"最大偏差 {worst_d:.3e} dB")

    terms_ok = all("diffraction" in r["included_loss_terms"] for r in rows)
    check("included_loss_terms 每行都声明 diffraction（含视距帧）", terms_ok,
          f"第一行 {rows[0]['included_loss_terms']}")

    first = rows[0]
    check("07 §1.5 的起飞点锚点：约 210 m / 37 dB",
          abs(first["distance_m"] - 210.0) < 15.0 and abs(first["diffraction_dB"] - 37.0) < 1.5,
          f"实测 {first['distance_m']:.1f} m / {first['diffraction_dB']:.2f} dB")

    # 建筑加载的计数进了 scn 节点的 notes（铁律 15：剔了什么要说出来）。
    # task.json 是应用服务写的，cuav_run 自己只落 events.jsonl，终态在它最后一条 task.state 里。
    state = {}
    for line in open(os.path.join(args.out, "events.jsonl"), encoding="utf-8"):
        e = json.loads(line)
        if e.get("type") == "task.state":
            state = e.get("payload", {})
    notes = " ".join(state.get("reasons", []))
    check("建筑加载的计数如实进了产物", "47662" in notes, notes[:90] + "…" if notes else "（空）")

    print(f"\n共 {ok + bad} 项，不通过 {bad} 项")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
