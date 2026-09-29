#!/usr/bin/env python3
"""Q-1 端到端：真引擎写观测点 iq，导出 SigMF，按 06 §9K Q-1 的验收逐条核（D-087）。

夹具取 C-10 的三级全开链 `chain-golden-02-dsp.json`（10 MS/s ADC → 5 MS/s DDC → 信道化），运行时改成 1 s、
在 s3（ADC 后）与 s4（DDC 后）两个观测点加开 iq——**不新增入库夹具**，免得和原夹具两份各自漂。核：

1. 开 iq 不扰动既有产品：同一框图关掉 iq 再跑一遍，两次的谱、包络与它们的索引**逐字节相同**（铁律 10）；
2. S3 导出无损：读回 int16 按满量程换回 float32，与引擎的 iq.cf32 逐位相同；
3. S4 导出一次重量化：回读误差 ≤ 半个码，重量化噪声低于底噪 ≥ 20 dB；
4. SigMF 官方包校验通过（含 SHA-512）；
5. 同种子重跑引擎再导出，SigMF 数据与元数据逐字节相同（铁律 9）；
6. 注记里按链路预算算的带内信噪比，与在导出数据上实测的带内信噪比差 ≤ 1 dB（原型阶段验证值）。

跑法（约 20 s；需要 engine/build/cuav_run，已接进 scripts/build-all.sh）：
    uv run --quiet --with numpy --with sigmf python tests/regression/iq_export_sigmf.py [--keep]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import iq_export_sigmf as X   # noqa: E402

SOURCE = os.path.join(ROOT, "tests", "regression", "diagrams", "chain-golden-02-dsp.json")
SCENARIO = os.path.join("data", "scene", "beijing-yayuncun", "scenarios", "golden-02.scenario.json")
DURATION_S = 1
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    print(f"  [{'过' if ok else '失败'}] {name}：{detail}")
    if not ok:
        FAILS.append(name)


def diagram_bytes(with_iq: bool) -> bytes:
    d = json.load(open(SOURCE, encoding="utf-8"))
    fs = None
    for n in d["nodes"]:
        if n["type"] == "ScenarioSource":
            fs = n["params"]["sample_rate_Hz"]
    d["diagram_id"] = "q1-iq-export"
    d["run"]["duration_s"] = DURATION_S
    for n in d["nodes"]:
        if "total_samples" in n.get("params", {}):
            n["params"]["total_samples"] = int(fs * DURATION_S)
    for op in d["observation_points"]:
        if with_iq and op["id"] in ("s3", "s4"):
            op["products"] = list(op["products"]) + ["iq"]
    return (json.dumps(d, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def run(engine: str, out: str, dbytes: bytes) -> None:
    if os.path.exists(out):
        shutil.rmtree(out)
    dpath = out + ".diagram.json"
    with open(dpath, "wb") as fh:
        fh.write(dbytes)
    p = subprocess.run([engine, "--run", os.path.relpath(dpath, ROOT), "--out", os.path.relpath(out, ROOT),
                        "--task-id", os.path.basename(out), "--scenario", SCENARIO],
                       cwd=ROOT, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"cuav_run 失败（{p.returncode}）：{p.stderr[-800:]}")
    shutil.move(dpath, os.path.join(out, "diagram.json"))    # 与应用服务落盘的位置一致，导出工具缺省在这里找


def sha(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def product_files(run_dir: str) -> dict[str, str]:
    out = {}
    for op in sorted(os.listdir(run_dir)):
        p = os.path.join(run_dir, op)
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if f.startswith(("spectrum.", "envelope.")):
                    out[f"{op}/{f}"] = sha(os.path.join(p, f))
    return out


def measured_snr(data: str, meta: dict, ann: dict) -> float:
    """带内功率：注记区间内（避开边界 20 ms）对注记前的无信号段，汉宁均值谱在 [lo, hi) 内求和。"""
    g = meta["global"]
    amp = 10 ** (g["cuav:full_scale_dBm"] / 20)
    x = np.fromfile(data, dtype="<i2").astype(np.float64).reshape(-1, 2)
    z = (x[:, 0] + 1j * x[:, 1]) / 32768 * amp
    fs, fc = g["core:sample_rate"], meta["captures"][0]["core:frequency"]
    guard = int(0.02 * fs)
    s0 = ann["core:sample_start"]
    lo, hi = ann["core:freq_lower_edge"], ann["core:freq_upper_edge"]

    def band(seg: np.ndarray) -> float:
        n = 1 << 14
        k = seg.size // n
        w = np.hanning(n)
        X_ = np.fft.fftshift(np.fft.fft(seg[:k * n].reshape(k, n) * w, axis=1), axes=1)
        p = np.mean(np.abs(X_) ** 2, axis=0) / np.sum(w * w)
        f = fc + (np.arange(n) - n / 2) * fs / n
        return float(p[(f >= lo) & (f < hi)].sum() / n)

    sig = band(z[s0 + guard:s0 + ann["core:sample_count"] - guard])
    noise = band(z[:s0 - guard])
    return 10 * math.log10(sig / noise - 1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine", default=os.path.join(ROOT, "engine", "build", "cuav_run"))
    ap.add_argument("--keep", action="store_true", help="保留运行目录与导出文件便于手查")
    args = ap.parse_args()
    if not os.path.exists(args.engine):
        print("跳过：没有 engine/build/cuav_run", file=sys.stderr)
        return 0
    os.environ.setdefault("CUAV_RUN", args.engine)
    base = os.path.join(ROOT, "data", "runs", "q1-iq-export")
    dirs = {k: f"{base}{k}" for k in ("", "-noiq", "-rerun")}
    exp = {k: os.path.join(ROOT, "data", "tmp", f"q1-sigmf{k}") for k in ("", "-rerun")}
    print("Q-1 导出 SigMF 端到端（原型阶段验证值）")
    try:
        with_iq, no_iq = diagram_bytes(True), diagram_bytes(False)
        run(args.engine, dirs[""], with_iq)
        run(args.engine, dirs["-noiq"], no_iq)
        a, b = product_files(dirs[""]), product_files(dirs["-noiq"])
        check("开 iq 不扰动既有产品", a == b and len(a) > 0,
              f"{len(a)} 个谱 / 包络文件与索引，开关 iq 两次运行{'逐字节相同' if a == b else '不同'}")

        for d in exp.values():
            shutil.rmtree(d, ignore_errors=True)
        res = {r["op_id"]: r for r in X.export_run(dirs[""], exp[""], stem_prefix="q1")}
        X.validate_with_sigmf(exp[""], [r["stem"] for r in res.values()])
        check("SigMF 官方校验", True, f"{len(res)} 对文件（sigmf 包，规范 {X.SIGMF_VERSION}，含 SHA-512）")

        s3 = res["s3"]
        codes = np.fromfile(os.path.join(exp[""], s3["stem"] + ".sigmf-data"), dtype="<i2")
        meta3 = json.load(open(os.path.join(exp[""], s3["stem"] + ".sigmf-meta"), encoding="utf-8"))
        amp = 10 ** (meta3["global"]["cuav:full_scale_dBm"] / 20)
        back = (codes.astype(np.float64) / 32768 * amp).astype(np.float32)
        raw = np.fromfile(os.path.join(dirs[""], "s3", "iq.cf32"), dtype="<f4")
        check("S3 无损", s3["lossless"] and np.array_equal(back, raw),
              f"{s3['samples']} 样点，读回与引擎 float32 逐位相同：{np.array_equal(back, raw)}")

        s4 = res["s4"]
        check("S4 重量化", s4["max_readback_error_codes"] <= 0.5 and s4["requant_margin_dB"] >= 20.0
              and s4["state"] == "valid",
              f"回读最大误差 {s4['max_readback_error_codes']:.3f} 码（线 0.5），量化噪声低于底噪 "
              f"{s4['requant_margin_dB']} dB（线 20），导出削顶 {s4['export_clipped']}，{s4['state']}")

        run(args.engine, dirs["-rerun"], with_iq)
        same_cf = all(sha(os.path.join(dirs[""], op, "iq.cf32")) == sha(os.path.join(dirs["-rerun"], op, "iq.cf32"))
                      for op in ("s3", "s4"))
        res2 = {r["op_id"]: r for r in X.export_run(dirs["-rerun"], exp["-rerun"], stem_prefix="q1")}
        same_out = all(sha(os.path.join(exp[""], r["stem"] + ext)) == sha(os.path.join(exp["-rerun"], r["stem"] + ext))
                       for r in res2.values() for ext in (".sigmf-data", ".sigmf-meta", ".cuav-links.jsonl"))
        check("同种子逐字节复现", same_cf and same_out,
              f"iq.cf32 {'相同' if same_cf else '不同'}，SigMF 数据 / 元数据 / 链路旁挂 {'相同' if same_out else '不同'}")

        meta4 = json.load(open(os.path.join(exp[""], s4["stem"] + ".sigmf-meta"), encoding="utf-8"))
        anns = [x for x in meta4["annotations"] if x.get("cuav:snr_dB") is not None and x["cuav:in_capture_band"]]
        if not anns:
            check("预算信噪比对实测", False, "没有可对照的注记")
        for ann in anns:
            m = measured_snr(os.path.join(exp[""], s4["stem"] + ".sigmf-data"), meta4, ann)
            check("预算信噪比对实测", abs(m - ann["cuav:snr_dB"]) <= 1.0,
                  f"{ann['cuav:emitter_id']} {ann['core:label']}：注记 {ann['cuav:snr_dB']:.2f} dB，"
                  f"数据上实测 {m:.2f} dB，差 {m - ann['cuav:snr_dB']:+.2f} dB（线 ±1）")
    finally:
        if not args.keep:
            for d in list(dirs.values()) + list(exp.values()):
                shutil.rmtree(d, ignore_errors=True)
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
