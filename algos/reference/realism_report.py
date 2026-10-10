"""真实感对照报告：把 realism_compare.py 的结果写成单文件 HTML（Q-5，D-096；14 号报告 §7.3）。

读者是甲方。正文不出现决策编号、内部步骤号与机器路径，出处收在文末。图用 matplotlib 画成 PNG、以 base64 内嵌，
页面不引用任何外部资源（离线可开）。两次运行逐字节相同：PNG 不写软件元数据，页面不写生成时间。

只由 realism_compare.py 调用：`write(doc, figs) -> 路径`。
"""
from __future__ import annotations

import base64
import html
import io
import math
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_HTML = os.path.join(ROOT, "data", "eval", "realism-v1", "realism-report.html")

REPORT_VERSION = "v1.0"
REPORT_DATE = "2026-10-10"

# 配色（作图规范的参考色板，浅色）：实测验收集 = 1 号蓝，合成 = 2 号橙，实测训练部分 = 3 号青（虚线，作参照）
C_MAIN, C_SYNTH, C_REF = "#2a78d6", "#eb6834", "#1baf7a"
INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"
FONTS = ["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", "SimHei", "Arial Unicode MS"]

STAT_NAME = {
    "obw99_Hz": "99% 占用带宽", "bw10_Hz": "−10 dB 宽度", "dur_s": "突发时长", "interval_s": "突发间隔",
    "flatness": "谱平坦度", "papr_dB": "峰均比（CCDF 1e-3）", "bw3_Hz": "−3 dB 宽度", "snr_dB": "带内信噪比",
}
COL_NAME = {"holdout": "实测（验收集）", "train": "实测（训练部分）", "all": "实测（全部）", "synth": "合成"}
PRESET_NAME = {
    "dji-video-20m-a": "DJI 图传 20 MHz（A/D/F/G 族时序）", "dji-video-20m-c": "DJI 图传 20 MHz（C/E 族时序）",
    "dji-uplink-1m": "DJI 遥控上行 1.1 MHz 档", "dji-uplink-2m": "DJI 遥控上行 2.2 MHz 档",
    "dji-uplink-4m": "DJI 遥控上行 4.4 MHz 档", "dji-video-40m": "DJI 图传 40 MHz（5.8 GHz）",
    "frsky-d16v2-fcc": "FrSky D16 v2（FCC）遥控", "futaba-sfhss": "Futaba S-FHSS 遥控",
    "dji-video-10m": "DJI 图传 10 MHz", "dji-droneid": "DJI DroneID",
}
VARIANT_NAME = {"p1-ideal": "无损伤", "p1-tgn-b": "TGn-B（15 ns，K 0 dB）", "p1-tgn-c": "TGn-C（30 ns，K 0 dB）",
                "p1-tgn-d": "TGn-D（50 ns，K 3 dB）", "p1-tgn-e": "TGn-E（100 ns，K 6 dB）",
                "p1-tgn-f": "TGn-F（150 ns，K 6 dB）"}

FRSKY_FRAME_S = 0.007      # FrSky 预设的帧周期（实测 7.000 ms，gfsk-presets-v1.json）


# ---------------------------------------------------------------- 「有差距」各项的可能原因

def _ms(v) -> str:
    return "—" if v is None else f"{v * 1e3:.2f}"


def _mhz(v, nd: int = 2) -> str:
    return "—" if v is None else f"{v / 1e6:.{nd}f}"


def _peaks(pk: list[dict]) -> str:
    return "、".join(f"{d['center']:.2f} ms（{d['frac'] * 100:.0f}%）" for d in pk) or "—"


def _band(curve, sh) -> dict:
    """平均谱形在占用带宽内三段的均值：低端 2 MHz、中间 ±1 MHz、高端 2 MHz（窄信号按带宽的五分之一）。"""
    n = int(round(sh["span_Hz"] / sh["res_Hz"]))
    g = np.arange(-n, n + 1) * sh["res_Hz"]
    v = np.array([np.nan if x is None else x for x in curve])
    b = sh["band_Hz"] / 2
    edge = min(2e6, sh["band_Hz"] / 5)

    def m(lo, hi):
        sel = (g >= lo) & (g <= hi) & np.isfinite(v)
        return float(np.mean(v[sel])) if sel.any() else float("nan")
    return {"low": m(-b, -b + edge), "mid": m(-edge / 2, edge / 2), "high": m(b - edge, b)}


