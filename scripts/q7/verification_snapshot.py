#!/usr/bin/env python3
"""实现验证快照（Q-7，D-106）：给《仿真模型与实现验证说明》备好全部数字。

跑一遍、记下结果，写成 `data/eval/<集合>/verification.json`（入库）。文档生成器只读这个文件与入库的参数表，
不手抄任何数字（formal-tech-report：数字只取自结果文件）。

做五件事：
1. 04 §15.2 标准算例：`tests/regression/standard_cases.py --json`（判据与实测值逐项）；
2. 跨层一致性算例 ①：`tests/regression/crosslayer_pd_chain.py --json`；
3. 引擎与 geo 的单元测试：doctest 与 ctest 的通过计数（要先建好 engine/build 与 geo/build）；
4. 黄金基准清点：每个文件的用途、判据（文件里的 tolerance）、算例数、有没有 MATLAB 一方；
5. 记下引擎二进制与 git 提交，说明这些数字出自哪一版。

用法：uv run --quiet --with numpy --with scipy python scripts/q7/verification_snapshot.py [--set formal-v1]
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, **kw)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def run_json(script: str, extra: list[str]) -> dict:
    with tempfile.TemporaryDirectory(dir=os.path.join(ROOT, "data", "tmp")) as d:
        out = os.path.join(d, "out.json")
        p = sh([sys.executable, script, "--json", out, *extra])
        if p.returncode != 0:
            raise SystemExit(f"{script} 退出码 {p.returncode}：\n{p.stdout[-2000:]}\n{p.stderr[-2000:]}")
        with open(out, encoding="utf-8") as fh:
            return json.load(fh)


def unit_tests() -> dict:
    out = {}
    exe = os.path.join(ROOT, "engine", "build", "cuav_engine_tests")
    p = sh([exe])
    m = re.search(r"test cases:\s*(\d+)\s*\|\s*(\d+) passed\s*\|\s*(\d+) failed(?:\s*\|\s*(\d+) skipped)?", p.stdout)
    if not m:
        raise SystemExit(f"读不出 doctest 的汇总：{p.stdout[-500:]}")
    out["doctest"] = {"cases": int(m.group(1)), "passed": int(m.group(2)), "failed": int(m.group(3)),
                      "skipped": int(m.group(4) or 0), "exit_code": p.returncode}
    for name, d in (("ctest_engine", "engine/build"), ("ctest_geo", "geo/build")):
        p = sh(["ctest", "--test-dir", d, "--output-on-failure"])
        m = re.search(r"(\d+)% tests passed, (\d+) tests failed out of (\d+)", p.stdout)
        if not m:
            raise SystemExit(f"读不出 {d} 的 ctest 汇总：{p.stdout[-500:]}")
        out[name] = {"total": int(m.group(3)), "failed": int(m.group(2)), "exit_code": p.returncode}
    return out


def _count_cases(doc) -> int | None:
    """黄金基准里的算例数：取顶层或 cases / vectors / points 一类列表的长度之和；认不出就不写。"""
    if isinstance(doc, list):
        return len(doc)
    if not isinstance(doc, dict):
        return None
    for k in ("cases", "vectors", "points", "rows", "tests"):
        if isinstance(doc.get(k), list):
            return len(doc[k])
    n = 0
    for k, v in doc.items():
        if k in ("schema", "purpose", "generator", "tolerance", "params", "inputs", "note", "notes"):
            continue
        if isinstance(v, list) and v and isinstance(v[0], dict):
            n += len(v)
    return n or None


def goldens() -> list[dict]:
    out = []
    files = sorted(glob.glob(os.path.join(ROOT, "tests", "golden", "*.json"))
                   + glob.glob(os.path.join(ROOT, "engine", "tests", "golden", "*.json")))
    names = {os.path.basename(f) for f in files}
    for f in files:
        name = os.path.basename(f)
        if name.endswith(".matlab.json"):
            continue
        with open(f, encoding="utf-8") as fh:
            doc = json.load(fh)
        tol = doc.get("tolerance") if isinstance(doc, dict) else None
        out.append({"file": os.path.relpath(f, ROOT).replace(os.sep, "/"), "name": name[:-5],
                    "cases": _count_cases(doc),
                    "tolerance": {k: v for k, v in tol.items() if k in ("rel", "abs", "abs_dB", "rel_tol", "abs_tol")}
                    if isinstance(tol, dict) else None,
                    "matlab": name.replace(".json", ".matlab.json") in names,
                    "bytes": os.path.getsize(f)})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--set", default="formal-v1")
    a = ap.parse_args(argv)
    os.makedirs(os.path.join(ROOT, "data", "tmp"), exist_ok=True)
    print("标准算例 …", flush=True)
    std = run_json(os.path.join("tests", "regression", "standard_cases.py"), [])
    print("跨层一致性算例 ① …", flush=True)
    cross = run_json(os.path.join("tests", "regression", "crosslayer_pd_chain.py"), [])
    print("单元测试 …", flush=True)
    ut = unit_tests()
    head = sh(["git", "rev-parse", "HEAD"]).stdout.strip()
    dirty = [l[3:] for l in sh(["git", "status", "--porcelain", "--", "engine", "geo", "models", "tests", "scripts",
                                "algos"]).stdout.splitlines() if l.strip()]
    doc = {"schema_version": "cuav-verification-snapshot/1", "git": {"commit": head, "dirty_paths": dirty},
           "cuav_run_sha256": sha256(os.path.join(ROOT, "engine", "build", "cuav_run")),
           "standard_cases": std, "crosslayer_1": cross, "unit_tests": ut, "goldens": goldens(),
           "reproduce": ["uv run --quiet --with numpy --with scipy python scripts/q7/verification_snapshot.py"]}
    out = os.path.join(ROOT, "data", "eval", a.set, "verification.json")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    bad = [c for c in std["checks"] if not c["ok"]]
    print(f"写了 {os.path.relpath(out, ROOT)}：标准算例 {len(std['checks'])} 项（不过 {len(bad)}）、"
          f"doctest {ut['doctest']['passed']}/{ut['doctest']['cases']}、ctest 引擎 {ut['ctest_engine']['total']} 项、"
          f"黄金基准 {len(doc['goldens'])} 份")
    return 1 if bad or ut["doctest"]["failed"] or ut["ctest_engine"]["failed"] or ut["ctest_geo"]["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
