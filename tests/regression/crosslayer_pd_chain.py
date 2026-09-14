#!/usr/bin/env python3
"""跨层一致性算例 ①（01 §8.3）的典型链路实例：EM-S-02 的解析检出率 vs IQ 级蒙特卡洛检出率（C-5，D-067）。

比对双方：
  M1/M2 侧  D-026 选定的确定型目标检出率公式 Pd = Σ_k Poisson(k; M·s)·Q(M+k, M·η)（algos/reference/energy_detector.py），
            输入是链路预算给出的带内信噪比 s：P_rx = P_tx + G_t + G_r − L（L 取 links.jsonl 的实际路损）、
            N = −174 + nf + 10·log10(M·fs/nfft)，两边都加接收机增益（对信噪比无影响，写出来只为读数自洽）。
  M3 侧     典型链路（场景辐射源 → 天线 → 场景绑定信道 → 天线 → 前端 → ADC → 滑动能量检测 → 特征 → 识别 → 评价）
            跑出的 metrics.json 帧级 Pd（真值 = 突发导通窗，评价器按帧中点判）。
判据：|Pd_mc − Pd_analytic| ≤ 0.05（04 §16.3 建议 0.05–0.10 取严者）。超差是**发现**：退出码 1、打印两侧数字与候选原因，
不得回头调发射功率或距离使其通过（铁律 10）。

场景 tests/regression/scenarios/crosslayer-pd.scenario.json 的参数在跑之前按解析预测冻结（推导写在它的 trace.notes 里）。
框图从前端内置的缺省典型链路（web/src/chain/examples/default.ts）改出：换场景、40 s、ADC 16 bit、加评价器——它就是用户在
框图页会点出来的那条链，不是另写的测试链。

跑法（仓库根目录）：
    uv run --quiet --with numpy python tests/regression/crosslayer_pd_chain.py [--engine engine/build/cuav_run] [--out data/runs/crosslayer-pd]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "algos", "reference"))
import energy_detector as ed  # noqa: E402

TOLERANCE = 0.05
RX_GAIN_DB = 20.0
ADC_BITS = "16"


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT).replace(os.sep, "/")


def default_chain() -> dict:
    src = open(os.path.join(ROOT, "web", "src", "chain", "examples", "default.ts"), encoding="utf-8").read()
    lit = src[src.index("= ") + 2:].strip().rstrip(";")
    return json.loads(json.loads(lit))


def build_diagram(scenario_path: str, scenario: dict) -> dict:
    sha = hashlib.sha256(open(scenario_path, "rb").read()).hexdigest()
    doc = default_chain()
    fs = scenario["sites"][0]["receiver"]["fs_Hz"]
    duration = scenario["time"]["duration_s"]
    sid = scenario["scenario_id"]
    doc["diagram_id"] = "crosslayer-pd-chain"
    doc["name"] = "跨层一致性算例 ①：典型链路实例（C-5）"
    doc["scenario_ref"] = {"scenario_id": sid, "sha256": sha}
    for n in doc["nodes"]:
        if "scene_binding" in n:
            n["scene_binding"]["scenario_id"] = sid
        if "total_samples" in n["params"]:
            n["params"]["total_samples"] = int(duration * fs)
        if n["type"] == "AdcQuantizer":
            n["params"]["bits"] = ADC_BITS      # 量化噪声压到热噪声之下 27 dB，不进解析式
        if n["type"] == "ReceiverFrontEnd":
            n["params"]["gain_dB"] = RX_GAIN_DB
    doc["run"]["duration_s"] = duration
    doc["run"]["seed"] = scenario["seed"]
    doc.pop("observation_points", None)        # 不要谱产品：40 s 的瀑布近 80 MB，本算例只读评价结果
    doc["nodes"].append({"id": "eval", "type": "Evaluator",
                         "scene_binding": {"scenario_id": sid, "site_id": scenario["sites"][0]["id"]}, "params": {}})
    n = len(doc["edges"])
    em = scenario["emitters"][0]["id"]
    doc["edges"] += [
        {"id": f"e{n + 1}", "from": {"node": "det", "port": "out"}, "to": {"node": "eval", "port": "det"}},
        {"id": f"e{n + 2}", "from": {"node": "rec", "port": "out"}, "to": {"node": "eval", "port": "rec"}},
        {"id": f"e{n + 3}", "from": {"node": "scn", "port": f"link:{em}"}, "to": {"node": "eval", "port": "scene1"}},
    ]
    return doc


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="跨层一致性算例 ① 的典型链路实例")
    ap.add_argument("--engine", default=os.path.join(ROOT, "engine", "build", "cuav_run"))
    ap.add_argument("--scenario", default=os.path.join(HERE, "scenarios", "crosslayer-pd.scenario.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "runs", "crosslayer-pd"))
    ap.add_argument("--json", help="把两侧数字写到该文件")
    args = ap.parse_args(argv)
    if not os.path.exists(args.engine):
        print(f"找不到引擎 {rel(args.engine)}：先构建 engine/", file=sys.stderr)
        return 2

    scenario = json.load(open(args.scenario, encoding="utf-8"))
    doc = build_diagram(args.scenario, scenario)
    os.makedirs(args.out, exist_ok=True)
    diagram_path = os.path.join(args.out, "diagram.json")
    with open(diagram_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    cmd = [args.engine, "--run", rel(diagram_path), "--out", rel(args.out), "--task-id", "crosslayer-pd",
           "--scenario", rel(args.scenario), "--scene-root", "", "--library-root", "models/recognition"]
    print("$ " + " ".join(cmd))
    proc = subprocess.run(cmd, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        print(f"引擎退出码 {proc.returncode}", file=sys.stderr)
        return 2

    metrics = json.load(open(os.path.join(args.out, "metrics.json"), encoding="utf-8"))
    sec = metrics["sites"][0]
    det_idx = json.load(open(os.path.join(args.out, "detections.index.json"), encoding="utf-8"))["nodes"]["det"]
    links = read_jsonl(os.path.join(args.out, "links.jsonl"))
    pl = [r["path_loss_dB"] for r in links]
    pl_min, pl_max = min(pl), max(pl)

    site = scenario["sites"][0]
    em = scenario["emitters"][0]
    fs = float(site["receiver"]["fs_Hz"])
    nfft = int(det_idx["nfft"])
    center = float(det_idx["center_Hz"])
    band = ed.Band(det_idx["f_lo_Hz"] - center, det_idx["f_hi_Hz"] - center)   # 索引里是绝对频率，Band 要相对中心的
    M = int(band.mask(nfft, fs).sum())
    eta = float(det_idx["threshold"])
    eta_ref = ed.threshold_for_pfa(M, float(det_idx["pfa"]))
    S_dBm = em["emission"]["tx_power_dBm"] + em["emission"]["antenna_gain_dBi"] + site["antenna"]["gain_dBi"] - pl_min + RX_GAIN_DB
    N_dBm = -174.0 + site["receiver"]["nf_dB"] + 10.0 * math.log10(M * fs / nfft) + RX_GAIN_DB
    snr_dB = S_dBm - N_dBm
    s = ed.snr_db_to_linear(snr_dB)
    pd_det = ed.pd_deterministic_signal(M, eta, s)
    pd_rand = ed.pd_random_signal(M, eta, s)
    pd_mc = sec["frames"]["pd"]
    delta = abs(pd_mc - pd_det)

    fr, sg, rc = sec["frames"], sec["segments"], sec["recognition"]
    print(f"链路：路损 {pl_min:.3f}–{pl_max:.3f} dB（定点，{len(links)} 帧），接收电平 {S_dBm:.2f} dBm，"
          f"带内噪声 {N_dBm:.2f} dBm（M = {M} bin × {fs / nfft:.3f} Hz），带内信噪比 {snr_dB:.2f} dB")
    print(f"检测器：nfft {nfft}，η = {eta:.6f}（Q(M, M·η) = pfa 反解 {eta_ref:.6f}），pfa 目标 {det_idx['pfa']}，"
          f"滑动窗 {det_idx.get('noise_window_frames')} 帧")
    print(f"解析（EM-S-02，D-026）：确定型 Pd = {pd_det:.4f}，随机型 Pd = {pd_rand:.4f}")
    print(f"蒙特卡洛（metrics.json）：帧 {fr['total']}，真值帧 {fr['truth_on']}，tp {fr['tp']} fn {fr['fn']} fp {fr['fp']} tn {fr['tn']}，"
          f"Pd = {pd_mc:.4f}，Pfa = {fr['pfa']:.5f}（目标 {det_idx['pfa']}），F1 = {fr['f1']:.4f}")
    print(f"突发级：真值段 {sg['truth']}，检出 {sg['matched']}（pd_segment {sg['pd_segment']:.4f}），虚警段 {sg['false_segments']}，"
          f"发现时延均值 {sg['detect_delay_s']['mean']:.4f} s")
    lab = rc["labels"]
    row = rc["confusion"][lab.index("telemetry_burst")] if "telemetry_burst" in lab else []
    print(f"识别：评价 {rc['evaluated']} 段，准确率 {rc['accuracy']}，telemetry_burst 行 → {dict(zip(lab, row))}")
    print(f"状态：{sec['state']} {sec['reasons']}")
    print(f"|Pd_mc − Pd_analytic| = {delta:.4f}（容差 {TOLERANCE}）")

    # 参考实现逐值对拍也要过：评价器的数与 evaluate.py 重算一致才谈得上比解析式
    chk = subprocess.run([sys.executable, os.path.join(ROOT, "algos", "reference", "evaluate.py"), args.out],
                         cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(chk.stdout.strip().splitlines()[-1])

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"path_loss_dB": pl_min, "S_dBm": S_dBm, "N_dBm": N_dBm, "snr_dB": snr_dB, "M": M, "eta": eta,
                       "pd_analytic_deterministic": pd_det, "pd_analytic_random": pd_rand, "pd_mc": pd_mc,
                       "delta": delta, "tolerance": TOLERANCE, "frames": fr, "segments": sg,
                       "recognition": {"accuracy": rc["accuracy"], "evaluated": rc["evaluated"]},
                       "evaluate_py": chk.stdout.strip().splitlines()[-1]}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    ok = delta <= TOLERANCE and chk.returncode == 0
    if not ok:
        print("超差或对拍不一致——这是一个发现（铁律 10）：不调参，查根因。候选：导通边沿帧、环里漏检帧带来的噪声估计偏差、"
              "中位数估计的小样本偏差、量化噪声、块门控。", file=sys.stderr)
    print("跨层一致性算例 ① 通过" if ok else "跨层一致性算例 ① 未通过")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
