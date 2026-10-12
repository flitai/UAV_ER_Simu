#!/usr/bin/env python3
"""按突发解调：服务端 TS（server/src/demod/）对 Python 参考（algos/reference/demod.py）逐项对拍（D-107）。

判据：状态相同；OFDM 的整数倍频偏 q 与定时相同，EVM 差 ≤ 0.01 dB，频偏差 ≤ 0.1 Hz，时延差 ≤ 1e-12 s，
均衡后的点最大绝对差 ≤ 1e-6；GFSK 的前导与同步字比对数相同，频偏差 ≤ 0.1 Hz，符号中心频偏最大差 ≤ 1e-3 Hz。
两边的 FFT（numpy 对自写基 2）与求和次序不同，所以判容差不判逐位。

用法（要先 cd server && npm run build）：
    uv run --quiet --with numpy python tests/regression/demod_parity.py <运行目录> [--op s3] [--per 3]
运行目录缺省取 data/runs/q2-ofdm-waveforms 与 q3-gfsk-waveforms（回归跑出来的，不入 git；缺即明说跳过）。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "algos", "reference"))
import demod  # noqa: E402

fails = 0


def check(cond: bool, what: str) -> None:
    global fails
    print(("  ok   " if cond else "  FAIL ") + what)
    fails += 0 if cond else 1


def ts(run_dir: str, op: str, emitter: str, t: float) -> dict:
    out = subprocess.run(["node", os.path.join(ROOT, "server", "dist", "demod", "cli.js"), run_dir, "--op", op,
                          "--emitter", emitter, "--t", repr(t)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def compare(run_dir: str, op: str, per: int) -> None:
    iq = demod.IqFile(run_dir, op)
    rows = demod.truth_rows(run_dir)
    docs = demod.load_docs()
    by = {}
    for r in rows:
        if r.get("waveform") in ("ofdm", "droneid", "gfsk"):
            by.setdefault(r["emitter_id"], []).append(r)
    for eid, rs in sorted(by.items()):
        for r in rs[1:1 + per]:
            p = demod.demod(iq, r, docs)
            t = ts(run_dir, op, eid, r["t_s"])
            tag = f"{os.path.basename(run_dir)}/{op} {eid} t={r['t_s']:.6f}"
            if p["state"] != t["state"]:
                check(False, f"{tag}：状态 Python {p['state']} 对 TS {t['state']}")
                continue
            if p["state"] != "valid":
                check(True, f"{tag}：两边都是 {p['state']}")
                continue
            if p["kind"] == "ofdm":
                pts = np.array([complex(a, b) for a, b in t["points"]])
                dp = float(np.max(np.abs(pts - p["points"])))
                devm = abs(20 * math.log10(t["evm_rms"]) - 20 * math.log10(p["evm_rms"]))
                ok = (t["q"] == p["q"] and t["timing"] == p["timing"] and devm <= 0.01 and abs(t["cfo_Hz"] - p["cfo_Hz"]) <= 0.1
                      and abs(t["delay_s"] - p["delay_s"]) <= 1e-12 and dp <= 1e-6)
                check(ok, f"{tag}：q {t['q']}/{p['q']} 定时 {t['timing']}/{p['timing']} EVM 差 {devm:.2e} dB "
                          f"频偏差 {abs(t['cfo_Hz'] - p['cfo_Hz']):.2e} Hz 点最大差 {dp:.2e}（MER {p['mer_dB']:.2f} dB）")
            else:
                dd = float(np.max(np.abs(np.array(t["deviations"]) - p["deviations"])))
                ok = (t["header_match"] == p["header_match"] and abs(t["cfo_Hz"] - p["cfo_Hz"]) <= 0.1 and dd <= 1e-3)
                check(ok, f"{tag}：同步字 {t['header_match']}/{p['header_match']} 频偏差 {abs(t['cfo_Hz'] - p['cfo_Hz']):.2e} Hz "
                          f"符号中心最大差 {dd:.2e} Hz")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir", nargs="*")
    ap.add_argument("--op", default=None)
    ap.add_argument("--per", type=int, default=3)
    a = ap.parse_args()
    if not os.path.isfile(os.path.join(ROOT, "server", "dist", "demod", "cli.js")):
        print("缺 server/dist/demod/cli.js：先 cd server && npm run build")
        return 1
    jobs = [(d, a.op or "s3") for d in a.run_dir] or [
        (os.path.join(ROOT, "data", "runs", "q2-ofdm-waveforms"), "s3"),
        (os.path.join(ROOT, "data", "runs", "q3-gfsk-waveforms"), "s3")]
    ran = 0
    for d, op in jobs:
        if not os.path.isfile(os.path.join(d, op, "iq.index.json")):
            print(f"跳过（不当作通过）：{d} 没有 {op}/iq.index.json")
            continue
        compare(d, op, a.per)
        ran += 1
    if not ran:
        print("一个运行目录都没有：没有对拍")
        return 1
    print("对拍", "通过" if fails == 0 else f"失败 {fails} 项")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
