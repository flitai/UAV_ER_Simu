#!/usr/bin/env python3
"""04 §15.2 的标准算例：**从保存的典型链路**跑出来逐项核对（C-11；10 报告 §9）。

十二项里本脚本覆盖 1、2、3、6、9、10、11 七项；第 5、7、8 项（接收滤波与群时延、
DDC、信道化）由 C-10 的三级夹具与引擎单测覆盖，见 `models/{receiver,adc-ddc,channelizer}/README.md`；
第 4 项（多信号同频及邻频叠加）与第 12 项（用户算法插件）随后续。

「从保存的典型链路」是这一步的要点：算例不另写测试链，一律跑
`tests/regression/diagrams/chain-*.json` —— 那些是框图页真的编译得出来的文档。

判据一律写成**可算的量**，超差是发现：打印两侧数字与候选原因，退出码 1，
不得回头调参数使其通过（铁律 10）。

跑法（仓库根目录）：
    uv run --quiet --with numpy python tests/regression/standard_cases.py
    ... --engine engine/build/cuav_run --keep        # --keep 保留产品目录便于手查

实测回放与混合增强两项要 `data/iq/measured/`（不入 git）。数据不在时**明说跳过**、
不当作通过，也不静默略过（铁律 15）。
"""
from __future__ import annotations

import argparse
import filecmp
import json
import math
import os
import shutil
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DIAGRAMS = os.path.join(HERE, "diagrams")
SCENARIOS = os.path.join(ROOT, "data", "scene", "beijing-yayuncun", "scenarios")
LOCAL_SCEN = os.path.join(HERE, "scenarios")
DATA_INDEX = os.path.join(ROOT, "data", "iq", "measured", "dronerfb", "index.manifest.json")

# hann 窗下对单音作邻域求和得到的是 1.5 倍单音功率（等效噪声带宽），比绝对电平时要扣掉（D-049 ⑪）
HANN_ENBW_DB = 10.0 * math.log10(1.5)

results: list[tuple[str, bool, str]] = []
skipped: list[tuple[str, str]] = []


def check(case: str, ok: bool, detail: str) -> None:
    results.append((case, ok, detail))
    print(f"  {'通过' if ok else '不过'}  {case}：{detail}")


def run_chain(engine: str, diagram: str, out: str, *, scenario: str | None = None,
              data_index: str | None = None) -> dict:
    """跑一条保存下来的典型链路，返回收尾的 task.state。"""
    if os.path.isdir(out):
        shutil.rmtree(out)
    cmd = [engine, "--run", os.path.join(DIAGRAMS, diagram), "--out", out,
           "--library-root", os.path.join(ROOT, "models", "recognition")]
    if scenario:
        cmd += ["--scenario", scenario, "--scene-root", os.path.join(ROOT, "data", "scene")]
    if data_index:
        cmd += ["--data-index", data_index]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"{diagram} 跑失败（退出码 {p.returncode}）：{p.stderr.strip()[:500]}")
    last = [json.loads(l) for l in p.stdout.splitlines() if l.strip().startswith("{")][-1]
    return last["payload"]


