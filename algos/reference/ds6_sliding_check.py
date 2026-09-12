#!/usr/bin/env python3
"""DS-6 分半标定在滑动噪声估计下的复跑（C-3，D-063；兑现 D-026）。

D-026 的实测（`ds7_pd_curves.py` §6）：静态门限在一半真实背景上标定、换到另一半虚警率是目标的
7.0–7.2 倍，随机打散分半则达标——失配来自背景随时间与文件漂移，不是统计涨落，所以
「交付形态不得是静态门限」。本脚本用同一批帧（同 62 片 DroneRFb 背景、同两个频段、同 120 000 帧、
同一分法）复跑一遍，只把检测量换成滑动模式的 Λ（`energy_detector.sliding_from_power`，
W = 256 帧、删截、门限取解析值），再做同样的三档门限分析：

    ① 解析门限 η_theory 直接用在测试半区（部署形态，不需要标定）
    ② 在标定半区上按分位数标出 η_cal，用到测试半区 ——「分半标定」，D-026 里失效 7 倍的那一档
    ③ 在测试半区自身标定 η_oracle（理想上界）
    ④ 打散分半（诊断：失配是不是来自漂移）

计划里的判据是「② 的比值回到 1 的量级（此前 7.0–7.2）」。**实测没有回到 1**（7.3 / 8.3），
这是一个发现而不是可以调参的偏差（铁律 10）：0.1% 那截尾部是真实的 WiFi / 蓝牙突发，它们在
两半文件里的统计本来就不同，任何噪声估计都归一不掉；滑动估计能归一的是分布的**主体**——
安静频段上逐片中位数的散布从 1.32 dB 压到 0.52 dB。繁忙频段部分片的占用超过一半，中位数估计
两种口径都跟不上。这两条与静态门限的 7 倍一并如实进报告、模型卡与 D-063。

全部数字是**原型阶段验证值**（D-028）：公开数据集只用于验证技术途径，甲方数据到货后按同一脚本重跑。

跑法（约 1–2 min / 频段，需要 data/iq/measured/dronerfb）：
    uv run --quiet --with h5py --with numpy python algos/reference/ds6_sliding_check.py \\
        --report data/iq/measured/ds6-sliding-report.md --json data/iq/measured/ds6-sliding.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "tools"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iq_format import store                        # noqa: E402
import energy_detector as ed                       # noqa: E402
import ds7_pd_curves as ds7                        # noqa: E402

WINDOW_FRAMES = 256
MERGE_GAP = 2


def analyse(lam: np.ndarray, m: int, pfa: float, rng: np.random.Generator) -> dict:
    half = lam.shape[0] // 2
    cal, test = lam[:half], lam[half:]
    eta_theory = ed.threshold_for_pfa(m, pfa)
    eta_cal = float(np.quantile(cal, 1 - pfa))
    eta_oracle = float(np.quantile(test, 1 - pfa))
    idx = rng.permutation(lam.shape[0])
    sh_cal, sh_test = lam[idx[:half]], lam[idx[half:]]
    eta_sh = float(np.quantile(sh_cal, 1 - pfa))
    return {
        "frames_cal": int(half), "frames_test": int(lam.shape[0] - half),
        "eta_theory": eta_theory, "eta_calibrated": eta_cal, "eta_oracle": eta_oracle,
        "eta_gain_dB": 10 * np.log10(eta_cal / eta_theory),
        "pfa_real_at_theory": float(np.mean(test > eta_theory)),
        "pfa_real_at_calibrated": float(np.mean(test > eta_cal)),
        "pfa_real_at_oracle": float(np.mean(test > eta_oracle)),
        "pfa_shuffled_split": float(np.mean(sh_test > eta_sh)),
        "ratio_calibrated": float(np.mean(test > eta_cal)) / pfa,
        "ratio_shuffled": float(np.mean(sh_test > eta_sh)) / pfa,
    }


def run(directory: str, limit_products: int | None, window: int, gap: int) -> dict:
    prods = [p for p in store.list_products(directory)
             if str((p.truth or {}).get("class_code", "")) in ("B", "T0000")]
    if limit_products:
        prods = prods[:limit_products]
    if not prods:
        raise SystemExit(f"{directory}: 没有背景产物")
    rng = np.random.default_rng(ds7.SEED)
    probe_ref = None
    ref_path = os.path.join(_ROOT, "data/iq/measured/ds7-pd-curves.json")
    if os.path.exists(ref_path):
        with open(ref_path, encoding="utf-8") as fh:
            probe_ref = json.load(fh)
    result = {"products": len(prods), "pfa_target": ds7.PFA_TARGET, "nfft": ds7.NFFT,
              "window_frames": window, "merge_gap_frames": gap, "bands": {}}
    for key, band in ds7.BANDS.items():
        t0 = time.time()
        bins, _noise = ds7.collect_band_bins(prods, band, ds7.NFFT, 2 * ds7.MAX_TEST_FRAMES)
        power = bins.real.astype(np.float64) ** 2 + bins.imag.astype(np.float64) ** 2
        m = power.shape[1]
        r = ed.sliding_from_power(power, np.ones(m, dtype=bool), ds7.PFA_TARGET, window, gap)
        lam = r["statistic"]
        a = analyse(lam, m, ds7.PFA_TARGET, rng)
        # 诊断：漂移到底在分布的哪一段。静态口径 = 全 120 000 帧的逐 bin 中位数当噪声（ds7 同法）。
        # 两半区各自的分位数：主体（50% / 90%）对不上 → 噪声底漂移；只有尾部（99.9%）对不上 → 尾部是干扰。
        noise_static = np.median(power, axis=0) / ed.LN2
        lam_static = power.sum(axis=1) / float(noise_static.sum())
        a["quantiles"] = {}
        for name, arr in (("static", lam_static), ("sliding", lam)):
            half = arr.shape[0] // 2
            a["quantiles"][name] = {
                q: {"cal": float(np.quantile(arr[:half], q)), "test": float(np.quantile(arr[half:], q))}
                for q in (0.5, 0.9, 0.99, 0.999)
            }
        # 逐片中位数的散布：每片 4 M 样点 = 3906 帧；静态口径下随片漂、滑动口径下应当稳在 1 附近
        per_clip = 4_000_000 // ds7.NFFT
        clips = lam.shape[0] // per_clip
        a["clip_median"] = {}
        for name, arr in (("static", lam_static), ("sliding", lam)):
            med = [float(np.median(arr[i * per_clip:(i + 1) * per_clip])) for i in range(clips)]
            a["clip_median"][name] = {"min": min(med), "max": max(med), "spread_dB": 10 * np.log10(max(med) / min(med)), "values": med}
        a.update({
            "label": f"{2440 + band.lo_Hz / 1e6:.0f}–{2440 + band.hi_Hz / 1e6:.0f} MHz",
            "m_bins": m, "frames": int(lam.shape[0]),
            "hits_at_theory": int(np.count_nonzero(r["hit"])), "segments_at_theory": r["segments"],
            "noise_stale_frames": r["noise_stale"], "lambda_mean_after_warmup": float(lam[window:].mean()),
            "lambda_median_after_warmup": float(np.median(lam[window:])),
            "elapsed_s": time.time() - t0,
        })
        if probe_ref and key in probe_ref.get("bands", {}):
            pb = probe_ref["bands"][key]
            a["probe"] = {k: pb.get(k) for k in ("eta_theory", "eta_calibrated", "eta_gain_dB",
                                                 "pfa_real_at_theory", "pfa_real_at_calibrated",
                                                 "pfa_real_at_oracle", "pfa_shuffled_split")}
            a["probe"]["ratio_calibrated"] = pb["pfa_real_at_calibrated"] / ds7.PFA_TARGET
        result["bands"][key] = a
        print(f"[{key}] {a['label']}：分半标定虚警率 {a['pfa_real_at_calibrated']:.2e}（目标 {ds7.PFA_TARGET}，"
              f"比值 {a['ratio_calibrated']:.2f}；probe 曾为 "
              f"{a.get('probe', {}).get('ratio_calibrated', float('nan')):.2f}），"
              f"解析门限直接用 {a['pfa_real_at_theory']:.3e}，打散分半 {a['pfa_shuffled_split']:.2e}，"
              f"陈旧 {a['noise_stale_frames']} 帧，{a['elapsed_s']:.1f} s")
    return result


def write_report(res: dict, path: str) -> None:
    pfa = res["pfa_target"]
    lines = [
        "# DS-6 分半标定 · 滑动噪声估计复跑（C-3，D-063）",
        "",
        f"数据：`{res.get('dataset', '')}` 背景片 {res['products']} 片；nfft {res['nfft']}；目标虚警率 {pfa}；"
        f"滑动窗 {res['window_frames']} 帧、删截、突发合并空隙 {res['merge_gap_frames']} 帧。"
        "与 `ds7_pd_curves.py` 同一批帧、同一分法（按文件与时间顺序对半分），只把检测量换成滑动模式的 Λ。",
        "",
        "**全部数字是原型阶段验证值（D-028）**：公开数据集只用于验证技术途径，甲方数据到货后按同一脚本重跑。",
        "",
        "| 频段 | 门限档 | 静态（probe，DS-7 记录） | 滑动（本次） |",
        "|---|---|---|---|",
    ]
    for key, a in res["bands"].items():
        pb = a.get("probe") or {}
        def f(v, fmt="{:.2e}"):
            return "—" if v is None else fmt.format(v)
        lines += [
            f"| {a['label']} | ① 解析门限直接用于测试半区 | {f(pb.get('pfa_real_at_theory'))} | {f(a['pfa_real_at_theory'])} |",
            f"| {a['label']} | **② 另一半上标定，用到测试半区** | **{f(pb.get('pfa_real_at_calibrated'))}（目标的 {f(pb.get('ratio_calibrated'), '{:.2f}')} 倍）** "
            f"| **{f(a['pfa_real_at_calibrated'])}（目标的 {a['ratio_calibrated']:.2f} 倍）** |",
            f"| {a['label']} | ③ 测试半区自身标定（理想上界） | {f(pb.get('pfa_real_at_oracle'))} | {f(a['pfa_real_at_oracle'])} |",
            f"| {a['label']} | ④ 打散分半（诊断） | {f(pb.get('pfa_shuffled_split'))} | {f(a['pfa_shuffled_split'])} |",
            f"| {a['label']} | 标定门限相对解析门限 | {f(pb.get('eta_gain_dB'), '{:+.1f} dB')} | {a['eta_gain_dB']:+.1f} dB |",
        ]
    lines += ["", "## 漂移在分布的哪一段", "",
              "| 频段 | 口径 | 分位数 | 标定半区 | 测试半区 | 逐片中位数 min–max（散布） |",
              "|---|---|---|---|---|---|"]
    for key, a in res["bands"].items():
        for name in ("static", "sliding"):
            qs = a["quantiles"][name]
            cm = a["clip_median"][name]
            for i, q in enumerate(("0.5", "0.9", "0.99", "0.999")):
                qq = qs[q] if q in qs else qs[float(q)]
                tail = f"{cm['min']:.3f}–{cm['max']:.3f}（{cm['spread_dB']:.2f} dB）" if i == 0 else ""
                lines.append(f"| {a['label']} | {'静态' if name == 'static' else '滑动'} | {q} | {qq['cal']:.3f} | {qq['test']:.3f} | {tail} |")
    lines += ["", "## 读法", ""]
    for key, a in res["bands"].items():
        lines.append(
            f"- **{a['label']}**：暖机后 Λ 均值 {a['lambda_mean_after_warmup']:.3f}、中位 {a['lambda_median_after_warmup']:.3f}；"
            f"按解析门限命中 {a['hits_at_theory']} 帧 / {a['frames']} 帧、并成 {a['segments_at_theory']} 段；"
            f"噪声估计陈旧 {a['noise_stale_frames']} 帧；耗时 {a['elapsed_s']:.1f} s。")
    lines += [
        "",
        "**结论（与计划相反，按铁律 10 记为发现）**：档 ② 的比值在滑动模式下没有回到 1，与静态门限同量级。"
        "分位数表说明了为什么——两半区在 50% 分位上对得上（安静频段静态 0.887 / 0.906，滑动 1.042 / 1.051），"
        "在 99.9% 分位上对不上（滑动 77 / 101），差的是**尾部**；尾部由真实的 WiFi / 蓝牙突发构成，"
        "两半文件采自不同时间与地点，突发的强弱与多寡本来就不同，这不是噪声估计能归一掉的东西。"
        "档 ④ 打散分半在两种口径下都达标，也印证了失配来自文件之间的差异而非统计涨落。",
        "",
        "滑动估计**确实**归一了分布的主体：安静频段逐片中位数的散布从静态的 1.32 dB 压到 0.52 dB，"
        "中位数稳在 1.00–1.13——这是它相对静态门限的实际收益（背景底噪随文件漂移的那部分被跟上了）。"
        "繁忙频段上部分片的占用超过一半（逐片中位数最高 4.49），中位数估计在两种口径下都跟不上：这是中位数"
        "估计的已知边界（占空比 > 50% 即被当成噪声），要靠子带 / 逐 bin 的参考才解得开，随 C-4 与 P3。",
        "",
        "档 ① 的 25–36% 是环境代价：这两个频段本来就被 WiFi / 蓝牙占着，超过解析门限的帧多数是**真信号**，"
        "能量检测分不清「不是无人机的信号」与「无人机的信号」，那是识别（C-4）的事，不是把门限抬高 30 dB 能解决的。",
        "",
        "复跑：`uv run --quiet --with h5py --with numpy python algos/reference/ds6_sliding_check.py "
        "--report data/iq/measured/ds6-sliding-report.md --json data/iq/measured/ds6-sliding.json`",
        "",
    ]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DS-6 分半标定的滑动模式复跑")
    ap.add_argument("--dir", default=os.path.join(_ROOT, "data/iq/measured/dronerfb"))
    ap.add_argument("--report", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--window", type=int, default=WINDOW_FRAMES)
    ap.add_argument("--gap", type=int, default=MERGE_GAP)
    ap.add_argument("--name", default=None)
    args = ap.parse_args(argv)
    res = run(args.dir, args.limit, args.window, args.gap)
    res["dataset"] = args.name or os.path.basename(args.dir)
    if args.report:
        write_report(res, args.report)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=2, default=float)
            fh.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
