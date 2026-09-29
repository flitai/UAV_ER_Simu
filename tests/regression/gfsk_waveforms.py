#!/usr/bin/env python3
"""GFSK 族波形的端到端回归（Q-3，14 号报告 §3、§10.1，决策 D-089）。

从**保存的典型链路** tests/regression/diagrams/chain-gfsk.json（场景 gfsk-80m：FrSky D16 v2 FCC 与
Futaba S-FHSS 两个地面遥控器同时跳频，80 MS/s @ 2440 MHz，1 s）跑一遍真引擎，逐项核对：

  ① 真值：每个包一行，起止与频点与 Python 复刻（gfsk_ref.frame_bursts + hop 活动按包中点取频点）逐位相同；
  ② 瞬时频率轨迹：无噪的 S0 上逐样点相位增量对解析式（gfsk_ref 的闭式相位差 + 载波频偏）；比特由 S0 解调，
     前导 1010… 与同步字 0xD391D391 逐包逐位对上；由轨迹最小二乘估出频偏（→ 调制指数 h），由前导的过零点
     估出符号率；包长（非零样点数）逐包等于 sample_at(t1) − sample_at(t0)；
  ③ 像不像：拿 Q-0b 的提取器（产生 14 §7.1 那张 M 档表的同一段代码）量 S3，按真值把突发分给两个遥控器，
     逐项对：FrSky 对 X20 录音（时长、间隔、频点数、逐跳 +4.5 MHz、−10 dB 与 99% 带宽）；S-FHSS 对它自己的
     S 档参数，与 T14SG 录音的差距**只报数**（协议不同，14 §3.1）。按宽松的物理界判，差距进 Q-5，不调参（铁律 10）；
  ④ 导出：SigMF 注记带 cuav:preset_id、全局预设清单含两个 GFSK 预设；
  ⑤ 铁律 4：站点降到 40 MS/s 时装不下 FrSky 的跳频跨度，场景载入即拒（逐跳闸）。

观测点的 iq 产品在内存里加，不写进夹具（D-087：生成 iq 的夹具随 Q-6）。实时因子照实打印。

用法：uv run --quiet --with numpy --with scipy python tests/regression/gfsk_waveforms.py
"""
from __future__ import annotations

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
import gfsk_ref  # noqa: E402
import q0b_param_extract as q0b  # noqa: E402

CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))
DIAGRAM = os.path.join("tests", "regression", "diagrams", "chain-gfsk.json")
SCENARIO = os.path.join("tests", "regression", "scenarios", "gfsk-80m.scenario.json")
RUN = os.path.join("data", "runs", "q3-gfsk-waveforms")
FS = 80e6
FC = 2.44e9

fails = 0
summary: dict = {}


def check(cond: bool, what: str) -> None:
    global fails
    print(("  通过  " if cond else "  失败  ") + what)
    fails += 0 if cond else 1