def causes(doc: dict) -> dict[tuple[str, str], str]:
    """「有差距」各项的可能原因。数字全部取自结果，不手抄；事实与推断分开写（铁律 10：只解释，不调参）。"""
    P = {p["id"]: p for p in doc["pairs"]}
    dg = doc["diagnostics"]
    out: dict[tuple[str, str], str] = {}

    def st(pid, col, stat, key="median"):
        return P[pid]["columns"][col]["stats"][stat].get(key)

    def cmp(pid, stat):
        return next(r for r in P[pid]["stats"] if r["stat"] == stat)

    # 图传的时隙结构
    for pid, slot in (("p1", 2), ("p2", 4), ("p6", 2)):
        if pid in P and P[pid]["verdicts"].get("interval_s") == "有差距":
            c = cmp(pid, "interval_s")["synth_vs_main"]
            out[(pid, "interval_s")] = (
                f"预设的帧排布是 {slot} ms 一格的时隙，合成突发只从时隙起点开始，间隔只能取 {slot} ms 的整数倍"
                f"（合成间隔的峰：{_peaks(P[pid]['columns']['synth']['interval_peaks_ms'])}）。"
                f"实测间隔的峰：{_peaks(P[pid]['columns']['main']['interval_peaks_ms'])}。"
                f"中位数 {_ms(st(pid, 'main', 'interval_s'))} ms 对 {_ms(st(pid, 'synth', 'interval_s'))} ms，KS {c['ks']:.3f}。"
                "时隙概率当初只按占空与长短突发比例拟合，没有拟合间隔分布。"
                + ("这一对同源（时序参数就取自这些实测片段），间隔仍对不上，说明时隙模型本身表达不了实测的间隔分布。"
                   if not P[pid]["independent"] else ""))
    p1 = P["p1"]
    if p1["verdicts"].get("flatness") == "有差距":
        main = st("p1", "main", "flatness")
        near = [r for r in doc["variants"]["rows"] if r["cell"] != "p1-ideal" and r["flatness"].get("median") is not None
                and abs(r["flatness"]["median"] - main) <= 0.05]
        names = "、".join(VARIANT_NAME[r["cell"]].split("（")[0] for r in near)
        out[("p1", "flatness")] = (
            f"交付配置用平坦衰落，合成逐突发谱平坦度中位数 {st('p1', 'synth', 'flatness'):.3f}，实测 {main:.3f}。"
            f"第 5 节打开抽头延迟线后，{names or '没有一档'} 的中位数与实测差在 ±0.05 以内。"
            "推断：差距主要来自实测场地的频率选择性多径，不是波形本身。")
    for pid in ("p1", "p6"):
        if P[pid]["verdicts"].get("shape") != "有差距":
            continue
        d = dg[pid]
        sig, rx = d["measured_signal"], d["receiver_noise"]
        if pid == "p1":
            out[(pid, "shape")] = (
                f"实测平均谱在占用带宽内从低端到高端下降 {sig['low_minus_high_dB']:.2f} dB，合成是平的"
                f"（均方根差 {P[pid]['shape']['synth_vs_main_rms_dB']:.2f} dB）。采集接收机在同一频段的噪声底下降 "
                f"{rx['low_minus_high_dB']:.2f} dB（{d['receiver_source']}，{rx['n_records']} 片），能解释其中一部分；"
                f"其余约 {sig['low_minus_high_dB'] - rx['low_minus_high_dB']:.1f} dB 的来源没有查明。")
        else:
            out[(pid, "shape")] = (
                f"实测平均谱中间比两端高 {sig['mid_minus_edges_dB']:.2f} dB（高端比低端再低 "
                f"{-sig['low_minus_high_dB']:.2f} dB），合成是平的（均方根差 {P[pid]['shape']['synth_vs_main_rms_dB']:.2f} dB）。"
                f"采集接收机的噪声底中间比两端高 {rx['mid_minus_edges_dB']:.2f} dB（{d['receiver_source']}），能解释其中一部分。")
    if P["p2"]["verdicts"].get("dur_s") == "有差距":
        rk = cmp("p2", "dur_s")["ref_vs_main"]["ks"]
        out[("p2", "dur_s")] = (
            f"C、E 型的图传突发分长短两档（验收集的峰：{_peaks(P['p2']['columns']['main']['dur_peaks_ms'])}；"
            f"训练部分的峰：{_peaks(P['p2']['columns']['ref']['dur_peaks_ms'])}），两档的比例在实测两部分之间就不同："
            f"训练部分中位数 {_ms(st('p2', 'ref', 'dur_s'))} ms，验收集 {_ms(st('p2', 'main', 'dur_s'))} ms，两部分之间 KS {rk:.3f}。"
            f"预设按训练部分取比例，合成中位数 {_ms(st('p2', 'synth', 'dur_s'))} ms 与训练部分一致。")
    for pid in ("p3", "p4", "p5"):
        c = P[pid]["columns"]
        m, sy = c["main"], c["synth"]
        frac_m = m["n_clean"] / m["n_bursts"] if m["n_bursts"] else None
        frac_s = sy["n_clean"] / sy["n_bursts"] if sy["n_bursts"] else None
        if P[pid]["verdicts"].get("interval_s") == "有差距":
            out[(pid, "interval_s")] = (
                f"合成上行突发里只有 {sy['n_clean']} / {sy['n_bursts']}（{frac_s * 100:.0f}%）被完整认出，实测为 {frac_m * 100:.0f}%；"
                f"每秒核心突发合成 {sy['core_per_s']:.0f} 个、实测 {m['core_per_s']:.0f} 个。逐格检查合成突发，频率跨度在部分格里"
                "从约 1.5 MHz 跳到 4–5 MHz，测量程序据此把突发切碎或记成与邻居争用。推断原因：合成 OFDM 的符号交界不加窗，"
                f"信噪比 {st(pid, 'synth', 'snr_dB'):.0f} dB 时交界处的频谱泼溅高出底噪 6 dB 以上。漏掉的突发使相邻核心突发的间隔变长"
                f"（中位数 {_ms(st(pid, 'synth', 'interval_s'))} ms 对实测 {_ms(st(pid, 'main', 'interval_s'))} ms）。")
        if P[pid]["verdicts"].get("hops") == "有差距":
            hm, hs = m["hops"], sy["hops"]
            hr = c.get("ref", {}).get("hops")
            if pid == "p4" and hr:
                out[(pid, "hops")] = (
                    f"差距在实测两部分之间：验收集 {hm['n_points']} 个点、跨度 {_mhz(hm['span_Hz'])} MHz、最高点 {_mhz(hm['max_Hz'])} MHz；"
                    f"训练部分 {hr['n_points']} 个点、{_mhz(hr['span_Hz'])} MHz、最高点 {_mhz(hr['max_Hz'])} MHz；"
                    f"合成 {hs['n_points']} 个点、{_mhz(hs['span_Hz'])} MHz，与训练部分一致。验收集的实测片段里没有量到栅格高端的点。")
            elif pid == "p5":
                out[(pid, "hops")] = (
                    f"点数 {hm['n_points']} 对 {hs['n_points']}，只差一个；跨度 {_mhz(hm['span_Hz'])} 对 {_mhz(hs['span_Hz'])} MHz。"
                    f"验收集的最小点间隔只有 {_mhz(hm['spacing_min_Hz'], 3)} MHz，远小于约 5 MHz 的栅格，"
                    "推断是同一个点被分成了两簇，或混进了别的信号。")
            else:
                out[(pid, "hops")] = (
                    f"合成序列在 1 MHz 栅格上随机取频点，逐跳 |步长| 中位数 {_mhz(hs['step_abs_median_Hz'])} MHz；"
                    f"实测是小步跳（{_mhz(hm['step_abs_median_Hz'])} MHz）。点数 {hm['n_points']} 对 {hs['n_points']}，"
                    f"最小点间隔 {_mhz(hm['spacing_min_Hz'], 3)} 对 {_mhz(hs['spacing_min_Hz'], 3)} MHz：实测的点不全在 1 MHz 栅格上。")
        if P[pid]["verdicts"].get("shape") == "有差距":
            b = _band(P[pid]["shape"]["curves_dB"]["main"], P[pid]["shape"])
            out[(pid, "shape")] = (
                f"实测平均谱在占用带宽内中间比两端高 {b['mid'] - 0.5 * (b['low'] + b['high']):.2f} dB"
                f"（低端 {b['low']:+.2f}、中间 {b['mid']:+.2f}、高端 {b['high']:+.2f} dB），合成是平顶"
                f"（均方根差 {P[pid]['shape']['synth_vs_main_rms_dB']:.2f} dB）。"
                + ("实测样本里还混有下一条说的恒包络突发，它们的谱是钟形的。" if pid == "p3" else ""))
    if P["p3"]["verdicts"].get("papr_dB") == "有差距":
        d = dg["p3"]
        others = [f"{x.upper()} {abs(next(r for r in P[x]['stats'] if r['stat'] == 'papr_dB')['synth_vs_main']['diff']):.2f} dB"
                  for x in ("p4", "p5")]
        out[("p3", "papr_dB")] = (
            f"实测角色窗里 {d['constant_envelope_frac'] * 100:.0f}% 的突发峰均比低于 4 dB，是恒包络信号（蓝牙一类），"
            f"不是 DJI 上行的 OFDM。去掉它们后实测中位数 {d['papr_median_without_constant_envelope_dB']:.2f} dB，"
            f"仍比合成（{d['synth_papr_median_dB']:.2f} dB）低 "
            f"{d['synth_papr_median_dB'] - d['papr_median_without_constant_envelope_dB']:.2f} dB；另两档上行的差只有 "
            f"{'、'.join(others)}。C、E 型上行的峰均比为什么更低，没有查明。")
    p7 = P["p7"]
    if p7["verdicts"].get("obw99_Hz") == "有差距" or p7["verdicts"].get("bw10_Hz") == "有差距":
        txt = (f"合成 99% 占用带宽 {st('p7', 'synth', 'obw99_Hz') / 1e3:.0f} kHz，实测 {st('p7', 'main', 'obw99_Hz') / 1e3:.0f} kHz"
               f"（{cmp('p7', 'obw99_Hz')['synth_vs_main']['rel'] * 100:+.1f}%）；−10 dB 宽度 {st('p7', 'synth', 'bw10_Hz') / 1e3:.0f} 对 "
               f"{st('p7', 'main', 'bw10_Hz') / 1e3:.0f} kHz。合成的调制参数取自开源实现里 CC2500 的 FCC 档寄存器"
               "（GFSK、BT 1、频偏 57.1 kHz）；实测数据采集时用的是 ACCESS 还是 ACCST D16 没有记录，实际参数可能不同。")
        for k in ("obw99_Hz", "bw10_Hz"):
            if p7["verdicts"].get(k) == "有差距":
                out[("p7", k)] = txt
    if p7["verdicts"].get("interval_s") == "有差距":
        c = p7["columns"]
        miss = 1 - c["main"]["core_per_s"] * FRSKY_FRAME_S
        out[("p7", "interval_s")] = (
            f"实测每秒认出 {c['main']['core_per_s']:.0f} 个核心突发，帧率是每秒 {1 / FRSKY_FRAME_S:.1f} 帧，约 {miss * 100:.0f}% 的帧"
            f"没有认出遥控包，于是出现两倍帧长的间隔（实测间隔的峰：{_peaks(c['main']['interval_peaks_ms'])}）；"
            f"合成每帧都发（每秒 {c['synth']['core_per_s']:.0f} 个）。缺的包是没有发还是没有认出，这里没有查明。")
    if p7["verdicts"].get("flatness") == "有差距" or p7["verdicts"].get("shape") == "有差距":
        txt = (f"实测谱在一个频偏音附近有一根窄峰（−3 dB 宽度 {st('p7', 'main', 'bw3_Hz') / 1e3:.0f} kHz，"
               f"合成 {st('p7', 'synth', 'bw3_Hz') / 1e3:.0f} kHz），平坦度 {st('p7', 'main', 'flatness'):.3f} 对 "
               f"{st('p7', 'synth', 'flatness'):.3f}，平均谱形均方根差 {p7['shape']['synth_vs_main_rms_dB']:.2f} dB。"
               "推断：实测载荷里同一比特连续出现得多（例如通道值少变、数据不白化），合成载荷是随机的。"
               "对 GFSK 遥控，载荷内容会改变谱形，「随机载荷足以给出正确的谱」这一假定在这里不成立。")
        for k in ("flatness", "shape"):
            if p7["verdicts"].get(k) == "有差距":
                out[("p7", k)] = txt
    return out


