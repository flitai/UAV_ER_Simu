#!/usr/bin/env python3
"""评测数据集生成器的冒烟回归（试样集，D-092）：tests/regression/eval-dataset/smoke.json 一格、2 MS/s、0.2 s。

从格子文件一路走到交付件：场景 → 框图（_gen.ts eval，往返逐字节、频率计划对放行表）→ cuav_run → SigMF 导出与官方校验
→ 生成器自己的断言 → 交付件（数据、预览、读取示例、README、index.json、SHA512SUMS）。这里再核：
  ① 交付件齐全，README 没有没替换的占位符；
  ② SHA512SUMS 逐个对得上；
  ③ 读取示例 examples/read_sigmf.py 读得出样点，样点数与元数据一致；
  ④ 交付件的文本里没有本机路径（铁律 17）；
  ⑤ 重跑这一格，交付的数据、元数据、链路旁挂与预览图逐字节相同（铁律 9）。

跑法（几秒；需要 engine/build/cuav_run 与 node，已接进 scripts/build-all.sh）：
    uv run --quiet --with numpy --with sigmf --with matplotlib python tests/regression/eval_dataset_smoke.py
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))
OUT = os.path.join("data", "tmp", "eval-smoke")
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    print(f"  [{'过' if ok else '失败'}] {name}：{detail}")
    if not ok:
        FAILS.append(name)


def gen(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "gen_eval_dataset.py"), *args],
                          cwd=ROOT, capture_output=True, text=True)


def main() -> int:
    if not os.path.exists(CUAV_RUN):
        print("跳过：没有 engine/build/cuav_run")
        return 0
    base = os.path.join(ROOT, OUT)
    shutil.rmtree(base, ignore_errors=True)
    print("评测数据集生成器冒烟（smoke.json：一格、2 MS/s、0.2 s）")
    try:
        p = gen("run", "--set", "smoke", "--root", OUT, "--allow-dirty")
        check("生成器跑完且自己的断言全过", p.returncode == 0, (p.stdout + p.stderr).strip().splitlines()[0]
              if (p.stdout + p.stderr).strip() else "无输出")
        if p.returncode != 0:
            print(p.stdout, p.stderr)
            return 1
        pkg = os.path.join(base, "package")
        want = ["README.md", "SHA512SUMS", "index.json", "examples/read_sigmf.py", "examples/read_sigmf.m"] + \
               [f"data/smk-c1_{op}{ext}" for op in ("s3", "s4")
                for ext in (".sigmf-data", ".sigmf-meta", ".cuav-links.jsonl")] + \
               [f"previews/smk-c1_{op}.png" for op in ("s3", "s4")]
        missing = [f for f in want if not os.path.exists(os.path.join(pkg, f))]
        readme = open(os.path.join(pkg, "README.md"), encoding="utf-8").read()
        check("① 交付件齐全、README 占位符都已替换", not missing and "{{" not in readme,
              f"{len(want) - len(missing)} / {len(want)} 个文件" + (f"，缺 {missing}" if missing else ""))

        bad, n = [], 0
        for line in open(os.path.join(pkg, "SHA512SUMS"), encoding="utf-8"):
            h, f = line.rstrip("\n").split("  ", 1)
            n += 1
            if hashlib.sha512(open(os.path.join(pkg, f), "rb").read()).hexdigest() != h:
                bad.append(f)
        check("② SHA512SUMS 逐个对得上", n > 0 and not bad, f"{n} 个文件" + (f"，不符 {bad}" if bad else ""))

        spec = importlib.util.spec_from_file_location("read_sigmf", os.path.join(pkg, "examples", "read_sigmf.py"))
        rs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rs)
        x, meta = rs.load(os.path.join(pkg, "data", "smk-c1_s3"))
        n_meta = os.path.getsize(os.path.join(pkg, "data", "smk-c1_s3.sigmf-data")) // 4
        seg = rs.annotation_samples(x, meta["annotations"][0]) if meta["annotations"] else x[:0]
        check("③ 读取示例读得出样点", x.size == n_meta and seg.size == meta["annotations"][0]["core:sample_count"],
              f"{x.size} 个样点，第一条注记 {seg.size} 个样点，平均功率 {rs.power_dBm(x):.2f} dBm")

        leaks = []
        for d, _, fs in os.walk(pkg):
            for f in fs:
                if f.endswith((".md", ".json", ".sigmf-meta", ".jsonl", ".py", ".m")):
                    t = open(os.path.join(d, f), encoding="utf-8").read()
                    if ROOT in t or os.path.expanduser("~") in t:
                        leaks.append(f)
        check("④ 交付件文本里没有本机路径", not leaks, f"{leaks}" if leaks else "无")

        v = gen("run", "--set", "smoke", "--root", OUT, "--allow-dirty", "--verify", "c1")
        check("⑤ 重跑逐字节相同", v.returncode == 0, (v.stdout + v.stderr).strip().splitlines()[-1]
              if (v.stdout + v.stderr).strip() else "无输出")
    finally:
        shutil.rmtree(base, ignore_errors=True)
        shutil.rmtree(os.path.join(ROOT, "data", "eval", "smoke"), ignore_errors=True)
    print("全部通过" if not FAILS else f"失败 {len(FAILS)} 项：{FAILS}")
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