def run_engine() -> float:
    with open(os.path.join(ROOT, DIAGRAM), encoding="utf-8") as fh:
        d = json.load(fh)
    for op in d["observation_points"]:
        if op["id"] in ("s0__rc-frsky", "s0__rc-futaba", "s3"):
            op["products"] = op["products"] + ["iq"]
    tmp = tempfile.mkdtemp(prefix="q3-gfsk-")
    try:
        dp = os.path.join(tmp, "chain-gfsk-iq.json")
        with open(dp, "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, indent=2)
        shutil.rmtree(os.path.join(ROOT, RUN), ignore_errors=True)
        t0 = time.time()
        r = subprocess.run([CUAV_RUN, "--run", dp, "--out", RUN, "--scenario", SCENARIO,
                            "--library-root", "models/recognition"], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        wall = time.time() - t0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if r.returncode != 0:
        print(r.stderr)
        raise SystemExit(f"cuav_run 退出码 {r.returncode}")
    with open(os.path.join(ROOT, RUN, "diagram.json"), "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, indent=2)
    return wall


def load_iq(op: str) -> np.ndarray:
    return np.fromfile(os.path.join(ROOT, RUN, op, "iq.cf32"), dtype=np.complex64)


def sample_at(t: float) -> int:
    """geo::sample_at 的同式复刻（四舍五入）。"""
    return 0 if not t > 0.0 else int(t * FS + 0.5)


def center_at(e: dict, acts: list, t: float) -> float:
    """EmitterRuntime::center_Hz_at 的同式复刻（本夹具每个辐射源一条 sequence + dwell 的 hop 活动）。"""
    f = float(e["emission"]["center_Hz"])
    for a in acts:
        if a["emitter_id"] != e["id"] or a["event"] != "hop" or a["t_s"] > t:
            continue
        seq, dw = a["args"]["sequence"], a["args"]["dwell_s"]
        k = math.floor((t - a["t_s"]) / dw)
        f = float(seq[int(math.fmod(k, len(seq)))])
    return f


def expected_bursts(doc_p: dict, scen: dict, eid: str) -> list:
    e = next(x for x in scen["emitters"] if x["id"] == eid)
    w = e["emission"]["waveform"]
    p = gfsk_ref.Preset(doc_p, w["preset_id"])
    out = []
    for (k, q, idx, t0, t1, nb) in gfsk_ref.frame_bursts(p, w.get("frame_offset_s", 0.0), scen["time"]["duration_s"]):
        out.append({"t0": t0, "t1": t1, "center": center_at(e, scen["activities"], t0 + 0.5 * (t1 - t0)),
                    "n_bits": nb, "index": idx, "preset": p})
    return out


# ---------------------------------------------------------------- ① 真值

def check_truth(doc_p: dict, scen: dict) -> dict:
    print("① 真值：一包一行，与 Python 复刻逐位相同")
    rows = [json.loads(l) for l in open(os.path.join(ROOT, RUN, "truth.jsonl"), encoding="utf-8")]
    want_all = {}
    for e in scen["emitters"]:
        eid = e["id"]
        want = expected_bursts(doc_p, scen, eid)
        want_all[eid] = want
        got = [(r["t_s"], r["t_end_s"], r["center_Hz"]) for r in rows if r["emitter_id"] == eid]
        exp = [(b["t0"], b["t1"], b["center"]) for b in want]
        lab = {r["label"] for r in rows if r["emitter_id"] == eid}
        pre = {r.get("preset_id") for r in rows if r["emitter_id"] == eid}
        wav = {r.get("waveform") for r in rows if r["emitter_id"] == eid}
        check(got == exp, f"{eid}：{len(got)} 行真值与复刻逐位相同（{e['emission']['waveform']['preset_id']}）")
        check(lab == {"rc_hopping"} and pre == {e["emission"]["waveform"]["preset_id"]} and wav == {"gfsk"},
              f"{eid}：标签 {sorted(lab)}、preset_id {sorted(pre)}、waveform {sorted(wav)}")
    fr = want_all["rc-frsky"]
    sf = want_all["rc-futaba"]
    check(len(fr) == 143 and abs(fr[1]["t0"] - 0.007) < 1e-15, f"FrSky 每 7 ms 一包（1 s {len(fr)} 包）")
    check(len(sf) == 2 * 147 and abs(sf[1]["t0"] - sf[0]["t0"] - 0.001625) < 1e-15,
          f"S-FHSS 每 6.8 ms 同频两包、相隔 1.625 ms（1 s {len(sf)} 包）")
    check(sf[0]["center"] == sf[1]["center"] and sf[2]["center"] != sf[1]["center"], "S-FHSS 发完第二包才换频")
    summary["truth_rows"] = {eid: len(v) for eid, v in want_all.items()}
    return want_all


# ---------------------------------------------------------------- ② 瞬时频率轨迹

def check_trajectory(want_all: dict) -> None:
    print("② 无噪 S0：逐样点相位增量对闭式解析式；解调比特对前导与同步字；估频偏与符号率")
    for eid, n_check in (("rc-frsky", 12), ("rc-futaba", 16)):
        x = load_iq(f"s0__{eid}").astype(np.complex128)
        bursts = want_all[eid]
        p = bursts[0]["preset"]
        m1 = gfsk_ref.Modulator(p.gaussian, p.bt, p.R, 1.0)        # 单位频偏：拟合频偏用
        mod = gfsk_ref.Modulator.of(p)
        worst = 0.0
        num = den = 0.0
        head_ok = 0
        len_ok = 0
        rate_est = []
        nonzero_total = 0
        for b in bursts[:n_check]:
            lo, hi = sample_at(b["t0"]), sample_at(b["t1"])
            nz = np.flatnonzero(np.abs(x[max(0, lo - 5):hi + 5]) > 0) + max(0, lo - 5)
            len_ok += int(nz.size == hi - lo and nz[0] == lo and nz[-1] == hi - 1)
            nonzero_total += nz.size
            seg = x[lo:hi]
            d = np.angle(seg[1:] * np.conj(seg[:-1])) / (2 * math.pi)      # 周 / 样点
            carrier = (b["center"] - FC) / FS
            m = d - carrier
            m = (m + 0.5) % 1.0 - 0.5
            # 解调：每个符号中心附近那个样点的调制频率符号
            nb = b["n_bits"]
            bits = []
            for k in range(nb):
                n = int(round((k + 0.5) / p.R * FS))
                n = min(max(n, 0), m.size - 1)
                bits.append(1 if m[n] > 0 else -1)
            pre = gfsk_ref.prefix_sums(bits)
            head = [1 if k % 2 == 0 else -1 for k in range(32)] + \
                   [1 if (0xD391D391 >> k) & 1 else -1 for k in range(31, -1, -1)]
            head_ok += int(bits[:64] == head)
            # 解析：ψ(τ_{n+1}) − ψ(τ_n) + 载波
            taus = (np.arange(lo, hi) / FS) - b["t0"]
            psi = np.array([mod.phase_cycles(bits, pre, float(t)) for t in taus])
            psi1 = np.array([m1.phase_cycles(bits, pre, float(t)) for t in taus])
            e = np.diff(psi) + carrier
            diff = d - e
            diff = (diff + 0.5) % 1.0 - 0.5
            worst = max(worst, float(np.max(np.abs(diff))))
            u = np.diff(psi1)
            num += float(np.dot(m, u))
            den += float(np.dot(u, u))
            # 符号率：前导 1010… 的调制频率过零点（相邻符号对称，过零恰在符号边界）
            zc = []
            for k in range(1, 31):
                tb = k / p.R
                n = int(tb * FS)
                a0, a1 = m[n - 1], m[n]
                if a0 * a1 < 0:
                    zc.append((k, (n - 1 + a0 / (a0 - a1) + 0.5) / FS))   # 相位差样点落在两样点中间
            if len(zc) >= 10:
                kk = np.array([z[0] for z in zc], dtype=float)
                tt = np.array([z[1] for z in zc])
                rate_est.append(1.0 / np.polyfit(kk, tt, 1)[0])
        fdev_hat = num / den
        r_hat = float(np.median(rate_est)) if rate_est else float("nan")
        h_hat = 2 * fdev_hat / p.R
        print(f"    {eid}：{n_check} 包，相位增量对解析式最坏 {worst:.2e} 周；频偏估计 {fdev_hat:.3f} Hz（预设 {p.fdev:.3f}）、"
              f"h = {h_hat:.6f}；符号率估计 {r_hat:.2f} baud（预设 {p.R:.2f}）")
        check(worst < 1e-6, f"{eid}：相位增量对解析式最坏 {worst:.1e} 周（float32 的相位分辨约 4e-8 周，线 1e-6）")
        check(head_ok == n_check, f"{eid}：解调出的前导与同步字逐包逐位对上（{head_ok} / {n_check}）")
        check(len_ok == n_check, f"{eid}：非零样点恰为 [sample_at(t0), sample_at(t1))（{len_ok} / {n_check}）")
        check(abs(fdev_hat - p.fdev) / p.fdev < 1e-6, f"{eid}：频偏估计相对差 {abs(fdev_hat - p.fdev) / p.fdev:.1e}")
        check(abs(r_hat - p.R) / p.R < 1e-4, f"{eid}：符号率估计相对差 {abs(r_hat - p.R) / p.R:.1e}")
        summary.setdefault("trajectory", {})[eid] = {"worst_cycles": float(f"{worst:.3g}"),
                                                    "deviation_Hz": round(fdev_hat, 4), "h": round(h_hat, 6),
                                                    "symbol_rate": round(r_hat, 3)}


# ---------------------------------------------------------------- ③ Q-0b 提取器量合成信号

def extractor_by_emitter(want_all: dict) -> dict:
    x = load_iq("s3")
    per = {eid: [] for eid in want_all}
    for st in range(0, x.size, q0b.DRONERFA_BLOCK):
        blk = q0b.analyse_block(x[st:st + q0b.DRONERFA_BLOCK].astype(np.complex128), FS, FC, None, (0.05e6, 5e6))
        t_off = st / FS
        hops = {eid: [] for eid in want_all}
        for h in blk["hops"]:
            t0, t1 = t_off + h.t0_s, t_off + h.t0_s + h.dur_s
            best = None
            for eid, bs in want_all.items():
                for b in bs:
                    ov = min(t1, b["t1"]) - max(t0, b["t0"])
                    if ov > 0 and abs(h.f_center_Hz - b["center"]) < 0.5e6 and (best is None or ov > best[0]):
                        best = (ov, eid)
            if best is not None:
                hops[best[1]].append(h)
        for eid in want_all:
            per[eid].append({"seconds": blk["seconds"], "hops": hops[eid]})
    return {eid: q0b.summarize_link(bl, None, "rc") for eid, bl in per.items()}


def check_realism(q0bj: dict, want_all: dict) -> None:
    print("③ 用 Q-0b 的提取器量 S3，按真值分给两个遥控器（只报数，按宽松的物理界判；差距进 Q-5）")
    meas = {s["id"]: s["groups"][0]["links"][0] for s in q0bj["sources"]
            if s["id"] in ("dronerfa_frsky_x20", "dronerfa_futaba_t14sg")}
    got = extractor_by_emitter(want_all)
    out = {}
    for eid, src in (("rc-frsky", "dronerfa_frsky_x20"), ("rc-futaba", "dronerfa_futaba_t14sg")):
        L, M = got[eid], meas[src]
        if not L.get("found"):
            check(False, f"{eid}：提取器没找到角色")
            continue
        row = {
            "dur_ms": L["dur_s"]["median"] * 1e3, "interval_peak_ms": max(L["interval_peaks_ms"], key=lambda p: p["frac"])["center"],
            "n_points": L["freq_set"]["n_points"], "spacing_MHz": L["freq_set"]["spacing_median_Hz"] / 1e6,
            "step_peak_MHz": max(L["hop_step_peaks_MHz"], key=lambda p: p["frac"])["center"] if L["hop_step_peaks_MHz"] else float("nan"),
            "bw10_kHz": L["bw10_Hz"]["median"] / 1e3, "obw99_kHz": L["obw99_Hz"]["median"] / 1e3,
            "bw3_kHz": L["bw3_Hz"]["median"] / 1e3, "flatness": L["flatness"]["median"], "papr_dB": L["papr_dB"]["median"],
            "n_core": L["n_core"],
        }
        mrow = {
            "dur_ms": M["dur_s"]["median"] * 1e3, "interval_peak_ms": max(M["interval_peaks_ms"], key=lambda p: p["frac"])["center"],
            "n_points": M["freq_set"]["n_points"], "spacing_MHz": M["freq_set"]["spacing_median_Hz"] / 1e6,
            "step_peak_MHz": max(M["hop_step_peaks_MHz"], key=lambda p: p["frac"])["center"],
            "bw10_kHz": M["bw10_Hz"]["median"] / 1e3, "obw99_kHz": M["obw99_Hz"]["median"] / 1e3,
            "bw3_kHz": M["bw3_Hz"]["median"] / 1e3, "flatness": M["flatness"]["median"], "papr_dB": M["papr_dB"]["median"],
        }
        for k in ("dur_ms", "interval_peak_ms", "n_points", "spacing_MHz", "step_peak_MHz", "bw10_kHz", "obw99_kHz",
                  "bw3_kHz", "flatness", "papr_dB"):
            print(f"    {eid} {k:16s} 合成 {row[k]:10.4f}   实测（{src}）{mrow[k]:10.4f}")
        out[eid] = {"synthetic": {k: round(v, 4) for k, v in row.items()},
                    "measured": {k: round(v, 4) for k, v in mrow.items()}}
    fr, sf = out.get("rc-frsky", {}).get("synthetic"), out.get("rc-futaba", {}).get("synthetic")
    if fr:
        check(abs(fr["dur_ms"] - 2.845) < 0.03, "FrSky 时长中位在实测 2.845 ± 0.03 ms")
        check(abs(fr["interval_peak_ms"] - 7.0) < 0.1, "FrSky 间隔主峰在 7.0 ± 0.1 ms")
        check(fr["n_points"] == 47 and abs(fr["spacing_MHz"] - 1.5) < 0.05, "FrSky 47 个频点、间距 1.5 MHz")
        check(abs(fr["step_peak_MHz"] - 4.5) < 0.2, "FrSky 逐跳主峰 +4.5 MHz")
        check(0.10 < fr["bw10_kHz"] / 1e3 < 0.30 and 0.12 < fr["obw99_kHz"] / 1e3 < 0.35,
              "FrSky −10 dB 与 99% 带宽在 0.1–0.35 MHz（窄带 GFSK 量级；与实测的差进 Q-5）")
        check(fr["papr_dB"] < 1.0, "FrSky 恒包络：峰均比 < 1 dB")
    if sf:
        check(abs(sf["dur_ms"] - 1.436) < 0.03, "S-FHSS 时长中位在 1.436 ± 0.03 ms（184 比特 / 128.14 kbaud）")
        check(sf["n_points"] == 30 and abs(sf["spacing_MHz"] - 1.49963) < 0.05, "S-FHSS 30 个频点、间距 1.4996 MHz")
        check(sf["papr_dB"] < 1.0, "S-FHSS 恒包络：峰均比 < 1 dB")
    summary["realism"] = out


# ---------------------------------------------------------------- ④ SigMF 导出

def check_export() -> None:
    print("④ SigMF 导出：注记带 cuav:preset_id，全局带预设清单")
    out = tempfile.mkdtemp(prefix="q3-sigmf-")
    try:
        r = subprocess.run([sys.executable, os.path.join("tools", "iq_export_sigmf.py"), RUN, "-o", out,
                            "--op", "s3", "--scenario", SCENARIO], cwd=ROOT, capture_output=True, text=True)
        check(r.returncode == 0, f"导出退出码 {r.returncode} {r.stderr.strip()[-200:]}")
        metas = [f for f in os.listdir(out) if f.endswith(".sigmf-meta") and "s3" in f]
        check(len(metas) == 1, f"S3 一对 SigMF（{metas}）")
        if metas:
            meta = json.load(open(os.path.join(out, metas[0]), encoding="utf-8"))
            g = meta["global"]
            check(g.get("cuav:preset_ids") == ["frsky-d16v2-fcc", "futaba-sfhss"] and g.get("cuav:presets_version") == "v1",
                  f"全局 {g.get('cuav:preset_ids')} / {g.get('cuav:presets_version')}")
            ann = meta["annotations"]
            ids = {}
            for a in ann:
                ids[a.get("cuav:preset_id")] = ids.get(a.get("cuav:preset_id"), 0) + 1
            check(all(a.get("cuav:preset_id") for a in ann) and all(a.get("cuav:waveform") == "gfsk" for a in ann),
                  f"{len(ann)} 条注记都带 cuav:preset_id 与 waveform = gfsk；按预设 {ids}")
            summary["sigmf_annotations"] = ids
    finally:
        shutil.rmtree(out, ignore_errors=True)


# ---------------------------------------------------------------- ⑤ 铁律 4

def check_rate_gate(scen: dict) -> None:
    print("⑤ 站点 40 MS/s：装不下 FrSky 的跳频跨度，场景载入即拒（逐跳闸）")
    tmp = tempfile.mkdtemp(prefix="q3-40m-")
    try:
        a = json.loads(json.dumps(scen))
        a["sites"][0]["receiver"]["fs_Hz"] = 40_000_000
        a["sites"][0]["receiver"]["bw_Hz"] = 32_000_000
        pa = os.path.join(tmp, "a.scenario.json")
        json.dump(a, open(pa, "w", encoding="utf-8"), ensure_ascii=False)
        r = subprocess.run([CUAV_RUN, "--scenario-track", pa], cwd=ROOT, capture_output=True, text=True)
        check(r.returncode == 2 and "铁律 4" in r.stdout and "跳频点" in r.stdout,
              "退出码 2，报文点名越界的跳频点")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    if not os.path.exists(CUAV_RUN):
        print(f"跳过：没有 {CUAV_RUN}（先构建引擎）")
        return 0
    doc_p = gfsk_ref.load_presets()
    scen = json.load(open(os.path.join(ROOT, SCENARIO), encoding="utf-8"))
    q0bj = json.load(open(os.path.join(ROOT, "data", "iq", "measured", "q0b-params.json"), encoding="utf-8"))
    print("运行 cuav_run（1 s × 80 MS/s，两个遥控器，S0 两路与 S3 写原始 IQ）…")
    wall = run_engine()
    summary["wall_s"] = round(wall, 2)
    summary["realtime_factor"] = round(1.0 / wall, 4)
    print(f"  墙钟 {wall:.1f} s，实时因子 {1.0 / wall:.3f}")
    want_all = check_truth(doc_p, scen)
    check_trajectory(want_all)
    check_realism(q0bj, want_all)
    check_export()
    check_rate_gate(scen)
    print("摘要 " + json.dumps(summary, ensure_ascii=False))
    print("GFSK 族回归" + ("全部通过" if fails == 0 else f"有 {fails} 项失败"))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
