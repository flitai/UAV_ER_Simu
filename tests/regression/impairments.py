#!/usr/bin/env python3
"""接收机非理想与小尺度衰落的端到端回归（Q-4，14 号报告 §4，决策 D-091）。

从**保存的典型链路** tests/regression/diagrams/chain-impairments.json（场景 impairments：悬停信标，单音
名义 2440.25 MHz + 基带偏移 50 kHz，载频偏差 −22.4 ppm；前端开本振相噪、信道开莱斯衰落；2 MS/s @ 2440 MHz、2 s）
跑真引擎。变体在内存里从同一份框图派生（逐项关掉、调高多普勒下限），不另存夹具：

  ① 真值与载频（原样三项全开）：truth.jsonl 每行 cfo_Hz = −22.4e-6·(2440.25e6 + 50e3)；S3 上单音的平均相位增量
     折成的基带频率 = 名义频偏 + cfo（悬停，视距多普勒为 0）；
  ② 相噪积分（衰落关）：S3 单音去掉线性相位后的残余相位方差，减去「相噪也关」那一次的方差（同种子同一串热噪声，
     因为相噪流由前端子种子派生、不从共享流取数，D-091），对闭式 σφ² = π·fc·L0；
  ③ 衰落（相噪关、多普勒下限调到 200 Hz，8 个运行种子）：包络的矩法 K 对设定的 9 dB；**系综**平均功率对链路预算
     （发射 30 dBm + 发射天线 0 dBi + 接收天线 3 dBi − 路损 + 前端 20 dB）。「保均值」是系综性质——有限正弦和
     不是遍历的，单次实现的时间平均会偏开零点几 dB，那个离散只报数；
  ④ 抽头延迟线（只报数，不对实测调参，铁律 10）：拿 Q-2 的 OFDM 夹具 chain-ofdm.json 截成 0.2 s，
     信道分别不开衰落、开「K 9 dB + 100 ns」与「K 0 dB + 100 ns」，用 Q-0b 的提取器量图传的平坦度——
     Q-2 留下的「0.985 对实测 0.73–0.90」是交 Q-5 的差距，这里只把频率选择性会把它挪多少照实打印；
  ⑤ 缺省关：原样框图的节点参数里没有任何一个新参数的缺省值（编译省略缺省值，既有框图逐字节不变）。

实时因子照实打印。零基准（既有产品逐字节不变）不在这里做：那要上一版提交的引擎，按 D-091 手工比对并记录。

用法：uv run --quiet --with numpy --with scipy python tests/regression/impairments.py
"""
from __future__ import annotations

import copy
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "algos", "reference"))
import q0b_param_extract as q0b  # noqa: E402

CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))
DIAGRAM = os.path.join("tests", "regression", "diagrams", "chain-impairments.json")
SCENARIO = os.path.join("tests", "regression", "scenarios", "impairments.scenario.json")
OFDM_DIAGRAM = os.path.join("tests", "regression", "diagrams", "chain-ofdm.json")
OFDM_SCENARIO = os.path.join("tests", "regression", "scenarios", "ofdm-80m.scenario.json")
RUN_BASE = os.path.join("data", "runs", "q4-impairments")
FS = 2e6
FC = 2.44e9

fails = 0
summary: dict = {}


def check(cond: bool, what: str) -> None:
    global fails
    print(("  通过  " if cond else "  失败  ") + what)
    fails += 0 if cond else 1


def load(path: str) -> dict:
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return json.load(fh)


def node(d: dict, ntype: str) -> list[dict]:
    return [n for n in d["nodes"] if n["type"] == ntype]


