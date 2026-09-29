#!/usr/bin/env python3
"""SigMF 导出的两份实现逐项一致（D-090）：服务端 TypeScript（界面「数据导出」用）对 Python 参考（Q-1，D-087）。

交付包只带便携 Node、不带 Python（D-084），界面上的导出因此在服务端另写了一份（server/src/exports/sigmf.ts）。
这里在真引擎运行上把两份的输出逐项对上：

  ① 输出文件集合相同；
  ② .sigmf-data（量化后的 int16）**逐字节相同**——量化只用 IEEE 的乘、加、floor，两种语言结果相同；
  ③ .sigmf-meta 与 .cuav-links.jsonl **逐值相同**（解析成 JSON 再比，键、数组长度、字符串、布尔、整数都要相等，
     浮点只允许经 log10 等超越函数算出的量差在末位：相对差 ≤ 1e-12）。不比字节，因为 Python 把整数值的浮点写成
     `80000000.0`、JavaScript 写成 `80000000`，指数写法的阈值也不同。唯一允许不同的是 `cuav:exporter`（写的是哪一份）；
  ④ 服务端那份过 SigMF 官方包校验（含 SHA-512）。

两次运行覆盖两条量化路径与两类真值：
  · C-10 的三级全开链（chain-golden-02-dsp，10 MS/s → 5 → 2.5，1 s）在 S3 / S4 / S5 开 iq：S3 无损、S4 / S5 重量化；
  · Q-3 的 GFSK 链（chain-gfsk，80 MS/s，截成 0.05 s）在 S3 开 iq：一包一条注记、带 preset_id。

跑法（约 20 s；需要 engine/build/cuav_run 与 server/dist，已接进 scripts/build-all.sh）：
    uv run --quiet --with numpy --with sigmf python tests/regression/export_parity.py [--keep]
"""
from __future__ import annotations

import argparse
import filecmp
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))
TS_CLI = os.path.join(ROOT, "server", "dist", "exports", "cli.js")
FAILS: list[str] = []

CASES = [
    {"name": "dsp", "diagram": "tests/regression/diagrams/chain-golden-02-dsp.json",
     "scenario": "data/scene/beijing-yayuncun/scenarios/golden-02.scenario.json",
     "duration_s": 1.0, "iq_ops": ("s3", "s4", "s5")},
    {"name": "gfsk", "diagram": "tests/regression/diagrams/chain-gfsk.json",
     "scenario": "tests/regression/scenarios/gfsk-80m.scenario.json",
     "duration_s": 0.05, "iq_ops": ("s3",)},
]


def check(name: str, ok: bool, detail: str) -> None:
    print(f"  [{'过' if ok else '失败'}] {name}：{detail}")
    if not ok:
        FAILS.append(name)


def prepare(case: dict, run_dir: str) -> None:
    d = json.load(open(os.path.join(ROOT, case["diagram"]), encoding="utf-8"))
    d["diagram_id"] = f"parity-{case['name']}"
    d["run"]["duration_s"] = case["duration_s"]
    fs = next(n["params"]["sample_rate_Hz"] for n in d["nodes"] if n["type"] == "ScenarioSource")
    for n in d["nodes"]:
        if "total_samples" in n.get("params", {}):
            n["params"]["total_samples"] = int(round(fs * case["duration_s"]))
    for op in d["observation_points"]:
        if op["id"] in case["iq_ops"]:
            op["products"] = list(op["products"]) + ["iq"]
    if os.path.exists(run_dir):
        shutil.rmtree(run_dir)
    dpath = run_dir + ".diagram.json"
    with open(dpath, "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    p = subprocess.run([CUAV_RUN, "--run", os.path.relpath(dpath, ROOT), "--out", os.path.relpath(run_dir, ROOT),
                        "--task-id", os.path.basename(run_dir), "--scenario", case["scenario"],
                        "--library-root", "models/recognition"], cwd=ROOT, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"cuav_run 失败（{p.returncode}）：{p.stderr[-800:]}")
    shutil.move(dpath, os.path.join(run_dir, "diagram.json"))


def export(kind: str, run_dir: str, out: str, scenario: str) -> None:
    if kind == "py":
        cmd = [sys.executable, os.path.join(ROOT, "tools", "iq_export_sigmf.py"), run_dir, "-o", out, "--scenario", scenario]
    else:
        cmd = ["node", TS_CLI, run_dir, "-o", out, "--scenario", scenario]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"{kind} 导出失败（{p.returncode}）：{p.stderr[-800:]}")