def observations(doc: dict) -> list[str]:
    """不进判定、但评测者看得出来的差别。"""
    P = {p["id"]: p for p in doc["pairs"]}
    steps = "；".join(
        f"{pid.upper()} 合成 {_mhz(P[pid]['columns']['synth']['hops'].get('step_abs_median_Hz'))} MHz、"
        f"实测 {_mhz(P[pid]['columns']['main']['hops'].get('step_abs_median_Hz'))} MHz" for pid in ("p3", "p4", "p5"))
    full = "；".join(
        f"{pid.upper()} 合成 {P[pid]['columns']['synth']['n_clean'] / max(1, P[pid]['columns']['synth']['n_bursts']) * 100:.0f}%、"
        f"实测 {P[pid]['columns']['main']['n_clean'] / max(1, P[pid]['columns']['main']['n_bursts']) * 100:.0f}%"
        for pid in ("p3", "p4", "p5"))
    return [
        "合成 OFDM 的符号交界不加窗。信噪比高时，合成突发在含符号交界的时频格里频谱展宽"
        "（逐格检查 P3 的合成突发，测得的频率跨度从约 1.5 MHz 跳到 4–5 MHz）。上行突发被完整认出的比例："
        + full + "。",
        "DJI 上行的跳频序列：合成在栅格上随机取点，实测多是小步跳。逐跳 |步长| 中位数：" + steps + "。",
    ]


# ---------------------------------------------------------------- 数字格式

def fmt_val(stat: str, v) -> str:
    if v is None:
        return "—"
    if stat.endswith("_Hz"):
        return f"{v / 1e6:.3f} MHz" if abs(v) >= 1e6 else f"{v / 1e3:.1f} kHz"
    if stat in ("dur_s", "interval_s"):
        return f"{v * 1e3:.3f} ms"
    if stat.endswith("_dB"):
        return f"{v:.2f} dB"
    return f"{v:.3f}"


def fmt_summary(stat: str, s: dict) -> str:
    if not s or not s.get("n"):
        return "—（无样本）"
    return (f"{fmt_val(stat, s['median'])}<br><span class=sub>{fmt_val(stat, s['p10'])} – "
            f"{fmt_val(stat, s['p90'])}，n = {s['n']}</span>")


def fmt_diff(stat: str, c: dict) -> str:
    if c.get("diff") is None:
        return "—"
    if c.get("measure") == "rel_median" or (stat.endswith("_Hz") or stat in ("dur_s", "interval_s")):
        if c.get("rel") is not None:
            return f"{c['rel'] * 100:+.1f}%"
    return f"{c['diff']:+.3f}" if not stat.endswith("_dB") else f"{c['diff']:+.2f} dB"


def badge(v: str | None) -> str:
    if v == "一致":
        return '<span class="badge ok">✓ 一致</span>'
    if v == "有差距":
        return '<span class="badge gap">△ 有差距</span>'
    if v == "无法比较":
        return '<span class="badge na">— 无法比较</span>'
    return '<span class="sub">只报数</span>'


def e(s) -> str:
    return html.escape(str(s))


# ---------------------------------------------------------------- 图

def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({
        "font.family": "sans-serif", "font.sans-serif": FONTS + ["DejaVu Sans"], "axes.unicode_minus": False,
        "font.size": 9, "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": MUTED,
        "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.facecolor": SURFACE,
        "figure.facecolor": SURFACE, "legend.frameon": False, "axes.spines.top": False, "axes.spines.right": False,
        "svg.hashsalt": "cuav-realism",
    })
    return plt


def png(fig) -> str:
    """线图用 PNG（不写软件元数据）。返回「媒体类型;base64,数据」。"""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, metadata={"Software": None})
    import matplotlib.pyplot as plt
    plt.close(fig)
    return "image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def jpg(fig) -> str:
    """时频图用 JPEG（噪声纹理按 PNG 存要大十倍）。Pillow 的编码对同一输入逐字节相同。"""
    buf = io.BytesIO()
    fig.savefig(buf, format="jpg", dpi=110, pil_kwargs={"quality": 85, "optimize": True})
    import matplotlib.pyplot as plt
    plt.close(fig)
    return "image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def fig_spectrograms(left: dict | None, left_img, right: dict | None, right_img, titles: tuple[str, str]) -> str | None:
    """两块的时频图并排：同一色标（高出逐频点底噪 0–40 dB），横轴绝对频率，纵轴块内时间。"""
    if left_img is None and right_img is None:
        return None
    plt = _plt()
    single = left is None and left_img is None and not titles[0]
    fig, axes = plt.subplots(1, 1 if single else 2, figsize=(5.4 if single else 9.6, 3.9), constrained_layout=True)
    axes = [axes] if single else list(axes)
    panels = [(axes[0], right, right_img, titles[1])] if single else \
        [(axes[0], left, left_img, titles[0]), (axes[1], right, right_img, titles[1])]
    im = None
    for ax, rep, img, title in panels:
        ax.grid(False)
        if img is None or rep is None:
            ax.text(0.5, 0.5, "没有满足条件的块", ha="center", va="center", color=MUTED, transform=ax.transAxes)
            ax.set_axis_off()
            continue
        fs, fc, dur = rep["fs"], rep["fc"], rep["n"] / rep["fs"]
        im = ax.imshow(img, aspect="auto", origin="upper", cmap="viridis", vmin=0, vmax=40, interpolation="nearest",
                       extent=[(fc - fs / 2) / 1e6, (fc + fs / 2) / 1e6, dur * 1e3, 0])
        ax.set_title(title, fontsize=9, color=INK)
        ax.set_xlabel("频率（MHz）")
        ax.set_ylabel("块内时间（ms）")
    if im is not None:
        fig.colorbar(im, ax=axes, label="高出底噪（dB）", shrink=0.9)
    return jpg(fig)


