"""DA-6：DroneRFa 路损指数重算并给误差范围。

算法口径与 WORKLOG 2026-09-03 第三条日志 4.1 节一致，不做任何改动：
  每文件 6 个采样偏移 × 200 万点；FFT 8192 汉宁窗不重叠；
  平均功率谱 = 各偏移线性域累加 / 总帧数；底噪 = 平均功率谱在频率维第 10 百分位；
  带内 = 相对中心频率 +2 至 +12 MHz（2442–2452 MHz，已确认为图传）。
本次新增的只有统计处理：片间抖动、按对组合、最小二乘拟合、距离区间敏感性。
"""
import h5py, numpy as np, itertools, json, os

NF = 8192
W = 2_000_000
FS = 100e6
OFFS = [0, 30_000_000, 60_000_000, 90_000_000, 120_000_000, 146_000_000]
fr = np.fft.fftshift(np.fft.fftfreq(NF, 1 / FS)) / 1e6
BAND = (fr >= 2) & (fr < 12)

DIR = "/Users/zhiyu/CC/804 C-UAV/Datasets2-DroneRFa"

# 距离档的三种取值口径：区间中点、区间几何均值、以及区间上下界（用于给出边界）
BINS = {"D00": (20, 40), "D01": (40, 80), "D10": (80, 150)}
MID = {k: (a + b) / 2 for k, (a, b) in BINS.items()}
GEO = {k: float(np.sqrt(a * b)) for k, (a, b) in BINS.items()}

SAMPLES = {
    "T0010": {"D00": ["T0010_D00_S0101", "T0010_D00_S0111"],
              "D01": ["T0010_D01_S0001", "T0010_D01_S0011"],
              "D10": ["T0010_D10_S0000", "T0010_D10_S0100"]},
    "T0011": {"D00": ["T0011_D00_S0000"],
              "D01": ["T0011_D01_S0000"],
              "D10": ["T0011_D10_S0000"]},
}


def band_power_above_nf(name, ch="RF0"):
    Sa = None
    cnt = 0
    with h5py.File(os.path.join(DIR, name + ".mat"), "r") as h:
        for o in OFFS:
            x = h[f"{ch}_I"][0, o:o + W] + 1j * h[f"{ch}_Q"][0, o:o + W]
            n = len(x) // NF
            X = x[:n * NF].reshape(n, NF) * np.hanning(NF)
            S = np.abs(np.fft.fftshift(np.fft.fft(X, axis=1), axes=1)) ** 2
            Sa = S.sum(0) if Sa is None else Sa + S.sum(0)
            cnt += n
    p = 10 * np.log10(Sa / cnt + 1e-30)
    nf = np.percentile(p, 10)
    return float(p[BAND].mean() - nf), float(nf), float(p.max() - nf)


def n_from(delta_db, d1, d2):
    return -delta_db / (10 * np.log10(d2 / d1))


res = {}
for model, bins in SAMPLES.items():
    print("=" * 76)
    print(f"【{model}】{'DJI Phantom 4 Pro' if model == 'T0010' else 'DJI MATRICE 200'}，RF0，S0xxx（2.4 GHz 状态）")
    print(f"{'文件':<22}{'距离档':>7}{'带内高于底噪':>13}{'底噪':>9}{'峰-底噪':>9}")
    vals = {}
    for b, names in bins.items():
        vals[b] = []
        for nm in names:
            bp, nf, pk = band_power_above_nf(nm)
            vals[b].append(bp)
            print(f"{nm:<22}{b:>7}{bp:12.1f} dB{nf:8.1f}{pk:8.1f}")
    res[model] = vals

    print()
    for b in ["D00", "D01", "D10"]:
        v = vals[b]
        spread = (max(v) - min(v)) if len(v) > 1 else float("nan")
        print(f"  {b} {BINS[b][0]}–{BINS[b][1]} m: 均值 {np.mean(v):6.1f} dB，"
              f"{len(v)} 片，片间极差 {spread:.1f} dB" if len(v) > 1 else
              f"  {b} {BINS[b][0]}–{BINS[b][1]} m: {np.mean(v):6.1f} dB，1 片，无片间极差")

    # 逐对组合的 n（D00 → D10），中点口径
    pairs = list(itertools.product(vals["D00"], vals["D10"]))
    ns = [n_from(b - a, MID["D00"], MID["D10"]) for a, b in pairs]
    print(f"\n  D00→D10（中点 {MID['D00']:.0f}→{MID['D10']:.0f} m，比 {MID['D10']/MID['D00']:.2f}）:")
    print(f"    逐对组合 n = {', '.join(f'{x:.2f}' for x in ns)}"
          f"   → 均值 {np.mean(ns):.2f}，极差 {max(ns)-min(ns):.2f}，标准差 {np.std(ns, ddof=1) if len(ns)>1 else 0:.2f}")
    print(f"    自由空间预期降幅 {-10*2*np.log10(MID['D10']/MID['D00']):.1f} dB，"
          f"实测降幅 {np.mean(vals['D10'])-np.mean(vals['D00']):.1f} dB")

    # 相邻档（诊断用，已知不可靠）
    for a, b in [("D00", "D01"), ("D01", "D10")]:
        d = np.mean(vals[b]) - np.mean(vals[a])
        print(f"    诊断 {a}→{b}: 实测 {d:+.1f} dB，折算 n = {n_from(d, MID[a], MID[b]):.2f}"
              f"（自由空间预期 {-20*np.log10(MID[b]/MID[a]):+.1f} dB）")

    # 三点最小二乘（中点与几何均值两种口径）
    for tag, DM in [("中点", MID), ("几何均值", GEO)]:
        xs, ys = [], []
        for b in ["D00", "D01", "D10"]:
            for v in vals[b]:
                xs.append(10 * np.log10(DM[b] / DM["D00"]))
                ys.append(v)
        slope, icpt = np.polyfit(xs, ys, 1)
        yhat = np.polyval([slope, icpt], xs)
        rms = float(np.sqrt(np.mean((np.array(ys) - yhat) ** 2)))
        print(f"    三档最小二乘（{tag}口径，{len(xs)} 点）: n = {-slope:.2f}，残差均方根 {rms:.1f} dB")

    # 距离区间本身带来的边界：最保守与最激进的距离比
    delta = np.mean(vals["D10"]) - np.mean(vals["D00"])
    ratio_min = BINS["D10"][0] / BINS["D00"][1]     # 80 / 40
    ratio_max = BINS["D10"][1] / BINS["D00"][0]     # 150 / 20
    print(f"    **距离区间敏感性**：D00 与 D10 的真实距离比只能确定在 {ratio_min:.1f} 至 {ratio_max:.1f} 之间，")
    print(f"      同一实测降幅 {delta:.1f} dB 对应 n = {n_from(delta, 1, ratio_max):.2f} 至 {n_from(delta, 1, ratio_min):.2f}")
    print()

print("=" * 76)
print("原始结果（供记录）：")
print(json.dumps(res, ensure_ascii=False, indent=2))
