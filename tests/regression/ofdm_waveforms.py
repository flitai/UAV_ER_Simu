#!/usr/bin/env python3
"""OFDM 族波形的端到端回归（Q-2，14 号报告 §2、§10.1，决策 D-088）。

从**保存的典型链路** tests/regression/diagrams/chain-ofdm.json（场景 ofdm-80m：DJI 图传 20 MHz +
同一架机的 DroneID + 地面遥控器上行跳频，80 MS/s @ 2440 MHz，1 s）跑一遍真引擎，逐项核对：

  ① 真值：每个突发一行，起止与频点与 Python 复刻的帧排布逐位相同；DroneID 首个突发在 0.1 s、
     长 9880 / 15.36e6 s（643.23 µs）、周期 640 ms，逐位；
  ② 结构：无噪的 S0 上，DroneID 第 4 符号的 ZC 相关峰恰在「突发起点 + 前三个符号 + CP」（0 样点偏差）；
     带噪的 S3 上同一个峰在按链路时延平移后的位置（±1 个原生样点）；
  ③ 星座：无噪的 S0 上把图传搬回基带、有理重采样回原生率、逐子载波一抽头均衡后的 EVM；
  ④ 像不像：拿 Q-0b 的提取器（algos/reference/q0b_param_extract.py，产生 14 §7.1 那张 M 档表的同一段代码）
     量 S3，逐项对实测：图传 −10 dB 宽度、99% 带宽、突发时长两峰、占空、间隔、峰均比、平坦度；上行与 DroneID
     的时长与单跳宽度。**只报数、按宽松的物理界判**——差距本身是 Q-5 对照报告的内容，不在这里调参凑近（铁律 10）；
  ⑤ 导出：SigMF 注记带 cuav:preset_id、全局带预设清单；
  ⑥ 铁律 4：站点降到 10 MS/s 时场景载入即拒，报文说清缘由（图传被占用带宽闸拦；只留 DroneID 时被档位拦并列出可取值）。

观测点的 iq 产品在内存里加（写 1 s × 80 MS/s 的原始样点，约 640 MB / 点），不写进夹具（D-087：生成 iq 的夹具随 Q-6）。
实时因子照实打印，回填 14 §8.3。

用法：uv run --quiet --with numpy --with scipy python tests/regression/ofdm_waveforms.py
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
from scipy.signal import resample_poly

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "algos", "reference"))
import ofdm_ref  # noqa: E402
import q0b_param_extract as q0b  # noqa: E402

CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))
DIAGRAM = os.path.join("tests", "regression", "diagrams", "chain-ofdm.json")
SCENARIO = os.path.join("tests", "regression", "scenarios", "ofdm-80m.scenario.json")
RUN = os.path.join("data", "runs", "q2-ofdm-waveforms")
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
        if op["id"] in ("s0__uav-1", "s0__uav-1-droneid", "s3"):
            op["products"] = op["products"] + ["iq"]
    tmp = tempfile.mkdtemp(prefix="q2-ofdm-")
    try:
        dp = os.path.join(tmp, "chain-ofdm-iq.json")
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
    # 经应用服务提交的任务目录里有 diagram.json（导出工具据此找观测点与满量程）；直接跑引擎时照样放一份
    with open(os.path.join(ROOT, RUN, "diagram.json"), "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, indent=2)
    return wall


def load_iq(op: str) -> np.ndarray:
    return np.fromfile(os.path.join(ROOT, RUN, op, "iq.cf32"), dtype=np.complex64)


# ---------------------------------------------------------------- ① 真值

def check_truth(doc_p: dict, scen: dict) -> None:
    print("① 真值：一个突发一行，与 Python 复刻的帧排布逐位相同")
    rows = [json.loads(l) for l in open(os.path.join(ROOT, RUN, "truth.jsonl"), encoding="utf-8")]
    ems = {e["id"]: e for e in scen["emitters"]}
    hop = next(a for a in scen["activities"] if a["emitter_id"] == "rc-1")["args"]
    for eid, e in ems.items():
        w = e["emission"]["waveform"]
        p = ofdm_ref.Preset(doc_p, w["preset_id"])
        raw = next(x for x in doc_p["presets"] if x["id"] == w["preset_id"])
        off = int(round(w.get("frame_offset_s", 0.0) * p.fs))
        end_n = math.ceil(scen["time"]["duration_s"] * p.fs) + 1
        want = []
        for (_, s, n, _) in ofdm_ref.frame_bursts(doc_p, w["preset_id"], scen["seed"], eid, off, end_n):
            t0 = s / p.fs
            if t0 >= scen["time"]["duration_s"]:
                continue
            mid = (s + 0.5 * n) / p.fs
            c = e["emission"]["center_Hz"]
            if eid == "rc-1":
                c = hop["sequence"][int(math.floor(mid / hop["dwell_s"])) % len(hop["sequence"])]
            want.append((t0, (s + n) / p.fs, float(c)))
        got = [(r["t_s"], r["t_end_s"], r["center_Hz"]) for r in rows if r["emitter_id"] == eid]
        lab = {r["label"] for r in rows if r["emitter_id"] == eid}
        pre = {r.get("preset_id") for r in rows if r["emitter_id"] == eid}
        check(got == want, f"{eid}：{len(got)} 行真值与复刻逐位相同（{w['preset_id']}）")
        check(lab == {raw["role"]} and pre == {w["preset_id"]}, f"{eid}：标签 {sorted(lab)}、preset_id {sorted(pre)}")
    did = [r for r in rows if r["emitter_id"] == "uav-1-droneid"]
    check(len(did) == 2 and did[0]["t_s"] == 1536000 / 15.36e6 and did[1]["t_s"] == (1536000 + 9830400) / 15.36e6,
          f"DroneID 突发起点 {[r['t_s'] for r in did]}（0.1 s 起、640 ms 周期，逐位）")
    check(all(r["t_end_s"] - r["t_s"] == 9880 / 15.36e6 or abs((r["t_end_s"] - r["t_s"]) - 9880 / 15.36e6) < 1e-15
              for r in did), f"DroneID 突发长 {(did[0]['t_end_s'] - did[0]['t_s']) * 1e6:.3f} µs（9880 个原生样点）")
    summary["truth_rows"] = {eid: sum(1 for r in rows if r["emitter_id"] == eid) for eid in ems}


# ---------------------------------------------------------------- ② ZC 相关峰

def zc_peak(x: np.ndarray, m0: int, df: float, up: int, down: int, ref: np.ndarray, span: int) -> tuple[int, float]:
    """把站点样点 [m0, m0 + span) 搬到基带、重采样到原生率，返回 ZC 相关峰的原生序号（相对 m0 对应的原生点）与峰旁瓣比。"""
    seg = x[m0:m0 + span].astype(np.complex128)
    m = np.arange(m0, m0 + span, dtype=np.float64)
    seg *= np.exp(-2j * np.pi * ((m * (df / FS)) % 1.0))
    y = resample_poly(seg, up, down)
    c = np.abs(np.correlate(y, ref, mode="valid"))
    k = int(np.argmax(c))
    side = np.concatenate([c[:max(0, k - 200)], c[k + 200:]])
    psr = 20 * math.log10(c[k] / float(np.max(side))) if side.size else float("inf")
    return k, psr


def check_zc(doc_p: dict) -> None:
    print("② DroneID 第 4 符号的 ZC 相关峰（NDSS23：根 600）")
    p = ofdm_ref.Preset(doc_p, "dji-droneid")
    ref = ofdm_ref.symbol_time(p, ofdm_ref.zc_carriers(p, 600))
    lead = 1104 + 1096 + 1096 + 72                        # 前三个符号 + 第 4 个符号的 CP
    m0 = 8_000_000                                        # 0.1 s：125 的整数倍，对应原生 1536000
    df = 2.4145e9 - FC
    k0, psr0 = zc_peak(load_iq("s0__uav-1-droneid"), m0, df, 24, 125, ref, 60_000)
    check(k0 == lead, f"S0（无噪）：峰在原生第 {k0} 点，应为 {lead}（偏差 {k0 - lead}），峰旁瓣比 {psr0:.1f} dB")
    link = json.loads(open(os.path.join(ROOT, RUN, "links.jsonl"), encoding="utf-8").readline())
    dly = [json.loads(l) for l in open(os.path.join(ROOT, RUN, "links.jsonl"), encoding="utf-8")
           if json.loads(l)["link_id"] == "site-1-uav-1-droneid"][0]["delay_s"]
    shift = round(dly * FS) * 24 / 125                   # 信道按整数个站点样点延时
    k3, psr3 = zc_peak(load_iq("s3"), m0, df, 24, 125, ref, 60_000)
    check(abs(k3 - (lead + shift)) <= 1.0 and psr3 > 10.0,
          f"S3（带噪、叠着图传与上行）：峰在 {k3}，应为 {lead + shift:.2f}（链路时延 {dly * 1e6:.3f} µs），峰旁瓣比 {psr3:.1f} dB")
    summary["zc"] = {"s0_offset": k0 - lead, "s0_psr_dB": round(psr0, 2), "s3_offset": round(k3 - lead - shift, 2),
                     "s3_psr_dB": round(psr3, 2)}
    del link


# ---------------------------------------------------------------- ③ 星座 EVM

def check_evm(doc_p: dict, rows: list[dict]) -> None:
    print("③ 图传星座：无噪 S0 搬回基带、重采样回原生率、逐子载波一抽头均衡后的 EVM")
    p = ofdm_ref.Preset(doc_p, "dji-video-20m-a")
    b = next(r for r in rows if r["emitter_id"] == "uav-1" and r["t_s"] > 0.001)
    n0 = int(round(b["t_s"] * p.fs))                     # 原生 30.72 MS/s 上的起点，整数
    j = n0 // 48 - 2                                     # 站点段从 125 的整数倍开始：原生 48·j ↔ 站点 125·j
    m0, nat0 = 125 * j, 48 * j
    L = int(round((b["t_end_s"] - b["t_s"]) * FS)) + 2000
    x = load_iq("s0__uav-1")[m0:m0 + L].astype(np.complex128)
    m = np.arange(m0, m0 + L, dtype=np.float64)
    x *= np.exp(-2j * np.pi * ((m * ((2.4625e9 - FC) / FS)) % 1.0))
    y = resample_poly(x, 48, 125, window=("kaiser", 10.0))
    cps = p.bursts[0]["cp"] if (b["t_end_s"] - b["t_s"]) * p.fs < 40000 else p.bursts[1]["cp"]
    ks = np.array([p.k_of(i) for i in range(2 * p.K)])
    zc = np.array(ofdm_ref.zc_carriers(p, 29))
    pos = n0 - nat0
    Y = []
    for cp in cps:
        pos += cp
        Y.append(np.fft.fft(y[pos:pos + p.fft])[ks % p.fft])
        pos += p.fft
    H = Y[0] / zc
    lv = np.array(p.levels)
    err = ref = 0.0
    for Yk in Y[1:]:
        X = Yk / H
        d = lv[np.argmin(np.abs(X.real[:, None] - lv[None, :]), axis=1)] + 1j * lv[np.argmin(np.abs(X.imag[:, None] - lv[None, :]), axis=1)]
        err += float(np.sum(np.abs(X - d) ** 2))
        ref += float(np.sum(np.abs(d) ** 2))
    evm = 10 * math.log10(err / ref)
    check(evm <= -40.0, f"EVM {evm:.1f} dB（{len(Y) - 1} 个数据符号 × {2 * p.K} 个子载波；线 −40 dB）")
    summary["evm_dB"] = round(evm, 2)


# ---------------------------------------------------------------- ④ Q-0b 提取器量合成信号

def check_realism(q0bj: dict) -> None:
    print("④ 用 Q-0b 的提取器量 S3，对 14 §7.1 的实测（只报数，按宽松的物理界判；差距进 Q-5）")
    src = q0bj["sources"][0]
    vrule = src["video_rule"]
    x = load_iq("s3")
    blocks = []
    for st in range(0, x.size, q0b.DRONERFA_BLOCK):
        blocks.append(q0b.analyse_block(x[st:st + q0b.DRONERFA_BLOCK].astype(np.complex128), FS, FC, vrule,
                                        (0.5e6, 12e6)))
    for b in blocks:
        b["visibility"] = "LOS"
    v = q0b.summarize_video(blocks)
    meas = {g["group"]: g["video"] for g in src["groups"] if g["group"] in "ADFG"}
    bw10 = v["bw10_Hz"]["median"] / 1e6
    obw = v["obw99_Hz"]["median"] / 1e6
    peaks = [(round(pk["center"], 3), round(pk["frac"], 3)) for pk in v["dur_peaks_ms"]]
    duty = v["duty_per_block"]["median"]
    papr = v["papr_dB"]["median"]
    flat = v["flatness"]["median"]
    iv = v["interval_s"]
    print(f"    图传 −10 dB 宽度 {bw10:.2f} MHz（实测 A/D/F/G 中位 "
          f"{', '.join(f'{meas[g]['bw10_Hz']['median'] / 1e6:.2f}' for g in 'ADFG')}）")
    print(f"    99% 带宽 {obw:.2f} MHz（实测 {', '.join(f'{meas[g]['obw99_Hz']['median'] / 1e6:.2f}' for g in 'ADFG')}）")
    print(f"    时长峰 {peaks}（实测 1.06–1.10 ms 与 2.12–2.14 ms）；占空 {duty:.3f}（实测 0.410–0.416）")
    print(f"    峰均比 {papr:.2f} dB（实测 7.85–8.17）；平坦度 {flat:.3f}（实测 0.73–0.90）")
    print(f"    间隔 p10/p50/p90 {iv['p10'] * 1e3:.2f}/{iv['median'] * 1e3:.2f}/{iv['p90'] * 1e3:.2f} ms"
          f"（实测约 1.99/2.83–2.97/5.0–5.2 ms；间隔不参与拟合）")
    check(abs(bw10 - 18.2) < 0.6, "图传 −10 dB 宽度在实测 18.1–18.3 MHz 的 ±0.6 MHz 内")
    check(any(abs(c - 1.07) < 0.05 for c, _ in peaks), "图传时长有 1.07 ms 一峰")
    check(abs(duty - 0.411) < 0.05, "图传占空在 0.411 ± 0.05 内")
    check(7.0 < papr < 9.5, "图传峰均比在 7–9.5 dB（OFDM 量级；复高斯 8.39 dB）")
    hops = [h for b in blocks for h in b["hops"] if not h.truncated and h.snr_dB >= 12.0]
    up = [h for h in hops if abs(h.bw10_Hz - 2.2e6) < 0.8e6]
    did = [h for h in hops if abs(h.f_center_Hz - 2.4145e9) < 1e6 and h.bw10_Hz > 6e6]
    up_dur = float(np.median([h.dur_s for h in up])) * 1e3 if up else float("nan")
    up_bw = float(np.median([h.bw10_Hz for h in up])) / 1e6 if up else float("nan")
    did_dur = [round(h.dur_s * 1e6, 1) for h in did]
    print(f"    上行 {len(up)} 个突发：时长中位 {up_dur:.3f} ms（实测 0.500）、−10 dB 宽度 {up_bw:.2f} MHz（实测 2.23）")
    print(f"    DroneID {len(did)} 个突发：能量等效时长 {did_dur} µs（结构 643.23 µs）")
    check(len(up) > 100 and abs(up_dur - 0.500) < 0.02, "上行时长中位在 0.500 ± 0.02 ms")
    check(abs(up_bw - 2.23) < 0.3, "上行 −10 dB 宽度在 2.23 ± 0.3 MHz")
    check(len(did) == 2 and all(abs(d - 643.23) < 25 for d in did_dur), "DroneID 两个突发、时长在 643 ± 25 µs")
    summary["realism"] = {"video_bw10_MHz": round(bw10, 3), "video_obw99_MHz": round(obw, 3), "video_dur_peaks_ms": peaks,
                          "video_duty": round(duty, 4), "video_papr_dB": round(papr, 3), "video_flatness": round(flat, 4),
                          "video_interval_ms": {k: round(iv[k] * 1e3, 3) for k in ("p10", "p25", "median", "p75", "p90")},
                          "uplink_n": len(up), "uplink_dur_ms": round(up_dur, 4), "uplink_bw10_MHz": round(up_bw, 3),
                          "droneid_dur_us": did_dur}


# ---------------------------------------------------------------- ⑤ SigMF 导出

def check_export() -> None:
    print("⑤ SigMF 导出：注记带 cuav:preset_id，全局带预设清单")
    out = tempfile.mkdtemp(prefix="q2-sigmf-")
    try:
        r = subprocess.run([sys.executable, os.path.join("tools", "iq_export_sigmf.py"), RUN, "-o", out,
                            "--op", "s3", "--scenario", SCENARIO], cwd=ROOT, capture_output=True, text=True)
        check(r.returncode == 0, f"导出退出码 {r.returncode} {r.stderr.strip()[-200:]}")
        metas = [f for f in os.listdir(out) if f.endswith(".sigmf-meta") and "s3" in f]
        check(len(metas) == 1, f"S3 一对 SigMF（{metas}）")
        if metas:
            meta = json.load(open(os.path.join(out, metas[0]), encoding="utf-8"))
            g = meta["global"]
            check(g.get("cuav:preset_ids") == ["dji-droneid", "dji-uplink-2m", "dji-video-20m-a"]
                  and g.get("cuav:presets_version") == "v1", f"全局 {g.get('cuav:preset_ids')} / {g.get('cuav:presets_version')}")
            ann = meta["annotations"]
            labs = {}
            for a in ann:
                labs[a["core:label"]] = labs.get(a["core:label"], 0) + 1
            check(all(a.get("cuav:preset_id") for a in ann), f"{len(ann)} 条注记都带 cuav:preset_id；按标签 {labs}")
            summary["sigmf_annotations"] = labs
    finally:
        shutil.rmtree(out, ignore_errors=True)


# ---------------------------------------------------------------- ⑥ 铁律 4

def check_rate_gate(scen: dict) -> None:
    print("⑥ 站点 10 MS/s：场景载入即拒")
    tmp = tempfile.mkdtemp(prefix="q2-10m-")
    try:
        a = json.loads(json.dumps(scen))
        a["sites"][0]["receiver"]["fs_Hz"] = 10_000_000
        a["sites"][0]["receiver"]["bw_Hz"] = 8_000_000
        pa = os.path.join(tmp, "a.scenario.json")
        json.dump(a, open(pa, "w", encoding="utf-8"), ensure_ascii=False)
        r = subprocess.run([CUAV_RUN, "--scenario-track", pa], cwd=ROOT, capture_output=True, text=True)
        check(r.returncode == 2 and "铁律 4" in r.stdout, "三个源都在：18 MHz 的图传被占用带宽闸拦下（退出码 2）")
        b = json.loads(json.dumps(a))
        only = next(e for e in b["emitters"] if e["id"] == "uav-1-droneid")
        only["emission"]["center_Hz"] = 2440000000
        b["emitters"] = [only]
        b["activities"] = []
        pb = os.path.join(tmp, "b.scenario.json")
        json.dump(b, open(pb, "w", encoding="utf-8"), ensure_ascii=False)
        r = subprocess.run([CUAV_RUN, "--scenario-track", pb], cwd=ROOT, capture_output=True, text=True)
        check(r.returncode == 2 and "20000000 / 40000000 / 80000000 Hz" in r.stdout,
              "只留 9 MHz 的 DroneID：过得了占用带宽闸，被重采样档位拦下并列出可取值")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    if not os.path.exists(CUAV_RUN):
        print(f"跳过：没有 {CUAV_RUN}（先构建引擎）")
        return 0
    doc_p = ofdm_ref.load_presets()
    scen = json.load(open(os.path.join(ROOT, SCENARIO), encoding="utf-8"))
    q0bj = json.load(open(os.path.join(ROOT, "data", "iq", "measured", "q0b-params.json"), encoding="utf-8"))
    print("运行 cuav_run（1 s × 80 MS/s，三个源，S0 两路与 S3 写原始 IQ）…")
    wall = run_engine()
    summary["wall_s"] = round(wall, 2)
    summary["realtime_factor"] = round(1.0 / wall, 4)
    print(f"  墙钟 {wall:.1f} s，实时因子 {1.0 / wall:.3f}")
    rows = [json.loads(l) for l in open(os.path.join(ROOT, RUN, "truth.jsonl"), encoding="utf-8")]
    check_truth(doc_p, scen)
    check_zc(doc_p)
    check_evm(doc_p, rows)
    check_realism(q0bj)
    check_export()
    check_rate_gate(scen)
    print("摘要 " + json.dumps(summary, ensure_ascii=False))
    print("OFDM 族回归" + ("全部通过" if fails == 0 else f"有 {fails} 项失败"))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