def fig_shape(pair: dict) -> str | None:
    sh = pair["shape"]
    curves = sh["curves_dB"]
    if not any(curves.get(k) for k in curves):
        return None
    plt = _plt()
    n = int(round(sh["span_Hz"] / sh["res_Hz"]))
    grid = np.arange(-n, n + 1) * sh["res_Hz"] / 1e6
    fig, ax = plt.subplots(figsize=(9.6, 3.4), constrained_layout=True)
    for key, color, ls, lw, label in (("main", C_MAIN, "-", 2.0, COL_NAME[pair["main"]]),
                                      ("ref", C_REF, "--", 1.4, COL_NAME.get(pair["ref"] or "", "")),
                                      ("synth", C_SYNTH, "-", 2.0, "合成")):
        c = curves.get(key)
        if c:
            ax.plot(grid, [np.nan if v is None else v for v in c], color=color, ls=ls, lw=lw, label=label)
    b = sh["band_Hz"] / 2e6
    for x in (-b, b):
        ax.axvline(x, color=AXIS, lw=1.0, ls=":")
    ax.set_ylim(-40, 6)
    ax.set_xlim(grid[0], grid[-1])
    ax.set_xlabel("相对对齐中心的频率（MHz）")
    ax.set_ylabel("归一化功率谱（dB）")
    ax.legend(loc="lower center", ncol=3)
    return png(fig)


def _ecdf(ax, vals, color, ls, lw, label, scale):
    v = np.sort(np.asarray([x for x in vals if x is not None and math.isfinite(x)], dtype=float)) * scale
    if v.size == 0:
        return
    ax.step(v, np.arange(1, v.size + 1) / v.size, where="post", color=color, ls=ls, lw=lw, label=f"{label}（n = {v.size}）")


def fig_ecdfs(pair: dict, cols: dict, synth_label: str = "合成") -> str:
    plt = _plt()
    panels = [("dur_s", 1e3, "突发时长（ms）"), ("interval_s", 1e3, "突发间隔（ms）"), ("flatness", 1.0, "谱平坦度"),
              ("obw99_Hz", 1e-6, "99% 占用带宽（MHz）")]
    has_papr = any(cols[k]["rows"] and any(z["papr_dB"] is not None for z in cols[k]["rows"]) for k in cols)
    if has_papr:
        panels[3] = ("papr_dB", 1.0, "峰均比（dB，CCDF 1e-3）")
    fig, axes = plt.subplots(2, 2, figsize=(9.6, 5.6), constrained_layout=True)
    for ax, (stat, scale, label) in zip(axes.ravel(), panels):
        for key, color, ls, lw, name in (("main", C_MAIN, "-", 2.0, COL_NAME[pair["main"]]),
                                         ("ref", C_REF, "--", 1.4, COL_NAME.get(pair["ref"] or "", "")),
                                         ("synth", C_SYNTH, "-", 2.0, synth_label)):
            c = cols.get(key)
            if c is None:
                continue
            vals = c["intervals"] if stat == "interval_s" else [z[stat] for z in c["rows"]]
            _ecdf(ax, vals, color, ls, lw, name, scale)
        ax.set_xlabel(label)
        ax.set_ylabel("累积比例")
        ax.set_ylim(0, 1.02)
        ax.legend(loc="upper left", fontsize=7.5)
    return png(fig)


def fig_hops(pair: dict, cols: dict, synth_label: str = "合成") -> str | None:
    """核心突发中心频率的直方图：上实测、下合成，同一横轴。"""
    main, synth = cols.get("main"), cols.get("synth")
    if not main or not synth or not main["core_centers"] or not synth["core_centers"]:
        return None
    plt = _plt()
    bw = (pair.get("supplement") or pair)["window"]["bw10_Hz"]
    step = 0.05 if bw < 0.5e6 else 0.25
    allc = np.concatenate([np.asarray(main["core_centers"]), np.asarray(synth["core_centers"])]) / 1e6
    edges = np.arange(math.floor(allc.min()) - 1, math.ceil(allc.max()) + 1 + step, step)
    fig, axes = plt.subplots(2, 1, figsize=(9.6, 3.6), sharex=True, constrained_layout=True)
    for ax, c, color, name in ((axes[0], main, C_MAIN, COL_NAME[pair["main"]]), (axes[1], synth, C_SYNTH, synth_label)):
        h, _ = np.histogram(np.asarray(c["core_centers"]) / 1e6, edges)
        ax.bar(edges[:-1], h / max(1, h.sum()), width=step, align="edge", color=color, linewidth=0)
        ax.set_ylabel("突发占比")
        ax.set_title(name, loc="left", fontsize=9, color=INK)
    axes[1].set_xlabel("核心突发中心频率（MHz）")
    return png(fig)


def fig_variants(doc: dict, figs: dict) -> str | None:
    v = doc["variants"]
    p1 = next(p for p in doc["pairs"] if p["id"] == "p1")
    rows = [(COL_NAME["holdout"], p1["columns"]["main"]["stats"]["flatness"], C_MAIN),
            (COL_NAME["train"], p1["columns"]["ref"]["stats"]["flatness"], C_REF),
            ("合成：交付配置", p1["columns"]["synth"]["stats"]["flatness"], C_SYNTH)]
    rows += [(f"合成：{VARIANT_NAME[r['cell']]}", r["flatness"], C_SYNTH) for r in v["rows"]]
    rows = [r for r in rows if r[1].get("n")]
    if not rows:
        return None
    plt = _plt()
    fig, ax = plt.subplots(figsize=(9.6, 0.42 * len(rows) + 1.0), constrained_layout=True)
    for i, (name, s, color) in enumerate(rows):
        y = len(rows) - 1 - i
        ax.plot([s["p10"], s["p90"]], [y, y], color=color, lw=2.0, solid_capstyle="round")
        ax.plot([s["median"]], [y], "o", color=color, ms=7, mec=SURFACE, mew=2)
    m = rows[0][1]
    ax.axvspan(m["p10"], m["p90"], color=C_MAIN, alpha=0.08, lw=0)
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels([r[0] for r in rows][::-1])
    ax.set_xlabel("逐突发谱平坦度：圆点为中位数，横线为第 10 – 90 百分位")
    ax.set_xlim(0, 1.02)
    ax.grid(axis="y", visible=False)
    return png(fig)


# ---------------------------------------------------------------- 页面

