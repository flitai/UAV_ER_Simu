#!/usr/bin/env python3
"""评测数据集生成（试样集，D-092；14 号报告 §8.3）。

格子文件 tests/regression/eval-dataset/<集合>.json 写意图（接收配置、传播、S4、平台与辐射源、信噪比目标）。
三个子命令：

  resolve   编写步骤：解算平台位置（视距按 cuav_run --field 迭代到 0.01 dB，非视距按环搜索），
            量接收机 IQ 不平衡与直流（DroneRFb 训练部分的背景，M 档），冻结回格子文件。输出要审阅并提交。
  prepare   每格写场景与链路规格，经 web/src/chain/examples/_gen.ts eval 编译成框图（往返逐字节、频率计划对放行表），
            再用 cuav_run --validate 核一遍；不跑引擎。
  run       prepare 之后逐格运行 cuav_run、导出 S3 与 S4 的 SigMF、做断言、删运行目录，最后写数据集索引与交付件。

输出在 data/eval/<集合>/（不入 git，只有 *.manifest.json 与 *.md 入库，见 .gitignore）。

跑法：
    uv run --quiet --with numpy --with scipy python scripts/gen_eval_dataset.py resolve --set sample-v1
    uv run --quiet --with numpy python scripts/gen_eval_dataset.py prepare --set sample-v1
    uv run --quiet --with numpy --with sigmf --with matplotlib python scripts/gen_eval_dataset.py run --set sample-v1
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from eval_dataset import cells as C  # noqa: E402
from eval_dataset import scenario as S  # noqa: E402


def _engine() -> str:
    return os.environ.get("CUAV_RUN") or os.path.join(ROOT, "engine", "build", "cuav_run")


def out_dir(set_id: str) -> str:
    return os.path.join(ROOT, "data", "eval", set_id)


def _pick(doc: dict, which: str | None) -> list[dict]:
    if not which:
        return list(doc["cells"])
    want = which.split(",")
    miss = sorted(set(want) - {c["id"] for c in doc["cells"]})
    if miss:
        raise SystemExit(f"格子文件里没有 {miss}")
    return [c for c in doc["cells"] if c["id"] in want]


# ---------------------------------------------------------------- resolve

def cmd_resolve(a) -> int:
    from eval_dataset import resolve as R
    doc = C.load(a.set)
    if a.frontend or doc.get("frontend_measured") is None:
        from eval_dataset import frontend
        doc["frontend_measured"] = frontend.measure()
        fm = doc["frontend_measured"]
        print(f"前端（DroneRFb 训练背景 {fm['source']['n_slices']} 片）：增益不平衡 {fm['iq_gain_imbalance_dB']} dB、"
              f"相位不平衡 {fm['iq_phase_imbalance_deg']}°、直流比噪声 {fm['dc_rel_noise_dB']} dB")
    for cell in _pick(doc, a.cells):
        R.resolve_cell(doc, cell)
        for p in cell["platforms"]:
            r = p["resolved"]
            extra = "" if p.get("off") else (f"，预算信噪比 {r['snr_budget_dB']} dB（目标 {p['snr_dB']}），路损 {r['path_loss_dB']} dB，"
                                            f"刀口 {r['diffraction_dB']} dB，{'视距' if r['line_of_sight'] else '非视距'}")
            print(f"{cell['id']} {p['id']}：方位 {r['azimuth_deg']}°、水平 {r['range_m']} m{extra}")
    C.save(doc)
    print(f"已写回 {os.path.relpath(C.path_of(a.set), ROOT)}：审阅后提交")
    return 0


# ---------------------------------------------------------------- prepare

def prepare_cell(doc: dict, cell: dict) -> dict:
    """写场景与链路规格、编译框图、--validate；返回各文件的仓库相对路径。"""
    base = out_dir(doc["set_id"])
    sid = S.scenario_id(doc, cell)
    rel = lambda p: os.path.relpath(p, ROOT)            # noqa: E731
    scen_path = os.path.join(base, "scenarios", f"{sid}.scenario.json")
    spec_path = os.path.join(base, "repro", f"{sid}.chain.json")
    diag_path = os.path.join(base, "repro", f"{sid}.diagram.json")
    for p in (scen_path, spec_path):
        os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(scen_path, "wb") as fh:
        fh.write(S.dumps(S.build(doc, cell)))
    with open(spec_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(S.chain_spec(doc, cell, rel(scen_path)), ensure_ascii=False, indent=2) + "\n")
    p = subprocess.run(["npx", "tsx", "src/chain/examples/_gen.ts", "eval", "--spec", rel(spec_path)],
                       cwd=os.path.join(ROOT, "web"), capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f"{cell['id']}：_gen eval 失败：{p.stderr.decode('utf-8', 'replace').strip()}")
    with open(diag_path, "wb") as fh:
        fh.write(p.stdout)
    v = subprocess.run([_engine(), "--validate", rel(diag_path), "--scenario", rel(scen_path),
                        "--library-root", "models/recognition"], cwd=ROOT, capture_output=True, text=True)
    if v.returncode != 0:
        raise SystemExit(f"{cell['id']}：cuav_run --validate 退出码 {v.returncode}：{(v.stdout + v.stderr).strip()[-800:]}")
    return {"scenario": rel(scen_path), "chain_spec": rel(spec_path), "diagram": rel(diag_path)}


def cmd_prepare(a) -> int:
    doc = C.load(a.set)
    for cell in _pick(doc, a.cells):
        files = prepare_cell(doc, cell)
        print(f"{cell['id']}：{files['diagram']}（--validate 通过）")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve", help="解算平台位置并量前端非理想，冻结回格子文件")
    r.add_argument("--set", required=True)
    r.add_argument("--cells", help="只解这些格子（逗号分隔）")
    r.add_argument("--frontend", action="store_true", help="重新量前端非理想（缺省只在还没量过时量）")
    r.set_defaults(func=cmd_resolve)
    p = sub.add_parser("prepare", help="写场景、链路规格与框图并 --validate")
    p.add_argument("--set", required=True)
    p.add_argument("--cells")
    p.set_defaults(func=cmd_prepare)
    a = ap.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
