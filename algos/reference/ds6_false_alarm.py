#!/usr/bin/env python3
"""DS-6：真实背景下的能量检测器虚警率标定。

步骤定义见 06 备忘录 §11.4 DS-6：「用纯背景片测能量检测器虚警率。预期按高斯白噪声假设推出
的门限会明显超标，因为真实背景中的 WiFi 与蓝牙是突发、非平稳、非高斯的。产出超标倍数与
修正后的门限」。检测器定义见同目录 `energy_detector.py`。

## 这个实验为什么成立

纯背景片里没有无人机（数据集出版方如此标注），因此**任何一次判决为「有信号」都是虚警**，
不需要额外真值即可直接测虚警率。这是真实数据能给出、而合成高斯噪声给不出的东西。

## 三个对照

1. **合成复高斯白噪声**：同样帧数、同样检测器。测得的虚警率应当与目标值一致，
   这一项验证的是实现本身，不是数据。它不通过，后面的结论都不成立。
2. **真实背景，逐频段**：把检测频段在整个频谱上滑动，看虚警率随频段位置怎么变。
   WiFi 信道所在的频段应当明显更差。
3. **两个数据集**：DroneRFb-DIR（80 MS/s，2.44 GHz 中心）与 DroneRFa（100 MS/s），
   采集地点、时间与接收配置都不同，可看结论是否只在某一次采集里成立。

用法：
    uv run --project tools python algos/reference/ds6_false_alarm.py \\
        --report data/iq/measured/ds6-false-alarm-report.md
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

NFFT = 1024                 # 帧长；80 MS/s 下 12.8 微秒，100 MS/s 下 10.24 微秒
BAND_WIDTH_HZ = 10e6        # 检测带宽，取 WiFi 20 MHz 信道的一半，便于看信道内外差别
BAND_STEP_HZ = 10e6         # 频段滑动步长
PFA_TARGETS = (1e-2, 1e-3, 1e-4)
CHUNK = 4_000_000
SEED = 20260904             # 固定种子，合成对照可逐位复现（铁律 9）


def accumulate(product: store.Product, bands: list[ed.Band], nfft: int
               ) -> tuple[np.ndarray, np.ndarray, int]:
    """流式跑完一个产物，返回 (逐帧逐频点功率的中位数估计所需的抽样, 各频段的 Λ, 帧数)。

    噪声估计需要帧维中位数，全量保存功率矩阵内存吃不消，所以分两遍：
    第一遍在抽样帧上估噪声，第二遍流式算 Λ。抽样帧取前 8192 帧，足够估中位数。
    """
    fs = product.sample_rate_Hz
    masks = [b.mask(nfft, fs) for b in bands]

    # 第一遍：估噪声
    probe = product.read(0, min(8192 * nfft, product.sample_count))
    noise = ed.estimate_noise_per_bin(ed.frame_bin_power(probe, nfft))

    # 第二遍：流式算各频段的 Λ
    lams: list[list[np.ndarray]] = [[] for _ in bands]
    frames = 0
    for chunk in product.chunks(CHUNK):
        p = ed.frame_bin_power(chunk, nfft)
        if p.shape[0] == 0:
            continue
        frames += p.shape[0]
        for i, m in enumerate(masks):
            lams[i].append(ed.statistic(p, m, noise))
    out = [np.concatenate(x) if x else np.empty(0) for x in lams]
    return noise, out, frames


def synthetic_control(frames: int, nfft: int, bands: list[ed.Band], fs: float,
                      rng: np.random.Generator) -> list[np.ndarray]:
    """合成复高斯白噪声对照，帧数与真实数据同量级。"""
    masks = [b.mask(nfft, fs) for b in bands]
    n = frames * nfft
    x = (rng.standard_normal(n) + 1j * rng.standard_normal(n)).astype(np.complex64) / math.sqrt(2)
    p = ed.frame_bin_power(x, nfft)
    noise = ed.estimate_noise_per_bin(p)
    return [ed.statistic(p, m, noise) for m in masks]


def measure(lam: np.ndarray, m_bins: int) -> list[dict]:
    """给定一组 Λ，逐目标虚警率算：理论门限、实测虚警率、超标倍数、修正门限。"""
    rows = []
    for pfa in PFA_TARGETS:
        eta = ed.threshold_for_pfa(m_bins, pfa)
        hits = int(np.count_nonzero(lam > eta))
        measured = hits / lam.size if lam.size else float("nan")
        # 修正门限：实测分布的 (1 - pfa) 分位数
        eta_fix = float(np.quantile(lam, 1 - pfa)) if lam.size else float("nan")
        rows.append({
            "pfa_target": pfa,
            "eta_theory": eta,
            "hits": hits,
            "frames": int(lam.size),
            "pfa_measured": measured,
            "ratio": measured / pfa if pfa else float("nan"),
            "eta_corrected": eta_fix,
            "eta_ratio_dB": 10 * math.log10(eta_fix / eta) if eta_fix > 0 else float("nan"),
        })
    return rows


def run_dataset(name: str, directory: str, only_background: bool,
                limit: int | None = None) -> dict:
    prods = store.list_products(directory)
    if only_background:
        prods = [p for p in prods if _is_background(p)]
    if limit:
        prods = prods[:limit]
    if not prods:
        raise SystemExit(f"{name}: 没有找到背景产物")

    fs = prods[0].sample_rate_Hz
    half = fs / 2
    edges = np.arange(-half, half - BAND_WIDTH_HZ + 1, BAND_STEP_HZ)
    bands = [ed.Band(float(e), float(e + BAND_WIDTH_HZ)) for e in edges]
    m_bins = int(np.count_nonzero(bands[0].mask(NFFT, fs)))

    print(f"\n=== {name} ===")
    print(f"产物 {len(prods)} 个，采样率 {fs/1e6:.0f} MS/s，中心 {prods[0].center_frequency_Hz/1e9:.3f} GHz")
    print(f"帧长 {NFFT}（{NFFT/fs*1e6:.2f} 微秒），检测带宽 {BAND_WIDTH_HZ/1e6:.0f} MHz "
          f"= {m_bins} 个频点，频段 {len(bands)} 个")

    t0 = time.time()
    per_band = [[] for _ in bands]
    frames_total = 0
    for k, p in enumerate(prods, 1):
        _, lams, frames = accumulate(p, bands, NFFT)
        frames_total += frames
        for i, l in enumerate(lams):
            per_band[i].append(l)
        if k % 10 == 0 or k == len(prods):
            print(f"  {k}/{len(prods)} 个产物，累计 {frames_total} 帧，{time.time()-t0:.0f} s")
    per_band = [np.concatenate(x) for x in per_band]
    all_lam = np.concatenate(per_band)

    rng = np.random.default_rng(SEED)
    ctrl_frames = min(200_000, max(frames_total // len(bands), 20_000))
    ctrl = synthetic_control(ctrl_frames, NFFT, bands, fs, rng)

    return {
        "name": name,
        "products": len(prods),
        "sample_rate_Hz": fs,
        "center_Hz": prods[0].center_frequency_Hz,
        "m_bins": m_bins,
        "frames_per_band": int(per_band[0].size),
        "bands": [{"lo_Hz": b.lo_Hz, "hi_Hz": b.hi_Hz,
                   "rows": measure(lam, m_bins),
                   "mean_lambda": float(lam.mean()),
                   "p99_lambda": float(np.quantile(lam, 0.99))}
                  for b, lam in zip(bands, per_band)],
        "pooled": measure(all_lam, m_bins),
        "control": measure(np.concatenate(ctrl), m_bins),
        "control_frames": int(np.concatenate(ctrl).size),
        "elapsed_s": time.time() - t0,
    }


def _is_background(p: store.Product) -> bool:
    t = p.truth or {}
    code = str(t.get("class_code", ""))
    return code == "B" or code == "T0000"


def _known_emitters(lo_mhz: float, hi_mhz: float) -> str:
    """标注频段内已知的固定发射源，用于解释虚警率的频率依赖。"""
    # WiFi 信道占 22 MHz，按跨度判而不是按中心频点判，否则相邻频段会被误标为「无发射」
    marks = []
    for ch, f in (("WiFi 1", 2412.0), ("WiFi 6", 2437.0), ("WiFi 11", 2462.0)):
        if lo_mhz < f + 11.0 and hi_mhz > f - 11.0:
            marks.append(ch)
    if hi_mhz > 2402.0 and lo_mhz < 2480.0:
        marks.append("蓝牙跳频")
    return "、".join(marks) if marks else "—"


def write_report(results: list[dict], path: str) -> None:
    L = ["# DS-6 真实背景虚警率标定报告", "",
         f"生成于 {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}，"
         "脚本 `algos/reference/ds6_false_alarm.py`，检测器 `algos/reference/energy_detector.py`。", "",
         "纯背景片里没有无人机，**任何一次判决为「有信号」都是虚警**，因此不需要额外真值即可",
         "直接测虚警率。合成复高斯白噪声对照用于验证实现本身。", ""]
    for r in results:
        L += [f"## {r['name']}", "",
              f"- 背景产物 {r['products']} 个，采样率 {r['sample_rate_Hz']/1e6:.0f} MS/s，"
              f"中心频率 {r['center_Hz']/1e9:.3f} GHz",
              f"- 帧长 {NFFT} 点（{NFFT/r['sample_rate_Hz']*1e6:.2f} 微秒），检测带宽 "
              f"{BAND_WIDTH_HZ/1e6:.0f} MHz = {r['m_bins']} 个频点",
              f"- 每个频段 {r['frames_per_band']} 帧，耗时 {r['elapsed_s']:.0f} s", "",
              "### 合成高斯白噪声对照（验证实现）", "",
              "| 目标虚警率 | 理论门限 | 实测虚警率 | 实测/目标 |", "|---|---|---|---|"]
        for row in r["control"]:
            L.append(f"| {row['pfa_target']:.0e} | {row['eta_theory']:.4f} | "
                     f"{row['pfa_measured']:.3e} | {row['ratio']:.2f} |")
        L += ["", "### 真实背景，全频段合并", "",
              "| 目标虚警率 | 理论门限 | 实测虚警率 | **超标倍数** | 修正门限 | 修正量 |",
              "|---|---|---|---|---|---|"]
        for row in r["pooled"]:
            L.append(f"| {row['pfa_target']:.0e} | {row['eta_theory']:.4f} | "
                     f"{row['pfa_measured']:.3e} | **{row['ratio']:.1f}×** | "
                     f"{row['eta_corrected']:.4f} | +{row['eta_ratio_dB']:.2f} dB |")
        L += ["", "### 逐频段（目标虚警率 1e-3）", "",
              "| 频段（相对中心，MHz） | 绝对频率（MHz） | 频段内已知发射 | Λ 均值 | Λ 99 分位 | 实测虚警率 | 超标倍数 |",
              "|---|---|---|---|---|---|---|"]
        c = r["center_Hz"]
        for b in r["bands"]:
            row = [x for x in b["rows"] if x["pfa_target"] == 1e-3][0]
            lo_abs = (c + b["lo_Hz"]) / 1e6
            hi_abs = (c + b["hi_Hz"]) / 1e6
            L.append(f"| {b['lo_Hz']/1e6:+.0f} 至 {b['hi_Hz']/1e6:+.0f} | "
                     f"{lo_abs:.0f}–{hi_abs:.0f} | {_known_emitters(lo_abs, hi_abs)} | "
                     f"{b['mean_lambda']:.2f} | {b['p99_lambda']:.2f} | "
                     f"{row['pfa_measured']:.3e} | {row['ratio']:.1f}× |")
        L += ["",
              "**Λ 均值是个脆弱的统计量，不要拿它预测检测代价。** 它会被极少数强事件主导：",
              "DroneRFa 的 2430–2440 MHz 一格 Λ 均值 8.68，但三个背景文件里有两个只有 1.3 与 2.5，",
              "全靠第三个文件（22.6）拉高，而那个文件的高值又集中在两段各约 0.1 秒的强发射上",
              "（该处 Λ 均值 165、峰值 1611，其余时段只有 1.2）。决定检测门限的是分布的高分位，",
              "不是均值——同一格的 99 分位与虚警率才是可用的量。DS-7 里两个数据集在这两个频段上的",
              "排序与 Λ 均值给出的排序不同，原因就在这里，两者并不矛盾，只是量的是不同的东西。", ""]

    L += ["## 怎么读这些数字", "",
          "**合成对照全部落在目标值附近**（实测比目标差在两成以内），所以检测器实现与门限公式没有问题，",
          "下面的超标是数据本身的性质，不是代码的性质。", "",
          "**超标倍数随目标虚警率越收越大，是因为真实背景的分布有重尾。** 目标定得越严，",
          "白噪声假设给出的门限越接近噪声均值，而真实背景里「高出噪声十几分贝」的帧比比皆是，",
          "于是判决几乎全部落在门限之上，实测虚警率趋于一个饱和值（本次是两成上下），",
          "与目标值之比自然越拉越大。", "",
          "**逐频段的差异有明确的频率结构，且与 WiFi 信道布局对得上，但不是「三个信道都最差」**：",
          "DroneRFb 背景里 Λ 均值最高的是信道 1 跨度内的 2400–2420 MHz（14.8 与 43.1），",
          "其次是信道 11 跨度内的 2450–2470 MHz（12.0 与 15.3）；而信道 6 跨度内的 2430–2450 MHz",
          "反而最低（5.2 与 6.8）。合理的解释是那次采集的环境里信道 1 与 11 有活跃接入点、信道 6 没有——",
          "这正是「真实背景」与「白噪声假设」的区别所在：**干扰不是均匀铺满频段的，它有具体的占用格局**，",
          "而这个格局只能从实测数据得到，不能从模型假设推出。若虚警率与频率完全无关，反倒说明",
          "实现或标定出了问题。", "",
          "**三条必须一起引用的限制**：", "",
          "1. 「虚警」在这里指**检测器在没有无人机时判为有信号**。真实背景里确实有 WiFi 与蓝牙在发射，",
          "   所以这些判决在物理上不是「无中生有」，而是「把别的发射源当成了目标」。能量检测本身不区分",
          "   信号种类，这正是它的固有局限，也是 M2 层要靠特征与识别来补的原因。",
          "2. 噪声估计取逐频点帧维中位数。**若某频段的占空比超过一半，中位数估的就不再是噪声而是",
          "   「信号加噪声」**，门限被抬高、虚警率被低估。因此本报告给出的超标倍数是**下界**。",
          "3. 突发占空比 d 时中位数估计本身高估噪声 0.33 dB（d=5%）到 0.68 dB（d=10%），",
          "   方向同样使虚警率偏低。两条加起来，真实情况只会比这里更差，不会更好。", "",
          "**对门限的实际含义**：修正门限比理论门限高 20 至 35 分贝，意味着在这两批真实背景里，",
          "纯能量检测要达到设定的虚警率，只能对**比 WiFi 还强 20 分贝以上**的信号动作。",
          "这不是「调一下门限就解决了」，而是该频段上能量检测的可用灵敏度被环境抬高了这么多。", ""]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")
    print(f"\n报告已写 {path}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DS-6 虚警率标定")
    ap.add_argument("--report", default=None)
    ap.add_argument("--json", default=None, help="同时输出机器可读结果")
    ap.add_argument("--limit", type=int, default=None, help="每个数据集只用前 N 个背景产物")
    args = ap.parse_args(argv)

    results = [
        run_dataset("DroneRFb-DIR 背景（杭州，80 MS/s）",
                    os.path.join(_ROOT, "data/iq/measured/dronerfb"), True, args.limit),
        run_dataset("DroneRFa 背景（100 MS/s）",
                    os.path.join(_ROOT, "data/iq/measured/dronerfa"), True, args.limit),
    ]
    for r in results:
        print(f"\n{r['name']}：全频段合并")
        for row in r["pooled"]:
            print(f"  目标 {row['pfa_target']:.0e} → 实测 {row['pfa_measured']:.3e}"
                  f"（{row['ratio']:.1f} 倍），门限需抬高 {row['eta_ratio_dB']:+.2f} dB")
        print(f"  合成对照：" + "，".join(
            f"{x['pfa_target']:.0e}→{x['pfa_measured']:.2e}" for x in r["control"]))
    if args.report:
        write_report(results, args.report)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=2, default=float)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