CSS = """
:root{--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--axis:#c3c2b7;--surface:#fcfcfb;--plane:#f9f9f7;
--ok:#0ca30c;--gap:#ec835a;--accent:#2a78d6}
*{box-sizing:border-box}
html{color-scheme:light}
body{margin:0;background:var(--plane);color:var(--ink);font:15px/1.65 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",
system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px;background:var(--surface)}
h1{font-size:26px;line-height:1.3;margin:0 0 6px}
h2{font-size:20px;margin:40px 0 10px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:28px 0 8px}
p,li{max-width:76ch}
.meta{color:var(--ink2);font-size:13px;margin-bottom:16px}
.note{background:var(--plane);border-left:3px solid var(--axis);padding:8px 12px;color:var(--ink2);font-size:14px}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:13.5px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--ink2);font-weight:600;background:var(--plane)}
td.num{font-variant-numeric:tabular-nums}
.sub{color:var(--muted);font-size:12px}
.badge{display:inline-block;font-size:12.5px;font-weight:600;white-space:nowrap}
.badge.ok::first-letter{color:var(--ok)}
.badge.gap::first-letter{color:var(--gap)}
.badge.na{color:var(--muted)}
figure{margin:12px 0 20px}
figure.narrow{max-width:560px}
figure img{width:100%;height:auto;display:block;border:1px solid var(--line)}
figcaption{font-size:13px;color:var(--ink2);margin-top:6px}
details{margin:8px 0}
summary{cursor:pointer;color:var(--ink2)}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ids{font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink2);word-break:break-all}
.toc a{color:var(--accent);text-decoration:none}
.scroll{overflow-x:auto}
@media print{body{background:#fff}main{max-width:none;padding:0}h2{break-before:page}figure,table{break-inside:avoid}}
"""


def img_tag(b64: str | None, alt: str, caption: str, narrow: bool = False) -> str:
    if not b64:
        return f'<p class="sub">{e(alt)}：没有可画的数据。</p>'
    return (f'<figure{" class=narrow" if narrow else ""}><img alt="{e(alt)}" src="data:{b64}">'
            f'<figcaption>{caption}</figcaption></figure>')


def section_summary(doc: dict) -> str:
    rows = []
    for p in doc["pairs"]:
        ok = [STAT_NAME.get(k, {"shape": "平均谱形", "hops": "跳频点"}.get(k, k))
              for k, v in p["verdicts"].items() if v == "一致"]
        gap = [STAT_NAME.get(k, {"shape": "平均谱形", "hops": "跳频点"}.get(k, k))
               for k, v in p["verdicts"].items() if v == "有差距"]
        na = [STAT_NAME.get(k, {"shape": "平均谱形", "hops": "跳频点"}.get(k, k))
              for k, v in p["verdicts"].items() if v == "无法比较"]
        rows.append(
            f"<tr><td>{e(p['id'].upper())}</td><td>{e(PRESET_NAME[p['preset']])}</td><td>{e(p['measured'])}</td>"
            f"<td>{'独立（验收集）' if p['independent'] else '同源'}</td>"
            f"<td>{e('、'.join(ok)) or '—'}</td><td>{e('、'.join(gap)) or '—'}"
            f"{('<br><span class=sub>无法比较：' + e('、'.join(na)) + '</span>') if na else ''}</td></tr>")
    return ("<table><tr><th>对</th><th>合成预设</th><th>实测对照</th><th>对照性质</th><th>一致</th><th>有差距</th></tr>"
            + "".join(rows) + "</table>")


def stats_table(p: dict) -> str:
    cols = p["columns"]
    head = (f"<tr><th>统计量</th><th>{COL_NAME[p['main']]}</th>"
            + (f"<th>{COL_NAME[p['ref']]}</th>" if "ref" in cols else "")
            + "<th>合成</th><th>合成 − 实测</th><th>KS 距离</th><th>判定</th></tr>")
    body = []
    for r in p["stats"]:
        s = r["stat"]
        c = r["synth_vs_main"]
        line = ""
        if c.get("line") is not None:
            unit = {"rel_median": "中位数相对差", "abs_median": "中位数差", "ks": "KS 距离"}[c["measure"]]
            lv = f"{c['line'] * 100:.0f}%" if c["measure"] == "rel_median" else f"{c['line']}"
            line = f"<br><span class=sub>线：{unit} ≤ {lv}</span>"
        ref_txt = ""
        if "ref" in cols:
            ref_txt = f"<td class=num>{fmt_summary(s, cols['ref']['stats'][s])}</td>"
        body.append(f"<tr><td>{STAT_NAME[s]}</td><td class=num>{fmt_summary(s, cols['main']['stats'][s])}</td>"
                    f"{ref_txt}<td class=num>{fmt_summary(s, cols['synth']['stats'][s])}</td>"
                    f"<td class=num>{fmt_diff(s, c)}</td><td class=num>{'—' if c.get('ks') is None else f'{c['ks']:.3f}'}</td>"
                    f"<td>{badge(c.get('verdict'))}{line}</td></tr>")
    sh = p["shape"]
    ref_sh = (f"<td class=num>对验收集 {sh['ref_vs_main_rms_dB']:.2f} dB</td>"
              if "ref" in cols and sh.get("ref_vs_main_rms_dB") is not None else ("<td>—</td>" if "ref" in cols else ""))
    body.append(f"<tr><td>平均谱形<br><span class=sub>占用带宽 {sh['band_Hz'] / 1e6:.3f} MHz 内的 dB 均方根差</span></td>"
                f"<td>—</td>{ref_sh}<td>—</td><td class=num>"
                f"{'—' if sh['synth_vs_main_rms_dB'] is None else f'{sh['synth_vs_main_rms_dB']:.2f} dB'}</td><td>—</td>"
                f"<td>{badge(sh['verdict'])}<br><span class=sub>线：≤ {sh['line']} dB</span></td></tr>")
    if "hops" in p:
        hm, hs = cols["main"]["hops"], cols["synth"]["hops"]
        hr = cols.get("ref", {}).get("hops")
        hv = p["hops"]["synth_vs_main"]

        def hcell(h):
            if not h or not h.get("n_points"):
                return "—"
            return (f"{h['n_points']} 个点，跨度 {h['span_Hz'] / 1e6:.2f} MHz<br><span class=sub>最小间隔 "
                    f"{(h['spacing_min_Hz'] or 0) / 1e6:.3f} MHz，逐跳 |步长| 中位数 "
                    f"{(h.get('step_abs_median_Hz') or 0) / 1e6:.3f} MHz，n = {h['n_bursts']}</span>")
        diff = ("—" if hv.get("span_rel") is None else
                f"点数 {hv['points_diff']:+d}<br>跨度 {hv['span_rel'] * 100:+.1f}%")
        body.append(f"<tr><td>跳频点</td><td class=num>{hcell(hm)}</td>"
                    + (f"<td class=num>{hcell(hr)}</td>" if "ref" in cols else "")
                    + f"<td class=num>{hcell(hs)}</td><td class=num>{diff}</td><td>—</td>"
                    f"<td>{badge(hv['verdict'])}<br><span class=sub>线：点数相等且跨度 ≤ 5%</span></td></tr>")
    return "<table>" + head + "".join(body) + "</table>"