def run(d: dict, scenario: str, name: str, iq_ops: tuple[str, ...], duration_s: float | None = None) -> tuple[str, float]:
    d = copy.deepcopy(d)
    if duration_s is not None:
        d["run"]["duration_s"] = duration_s
        fs = next(n["params"]["sample_rate_Hz"] for n in d["nodes"] if n["type"] == "ScenarioSource")
        for n in d["nodes"]:
            if "total_samples" in n.get("params", {}):
                n["params"]["total_samples"] = int(round(fs * duration_s))
    for op in d["observation_points"]:
        if op["id"] in iq_ops:
            op["products"] = list(op["products"]) + ["iq"]
    out = f"{RUN_BASE}-{name}"
    tmp = tempfile.mkdtemp(prefix="q4-")
    try:
        dp = os.path.join(tmp, "diagram.json")
        with open(dp, "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, indent=2)
        shutil.rmtree(os.path.join(ROOT, out), ignore_errors=True)
        t0 = time.time()
        r = subprocess.run([CUAV_RUN, "--run", dp, "--out", out, "--scenario", scenario,
                            "--library-root", "models/recognition"], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        wall = time.time() - t0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if r.returncode != 0:
        print(r.stderr)
        raise SystemExit(f"cuav_run（{name}）退出码 {r.returncode}")
    return out, wall


def load_iq(run_dir: str, op: str = "s3") -> np.ndarray:
    return np.fromfile(os.path.join(ROOT, run_dir, op, "iq.cf32"), dtype=np.complex64).astype(np.complex128)


def mean_freq(x: np.ndarray) -> float:
    """逐样点相位增量的均值折成赫兹（单音近乎恒包络，直接用 arg(x[n+1]·x*[n])）。"""
    return float(np.mean(np.angle(x[1:] * np.conj(x[:-1])))) * FS / (2 * math.pi)


def residual_phase_var(x: np.ndarray, f: float) -> float:
    n = np.arange(x.size)
    ph = np.unwrap(np.angle(x * np.exp(-2j * math.pi * f / FS * n)))
    a, b = np.polyfit(n, ph, 1)
    r = ph - (a * n + b)
    return float(np.mean(r * r))


def main() -> int:
    base = load(DIAGRAM)
    scen = load(SCENARIO)
    em = scen["emitters"][0]["emission"]
    f_nom = em["center_Hz"] + em["waveform"]["offset_Hz"]
    cfo_want = em["cfo_ppm"] * 1e-6 * f_nom
    fe = node(base, "ReceiverFrontEnd")[0]
    ch = node(base, "SceneBoundChannel")[0]

    print("⑤ 缺省关：编译省略缺省值")
    defaults = {"pn_level_dBc_Hz", "pn_corner_Hz", "fading_k_los_dB", "fading_min_doppler_Hz", "fading_delay_spread_ns"}
    written = sorted((set(fe.get("params", {})) | set(ch.get("params", {}))) & defaults)
    check(not written, f"保存的框图只写了开关，没写缺省值（{written or '无'}）")
    check(fe["params"].get("phase_noise") == "pll" and ch["params"].get("fading") == "rician",
          "保存的框图三项全开：phase_noise = pll、fading = rician（载频偏差在场景里）")

    # ① 原样三项全开
    print("① 真值与载频偏差（三项全开）")
    r_all, wall = run(base, SCENARIO, "all", ("s3",))
    rt = wall / scen["time"]["duration_s"]
    rows = [json.loads(l) for l in open(os.path.join(ROOT, r_all, "truth.jsonl"), encoding="utf-8")]
    check(len(rows) >= 1 and all(abs(r.get("cfo_Hz", 0.0) - cfo_want) <= 1e-9 * abs(cfo_want) for r in rows),
          f"{len(rows)} 行真值的 cfo_Hz = {cfo_want:.3f} Hz（−22.4 ppm × 实际名义射频）")
    check(all(r["center_Hz"] == em["center_Hz"] for r in rows), "真值 center_Hz 仍是名义值（in_band 按名义判）")
    x = load_iq(r_all)
    f_est = mean_freq(x)
    f_want = f_nom - FC + cfo_want
    print(f"    S3 单音基带频率 {f_est:.3f} Hz，期望 {f_want:.3f} Hz（名义 {f_nom - FC:.0f} Hz + 载频偏差 {cfo_want:.3f} Hz）")
    check(abs(f_est - f_want) < 1.0, "载频平移对 cfo_ppm·f（差 < 1 Hz；悬停，视距多普勒为 0）")
    summary["cfo"] = {"want_Hz": round(cfo_want, 3), "measured_shift_Hz": round(f_est - (f_nom - FC), 3)}
    summary["realtime_factor_all_on"] = round(1.0 / rt, 3) if rt > 0 else None

    # ② 相噪积分：衰落关；再关相噪作对照（同一串热噪声）
    print("② 本振相噪积分（衰落关；以「相噪也关」那一次作热噪声底）")
    d_pn = copy.deepcopy(base)
    node(d_pn, "SceneBoundChannel")[0]["params"].pop("fading", None)
    r_pn, _ = run(d_pn, SCENARIO, "pn", ("s3",))
    d_clean = copy.deepcopy(d_pn)
    node(d_clean, "ReceiverFrontEnd")[0]["params"].pop("phase_noise", None)
    r_clean, _ = run(d_clean, SCENARIO, "clean", ("s3",))
    xp, xc = load_iq(r_pn), load_iq(r_clean)
    fp = mean_freq(xp)
    v_pn, v_clean = residual_phase_var(xp, fp), residual_phase_var(xc, mean_freq(xc))
    L0 = 10 ** (-95.0 / 10)
    fc = 1e5
    want = math.pi * fc * L0
    a = math.exp(-2 * math.pi * fc / FS)
    sd = want * math.sqrt(2 * (1 + a * a) / ((1 - a * a) * xp.size))
    got = v_pn - v_clean
    print(f"    残余相位方差：开相噪 {v_pn:.4e}、关相噪 {v_clean:.4e} rad²；差 {got:.4e} 对闭式 {want:.4e}"
          f"（{math.degrees(math.sqrt(max(got, 0))):.4f}° 对 {math.degrees(math.sqrt(want)):.4f}°，AR(1) 标准差 {sd / want:.2%}）")
    check(abs(got - want) < max(5 * sd, 0.01 * want), "均方根相位误差对 sqrt(π·fc·L0)（5 倍标准差或 1% 取宽者）")
    summary["phase_noise"] = {"rms_deg": round(math.degrees(math.sqrt(max(got, 0))), 5),
                              "closed_form_deg": round(math.degrees(math.sqrt(want)), 5),
                              "thermal_floor_rad2": v_clean}

    # ③ 衰落：相噪关、多普勒下限调到 200 Hz（2 s 里约 400 个衰落周期）。「保均值」是**系综**性质：
    # 有限个正弦的和不是遍历的——多普勒接近 0 的那几个正弦在 2 s 里几乎不转，与视距分量的交叉项不随时间平均掉，
    # 单次实现的时间平均功率因此会偏开零点几 dB。所以换 8 个运行种子取系综，单次实现的离散只报数。
    print("③ 莱斯衰落（相噪关、多普勒下限 200 Hz；8 个运行种子的系综）")
    d_f = copy.deepcopy(base)
    node(d_f, "ReceiverFrontEnd")[0]["params"].pop("phase_noise", None)
    node(d_f, "SceneBoundChannel")[0]["params"]["fading_min_doppler_Hz"] = 200.0
    site = scen["sites"][0]
    means, m1s, m2s = [], [], []
    budget = None
    for k in range(8):
        dk = copy.deepcopy(d_f)
        dk["run"]["seed"] = 20261004 + k
        r_f, _ = run(dk, SCENARIO, "fading", ("s3",))
        p = np.abs(load_iq(r_f)) ** 2
        means.append(float(np.mean(p)))
        m1s.append(float(np.mean(p)))
        m2s.append(float(np.mean(p * p)))
        if budget is None:
            links = [json.loads(l) for l in open(os.path.join(ROOT, r_f, "links.jsonl"), encoding="utf-8")]
            pl = float(np.mean([r["path_loss_dB"] for r in links]))
            budget = em["tx_power_dBm"] + em["antenna_gain_dBi"] + site["antenna"]["gain_dBi"] - pl + 20.0
    ref = 10 ** (budget / 10)
    rel = np.array(means) / ref
    mu, se = float(np.mean(rel)), float(np.std(rel, ddof=1) / math.sqrt(rel.size))
    m1, m2 = float(np.mean(m1s)), float(np.mean(m2s))
    gam = (m2 - m1 * m1) / (m1 * m1)
    kh = math.sqrt(1 - gam) / (1 - math.sqrt(1 - gam))
    per = [10 * math.log10(v) for v in rel]
    print(f"    矩法 K {10 * math.log10(kh):.2f} dB（设定 9 dB）；系综平均功率对链路预算 {10 * math.log10(mu):+.3f} dB"
          f"（标准误 {10 * math.log10(1 + se):.3f} dB）")
    print(f"    单次实现（2 s）对预算：{', '.join(f'{v:+.2f}' for v in per)} dB（只报数：有限正弦和的非遍历）")
    check(abs(10 * math.log10(kh) - 9.0) < 1.0, "视距莱斯 K 在设定值 ±1 dB 内")
    check(abs(mu - 1.0) < max(5 * se, 0.01), "系综平均功率对链路预算在 5 倍标准误内（衰落保均值，不与路损重复计入）")
    summary["fading"] = {"K_dB": round(10 * math.log10(kh), 3), "ensemble_mean_minus_budget_dB": round(10 * math.log10(mu), 4),
                         "per_realization_dB": [round(v, 3) for v in per]}
    # 原样那一次（下限 5 Hz、2 s 只有十来个衰落周期）只报数
    pa = float(np.mean(np.abs(x) ** 2))
    print(f"    原样（下限 5 Hz）单次实现平均功率对预算 {10 * math.log10(pa) - budget:+.3f} dB（只报数）")

    # ④ 抽头延迟线：OFDM 图传的平坦度（只报数）
    print("④ 抽头延迟线对 OFDM 图传平坦度的影响（只报数，Q-2 差距交 Q-5）")
    q0bj = json.load(open(os.path.join(ROOT, "data", "iq", "measured", "q0b-params.json"), encoding="utf-8"))
    vrule = q0bj["sources"][0]["video_rule"]
    od = load(OFDM_DIAGRAM)
    flats = {}
    for name, fad in (("off", None), ("k9-100ns", {"fading": "rician", "fading_delay_spread_ns": 100.0}),
                      ("k0-100ns", {"fading": "rician", "fading_k_los_dB": 0.0, "fading_delay_spread_ns": 100.0})):
        dv = copy.deepcopy(od)
        if fad:
            for n in node(dv, "SceneBoundChannel"):
                n["params"].update(fad)
        rd, _ = run(dv, OFDM_SCENARIO, f"ofdm-{name}", ("s3",), duration_s=0.2)
        xo = np.fromfile(os.path.join(ROOT, rd, "s3", "iq.cf32"), dtype=np.complex64)
        blocks = []
        for st in range(0, xo.size, q0b.DRONERFA_BLOCK):
            b = q0b.analyse_block(xo[st:st + q0b.DRONERFA_BLOCK].astype(np.complex128), 80e6, FC, vrule, (0.5e6, 12e6))
            b["visibility"] = "LOS"
            blocks.append(b)
        v = q0b.summarize_video(blocks)
        flats[name] = v["flatness"]["median"]
        shutil.rmtree(os.path.join(ROOT, rd), ignore_errors=True)
    print(f"    图传平坦度：不开衰落 {flats['off']:.3f}；K 9 dB + 100 ns {flats['k9-100ns']:.3f}；"
          f"K 0 dB + 100 ns {flats['k0-100ns']:.3f}（DroneRFb 实测 0.73–0.90）")
    check(all(0.0 < f <= 1.0 for f in flats.values()), "三种配置的平坦度都量得出来")
    summary["ofdm_flatness"] = {k: round(val, 4) for k, val in flats.items()}

    for name in ("all", "pn", "clean", "fading"):
        shutil.rmtree(os.path.join(ROOT, f"{RUN_BASE}-{name}"), ignore_errors=True)
    print(f"实时因子（2 MS/s、三项全开、单源）{1.0 / rt:.3f}" if rt > 0 else "")
    print("摘要", json.dumps(summary, ensure_ascii=False))
    print("全部通过" if fails == 0 else f"失败 {fails} 项")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
