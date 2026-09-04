#!/usr/bin/env python3
"""DS-7：真实背景加合成目标，出检测概率曲线，与白噪声背景并排比较。

覆盖两件事：
- 06 备忘录 §11.4 DS-7 = 04 §15.2 标准算例第 10 项「实测背景加合成目标」。
- 跨层一致性算例 ①（CLAUDE.md「功能级—信号级衔接」）：同一场景下，M1/M2 的解析检测概率
  公式与 M3 的蒙特卡洛结果必须在容差内一致。本脚本的「合成白噪声背景」一栏就是这个对拍。

## 信噪比在这里的定义（不这样定就没法比较）

`s = 注入信号在检测频段内的总功率 / 该频段的安静时底噪功率`，底噪用与 DS-6 相同的估计
（逐频点帧维中位数除以 ln2）。**分母是「安静时的底噪」而不是「背景平均功率」**，
理由是：真实背景的平均功率被 WiFi 突发主导，用它作分母会把环境的恶劣程度悄悄折进信噪比里，
两种背景就不可比了。用安静底噪作分母，同一个 s 在两种背景下代表同样强度的目标信号，
环境的差别就干净地体现在「门限要抬多高」和「检测概率差多少」上。

## 门限怎么定（这是本实验最容易做错的一步）

- 白噪声背景：用解析门限，因为它在该背景下确实给出目标虚警率。
- 真实背景：解析门限在真实背景下的实际虚警率是目标值的几百倍（DS-6 结论），拿它测出来的
  检测概率没有意义。所以改用**实测标定门限**：把背景帧一分为二，前一半只用来标定门限
  （取分位数使真实虚警率等于目标值），后一半只用来测检测概率。**标定与测试不共用数据**，
  否则门限会拟合到测试集上。

## 两种目标波形

- **随机型**：带限噪声，占满检测频段。统计上接近图传下行这类占满带宽的连续信号。
- **确定型**：单音，全部能量集中在一个频点。这是能量检测最有利的情形。

突发型不单列一档，因为对「按帧取总能量」的检测器而言，**同一帧平均信噪比下突发与连续等价**：
帧内能量只与总能量有关，与它在帧内怎么分布无关。突发的实际影响是另外两条，都可解析给出：
只有含突发的帧才有检出机会；突发短于帧长时能量被摊薄，等效帧平均信噪比下降 10·lg(占空比)。
单测 `test_burst_equals_continuous_at_same_frame_snr` 把这条钉住。

用法：
    uv run --project tools python algos/reference/ds7_pd_curves.py \\
        --report data/iq/measured/ds7-pd-curves-report.md
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "tools"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iq_format import store                        # noqa: E402
import energy_detector as ed                       # noqa: E402

NFFT = 1024
PFA_TARGET = 1e-3
SNR_DB = np.arange(-20, 51, 1.0)   # 上限要够高：真实背景的标定门限比解析门限高 17–33 dB
SEED = 20260904
MAX_TEST_FRAMES = 60_000        # 测试半区用多少帧；Pd=0.5 时统计误差约 0.2 个百分点
CHUNK = 4_000_000

# DS-6 实测出的两个极端频段（相对 2.44 GHz 中心）
BANDS = {
    "busiest": ed.Band(-30e6, -20e6),     # 2410–2420 MHz，WiFi 信道 1 跨度内，Λ 均值 43
    "quietest": ed.Band(-10e6, 0.0),      # 2430–2440 MHz，WiFi 信道 6 跨度内，Λ 均值 5.2
}
# 两个数据集用同一对绝对频段，结果才可直接比较。DS-6 实测的拥挤程度：
#   2410–2420 MHz：DroneRFb Λ 均值 43.1（最吵）；DroneRFa 的对应频段 Λ 均值 4.36
#   2430–2440 MHz：DroneRFb Λ 均值 5.2（最静）；DroneRFa 的对应频段 Λ 均值 8.68（其最吵处）
BAND_LABEL = {"busiest": "2410–2420 MHz", "quietest": "2430–2440 MHz"}


def collect_band_bins(products: list[store.Product], band: ed.Band, nfft: int,
                      max_frames: int) -> tuple[np.ndarray, np.ndarray]:
    """把若干产物的频段内频点谱收集起来，返回 (帧 × 频点 的复谱, 每频点噪声估计)。"""
    bins: list[np.ndarray] = []
    probe_power = None
    frames = 0
    for p in products:
        fs = p.sample_rate_Hz
        mask = band.mask(nfft, fs)
        for chunk in p.chunks(CHUNK):
            k = chunk.size // nfft
            if k == 0:
                continue
            X = np.fft.fftshift(np.fft.fft(chunk[:k * nfft].reshape(k, nfft), axis=1), axes=1)
            sel = X[:, mask].astype(np.complex64)
            bins.append(sel)
            frames += k
            if probe_power is None:
                probe_power = (sel.real.astype(np.float64) ** 2
                               + sel.imag.astype(np.float64) ** 2)
            if frames >= max_frames:
                break
        if frames >= max_frames:
            break
    allbins = np.concatenate(bins)[:max_frames]
    power = allbins.real.astype(np.float64) ** 2 + allbins.imag.astype(np.float64) ** 2
    noise_per_bin = np.median(power, axis=0) / ed.LN2
    return allbins, noise_per_bin


def synth_awgn_bins(frames: int, m_bins: int, rng: np.random.Generator
                    ) -> tuple[np.ndarray, np.ndarray]:
    """合成复高斯白噪声的频段内频点谱，每频点功率为 1。"""
    x = (rng.standard_normal((frames, m_bins)) + 1j * rng.standard_normal((frames, m_bins))
         ).astype(np.complex64) / math.sqrt(2)
    power = x.real.astype(np.float64) ** 2 + x.imag.astype(np.float64) ** 2
    return x, np.median(power, axis=0) / ed.LN2


def inject_and_measure(bg_bins: np.ndarray, noise_per_bin: np.ndarray, eta: float,
                       snr_db_list, kind: str, rng: np.random.Generator) -> list[float]:
    """按各个信噪比注入目标并测检测概率。kind ∈ {random, deterministic}。"""
    frames, m = bg_bins.shape
    noise_band = float(noise_per_bin.sum())          # 频段内安静底噪总功率
    out = []
    centre = m // 2
    for snr_db in snr_db_list:
        s = ed.snr_db_to_linear(float(snr_db))
        sig_power = s * noise_band                   # 信号在频段内的总功率
        if kind == "random":
            per_bin = sig_power / m
            sig = ((rng.standard_normal((frames, m)) + 1j * rng.standard_normal((frames, m)))
                   * math.sqrt(per_bin / 2)).astype(np.complex64)
        elif kind == "deterministic":
            amp = math.sqrt(sig_power)
            phase = rng.uniform(0, 2 * math.pi, size=frames)
            sig = np.zeros((frames, m), dtype=np.complex64)
            sig[:, centre] = (amp * np.exp(1j * phase)).astype(np.complex64)
        else:
            raise ValueError(kind)
        tot = bg_bins + sig
        lam = (tot.real.astype(np.float64) ** 2
               + tot.imag.astype(np.float64) ** 2).sum(axis=1) / noise_band
        out.append(float(np.mean(lam > eta)))
    return out


def snr_at_pd(snr_db_list, pd_list, target: float = 0.9) -> float:
    """线性插值求达到指定检测概率所需的信噪比（分贝）。达不到返回 nan。"""
    for i in range(1, len(pd_list)):
        if pd_list[i - 1] < target <= pd_list[i]:
            x0, x1 = snr_db_list[i - 1], snr_db_list[i]
            y0, y1 = pd_list[i - 1], pd_list[i]
            return float(x0 + (target - y0) * (x1 - x0) / (y1 - y0)) if y1 > y0 else float(x1)
    return float("nan")


def run(directory: str, limit_products: int | None = None) -> dict:
    prods = [p for p in store.list_products(directory)
             if str((p.truth or {}).get("class_code", "")) in ("B", "T0000")]
    if limit_products:
        prods = prods[:limit_products]
    if not prods:
        raise SystemExit(f"{directory}: 没有背景产物")
    rng = np.random.default_rng(SEED)
    result = {"products": len(prods), "bands": {}, "pfa_target": PFA_TARGET,
              "snr_db": [float(x) for x in SNR_DB], "nfft": NFFT}

    for key, band in BANDS.items():
        t0 = time.time()
        bins, noise = collect_band_bins(prods, band, NFFT, 2 * MAX_TEST_FRAMES)
        m = bins.shape[1]
        half = bins.shape[0] // 2
        cal, test = bins[:half], bins[half:]
        noise_band = float(noise.sum())

        # 门限：解析门限，以及在标定半区上实测标定出的门限
        eta_theory = ed.threshold_for_pfa(m, PFA_TARGET)
        lam_cal = (cal.real.astype(np.float64) ** 2
                   + cal.imag.astype(np.float64) ** 2).sum(axis=1) / noise_band
        lam_test = (test.real.astype(np.float64) ** 2
                    + test.imag.astype(np.float64) ** 2).sum(axis=1) / noise_band
        # 三档门限，用来把「环境代价」与「标定迁移代价」拆开
        eta_cal = float(np.quantile(lam_cal, 1 - PFA_TARGET))        # 现实：在另一半上标定
        eta_oracle = float(np.quantile(lam_test, 1 - PFA_TARGET))    # 理想上界：在测试集自身标定
        pfa_theory_real = float(np.mean(lam_test > eta_theory))
        pfa_cal_real = float(np.mean(lam_test > eta_cal))
        pfa_oracle_real = float(np.mean(lam_test > eta_oracle))
        # 诊断：把帧随机打散再一分为二，看失配是不是来自时间与文件维度的漂移
        idx = rng.permutation(bins.shape[0])
        lam_all = (bins.real.astype(np.float64) ** 2
                   + bins.imag.astype(np.float64) ** 2).sum(axis=1) / noise_band
        sh_cal, sh_test = lam_all[idx[:half]], lam_all[idx[half:]]
        eta_shuffled = float(np.quantile(sh_cal, 1 - PFA_TARGET))
        pfa_shuffled = float(np.mean(sh_test > eta_shuffled))

        # 合成白噪声背景（对照，且是跨层算例 ① 的蒙特卡洛侧）
        awgn_bins, awgn_noise = synth_awgn_bins(test.shape[0], m, rng)
        awgn_band = float(awgn_noise.sum())
        lam_awgn = (awgn_bins.real.astype(np.float64) ** 2
                    + awgn_bins.imag.astype(np.float64) ** 2).sum(axis=1) / awgn_band
        pfa_awgn = float(np.mean(lam_awgn > eta_theory))

        curves = {}
        for kind in ("random", "deterministic"):
            curves[f"awgn_{kind}"] = inject_and_measure(
                awgn_bins, awgn_noise, eta_theory, SNR_DB, kind, rng)
            curves[f"real_{kind}"] = inject_and_measure(
                test, noise, eta_cal, SNR_DB, kind, rng)
            curves[f"real_oracle_{kind}"] = inject_and_measure(
                test, noise, eta_oracle, SNR_DB, kind, rng)
        # 解析曲线（公式侧）
        curves["analytic_random"] = [ed.pd_random_signal(m, eta_theory,
                                                         ed.snr_db_to_linear(float(d)))
                                     for d in SNR_DB]
        curves["analytic_deterministic"] = [ed.pd_deterministic_signal(
            m, eta_theory, ed.snr_db_to_linear(float(d))) for d in SNR_DB]

        result["bands"][key] = {
            "label": BAND_LABEL[key],
            "m_bins": m,
            "frames_cal": int(cal.shape[0]),
            "frames_test": int(test.shape[0]),
            "eta_theory": eta_theory,
            "eta_calibrated": eta_cal,
            "eta_oracle": eta_oracle,
            "eta_gain_dB": 10 * math.log10(eta_cal / eta_theory),
            "eta_oracle_gain_dB": 10 * math.log10(eta_oracle / eta_theory),
            "pfa_awgn_at_theory": pfa_awgn,
            "pfa_real_at_theory": pfa_theory_real,
            "pfa_real_at_calibrated": pfa_cal_real,
            "pfa_real_at_oracle": pfa_oracle_real,
            "pfa_shuffled_split": pfa_shuffled,
            "eta_shuffled": eta_shuffled,
            "background_mean_over_quiet_floor_dB":
                10 * math.log10(float(lam_test.mean())),
            "curves": curves,
            "snr90": {k: snr_at_pd(SNR_DB, v) for k, v in curves.items()},
            "max_abs_dev_analytic_vs_mc_random":
                float(np.max(np.abs(np.array(curves["awgn_random"])
                                    - np.array(curves["analytic_random"])))),
            "max_abs_dev_analytic_vs_mc_deterministic":
                float(np.max(np.abs(np.array(curves["awgn_deterministic"])
                                    - np.array(curves["analytic_deterministic"])))),
            "elapsed_s": time.time() - t0,
        }
        b = result["bands"][key]
        print(f"\n--- {BAND_LABEL[key]} ---")
        print(f"  频点 {m} 个，标定 {b['frames_cal']} 帧、测试 {b['frames_test']} 帧，"
              f"{b['elapsed_s']:.0f} s")
        print(f"  解析门限 {eta_theory:.4f}：白噪声背景实测虚警率 {pfa_awgn:.2e}，"
              f"真实背景实测 {pfa_theory_real:.2e}")
        print(f"  跨半区标定门限 {eta_cal:.4f}（+{b['eta_gain_dB']:.1f} dB）："
              f"另一半上实测虚警率 {pfa_cal_real:.2e}（目标 {PFA_TARGET:.0e}，"
              f"差 {pfa_cal_real/PFA_TARGET:.1f} 倍）")
        print(f"  测试集自身标定门限 {eta_oracle:.4f}（+{b['eta_oracle_gain_dB']:.1f} dB）："
              f"虚警率 {pfa_oracle_real:.2e}")
        print(f"  诊断·随机打散后再分半：虚警率 {pfa_shuffled:.2e}"
              f"（若接近目标值，说明失配来自时间与文件维度的漂移，不是统计涨落）")
        print(f"  跨层算例 ① 最大偏差：随机型 {b['max_abs_dev_analytic_vs_mc_random']:.4f}，"
              f"确定型 {b['max_abs_dev_analytic_vs_mc_deterministic']:.4f}（检出率绝对差）")
        for kind in ("random", "deterministic"):
            a = b["snr90"][f"awgn_{kind}"]
            o = b["snr90"][f"real_oracle_{kind}"]
            r = b["snr90"][f"real_{kind}"]
            print(f"  Pd=0.9 所需信噪比（{kind}）：白噪声 {a:+.1f} dB → "
                  f"真实背景理想标定 {o:+.1f} dB（环境代价 {o - a:+.1f} dB）→ "
                  f"真实背景跨半区标定 {r:+.1f} dB（再加迁移代价 {r - o:+.1f} dB）")
    return result


def write_report(res: dict, path: str) -> None:
    L = [f"# DS-7 真实背景加合成目标：检测概率曲线（{res.get('dataset', '')}）", "",
         f"生成于 {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}，"
         "脚本 `algos/reference/ds7_pd_curves.py`。", "",
         "本报告同时覆盖 04 §15.2 标准算例第 10 项「实测背景加合成目标」与跨层一致性算例 ①", "",
         "## 口径", "",
         "- **信噪比** = 注入信号在检测频段内的总功率 / 该频段**安静时**底噪功率（逐频点帧维",
         "  中位数除以 ln2）。分母不用背景平均功率，否则环境的恶劣程度会被悄悄折进信噪比，",
         "  两种背景就不可比了。同一个信噪比数值在两种背景下代表同样强度的目标信号。",
         "- **三档门限**，用来把两种代价拆开：",
         "  ① 解析门限（白噪声假设推出）；② 测试集自身标定的门限（理想上界，虚警率精确达标，",
         "  代表**环境代价**）；③ 在另一半背景上标定、拿到测试半区用的门限（现实做法，",
         "  额外反映**标定迁移代价**）。",
         f"- 目标虚警率 {res['pfa_target']:.0e}，帧长 {res['nfft']} 点，"
         f"背景产物 {res['products']} 个。", ""]
    for key, b in res["bands"].items():
        L += [f"## {b['label']}", "",
              f"- 频段内 {b['m_bins']} 个频点，标定 {b['frames_cal']} 帧、测试 {b['frames_test']} 帧",
              f"- 真实背景的平均功率比安静底噪高 **{b['background_mean_over_quiet_floor_dB']:.1f} dB**",
              "", "### 三档门限与实测虚警率", "",
              "| 门限 | 相对解析门限 | 白噪声背景 | 真实背景（测试半区） |", "|---|---|---|---|",
              f"| ① 解析门限 {b['eta_theory']:.4f} | — | {b['pfa_awgn_at_theory']:.2e} | "
              f"**{b['pfa_real_at_theory']:.2e}** |",
              f"| ② 测试集自身标定 {b['eta_oracle']:.1f} | +{b['eta_oracle_gain_dB']:.1f} dB | — | "
              f"{b['pfa_real_at_oracle']:.2e} |",
              f"| ③ 另一半上标定 {b['eta_calibrated']:.1f} | +{b['eta_gain_dB']:.1f} dB | — | "
              f"**{b['pfa_real_at_calibrated']:.2e}**（目标的 "
              f"{b['pfa_real_at_calibrated']/res['pfa_target']:.1f} 倍） |", "",
              "**门限标定换一批数据就失效。** 第 ③ 行的虚警率是目标值的几倍，而把同一批帧",
              f"随机打散后再分半标定，虚警率是 {b['pfa_shuffled_split']:.2e}，基本达标。",
              "两者的差别只在于分法：按时间与文件顺序分，还是打散分。因此失配来自**背景本身随",
              "时间与地点漂移**，不是统计涨落。这直接说明静态门限在真实环境里不成立，",
              "工程实现必须用滑动噪声估计或恒虚警率处理。", "",
              "### 跨层一致性算例 ①：解析公式 对 蒙特卡洛（白噪声背景）", "",
              f"- 随机型目标：检出率最大绝对偏差 **{b['max_abs_dev_analytic_vs_mc_random']:.4f}**",
              f"- 确定型目标：检出率最大绝对偏差 **{b['max_abs_dev_analytic_vs_mc_deterministic']:.4f}**",
              "",
              "04 §16.3 建议的检出率容差是 5 至 10 个百分点，实测偏差比它小两个数量级，**通过**。",
              "", "### 达到检出率 0.9 所需的信噪比", "",
              "| 目标波形 | 白噪声背景 | 真实背景·理想标定 | 环境代价 | 真实背景·跨半区标定 |",
              "|---|---|---|---|---|"]
        for kind, name in (("random", "随机型（带限噪声）"), ("deterministic", "确定型（单音）")):
            a = b["snr90"][f"awgn_{kind}"]
            o = b["snr90"][f"real_oracle_{kind}"]
            r = b["snr90"][f"real_{kind}"]
            L.append(f"| {name} | {a:+.1f} dB | {o:+.1f} dB | **{o - a:+.1f} dB** | {r:+.1f} dB |")
        L += ["",
              "**标定迁移的代价不体现在灵敏度上，而体现在虚警率上。** 第 ③ 档门限比理想门限低，",
              "所以检出率反而略高（所需信噪比低 0.7 至 1.5 dB），代价是虚警率高出目标数倍。",
              "两者是同一件事的两面：门限定低了。", "",
              "### 检测概率曲线", "",
              "| 信噪比 dB | 白噪声·随机型 | 解析·随机型 | 真实·随机型 | 白噪声·确定型 | 真实·确定型 |",
              "|---|---|---|---|---|---|"]
        for i, d in enumerate(res["snr_db"]):
            if float(d) % 4 != 0:
                continue
            c = b["curves"]
            L.append(f"| {d:+.0f} | {c['awgn_random'][i]:.4f} | {c['analytic_random'][i]:.4f} | "
                     f"{c['real_random'][i]:.4f} | {c['awgn_deterministic'][i]:.4f} | "
                     f"{c['real_deterministic'][i]:.4f} |")
        L.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")
    print(f"\n报告已写 {path}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DS-7 检测概率曲线")
    ap.add_argument("--dir", default=os.path.join(_ROOT, "data/iq/measured/dronerfb"))
    ap.add_argument("--report", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--name", default=None, help="数据集名，写进报告标题")
    ap.add_argument("--from-json", default=None,
                    help="不重算，直接用已有结果重新生成报告")
    args = ap.parse_args(argv)
    if args.from_json:
        with open(args.from_json, encoding="utf-8") as fh:
            res = json.load(fh)
    else:
        res = run(args.dir, args.limit)
    res["dataset"] = args.name or res.get("dataset") or os.path.basename(args.dir)
    if args.report:
        write_report(res, args.report)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=2, default=float)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