def rate_line(p: dict) -> str:
    parts = []
    for k in ("main", "ref", "synth"):
        c = p["columns"].get(k)
        if not c:
            continue
        name = COL_NAME["synth"] if k == "synth" else COL_NAME[p[k]]
        if p["kind"] == "video":
            parts.append(f"{name}：每秒 {c['bursts_per_s']:.0f} 个突发，占空 {c['duty']:.3f}，"
                         f"{c['n_blocks']} 块共 {c['seconds']:.2f} s")
        else:
            parts.append(f"{name}：每秒 {c['core_per_s']:.0f} 个核心突发，{c['n_blocks']} 块共 {c['seconds']:.2f} s")
    return "<p class=sub>" + "；".join(e(x) for x in parts) + "。</p>"


def by_class_table(p: dict) -> str:
    if not p.get("by_class"):
        return ""
    rows = "".join(
        f"<tr><td>{c}</td>" + "".join(f"<td class=num>{fmt_summary(s, v[s])}</td>"
                                      for s in ("obw99_Hz", "bw10_Hz", "dur_s", "flatness")) + "</tr>"
        for c, v in p["by_class"].items())
    return ("<details><summary>分型补充（验收集，只报数）</summary><table><tr><th>型</th><th>99% 占用带宽</th>"
            "<th>−10 dB 宽度</th><th>突发时长</th><th>谱平坦度</th></tr>" + rows + "</table></details>")


def pair_section(p: dict, figs: dict) -> str:
    f = figs["pairs"][p["id"]]
    cols = f["cols"]
    sy = p["synthetic"]
    indep = ("实测主列取<strong>验收集</strong>：这部分实测片段在数据入库时即冻结，从未用于提取任何参数，对照是独立的。"
             if p["independent"] else
             "这一型没有验收集，实测一侧取<strong>全部</strong>片段；预设里的时序参数正是从这些片段提取的，"
             "时序一致只说明提取闭合，不是独立证据。")
    win = ""
    if p.get("window"):
        w = p["window"]
        win = (f"遥控 / 上行突发按同一个角色窗认：−10 dB 宽度 {w['bw10_Hz'] / 1e6:.3f} MHz 的 1/1.35 – 1.35 倍、"
               f"时长 {w['dur_s'] * 1e3:.3f} ms 的 1/3 – 3 倍、信噪比 ≥ 10 dB；间隔、跳步与频点只用时长在 ±10% 内的核心突发。")
    rep_m = f["rep_main"]
    title_m = f"{COL_NAME[p['main']]}：{rep_m['data_id']}" if rep_m else COL_NAME[p["main"]]
    cz = causes_cache[0]
    causes_ = [(k, cz[(p["id"], k)]) for k, v in p["verdicts"].items() if v == "有差距" and (p["id"], k) in cz]
    seen, uniq = set(), []
    for k, t in causes_:
        if t not in seen:
            seen.add(t)
            uniq.append((k, t))
    out = [f'<h3 id="{p["id"]}">{e(p["id"].upper())} {e(PRESET_NAME[p["preset"]])} ↔ {e(p["measured"])}</h3>',
           f"<p>{indep} 合成段：{sy['fs_Hz'] / 1e6:g} MS/s @ {sy['center_Hz'] / 1e6:g} MHz，"
           f"{sy['samples'] / sy['fs_Hz']:.1f} s，按 {p['block_s'] * 1e3:g} ms 一块切开。{e(win)}</p>",
           stats_table(p), rate_line(p), by_class_table(p)]
    if uniq:
        out.append("<p><strong>差距与可能原因：</strong></p><ul>"
                   + "".join(f"<li><strong>{e(_name(k))}</strong>：{e(t)}</li>" for k, t in uniq) + "</ul>")
    if p.get("supplement"):
        out.append(supplement_table(p))
    out.append(img_tag(fig_spectrograms(rep_m, f["rep_main_img"], f["rep_synth"], f["rep_synth_img"],
                                        (title_m, f.get("synth_label", "合成"))),
                       f"{p['id']} 时频图", "时频图（1024 点汉宁窗，按时间分组取均值；色标为高出逐频点底噪的 dB，两侧同一色标）。"
                       "左为实测主列里按编号排序第一个满足条件的块，右为合成段第一个满足条件的块。"))
    out.append(img_tag(fig_shape(p), f"{p['id']} 平均谱形",
                       "平均谱形：逐突发去噪功率谱，按占用带宽（两条点线之间）内的均值归一后在线性域平均。"
                       + ("图传按信道中心对齐。" if p["kind"] == "video" else "跳频类按每个突发的功率重心对齐。")
                       + "只比两条点线之间；点线之外的实测曲线里混有同时段的其他信号（遥控、WiFi 等），不作比较。"))
    lab = f.get("synth_label", "合成")
    out.append(img_tag(fig_ecdfs(p, cols, lab), f"{p['id']} 分布", "逐突发统计量的累积分布。"))
    if p["kind"] == "link":
        out.append(img_tag(fig_hops(p, cols, lab), f"{p['id']} 跳频点", "核心突发中心频率的分布（上：实测主列；下：合成）。"))
    return "\n".join(out)


causes_cache: list[dict] = [{}]


def _name(k: str) -> str:
    return STAT_NAME.get(k, {"shape": "平均谱形", "hops": "跳频点"}.get(k, k))


def supplement_table(p: dict) -> str:
    """P8：合成按预设自己的窗认出的突发，与实测并排（取数之后加的补充，不判定）。"""
    sup, main = p["supplement"], p["columns"]["main"]
    w = sup["window"]
    rows = "".join(f"<tr><td>{STAT_NAME[s]}</td><td class=num>{fmt_summary(s, main['stats'][s])}</td>"
                   f"<td class=num>{fmt_summary(s, sup['stats'][s])}</td></tr>"
                   for s in ("obw99_Hz", "bw10_Hz", "dur_s", "interval_s", "flatness", "papr_dB"))
    hm, hs = main.get("hops") or {}, sup.get("hops") or {}

    def h(x):
        return "—" if not x.get("n_points") else f"{x['n_points']} 个点，跨度 {x['span_Hz'] / 1e6:.2f} MHz"
    rows += f"<tr><td>跳频点</td><td class=num>{h(hm)}</td><td class=num>{h(hs)}</td></tr>"
    return (f"<p><strong>补充（取数之后加的，不判定）</strong>：实测片段的角色窗装不下 S-FHSS 的包，"
            f"故另按预设自己的参数认合成突发：−10 dB 宽度 {w['bw10_Hz'] / 1e3:.0f} kHz、单包时长 {w['dur_s'] * 1e3:.3f} ms。"
            "两列是两种协议的实测与合成并排，差别归「协议不同」。</p>"
            f"<table><tr><th>统计量</th><th>{COL_NAME[p['main']]}（T14SG）</th><th>合成（S-FHSS，自身参数）</th></tr>"
            + rows + "</table>")