class Diff:
    def __init__(self) -> None:
        self.hard: list[str] = []
        self.max_rel = 0.0
        self.inexact = 0

    def cmp(self, a, b, path: str) -> None:
        if isinstance(a, bool) or isinstance(b, bool) or a is None or b is None or isinstance(a, str) or isinstance(b, str):
            if a != b or type(a) is not type(b) and not (a is None and b is None):
                self.hard.append(f"{path}: {a!r} ≠ {b!r}")
            return
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            if a == b:
                return
            rel = abs(a - b) / max(abs(a), abs(b))
            self.inexact += 1
            self.max_rel = max(self.max_rel, rel)
            if rel > 1e-12:
                self.hard.append(f"{path}: {a!r} ≠ {b!r}（相对差 {rel:.2e}）")
            return
        if isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                self.hard.append(f"{path}: 长度 {len(a)} ≠ {len(b)}")
                return
            for i, (x, y) in enumerate(zip(a, b)):
                self.cmp(x, y, f"{path}[{i}]")
            return
        if isinstance(a, dict) and isinstance(b, dict):
            ka, kb = set(a) - {"cuav:exporter"}, set(b) - {"cuav:exporter"}
            if ka != kb:
                self.hard.append(f"{path}: 键不同 {sorted(ka ^ kb)}")
                return
            for k in sorted(ka):
                self.cmp(a[k], b[k], f"{path}.{k}")
            return
        self.hard.append(f"{path}: 类型不同 {type(a).__name__} / {type(b).__name__}")


def compare(case: dict, py_out: str, ts_out: str) -> None:
    fa, fb = sorted(os.listdir(py_out)), sorted(os.listdir(ts_out))
    check(f"{case['name']} ① 文件集合相同", fa == fb, f"{len(fa)} 个文件")
    if fa != fb:
        return
    for f in fa:
        a, b = os.path.join(py_out, f), os.path.join(ts_out, f)
        if f.endswith(".sigmf-data"):
            same = filecmp.cmp(a, b, shallow=False)
            check(f"{case['name']} ② {f} 逐字节相同", same, f"{os.path.getsize(a)} 字节")
        elif f.endswith(".sigmf-meta"):
            ma, mb = json.load(open(a, encoding="utf-8")), json.load(open(b, encoding="utf-8"))
            dd = Diff()
            dd.cmp(ma, mb, "meta")
            check(f"{case['name']} ③ {f} 逐值相同", not dd.hard,
                  f"{len(ma['annotations'])} 条注记；非逐位相同的浮点 {dd.inexact} 个、最大相对差 {dd.max_rel:.1e}"
                  + (f"；{dd.hard[:3]}" if dd.hard else ""))
            check(f"{case['name']} ③ {f} 两份各自标明出处",
                  ma["global"]["cuav:exporter"].startswith("tools/iq_export_sigmf.py")
                  and mb["global"]["cuav:exporter"].startswith("server/src/exports/sigmf.ts"),
                  f"{ma['global']['cuav:exporter']} / {mb['global']['cuav:exporter']}")
        elif f.endswith(".cuav-links.jsonl"):
            la = [json.loads(l) for l in open(a, encoding="utf-8") if l.strip()]
            lb = [json.loads(l) for l in open(b, encoding="utf-8") if l.strip()]
            dd = Diff()
            dd.cmp(la, lb, "links")
            check(f"{case['name']} ③ {f} 逐值相同", not dd.hard, f"{len(la)} 行" + (f"；{dd.hard[:3]}" if dd.hard else ""))


def validate(ts_out: str) -> None:
    import sigmf
    stems = sorted(f[: -len(".sigmf-meta")] for f in os.listdir(ts_out) if f.endswith(".sigmf-meta"))
    for s in stems:
        f = sigmf.sigmffile.fromfile(os.path.join(ts_out, s))
        try:
            f.validate()
            ok = f.get_global_field("core:sha512") == f.calculate_hash()
            check(f"④ {s} 过 SigMF 官方校验", ok, "含 SHA-512")
        except Exception as e:  # noqa: BLE001 — 官方包抛的类型不固定，报出来就行
            check(f"④ {s} 过 SigMF 官方校验", False, str(e)[:200])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--keep", action="store_true", help="留下运行目录与两份导出（在临时目录里）")
    a = ap.parse_args()
    if not os.path.exists(CUAV_RUN) or not os.path.exists(TS_CLI):
        print(f"跳过：需要 {os.path.relpath(CUAV_RUN, ROOT)} 与 {os.path.relpath(TS_CLI, ROOT)}（先构建引擎与服务）")
        return 0
    base = os.path.join(ROOT, "data", "runs")
    tmp = tempfile.mkdtemp(prefix="export-parity-")
    try:
        for case in CASES:
            print(f"== {case['name']}：{case['diagram']}（{case['duration_s']} s，iq 开在 {', '.join(case['iq_ops'])}）")
            run_dir = os.path.join(base, f"export-parity-{case['name']}")
            prepare(case, run_dir)
            py_out, ts_out = os.path.join(tmp, case["name"], "py"), os.path.join(tmp, case["name"], "ts")
            export("py", run_dir, py_out, case["scenario"])
            export("ts", run_dir, ts_out, case["scenario"])
            compare(case, py_out, ts_out)
            validate(ts_out)
            if not a.keep:
                shutil.rmtree(run_dir, ignore_errors=True)
    finally:
        if a.keep:
            print(f"导出留在 {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print("两份导出" + ("逐项一致" if not FAILS else f"有 {len(FAILS)} 项不一致：{FAILS}"))
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