def spectrum(out: str, op: str):
    """读一个观测点的功率谱：返回（索引, 行×bin 的 dBm 矩阵, 频率轴（相对中心）, 帧间隔）。"""
    idx = json.load(open(os.path.join(out, op, "spectrum.index.json"), encoding="utf-8"))
    n = int(idx["row_len"])
    fs = float(idx["sample_rate_Hz"])
    a = np.fromfile(os.path.join(out, op, "spectrum.f32"), dtype="<f4").astype(np.float64)
    a = a[: len(a) // n * n].reshape(-1, n)
    return idx, a, (np.arange(n) - n // 2) * fs / n, int(idx["frame_hop_samples"]) / fs


def band_dbm(a: np.ndarray, f: np.ndarray, lo: float, hi: float, rows=slice(None)) -> float:
    """一段频率区间内的平均带内功率（线性域按行求和再对行取均值）。"""
    b = (f >= lo) & (f < hi)
    return 10.0 * math.log10(float(np.mean((10.0 ** (a[rows][:, b] / 10.0)).sum(axis=1))))


def links_at(out: str, t: float) -> dict:
    """取 t 时刻之前最后一行链路读数。"""
    rows = [json.loads(l) for l in open(os.path.join(out, "links.jsonl"), encoding="utf-8")]
    hit = [r for r in rows if r["t_s"] <= t]
    return hit[-1] if hit else rows[0]


# ---------------------------------------------------------------- 算例 1 / 6 / 11：全合成链
def synthetic_cases(engine: str, out: str, out2: str) -> None:
    st = run_chain(engine, "chain-synthetic.json", out,
                   scenario=os.path.join(SCENARIOS, "golden-01.scenario.json"))
    # 缺省参数下这条链**本来就削波**，结果因此是 degraded —— 那是引擎的真实判断，
    # D-066 ⑨ 明确不为了好看去改缺省参数。这里把它写成期望，而不是期望 valid。
    check("全合成链的四态如实传出（缺省参数下 ADC 过载，D-066 ⑨）",
          st["result"] == "degraded", f"result = {st['result']}")

    # --- 算例 1：单音频移和功率标度 -------------------------------------------------
    # golden-01 的 uav-1 是 2440.5 MHz + 48828.125 Hz 的单音，站点中心 2440.5 MHz、500 kS/s。
    # nfft 1024 下 bin 宽 488.28125 Hz，48828.125 Hz 恰好是 100 个 bin —— 单音精确落在 bin 中心。
    # 目标在动，所以频点要带上多普勒；电平按 hann 邻域求和的口径读（D-049 ⑪）。
    idx, a, f, dt = spectrum(out, "s1")
    t0, t1 = 4.0, 4.2
    rows = slice(int(t0 / dt), int(t1 / dt))
    lk = links_at(out, t0)
    binw = float(idx["bin_width_Hz"])
    want_off = 48828.125 + float(lk["doppler_Hz"])
    med = np.median(a[rows], axis=0)
    peak = int(np.argmax(med))
    got_off = f[peak]
    check("算例 1 单音频移", abs(got_off - want_off) <= binw / 2,
          f"峰值在 {got_off:+.3f} Hz（bin {peak}），应在 {want_off:+.3f} Hz"
          f"（48828.125 + 多普勒 {lk['doppler_Hz']:+.3f}），容差半个 bin = {binw / 2:.3f} Hz")

    # 电平：±3 bin 邻域求和扣掉等效噪声带宽，对链路预算 tx_power + G_t + G_r − 路损
    half = 3
    lin = (10.0 ** (a[rows][:, peak - half:peak + half + 1] / 10.0)).sum(axis=1)
    got = 10.0 * math.log10(float(np.mean(lin))) - HANN_ENBW_DB
    want = 27.0 + 2.0 + 3.0 - float(lk["path_loss_dB"])
    check("算例 1 功率标度（S1 = 链路预算）", abs(got - want) <= 0.15,
          f"S1 读 {got:.3f} dBm，链路预算 27 + 2 + 3 − {lk['path_loss_dB']:.3f} = {want:.3f} dBm，"
          f"差 {got - want:+.3f} dB（容差 0.15）")

    # 电平链的另两段（10 报告 §9「全合成链的电平链」，要求从**保存的**链路上量）：
    # S0 就是发射功率本身（emit_at_tx_power），S2 − S1 就是前端增益。
    def tone_dbm(op: str) -> float:
        ix, ax, fx, dx = spectrum(out, op)
        rr = slice(int(t0 / dx), int(t1 / dx))
        m = np.median(ax[rr], axis=0)
        pk = int(np.argmax(m))
        v = (10.0 ** (ax[rr][:, pk - half:pk + half + 1] / 10.0)).sum(axis=1)
        return 10.0 * math.log10(float(np.mean(v))) - HANN_ENBW_DB

    s0 = tone_dbm("s0")
    check("算例 1 电平链起点：S0 = 发射功率", abs(s0 - 27.0) <= 0.05,
          f"S0 读 {s0:.4f} dBm，场景写的 tx_power_dBm = 27（容差 0.05）")
    s2 = tone_dbm("s2")
    check("算例 1 电平链：S2 − S1 = 前端增益", abs((s2 - got) - 20.0) <= 0.05,
          f"S2 {s2:.3f} − S1 {got:.3f} = {s2 - got:.3f} dB，前端增益 20 dB（容差 0.05）")

    # --- 算例 6：ADC 量化和削波 ------------------------------------------------------
    # **削波**：缺省满量程 −20 dBm 在这条链上确实压不住峰值。削波是数据标记，
    # 比例超过 degrade_clip_ratio 才降级（D-051 ⑥）——两件事都要看得见。
    # 两件事分得很清楚：**计数进产品索引**（数据标记，观测点不作判断、状态仍是 valid），
    # **比例超阈值才把组件标降级**（ADC 节点 degraded，并沿四态传到任务结果）。
    i3, a3, f3, dt3 = spectrum(out, "s3")
    clip = int(i3.get("clipped_samples", 0))
    adc = [x for x in st["nodes"] if x["name"] == "adc"][0]
    n_in = int(adc["samples_in"])
    ratio = clip / n_in if n_in else 0.0
    check("算例 6 削波计数是数据标记，进索引但不改观测点状态",
          clip > 0 and i3["state"] == "valid",
          f"S3 索引记削波 {clip} / {n_in} 个样点（{ratio:.4%}），产品状态 {i3['state']}")
    check("算例 6 削波比例超阈值才把组件标降级（D-051 ⑥）",
          adc["state"] == "degraded" and ratio > 0.01,
          f"比例 {ratio:.4%} 超过缺省 degrade_clip_ratio = 1%，ADC 节点 {adc['state']}；"
          f"给的理由：{'；'.join(adc['notes'])}")

    # **量化**：把同一条保存的链路的满量程抬到不削波，再看 S3 的底噪相对 S2 抬升多少。
    # 解析预期由量化器自己的步长算：满量程复单音幅度 A = 10^(FS/20)，
    # 步长 Δ = 2A / 2^bits，复信号的量化噪声总功率 Δ²/6，按带宽比例折到读数那一段；
    # hann 窗下白噪声的带内读数是真值的 1.5 倍（等效噪声带宽），与解析量比时要扣掉（D-049 ⑪）。
    doc = json.load(open(os.path.join(DIAGRAMS, "chain-synthetic.json"), encoding="utf-8"))
    bits = 14.0
    fs_dbm = -10.0
    for nd in doc["nodes"]:
        if nd["id"] == "adc":
            bits = float(nd["params"].get("bits", 14))
            nd["params"]["full_scale_dBm"] = fs_dbm
    doc["diagram_id"] = "chain-synthetic-headroom"
    hp = os.path.join(ROOT, "data", "runs", "_headroom-variant.json")
    os.makedirs(os.path.dirname(hp), exist_ok=True)
    with open(hp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    run_chain(engine, os.path.relpath(hp, DIAGRAMS), out + "-hr",
              scenario=os.path.join(SCENARIOS, "golden-01.scenario.json"))
    os.remove(hp)
    i2h, a2h, f2h, d2h = spectrum(out + "-hr", "s2")
    i3h, a3h, f3h, d3h = spectrum(out + "-hr", "s3")
    r2 = slice(int(4.0 / d2h), int(4.2 / d2h))
    r3 = slice(int(4.0 / d3h), int(4.2 / d3h))
    lo, hi = 100e3, 200e3                      # 远离 48.8 kHz 的单音
    n2 = band_dbm(a2h, f2h, lo, hi, r2)
    n3 = band_dbm(a3h, f3h, lo, hi, r3)
    fs_hz = float(i2h["sample_rate_Hz"])
    a_pow = 10.0 ** (fs_dbm / 10.0)                       # A²，mW
    q_total = a_pow / (1.5 * 2.0 ** (2.0 * bits))         # Δ²/6
    q_band = q_total * (hi - lo) / fs_hz
    p2_true = 10.0 ** (n2 / 10.0) / 1.5                   # 扣掉 hann 的等效噪声带宽
    rise_pred = 10.0 * math.log10(1.0 + q_band / p2_true)
    rise = n3 - n2
    check("算例 6 ADC 量化噪声的抬升合解析预期",
          abs(rise - rise_pred) <= 0.15 and int(i3h.get("clipped_samples", 0)) == 0,
          f"满量程抬到 {fs_dbm:g} dBm 后削波 {i3h.get('clipped_samples')} 个；"
          f"S2 底噪 {n2:.3f} dBm、S3 {n3:.3f} dBm，实测抬升 {rise:+.3f} dB，"
          f"按 {bits:g} 位量化步长算应抬 {rise_pred:+.3f} dB，差 {rise - rise_pred:+.3f} dB（容差 0.15）")

    # --- 算例 11：固定随机种子重复运行 -----------------------------------------------
    run_chain(engine, "chain-synthetic.json", out2,
              scenario=os.path.join(SCENARIOS, "golden-01.scenario.json"))
    same, diff, only = compare_products(out, out2)
    check("算例 11 同种子逐字节复现", not diff and not only,
          f"{same} 个产品文件逐字节相同" + (f"；{len(diff)} 个不同：{diff[:3]}" if diff else "")
          + (f"；{len(only)} 个只在一侧：{only[:3]}" if only else ""))


def compare_products(a: str, b: str) -> tuple[int, list[str], list[str]]:
    """比两次运行的产品文件。事件流与 task.json 带时间戳，不比（D-041 ③）。"""
    skip = {"events.jsonl", "task.json"}
    def files(root: str) -> set[str]:
        out = set()
        for d, _, fs in os.walk(root):
            for x in fs:
                if x not in skip:
                    out.add(os.path.relpath(os.path.join(d, x), root))
        return out
    fa, fb = files(a), files(b)
    only = sorted(fa ^ fb)
    diff = []
    for x in sorted(fa & fb):
        pa, pb = os.path.join(a, x), os.path.join(b, x)
        if filecmp.cmp(pa, pb, shallow=False):
            continue
        # metrics.json 里带 task_id（两次运行的产品目录名不同），比内容不比那一个字段
        if os.path.basename(x) == "metrics.json":
            ja = json.load(open(pa, encoding="utf-8")); jb = json.load(open(pb, encoding="utf-8"))
            ja.pop("task_id", None); jb.pop("task_id", None)
            if ja == jb:
                continue
        diff.append(x)
    return len(fa & fb) - len(diff), diff, only


# ---------------------------------------------------------------- 算例 2 / 3：宽带链
def wideband_cases(engine: str, out: str) -> None:
    run_chain(engine, "chain-golden-02.json", out,
              scenario=os.path.join(SCENARIOS, "golden-02.scenario.json"))
    idx, a, f, dt = spectrum(out, "s4")

    # --- 算例 2：带限噪声和目标 SNR --------------------------------------------------
    # golden-02 的图传是 bw_Hz = 2 MHz 的带限噪声（4 阶巴特沃斯，fc = 1 MHz，D-069），
    # 中心 2438.5 MHz 即相对站点 −2.5 MHz。只有它在发的窗口是 0.5–2.5 s。
    rows = slice(int(0.7 / dt), int(2.3 / dt))
    quiet = slice(int(0.05 / dt), int(0.45 / dt))
    med = np.median(a[rows], axis=0)
    ctr = -2.5e6
    inb = (f >= ctr - 5e6) & (f <= ctr + 5e6)
    peak_db = float(np.max(med[(f >= ctr - 0.5e6) & (f <= ctr + 0.5e6)]))
    # −3 dB 带宽：以峰值为基准，取连续超过 peak − 3 dB 的频率跨度
    above = np.where(med >= peak_db - 3.0)[0]
    bw3 = float(f[above.max()] - f[above.min()]) if above.size else 0.0
    check("算例 2 带限噪声的 −3 dB 带宽", abs(bw3 - 2.0e6) <= 0.15e6,
          f"实测 {bw3 / 1e6:.4f} MHz，设定 bw_Hz = 2 MHz（容差 0.15 MHz）")
    sig = band_dbm(a, f, ctr - 1e6, ctr + 1e6, rows)
    noi = band_dbm(a, f, ctr - 1e6, ctr + 1e6, quiet)
    snr = sig - noi
    check("算例 2 目标信噪比可读且为正", snr > 10.0,
          f"带内 {sig:.3f} dBm、同带静默期底噪 {noi:.3f} dBm，信噪比 {snr:.3f} dB")

    # --- 算例 3：突发开关和占空比 ----------------------------------------------------
    # 跳频遥控是 burst：period 0.01 s、duty 0.3，只在 3.0–4.5 s 单独发。
    # 帧长 1024 / 10 MS/s = 102.4 µs，一个周期约 97.7 帧、导通约 29.3 帧。
    hop = slice(int(3.05 / dt), int(4.45 / dt))
    pw = 10.0 * np.log10((10.0 ** (a[hop][:, (np.abs(f) <= 3e6)] / 10.0)).sum(axis=1))
    floor = float(np.percentile(pw, 5))
    top = float(np.percentile(pw, 95))
    on = float(np.mean(pw > (floor + top) / 2.0))
    check("算例 3 突发占空比", abs(on - 0.3) <= 0.05,
          f"导通帧占比 {on:.4f}，场景设定 duty = 0.3（容差 0.05；判据取 5% / 95% 分位的中点 "
          f"{(floor + top) / 2:.2f} dBm）")


# ---------------------------------------------------------------- 算例 9 / 10：实测数据
def measured_cases(engine: str, out_replay: str, out_mixed: str) -> None:
    st = run_chain(engine, "chain-replay.json", out_replay, data_index=DATA_INDEX)
    idx, a, f, dt = spectrum(out_replay, "s4")
    mani = json.load(open(os.path.join(ROOT, "data", "iq", "measured", "dronerfb",
                                       "dronerfb_0_CH0_S4.manifest.json"), encoding="utf-8"))
    want_fs = float(mani["sampling"]["sample_rate_Hz"])
    want_n = int(mani["sampling"]["sample_count"])
    got_n = int([x for x in st["nodes"] if x["name"] == "tx"][0]["samples_out"])
    check("算例 9 实测回放的样点数与清单一致", got_n == want_n,
          f"回放 {got_n} 个样点，清单记 {want_n}")
    check("算例 9 采样率与中心频率取自清单不是框图",
          float(idx["sample_rate_Hz"]) == want_fs
          and float(idx["center_Hz"]) == float(mani["frequency"]["center_frequency_Hz"]),
          f"{float(idx['sample_rate_Hz']) / 1e6:g} MS/s @ {float(idx['center_Hz']) / 1e6:g} MHz")
    check("算例 9 标度是 dBm 且带标定来源（D-047）",
          idx["scale"] == "dBm" and bool(idx.get("calibration", {}).get("source")),
          f"scale {idx['scale']}，标定来源 {idx.get('calibration', {}).get('source')}")
    check("算例 9 数据集自带的 degraded 如实传到结果（铁律 15）",
          st["result"] == "degraded", f"result = {st['result']}")

    # --- 算例 10：实测背景加合成目标 --------------------------------------------------
    run_chain(engine, "chain-mixed.json", out_mixed,
              scenario=os.path.join(LOCAL_SCEN, "mixed-wideband.scenario.json"),
              data_index=DATA_INDEX)
    im, am, fm, dtm = spectrum(out_mixed, "s4")
    # ① 远离合成单音的地方，混合后的谱应当就是背景本身
    for lo, hi in ((-10e6, -5e6), (5e6, 10e6)):
        d = band_dbm(am, fm, lo, hi) - band_dbm(a, f, lo, hi)
        check(f"算例 10 背景原样通过（{lo / 1e6:+g}…{hi / 1e6:+g} MHz）", abs(d) <= 0.05,
              f"混合与纯回放差 {d:+.4f} dB")
    # ② 合成单音落在 +2.5 MHz，扣掉同处背景后应等于链路预算
    binw = float(im["bin_width_Hz"])
    j = int(round(2.5e6 / binw)) + am.shape[1] // 2
    lk = links_at(out_mixed, 0.0)
    half = 3
    lm = (10.0 ** (am[:, j - half:j + half + 1] / 10.0)).sum(axis=1)
    lr = (10.0 ** (a[:, j - half:j + half + 1] / 10.0)).sum(axis=1)
    # **逐行相减再取中位**，不取均值。两次运行读的是同一段背景，所以逐行差就是合成支路的贡献
    # （加上一个均值为零的交叉项）；但这段真实背景里有 WiFi 与蓝牙突发，
    # 同一段频率上功率的**均值是中位的约 50 倍**，均值差因此是两个大噪声量的小差值
    # ——实测有 18% 的行差出来是负的。这与 D-063 记过的「失配在干扰尾部」是同一件事。
    d = lm - lr
    tone = 10.0 * math.log10(max(float(np.median(d)), 1e-30)) - HANN_ENBW_DB
    want = 27.0 + 2.0 + 3.0 - float(lk["path_loss_dB"])
    check("算例 10 合成目标的绝对电平", abs(tone - want) <= 0.3,
          f"混合谱逐行扣掉背景后单音 {tone:.3f} dBm，链路预算 {want:.3f} dBm，"
          f"差 {tone - want:+.3f} dB（容差 0.3；背景在这一段的功率均值是中位的 "
          f"{float(np.mean(lr)) / float(np.median(lr)):.0f} 倍，故取中位不取均值）")
    check("算例 10 单音精确落在 bin 中心", int(np.argmax(np.median(am, axis=0))) == j,
          f"最强 bin 在 {fm[int(np.argmax(np.median(am, axis=0)))] / 1e6:+.4f} MHz，"
          f"应在 +2.5000 MHz（2.5 MHz / {binw:g} Hz = {2.5e6 / binw:g} 个 bin）")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="04 §15.2 标准算例：从保存的典型链路核对")
    ap.add_argument("--engine", default=os.path.join("engine", "build", "cuav_run"))
    ap.add_argument("--out-root", default=os.path.join("data", "runs"))
    ap.add_argument("--keep", action="store_true", help="保留产品目录")
    a = ap.parse_args(argv)
    engine = os.path.join(ROOT, a.engine) if not os.path.isabs(a.engine) else a.engine
    if not os.path.exists(engine):
        print(f"找不到引擎 {a.engine}：先 cmake --build engine/build", file=sys.stderr)
        return 2
    root = os.path.join(ROOT, a.out_root) if not os.path.isabs(a.out_root) else a.out_root
    outs = {k: os.path.join(root, f"stdcase-{k}") for k in
            ("synthetic", "synthetic2", "wideband", "replay", "mixed")}

    print("04 §15.2 标准算例（从保存的典型链路跑）")
    print("--- 全合成链 chain-synthetic.json（算例 1、6、11）---")
    synthetic_cases(engine, outs["synthetic"], outs["synthetic2"])
    print("--- 宽带链 chain-golden-02.json（算例 2、3）---")
    wideband_cases(engine, outs["wideband"])
    print("--- 实测数据（算例 9、10）---")
    if os.path.exists(DATA_INDEX):
        measured_cases(engine, outs["replay"], outs["mixed"])
    else:
        skipped.append(("算例 9 实测 IQ 回放 / 算例 10 实测背景加合成目标",
                        f"缺 {os.path.relpath(DATA_INDEX, ROOT)}（实测数据不入 git）"))
        print(f"  跳过  算例 9 / 10：缺 {os.path.relpath(DATA_INDEX, ROOT)}（实测数据不入 git）")

    if not a.keep:
        for p in list(outs.values()) + [outs["synthetic"] + "-hr"]:
            shutil.rmtree(p, ignore_errors=True)

    bad = [r for r in results if not r[1]]
    print()
    print(f"共 {len(results)} 项，不通过 {len(bad)} 项"
          + (f"，跳过 {len(skipped)} 组（{skipped[0][1]}）" if skipped else ""))
    if bad:
        print("超差是发现：查根因，不要回头调参数使其通过（铁律 10）", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