def variants_section(doc: dict, figs: dict) -> str:
    v = doc["variants"]
    p1 = next(p for p in doc["pairs"] if p["id"] == "p1")
    m = v["main_flatness"]
    rows = [f"<tr><td>合成：交付配置（平坦莱斯 K 9 dB）</td><td class=num>{fmt_summary('flatness', p1['columns']['synth']['stats']['flatness'])}</td>"
            f"<td class=num>{fmt_diff('flatness', next(r for r in p1['stats'] if r['stat'] == 'flatness')['synth_vs_main'])}</td>"
            f"<td class=num>{p1['shape']['synth_vs_main_rms_dB']:.2f} dB</td></tr>"]
    for r in v["rows"]:
        rows.append(f"<tr><td>合成：{e(VARIANT_NAME[r['cell']])}</td><td class=num>{fmt_summary('flatness', r['flatness'])}</td>"
                    f"<td class=num>{fmt_diff('flatness', r['flatness_vs_main'])}</td>"
                    f"<td class=num>{'—' if r['shape_rms_dB'] is None else f'{r['shape_rms_dB']:.2f} dB'}</td></tr>")
    table = ("<table><tr><th>配置</th><th>谱平坦度</th><th>中位数差（对验收集）</th><th>平均谱形均方根差</th></tr>"
             f"<tr><td>实测（验收集）</td><td class=num>{fmt_summary('flatness', m)}</td><td>—</td><td>—</td></tr>"
             + "".join(rows) + "</table>")
    return table + img_tag(fig_variants(doc, figs), "平坦度归因", "P1 图传逐突发谱平坦度：实测两部分与合成各配置。")


def selfcheck_section(doc: dict, figs: dict) -> str:
    out = []
    for sc in doc["selfchecks"]:
        rows = "".join(
            f"<tr><td>{e(c['name'])}</td><td class=num>{_sc_val(c, 'want')}</td><td class=num>{_sc_val(c, 'got')}</td>"
            f"<td class=num>{'—' if c.get('rel') is None else f'{c['rel'] * 100:+.2f}%'}</td><td>{badge(c['verdict'])}</td>"
            f"<td>{e(c['source'])}</td></tr>" for c in sc["checks"])
        out.append(f"<h3>{e(sc['id'].upper())} {e(PRESET_NAME[sc['preset']])}</h3>"
                   "<table><tr><th>项</th><th>出处的数</th><th>合成量得</th><th>相对差</th><th>判定</th><th>出处</th></tr>"
                   + rows + "</table>")
        f = figs["selfchecks"][sc["id"]]
        if f.get("rep_img") is not None:
            out.append(img_tag(fig_spectrograms(None, None, f["rep"], f["rep_img"], ("", "合成段")),
                               f"{sc['id']} 时频图", "合成段第一个满足条件的块（色标同上）。", narrow=True))
    return "\n".join(out)


def _sc_val(c: dict, k: str) -> str:
    v = c.get(k)
    if v is None:
        return "—"
    return f"{v / 1e6:.3f} MHz" if c["unit"] == "Hz" else f"{v * 1e3:.3f} ms"


# 「有差距」各项的归类（看过结果之后写的解释，不改判定）。类别 → 说明；键 = (配对, 统计量)。
CATEGORY_NAME = {
    "model": "模型结构：要改生成器才能消除",
    "preset": "预设参数：出处不足，可能取错了档",
    "config": "交付配置的选择",
    "measured": "实测一侧：样本、采集接收机或两部分实测之间",
    "open": "没有查明",
}
CATEGORY = {
    ("p1", "interval_s"): ("model", "图传帧排布是固定时隙格，间隔只取时隙长的整数倍"),
    ("p2", "interval_s"): ("model", "同上（4 ms 时隙）"),
    ("p6", "interval_s"): ("model", "同上（2 ms 时隙）；这一对同源，仍对不上"),
    ("p3", "interval_s"): ("model", "OFDM 符号交界不加窗，高信噪比下合成上行突发被测量程序切碎，漏掉的突发拉长了间隔"),
    ("p3", "hops"): ("model", "上行跳频序列在栅格上随机取点；实测是小步跳，频点也不全在栅格上"),
    ("p7", "flatness"): ("model", "GFSK 载荷随机；实测载荷有规律，谱上有窄峰"),
    ("p7", "shape"): ("model", "同上"),
    ("p7", "obw99_Hz"): ("preset", "FrSky 调制参数按开源实现的 FCC 档推断，采集时用的协议档没有记录"),
    ("p7", "bw10_Hz"): ("preset", "同上"),
    ("p1", "flatness"): ("config", "交付配置用平坦衰落；打开抽头延迟线（TGn-C…F）后与实测相当"),
    ("p2", "dur_s"): ("measured", "两档突发的比例在实测两部分之间就不同，合成与训练部分一致"),
    ("p4", "hops"): ("measured", "验收集没有量到栅格高端的点，合成与训练部分一致"),
    ("p3", "papr_dB"): ("measured", "实测样本里约三成是恒包络信号；去掉后仍差约 1.3 dB，这部分没有查明"),
    ("p3", "shape"): ("measured", "实测样本混有恒包络信号；实测谱中间高两边低"),
    ("p1", "shape"): ("open", "采集接收机的频响能解释一部分斜坡，其余没有查明"),
    ("p6", "shape"): ("open", "采集接收机的频响能解释一部分拱形，其余没有查明"),
    ("p5", "shape"): ("open", "实测谱中间略高、边沿更缓"),
    ("p5", "hops"): ("open", "实测多出一个点，推断是同一个点被分成了两簇"),
    ("p7", "interval_s"): ("open", "实测约两成帧没有认出遥控包，是没发还是没认出没有查明"),
}


def limits_section(doc: dict) -> str:
    groups: dict[str, list[str]] = {k: [] for k in CATEGORY_NAME}
    for p in doc["pairs"]:
        for k, v in p["verdicts"].items():
            if v != "有差距":
                continue
            cat, txt = CATEGORY.get((p["id"], k), ("open", "见第 4 节该对的说明"))
            groups[cat].append(f'<a href="#{p["id"]}">{e(p["id"].upper())}</a> {e(_name(k))}：{e(txt)}')
    rows = "".join(f"<tr><td>{e(CATEGORY_NAME[c])}</td><td>{'<br>'.join(v)}</td></tr>" for c, v in groups.items() if v)
    items = [f"<table><tr><th>类别</th><th>项与说明</th></tr>{rows}</table>"]
    fixed = [
        "实测数据带着采集现场的底噪、干扰与接收机特性，具体接收机参数没有公开；本报告只比带内归一后的形状与时序，不比绝对电平。",
        "5.8 GHz 图传只有 Mavic 3 一型的实测，结论不外推到其他 O3 类机型；Mavic 3 与 Futaba T14SG 没有验收集，对照不独立。",
        "Futaba 预设按 S-FHSS 协议，而 T14SG 实测数据的时序与频点结构不是 S-FHSS；这一对的差距归「协议不同」，不归模型误差。",
        "DJI 图传 10 MHz 档与 DroneID 在本地实测里没有同型对照，只做了结构自检（第 6 节）。",
        "全部数字是原型阶段验证值：公开数据集只用于验证技术途径，拿到实际接收机的实测数据后按同一程序重跑。",
        "判定线在取数之前写定；「有差距」的项没有为凑近实测去调任何模型参数。验收集此后不用于修改预设。",
    ]
    obs = "".join(f"<li>{e(x)}</li>" for x in observations(doc))
    return ("<h3>7.1 判定为「有差距」的项</h3>" + "".join(items) +
            "<h3>7.2 不判定、但看得出来的差别</h3><ul>" + obs + "</ul>"
            "<h3>7.3 对照本身的限制</h3><ul>" + "".join(f"<li>{e(x)}</li>" for x in fixed) + "</ul>")


def samples_section(doc: dict) -> str:
    out = []
    for p in doc["pairs"]:
        for col, ids in p["samples"].items():
            out.append(f"<details><summary>{e(p['id'].upper())} {e(COL_NAME[col])}：{len(ids)} 段</summary>"
                       f"<p class=ids>{e(' '.join(ids))}</p></details>")
    return "\n".join(out)


def write(doc: dict, figs: dict) -> str:
    causes_cache[0] = causes(doc)
    pairs_html = "\n".join(pair_section(p, figs) for p in doc["pairs"])
    lines_rows = [("99% 占用带宽", "逐突发；中位数相对差", "≤ 5%"), ("−10 dB 宽度", "逐突发；中位数相对差", "≤ 5%"),
                  ("平均谱形", "逐突发去噪功率谱，占用带宽内均值归一后线性平均；占用带宽内 dB 均方根差", "≤ 1 dB"),
                  ("谱平坦度", "逐突发，−10 dB 宽度内几何均值 ÷ 算术均值；中位数差", "≤ 0.05"),
                  ("突发时长", "能量等效时长；中位数相对差", "≤ 5%"),
                  ("突发间隔", "块内相邻突发起点之差；两样本 KS 距离", "≤ 0.2"),
                  ("峰均比", "突发内 CCDF 在 1e-3 处，只取带内信噪比 ≥ 15 dB 的突发；中位数差", "≤ 0.5 dB"),
                  ("跳频点", "核心突发中心频率聚类；点数与跨度", "点数相等且跨度 ≤ 5%"),
                  ("时频图", "高出逐频点底噪 0–40 dB 的同一色标", "并排附图，不量化")]
    lines_table = ("<table><tr><th>统计量</th><th>口径与比法</th><th>「一致」的线</th></tr>"
                   + "".join(f"<tr><td>{a}</td><td>{b}</td><td>{c}</td></tr>" for a, b, c in lines_rows) + "</table>")
    toc = " · ".join(f'<a href="#{p["id"]}">{p["id"].upper()}</a>' for p in doc["pairs"])
    page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>真实感对照报告</title><style>{CSS}</style></head><body><main>
<h1>生成 IQ 与公开实测数据的真实感对照</h1>
<div class="meta">{REPORT_VERSION} · {REPORT_DATE} · 全部数字为原型阶段验证值</div>

<h2>1. 这份报告回答什么</h2>
<p>本方生成的无人机信号 IQ，在频谱仪式的统计量上与真实采集的数据差多少。我们用<strong>同一套测量程序</strong>分别量本方的合成段与两个公开数据集里同类机型的实测数据，逐项给出数、差与判定。判定线在取数之前写定；有差距的项照实列在第 7 节，没有为凑近实测去调模型参数。</p>
<p class="note">「像不像」只是可信性的一半。另一半是「模型有没有按公式算对」，由黄金基准、解析锚点与标准算例证明，见交付包的实现验证摘要。</p>

<h2>2. 一页结论</h2>
{section_summary(doc)}

<h2>3. 方法</h2>
<h3>3.1 同一套测量程序</h3>
<ul>
<li>两侧用同一个测量程序：1024 点汉宁窗时频图，按约 50 µs 一格平滑，以逐频点第 10 百分位为底噪，高出 6 dB 的格算占用；占用格连成分量后在原始样点上精化出逐突发的时长（能量等效）、99% 占用带宽、−10 / −3 dB 宽度、谱平坦度、带内信噪比与峰均比。</li>
<li>块长两侧相同：DroneRFb 的配对 50 ms 一块，DroneRFa 的配对 0.1 s 一块；合成段按同样的块长切开，间隔只在块内算。</li>
<li>遥控与上行突发按同一个角色窗认出，三列共用；角色窗取自训练部分，不在验收集上重认。</li>
<li>DroneRFb 只取视距片。合成段是单源、定点悬停、视距，接收配置与实测相同；信噪比目标取训练部分同组视距突发信噪比的中位数。</li>
<li>合成段的链路与交付数据的视距段相同：平坦莱斯衰落（K 9 dB）、本振相位噪声、发射机载频偏差、按实测量得的接收机 IQ 不平衡与直流。</li>
</ul>
<h3>3.2 判定线</h3>
{lines_table}
<p class="sub">另报每个分布类统计量的 KS 距离与样本数；−3 dB 宽度、带内信噪比、每秒突发数与占空只报数，不判。</p>
<h3>3.3 对照的独立性</h3>
<p>预设里有一部分时序参数是从同一批公开数据的<strong>训练部分</strong>提取的。拿训练部分去比，只能说明提取闭合。故主列取<strong>验收集</strong>：数据入库时即冻结、从未用于提取参数或调门限的那部分实测片段。训练部分并列作参照，两部分实测之间的差可以当作「实测自身的散布」来读。</p>

<h2>4. 逐对结果</h2>
<p class="toc">{toc}</p>
{pairs_html}

<h2>5. 图传谱平坦度的归因</h2>
<p>只对 P1 另跑了几种合成配置，看谱平坦度对什么敏感。这些变体只用来解释差距，不改预设，也不改交付数据的配置。抽头延迟线的五档取自 IEEE 802.11n 信道模型 B–F（均方根时延扩展 15 / 30 / 50 / 100 / 150 ns，视距 K 0 / 0 / 3 / 6 / 6 dB），只借这两个数，簇结构不照搬。</p>
{variants_section(doc, figs)}

<h2>6. 结构自检（无实测对照）</h2>
<p>DJI 图传 10 MHz 档与 DroneID 在本地的实测数据里没有同型对照：在 DroneRFb 训练部分 2177 片里按「宽 6.5–11.5 MHz、长 0.35–1.0 ms」粗筛，候选集中在 WiFi 信道上，背景片里也有，DroneID 信道上没有成群的候选。这两项只用同一测量程序量合成段，对出处的数（相对差 ≤ 5% 记一致）。</p>
{selfcheck_section(doc, figs)}

<h2>7. 已知限制</h2>
{limits_section(doc)}

<h2>8. 附录</h2>
<h3>8.1 样本清单</h3>
{samples_section(doc)}
<h3>8.2 出处</h3>
<table><tr><th>简称</th><th>出处</th></tr>
<tr><td>DroneRFb</td><td>DroneRFb-DIR 数据集，电子与信息学报，doi 10.11999/JEIT240804；80 MS/s @ 2.44 GHz，每片 50 ms，六型 DJI 无人机，距接收机 10 m，视距 / 非视距</td></tr>
<tr><td>DroneRFa</td><td>虞宁宁 等，电子与信息学报 46(4):1147–1156，2024，doi 10.11999/JEIT230570；100 MS/s，双通道</td></tr>
<tr><td>NDSS 2023</td><td>N. Schiller 等，Drone Security and the Mysterious Case of DJI's DroneID，NDSS 2023，§III-B</td></tr>
<tr><td>IEEE 802.11n 信道模型</td><td>IEEE 802.11-03/940r4，TGn Channel Models；视距 K 取 TGac 信道模型附录的目标值</td></tr>
</table>
<p class="sub">合成段的生成配置（接收配置、信噪比目标、随机种子、衰落与非理想参数）随数据集一起留档，同一配置可逐字节复现。</p>
</main></body></html>
"""
    page = page.replace("<table>", '<div class="scroll"><table>').replace("</table>", "</table></div>")
    os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
    with open(OUT_HTML, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(page)
    return OUT_HTML
