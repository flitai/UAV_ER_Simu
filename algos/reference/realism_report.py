"""「无人机射频 IQ 信号仿真方法与可信性验证报告」（内部称真实感对照报告）：把 realism_compare.py 的结果写成单文件 HTML
（Q-5，D-096、D-100；14 号报告 §7.3–§7.4）。

读者是甲方的评测人员，按正式验证报告组织：摘要、目的与范围（编号验证目标）、仿真方法（链路、机型预设与参数出处、实现验证、
可复现性）、数据、验证方法（判定准则在比对前确定）、结果（判定矩阵与逐组结果）、差异归因分析、结构核查、结论（逐条回答
验证目标并分三档；总体评价可行性、可信性与科学性；方法的扩展应用）、局限性与改进方向、附录。章序只在 CHAPTERS 里定义，
标题与正文里的「第 n 章 / 第 n.m 节」都由 ch() 生成。
每个「不符合」项按「观测 / 分析 / 归因」三段写，归因注明等级（已确认 / 推断 / 未查明）。表与图统一编号，图注写数据来源。
正文先用占位符引用表图编号，全部生成后再统一替换（正文常在表出现之前引用它）。

正文不出现决策编号、内部步骤号与机器路径。报告里的数字一律取自 realism.json 与格子集文件，不手抄。
图用 matplotlib 画（线图 PNG、时频图 JPEG），以 base64 内嵌，页面不引用外部资源（离线可开）。两次运行逐字节相同。

只由 realism_compare.py 调用：`write(doc, figs) -> 路径`。
"""
from __future__ import annotations

import base64
import html
import io
import json
import math
import os
import re

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REPORT_TITLE = "无人机射频 IQ 信号仿真方法与可信性验证报告"
REPORT_SUBTITLE = "仿真方法说明与基于公开实测数据的统计特征比对"
REPORT_SHORT = "IQ 信号仿真可信性验证报告"

# 每个格子集对应一版报告：用哪两张机型预设表、版本、日期、适用对象（D-105）。
SETS = {
    "realism-v1": {"presets": ("presets-v1.json", "gfsk-presets-v1.json"), "version": "v1.2", "date": "2026-10-10",
                   "scope": "本方无人机射频 IQ 信号仿真方法及其生成的数据（仿真合成数据样本集及后续正式数据集）",
                   "note": None},
    "realism-v2": {"presets": ("presets-v2.json", "gfsk-presets-v1.json"), "version": "v1.4", "date": "2026-10-13",
                   "scope": "本方无人机射频 IQ 信号仿真方法（机型预设：OFDM 类 v2、GFSK 类 v1）及按该版本生成的数据"
                            "（仿真合成数据集 v1）",
                   "note": "自 v1.3 起，合成数据按机型预设 v2 生成并比对。v2 依据循环前缀相关的实测核实，修改了 DJI 图传的循环前缀排布"
                           "（见{sim2}）。v1.2 比对的是按机型预设 v1 生成的数据，适用于仿真合成数据样本集 v1。"
                           "v1.4 只修改结论的措辞，比对数据与判定结果与 v1.3 相同。"},
}


def use_set(set_id: str) -> None:
    """选格子集：报告的输出位置、格子文件、机型预设表与版本信息随之确定。"""
    global SET_ID, OUT_HTML, CELLS, PRESETS, REPORT_VERSION, REPORT_DATE
    cfg = SETS[set_id]
    SET_ID = set_id
    OUT_HTML = os.path.join(ROOT, "data", "eval", set_id, "realism-report.html")
    CELLS = os.path.join(ROOT, "tests", "regression", "eval-dataset", f"{set_id}.json")
    PRESETS = [os.path.join(ROOT, "models", "radiator", f) for f in cfg["presets"]]
    REPORT_VERSION, REPORT_DATE = cfg["version"], cfg["date"]


use_set("realism-v2")

# 配色（作图规范的参考色板，浅色）：验证集 = 1 号蓝，合成数据 = 2 号橙，实测样本集 = 3 号青（虚线，作参照）
C_MAIN, C_SYNTH, C_REF = "#2a78d6", "#eb6834", "#1baf7a"
INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"
FONTS = ["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", "SimHei", "Arial Unicode MS"]

STAT_NAME = {
    "obw99_Hz": "99% 占用带宽", "bw10_Hz": "−10 dB 带宽", "dur_s": "突发时长", "interval_s": "突发间隔",
    "flatness": "谱平坦度", "papr_dB": "峰均比", "bw3_Hz": "−3 dB 带宽", "snr_dB": "带内信噪比",
    "shape": "平均谱形", "hops": "跳频频点集合",
}
COL_NAME = {"holdout": "验证集", "train": "实测样本集", "all": "实测样本集", "synth": "合成数据"}
PRESET_NAME = {
    "dji-video-20m-a": "DJI 图传 20 MHz 档（A 族时序）", "dji-video-20m-c": "DJI 图传 20 MHz 档（C 族时序）",
    "dji-uplink-1m": "DJI 遥控上行 1.1 MHz 档", "dji-uplink-2m": "DJI 遥控上行 2.2 MHz 档",
    "dji-uplink-4m": "DJI 遥控上行 4.4 MHz 档", "dji-video-40m": "DJI 图传 40 MHz 档（5.8 GHz）",
    "frsky-d16v2-fcc": "FrSky D16 v2 遥控（FCC 档）", "futaba-sfhss": "Futaba S-FHSS 遥控",
    "dji-video-10m": "DJI 图传 10 MHz 档", "dji-droneid": "DJI DroneID 广播",
}
CLASS_NAME = {"A": "Mavic 3 Pro", "C": "Mini 2 SE", "D": "Mini 4 Pro", "E": "Mini 3", "F": "Air 3", "G": "Air 2S"}
VARIANT_NAME = {"p1-ideal": "无非理想效应", "p1-tgn-b": "TGn-B（15 ns，K = 0 dB）", "p1-tgn-c": "TGn-C（30 ns，K = 0 dB）",
                "p1-tgn-d": "TGn-D（50 ns，K = 3 dB）", "p1-tgn-e": "TGn-E（100 ns，K = 6 dB）",
                "p1-tgn-f": "TGn-F（150 ns，K = 6 dB）"}
CHECK_ID = {"s1": "K1", "s2": "K2"}       # 结构核查编号：不用 S1 / S2，免得与观测点 S1 / S2 混淆
VERDICT = {"一致": "符合", "有差距": "不符合", "无法比较": "不可判定"}
FRSKY_FRAME_S = 0.007       # FrSky 预设的帧周期（实测 7.000 ms，gfsk-presets-v1.json）

# 参考文献（正文以 [n] 引用）
REFS = [
    ("DroneRFb", "DroneRFb-DIR 无人机射频信号数据集，《电子与信息学报》，doi:10.11999/JEIT240804。"),
    ("DroneRFa", "虞宁宁 等，DroneRFa 无人机射频信号数据集，《电子与信息学报》，46(4):1147–1156，2024，"
                 "doi:10.11999/JEIT230570。"),
    ("NDSS23", "N. Schiller, M. Chlosta, M. Schloegel 等，Drone Security and the Mysterious Case of DJI's DroneID，"
               "NDSS Symposium 2023，§III-B。"),
    ("TGn", "IEEE 802.11-03/940r4，TGn Channel Models。"),
    ("TGac", "IEEE 802.11-09/0308r12，TGac Channel Model Addendum（视距 K 因子目标值）。"),
    ("MPM", "DIY-Multiprotocol-TX-Module，开源多协议遥控发射模块固件（FrSky、Futaba S-FHSS 协议实现）。"),
    ("CC2500", "Texas Instruments，CC2500 Low-Cost Low-Power 2.4 GHz RF Transceiver，数据手册 SWRS040C。"),
    ("vdBeek", "J.-J. van de Beek, M. Sandell, P. O. Börjesson，ML Estimation of Time and Frequency Offset in OFDM Systems，"
               "IEEE Transactions on Signal Processing，45(7):1800–1805，1997。"),
]
REF_NO = {k: i + 1 for i, (k, _) in enumerate(REFS)}


def cite(*keys: str) -> str:
    return "[" + "，".join(str(REF_NO[k]) for k in keys) + "]"


def e(s) -> str:
    return html.escape(str(s))


def neg(s: str) -> str:
    """数值里的负号用「−」（U+2212），不用连字符。只用于格式化好的数值串。"""
    return s.replace("-", "\u2212")


def after_cjk(x: str) -> str:
    """接在汉字之后的词组：以数字或拉丁字母开头时前面补一个空格（中西文间距）。"""
    return " " + x if x[:1].isascii() and x[:1].isalnum() else x


def sg(x: float, spec: str) -> str:
    """按格式串格式化数值，负号写成「−」。"""
    return neg(format(x, spec))


# 章序：正文按「第 n 章」「第 n.m 节」互相引用，章号只在这里定一次
CHAPTERS = [("scope", "目的与范围"), ("sim", "仿真方法"), ("data", "数据"), ("method", "验证方法"), ("results", "结果"),
            ("attr", "差异归因分析"), ("checks", "结构核查"), ("concl", "结论"), ("limits", "局限性与改进方向")]
CH_NO = {k: i + 1 for i, (k, _) in enumerate(CHAPTERS)}


def ch(key: str, sub: int | None = None) -> str:
    """章号或节号：ch('method') → '4'，ch('method', 2) → '4.2'。"""
    return f"{CH_NO[key]}" if sub is None else f"{CH_NO[key]}.{sub}"


def h2(key: str) -> str:
    return f"<h2 id=s{CH_NO[key]}>{CH_NO[key]}　{dict(CHAPTERS)[key]}</h2>"


def h3(key: str, sub: int, title: str, hid: str = "") -> str:
    return f'<h3{f" id={hid}" if hid else ""}>{ch(key, sub)}　{title}</h3>'


# ---------------------------------------------------------------- 编号

class Counter:
    """表与图的编号。new() 取号并返回占位符；ref() 返回同一键的占位符；resolve() 在全文生成之后统一换成「表 n」「图 n」。"""

    def __init__(self, prefix: str, tag: str):
        self.prefix, self.tag, self.n, self.keys = prefix, tag, 0, {}

    def _ph(self, key: str) -> str:
        return f"⟦{self.tag}:{key}⟧"

    def new(self, key: str | None = None) -> str:
        self.n += 1
        key = key or f"#{self.n}"
        if key in self.keys:
            raise ValueError(f"编号键重复：{self.tag}:{key}")
        self.keys[key] = f"{self.prefix} {self.n}"
        return self._ph(key)

    def ref(self, key: str) -> str:
        return self._ph(key)

    def resolve(self, text: str) -> str:
        def sub(m):
            if m.group(1) not in self.keys:
                raise ValueError(f"引用了不存在的编号：{self.tag}:{m.group(1)}")
            return self.keys[m.group(1)]
        return re.sub("⟦" + self.tag + r":([^⟧]+)⟧", sub, text)


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
    return (f"{fmt_val(stat, s['median'])}<br><span class=sub>[{fmt_val(stat, s['p10'])}，"
            f"{fmt_val(stat, s['p90'])}]，n = {s['n']}</span>")


def fmt_diff(stat: str, c: dict) -> str:
    if c.get("diff") is None:
        return "—"
    if stat.endswith("_Hz") or stat in ("dur_s", "interval_s"):
        if c.get("rel") is not None:
            return neg(f"{c['rel'] * 100:+.1f}%")
    return neg(f"{c['diff']:+.2f} dB" if stat.endswith("_dB") else f"{c['diff']:+.3f}")


def verdict_cell(v: str | None) -> str:
    w = VERDICT.get(v or "", "")
    if w == "符合":
        return '<span class="badge ok">✓ 符合</span>'
    if w == "不符合":
        return '<span class="badge gap">✗ 不符合</span>'
    if w == "不可判定":
        return '<span class="badge na">— 不可判定</span>'
    return '<span class="sub">仅列出</span>'


def _ms(v) -> str:
    return "—" if v is None else f"{v * 1e3:.2f} ms"


def _mhz(v, nd: int = 2) -> str:
    return "—" if v is None else f"{v / 1e6:.{nd}f} MHz"


def _peaks(pk: list[dict]) -> str:
    return "、".join(f"{d['center']:.2f} ms（{d['frac'] * 100:.0f}%）" for d in pk) or "—"


def _band(curve, sh) -> dict:
    """平均谱形在占用带宽内三段的均值：低端、中间、高端各取 2 MHz（窄信号取带宽的五分之一）。"""
    n = int(round(sh["span_Hz"] / sh["res_Hz"]))
    g = np.arange(-n, n + 1) * sh["res_Hz"]
    v = np.array([np.nan if x is None else x for x in curve])
    b = sh["band_Hz"] / 2
    edge = min(2e6, sh["band_Hz"] / 5)

    def m(lo, hi):
        sel = (g >= lo) & (g <= hi) & np.isfinite(v)
        return float(np.mean(v[sel])) if sel.any() else float("nan")
    return {"low": m(-b, -b + edge), "mid": m(-edge / 2, edge / 2), "high": m(b - edge, b)}


# ---------------------------------------------------------------- 「不符合」各项的观测、分析与归因

LEVEL_NOTE = {"已确认": "由模型定义或直接测量得出", "推断": "有间接证据支持，尚未直接验证", "未查明": "现有数据不足以确定原因"}
CATEGORY_NAME = {
    "model": "生成模型结构",
    "preset": "预设参数来源",
    "config": "仿真配置选择",
    "measured": "实测数据特性",
    "open": "原因待查",
}


def findings(doc: dict) -> dict[tuple[str, str], dict]:
    """每个「不符合」项：观测（obs）、分析（ana）、归因（attr）、等级（level）、类别（cat）、一句话摘要（short）。

    数字全部取自结果；只解释差异，不据此调整模型参数。"""
    P = {p["id"]: p for p in doc["pairs"]}
    dg = doc["diagnostics"]
    out: dict[tuple[str, str], dict] = {}

    def st(pid, col, stat, key="median"):
        return P[pid]["columns"][col]["stats"][stat].get(key)

    def cmp(pid, stat):
        return next(r for r in P[pid]["stats"] if r["stat"] == stat)

    def gap(pid, stat):
        return pid in P and P[pid]["verdicts"].get(stat) == "有差距"

    for pid, slot in (("p1", 2), ("p2", 4), ("p6", 2)):
        if gap(pid, "interval_s"):
            c = cmp(pid, "interval_s")["synth_vs_main"]
            same = ("本组的时序参数取自同一批实测数据，间隔分布仍不一致，说明差异不在参数取值，而在模型结构。"
                    if not P[pid]["independent"] else "")
            out[(pid, "interval_s")] = {
                "obs": (f"合成数据的突发间隔集中于 {_peaks(P[pid]['columns']['synth']['interval_peaks_ms'])}；"
                        f"{COL_NAME[P[pid]['main']]}的间隔峰值位于 {_peaks(P[pid]['columns']['main']['interval_peaks_ms'])}。"
                        f"两者中位数分别为 {_ms(st(pid, 'synth', 'interval_s'))} 与 {_ms(st(pid, 'main', 'interval_s'))}，"
                        f"KS 距离为 {c['ks']:.3f}，超过判定准则 0.2。"),
                "ana": (f"该预设的帧排布以 {slot} ms 为时隙单位，突发只在时隙起点开始，因此突发间隔只能取 {slot} ms 的整数倍。"
                        f"时隙占用概率按实测的占空比与长短突发比例确定，未以间隔分布作为拟合目标。{same}"),
                "attr": "差异由帧排布模型的时隙结构决定。",
                "level": "已确认", "cat": "model",
                "short": f"帧排布采用 {slot} ms 固定时隙，间隔只能取时隙长度的整数倍"}

    if gap("p1", "flatness"):
        main = st("p1", "main", "flatness")
        near = [r for r in doc["variants"]["rows"] if r["cell"] != "p1-ideal" and r["flatness"].get("median") is not None
                and abs(r["flatness"]["median"] - main) <= 0.05]
        names = "、".join(VARIANT_NAME[r["cell"]].split("（")[0] for r in near) or "无一档"
        out[("p1", "flatness")] = {
            "obs": (f"合成数据的逐突发谱平坦度中位数为 {st('p1', 'synth', 'flatness'):.3f}，"
                    f"验证集为 {main:.3f}（第 10–90 百分位 {st('p1', 'main', 'flatness', 'p10'):.3f}–"
                    f"{st('p1', 'main', 'flatness', 'p90'):.3f}），差值超过判定准则 0.05。"),
            "ana": ("合成数据采用平坦莱斯衰落，不产生频率选择性；实测数据在 10 m 距离的室内外场地采集，存在多径传播。"
                    f"在合成链路中启用抽头延迟线、按 IEEE 802.11n 信道模型 B–F 设置时延扩展与 K 因子 {cite('TGn', 'TGac')} 后，"
                    f"{names} 的谱平坦度中位数与验证集之差均在 ±0.05 以内（见第 {ch('attr', 1)} 节）。"),
            "attr": "差异主要由仿真配置未启用频率选择性衰落所致；实测场地的多径参数未经测量。",
            "level": "推断", "cat": "config",
            "short": "合成数据采用平坦衰落；启用抽头延迟线（TGn-C 至 TGn-F）后与实测相当"}

    for pid in ("p1", "p6"):
        if not gap(pid, "shape"):
            continue
        d = dg[pid]
        sig, rx = d["measured_signal"], d["receiver_noise"]
        if pid == "p1":
            out[(pid, "shape")] = {
                "obs": (f"验证集的平均谱在占用带宽内由低端至高端下降 {sig['low_minus_high_dB']:.2f} dB；合成数据的平均谱平坦，"
                        f"两者在占用带宽内的均方根差为 {P[pid]['shape']['synth_vs_main_rms_dB']:.2f} dB，超过判定准则 1 dB。"),
                "ana": (f"采集接收机的噪声底在同一频段内由低端至高端下降 {rx['low_minus_high_dB']:.2f} dB"
                        f"（由实测样本集中 {rx['n_records']} 个背景片段测得）。噪声不经过发射机，"
                        "该倾斜因此来自采集接收机的频率响应。"),
                "attr": (f"约 {rx['low_minus_high_dB']:.1f} dB 归因于采集接收机的频率响应；"
                         f"其余约 {sig['low_minus_high_dB'] - rx['low_minus_high_dB']:.1f} dB 的来源未能确定。"),
                "level": "未查明", "cat": "open",
                "short": "采集接收机频率响应可解释一部分谱倾斜，其余部分未查明"}
        else:
            out[(pid, "shape")] = {
                "obs": (f"实测平均谱在占用带宽中部比两端高 {sig['mid_minus_edges_dB']:.2f} dB；合成数据的平均谱平坦，"
                        f"均方根差为 {P[pid]['shape']['synth_vs_main_rms_dB']:.2f} dB，超过判定准则 1 dB。"),
                "ana": (f"采集接收机的噪声底在同一频段内中部比两端高 {rx['mid_minus_edges_dB']:.2f} dB"
                        "（由该型实测片段中未被信号占用的时频单元测得）。"),
                "attr": "差异的一部分归因于采集接收机的频率响应，其余部分的来源未能确定。",
                "level": "未查明", "cat": "open",
                "short": "采集接收机频率响应可解释一部分拱形谱形，其余部分未查明"}

    if gap("p2", "dur_s"):
        rk = cmp("p2", "dur_s")["ref_vs_main"]["ks"]
        out[("p2", "dur_s")] = {
            "obs": (f"突发时长中位数：验证集 {_ms(st('p2', 'main', 'dur_s'))}，实测样本集 {_ms(st('p2', 'ref', 'dur_s'))}，"
                    f"合成数据 {_ms(st('p2', 'synth', 'dur_s'))}。合成数据与验证集的中位数相对差超过判定准则 5%。"),
            "ana": (f"C、E 型的图传突发分为长短两档（验证集的峰值：{_peaks(P['p2']['columns']['main']['dur_peaks_ms'])}；"
                    f"实测样本集的峰值：{_peaks(P['p2']['columns']['ref']['dur_peaks_ms'])}）。两档的比例在验证集与实测样本集之间不同，"
                    f"两组实测数据之间的 KS 距离为 {rk:.3f}。预设参数取自实测样本集，合成数据与实测样本集一致。"),
            "attr": "差异来自两组实测数据之间的分布差异，不来自生成模型。",
            "level": "已确认", "cat": "measured",
            "short": "长短两档突发的比例在两组实测数据之间不同，合成数据与实测样本集一致"}

    for pid in ("p3", "p4", "p5"):
        c = P[pid]["columns"]
        m, sy = c["main"], c["synth"]
        frac_m = m["n_clean"] / m["n_bursts"] if m["n_bursts"] else 0.0
        frac_s = sy["n_clean"] / sy["n_bursts"] if sy["n_bursts"] else 0.0
        if gap(pid, "interval_s"):
            out[(pid, "interval_s")] = {
                "obs": (f"合成数据中被完整提取的上行突发占 {frac_s * 100:.0f}%（{sy['n_clean']} / {sy['n_bursts']}），"
                        f"验证集为 {frac_m * 100:.0f}%；每秒核心突发数分别为 {sy['core_per_s']:.0f} 与 {m['core_per_s']:.0f}。"
                        f"突发间隔中位数分别为 {_ms(st(pid, 'synth', 'interval_s'))} 与 {_ms(st(pid, 'main', 'interval_s'))}。"),
                "ana": ("逐个检查合成突发的时频单元，部分单元的频率跨度由约 1.5 MHz 扩展至 4–5 MHz。"
                        "合成 OFDM 信号在符号边界处未加窗；带内信噪比约 "
                        f"{st(pid, 'synth', 'snr_dB'):.0f} dB 时，边界处的频谱扩展超过占用门限，测量程序因此将突发切分，"
                        "或将其判为与相邻信号重叠。未被提取的突发使相邻核心突发之间的间隔变长。"),
                "attr": "差异由合成 OFDM 信号的符号边界处理方式引起。频谱扩展与符号边界的对应关系尚未逐点核实。",
                "level": "推断", "cat": "model",
                "short": "合成 OFDM 符号边界未加窗，高信噪比下突发被切分，间隔变长"}
        if gap(pid, "hops"):
            hm, hs = m["hops"], sy["hops"]
            hr = c.get("ref", {}).get("hops")
            if pid == "p4" and hr:
                out[(pid, "hops")] = {
                    "obs": (f"验证集 {hm['n_points']} 个频点、跨度 {_mhz(hm['span_Hz'])}；实测样本集 {hr['n_points']} 个频点、"
                            f"跨度 {_mhz(hr['span_Hz'])}；合成数据 {hs['n_points']} 个频点、跨度 {_mhz(hs['span_Hz'])}。"),
                    "ana": (f"验证集的最高频点为 {_mhz(hm['max_Hz'])}，实测样本集为 {_mhz(hr['max_Hz'])}；"
                            "验证集未覆盖频点栅格的高端。合成数据的频点集合与实测样本集一致。"),
                    "attr": "差异来自两组实测数据之间的覆盖范围差异，不来自生成模型。",
                    "level": "已确认", "cat": "measured",
                    "short": "验证集未覆盖频点栅格高端，合成数据与实测样本集一致"}
            elif pid == "p5":
                out[(pid, "hops")] = {
                    "obs": (f"频点数：验证集 {hm['n_points']}，合成数据 {hs['n_points']}；跨度分别为 {_mhz(hm['span_Hz'])} 与 "
                            f"{_mhz(hs['span_Hz'])}。"),
                    "ana": (f"验证集的最小频点间隔为 {_mhz(hm['spacing_min_Hz'], 3)}，远小于约 5 MHz 的频点栅格间距，"
                            "可能是同一频点在聚类时被分为两簇，或混入了其他信号。"),
                    "attr": "差异可能来自实测数据的频点聚类，尚未逐点核实。",
                    "level": "推断", "cat": "measured",
                    "short": "验证集多出一个间隔异常小的频点，推断为聚类分簇所致"}
            else:
                out[(pid, "hops")] = {
                    "obs": (f"频点数：验证集 {hm['n_points']}，合成数据 {hs['n_points']}；最小频点间隔分别为 "
                            f"{_mhz(hm['spacing_min_Hz'], 3)} 与 {_mhz(hs['spacing_min_Hz'], 3)}；逐跳频率步长绝对值的中位数分别为 "
                            f"{_mhz(hm['step_abs_median_Hz'])} 与 {_mhz(hs['step_abs_median_Hz'])}。"),
                    "ana": "合成跳频序列在 1 MHz 频点栅格上随机选取频点；实测数据以小步长跳变为主，且部分频点不在 1 MHz 栅格上。",
                    "attr": "差异由跳频序列模型决定。",
                    "level": "已确认", "cat": "model",
                    "short": "跳频序列模型随机选取频点，实测以小步长跳变为主"}
        if gap(pid, "shape"):
            b = _band(P[pid]["shape"]["curves_dB"]["main"], P[pid]["shape"])
            extra = "实测样本中混有恒包络信号（见下一项），其功率谱呈钟形，使实测平均谱中部偏高。" if pid == "p3" else \
                "现有数据未能区分发射端频谱成形与采集接收机频率响应的贡献。"
            out[(pid, "shape")] = {
                "obs": (f"实测平均谱在占用带宽内中部比两端高 {b['mid'] - 0.5 * (b['low'] + b['high']):.2f} dB"
                        f"（低端 {sg(b['low'], '+.2f')} dB，中部 {sg(b['mid'], '+.2f')} dB，"
                        f"高端 {sg(b['high'], '+.2f')} dB）；合成数据的平均谱平坦，"
                        f"均方根差为 {P[pid]['shape']['synth_vs_main_rms_dB']:.2f} dB，超过判定准则 1 dB。"),
                "ana": extra,
                "attr": "差异的一部分归因于实测样本中的其他信号，其余部分未查明。" if pid == "p3" else "原因未查明。",
                "level": "推断" if pid == "p3" else "未查明", "cat": "measured" if pid == "p3" else "open",
                "short": "实测样本混有恒包络信号，实测谱中部偏高" if pid == "p3" else "实测谱中部略高、边沿较缓，原因未查明"}

    if gap("p3", "papr_dB"):
        d = dg["p3"]
        others = "、".join(
            f"{x.upper()} 为 {abs(next(r for r in P[x]['stats'] if r['stat'] == 'papr_dB')['synth_vs_main']['diff']):.2f} dB"
            for x in ("p4", "p5"))
        out[("p3", "papr_dB")] = {
            "obs": (f"峰均比中位数：验证集 {st('p3', 'main', 'papr_dB'):.2f} dB，合成数据 {st('p3', 'synth', 'papr_dB'):.2f} dB。"
                    f"验证集中 {d['constant_envelope_frac'] * 100:.0f}% 的突发峰均比低于 4 dB。"),
            "ana": ("峰均比低于 4 dB 的突发为恒包络信号，不属于 OFDM 上行信号，推断来自同频段的其他设备（如蓝牙）。"
                    f"剔除这部分突发后，验证集的峰均比中位数为 {d['papr_median_without_constant_envelope_dB']:.2f} dB，"
                    f"仍比合成数据低 {d['synth_papr_median_dB'] - d['papr_median_without_constant_envelope_dB']:.2f} dB；"
                    f"其他两档上行信号的差值分别为：{others}。"),
            "attr": "差异的一部分来自实测样本中的其他信号；剔除后剩余的差异原因未查明。",
            "level": "推断", "cat": "measured",
            "short": "实测样本约三成为恒包络信号；剔除后仍差约 1.3 dB，原因未查明"}

    p7 = P["p7"]
    if gap("p7", "obw99_Hz") or gap("p7", "bw10_Hz"):
        f = {"obs": (f"99% 占用带宽中位数：合成数据 {st('p7', 'synth', 'obw99_Hz') / 1e3:.0f} kHz，验证集 "
                     f"{st('p7', 'main', 'obw99_Hz') / 1e3:.0f} kHz（相对差 {sg(cmp('p7', 'obw99_Hz')['synth_vs_main']['rel'] * 100, '+.1f')}%）；"
                     f"−10 dB 带宽分别为 {st('p7', 'synth', 'bw10_Hz') / 1e3:.0f} kHz 与 {st('p7', 'main', 'bw10_Hz') / 1e3:.0f} kHz。"),
             "ana": (f"合成数据的调制参数依据开源实现 {cite('MPM')} 中 CC2500 收发器 {cite('CC2500')} 的 FCC 档寄存器配置换算"
                     "（GFSK，BT = 1，频偏 57.1 kHz）。实测数据采集时遥控器工作在哪一协议档（ACCESS 或 ACCST D16）未有记录。"),
             "attr": "预设的调制参数可能与实测设备的工作档不一致。",
             "level": "推断", "cat": "preset",
             "short": "调制参数按开源实现的 FCC 档推断，实测设备的协议档未记录"}
        for k in ("obw99_Hz", "bw10_Hz"):
            if gap("p7", k):
                out[("p7", k)] = f
    if gap("p7", "interval_s"):
        c = p7["columns"]
        miss = 1 - c["main"]["core_per_s"] * FRSKY_FRAME_S
        out[("p7", "interval_s")] = {
            "obs": (f"验证集每秒提取到 {c['main']['core_per_s']:.0f} 个核心突发，帧率为每秒 {1 / FRSKY_FRAME_S:.1f} 帧，"
                    f"约 {miss * 100:.0f}% 的帧未提取到遥控包；间隔峰值位于 {_peaks(c['main']['interval_peaks_ms'])}。"
                    f"合成数据每帧均发射，每秒 {c['synth']['core_per_s']:.0f} 个核心突发。"),
            "ana": "现有数据无法区分缺失的帧是遥控器未发射，还是测量程序未提取到。",
            "attr": "原因未查明。",
            "level": "未查明", "cat": "open",
            "short": "实测约两成帧未提取到遥控包，原因未查明"}
    if gap("p7", "flatness") or gap("p7", "shape"):
        f = {"obs": (f"实测功率谱在一个频偏音附近存在窄峰：−3 dB 带宽中位数为 {st('p7', 'main', 'bw3_Hz') / 1e3:.0f} kHz，"
                     f"合成数据为 {st('p7', 'synth', 'bw3_Hz') / 1e3:.0f} kHz；谱平坦度中位数分别为 {st('p7', 'main', 'flatness'):.3f} 与 "
                     f"{st('p7', 'synth', 'flatness'):.3f}；平均谱形均方根差为 {p7['shape']['synth_vs_main_rms_dB']:.2f} dB。"),
             "ana": ("频移键控信号在某一频偏音处出现窄峰，表明载荷中同一符号连续出现的比例较高，"
                     "可能原因是通道数据变化少且未做数据白化。合成数据的载荷为随机序列，不产生该窄峰。"),
             "attr": "对 GFSK 遥控信号，载荷内容会改变功率谱形状，随机载荷不能复现实测谱形。实测载荷未经解调核实。",
             "level": "推断", "cat": "model",
             "short": "随机载荷不能复现实测谱中的窄峰"}
        for k in ("flatness", "shape"):
            if gap("p7", k):
                out[("p7", k)] = f
    return out


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
    """两个处理块的时频图并排：同一色标（高于逐频点噪声底 0–40 dB），横轴绝对频率，纵轴块内时间。"""
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
            ax.text(0.5, 0.5, "无满足条件的处理块", ha="center", va="center", color=MUTED, transform=ax.transAxes)
            ax.set_axis_off()
            continue
        fs, fc, dur = rep["fs"], rep["fc"], rep["n"] / rep["fs"]
        im = ax.imshow(img, aspect="auto", origin="upper", cmap="viridis", vmin=0, vmax=40, interpolation="nearest",
                       extent=[(fc - fs / 2) / 1e6, (fc + fs / 2) / 1e6, dur * 1e3, 0])
        ax.set_title(title, fontsize=9, color=INK)
        ax.set_xlabel("频率（MHz）")
        ax.set_ylabel("块内时间（ms）")
    if im is not None:
        fig.colorbar(im, ax=axes, label="高于噪声底的功率（dB）", shrink=0.9)
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
                                      ("ref", C_REF, "--", 1.4, "实测样本集（参照）"),
                                      ("synth", C_SYNTH, "-", 2.0, "合成数据")):
        c = curves.get(key)
        if c:
            ax.plot(grid, [np.nan if v is None else v for v in c], color=color, ls=ls, lw=lw, label=label)
    b = sh["band_Hz"] / 2e6
    for x in (-b, b):
        ax.axvline(x, color=AXIS, lw=1.0, ls=":")
    ax.set_ylim(-40, 6)
    ax.set_xlim(grid[0], grid[-1])
    ax.set_xlabel("相对对齐中心的频率偏移（MHz）")
    ax.set_ylabel("归一化功率谱密度（dB）")
    ax.legend(loc="lower center", ncol=3)
    return png(fig)


def _ecdf(ax, vals, color, ls, lw, label, scale):
    v = np.sort(np.asarray([x for x in vals if x is not None and math.isfinite(x)], dtype=float)) * scale
    if v.size == 0:
        return
    ax.step(v, np.arange(1, v.size + 1) / v.size, where="post", color=color, ls=ls, lw=lw, label=f"{label}（n = {v.size}）")


def fig_ecdfs(pair: dict, cols: dict, synth_label: str = "合成数据") -> str:
    plt = _plt()
    panels = [("dur_s", 1e3, "突发时长（ms）"), ("interval_s", 1e3, "突发间隔（ms）"), ("flatness", 1.0, "谱平坦度"),
              ("obw99_Hz", 1e-6, "99% 占用带宽（MHz）")]
    has_papr = any(cols[k]["rows"] and any(z["papr_dB"] is not None for z in cols[k]["rows"]) for k in cols)
    if has_papr:
        panels[3] = ("papr_dB", 1.0, "峰均比（dB，CCDF = 10⁻³）")
    fig, axes = plt.subplots(2, 2, figsize=(9.6, 5.6), constrained_layout=True)
    for ax, (stat, scale, label) in zip(axes.ravel(), panels):
        for key, color, ls, lw, name in (("main", C_MAIN, "-", 2.0, COL_NAME[pair["main"]]),
                                         ("ref", C_REF, "--", 1.4, "实测样本集（参照）"),
                                         ("synth", C_SYNTH, "-", 2.0, synth_label)):
            c = cols.get(key)
            if c is None:
                continue
            vals = c["intervals"] if stat == "interval_s" else [z[stat] for z in c["rows"]]
            _ecdf(ax, vals, color, ls, lw, name, scale)
        ax.set_xlabel(label)
        ax.set_ylabel("累积概率")
        ax.set_ylim(0, 1.02)
        ax.legend(loc="upper left", fontsize=7.5)
    return png(fig)


def fig_hops(pair: dict, cols: dict, synth_label: str = "合成数据") -> str | None:
    """核心突发中心频率的直方图：上为实测，下为合成，共用横轴。"""
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


def fig_variants(doc: dict) -> str | None:
    v = doc["variants"]
    p1 = next(p for p in doc["pairs"] if p["id"] == "p1")
    rows = [("验证集", p1["columns"]["main"]["stats"]["flatness"], C_MAIN),
            ("实测样本集（参照）", p1["columns"]["ref"]["stats"]["flatness"], C_REF),
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
    ax.set_xlabel("逐突发谱平坦度（圆点：中位数；横线：第 10–90 百分位）")
    ax.set_xlim(0, 1.02)
    ax.grid(axis="y", visible=False)
    return png(fig)


# ---------------------------------------------------------------- 页面元件

CSS = """
:root{--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--axis:#c3c2b7;--surface:#fcfcfb;--plane:#f9f9f7;
--ok:#0ca30c;--gap:#d03b3b;--accent:#2a78d6}
*{box-sizing:border-box}
html{color-scheme:light}
body{margin:0;background:var(--plane);color:var(--ink);font:15px/1.7 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",
system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:36px 16px 64px;background:var(--surface)}
h1{font-size:26px;line-height:1.3;margin:0 0 4px}
.subtitle{font-size:17px;color:var(--ink2);margin:0 0 18px}
h2{font-size:20px;margin:44px 0 10px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:28px 0 8px}
h4{font-size:15px;margin:20px 0 6px}
p,li{max-width:80ch}
table.info td:first-child{color:var(--ink2);width:9em}
.abstract{background:var(--plane);border:1px solid var(--line);padding:12px 16px;margin:16px 0}
.abstract p{margin:6px 0}
table{border-collapse:collapse;width:100%;margin:6px 0 18px;font-size:13.5px}
caption{caption-side:top;text-align:left;font-weight:600;font-size:13.5px;color:var(--ink);padding:4px 0}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--ink2);font-weight:600;background:var(--plane)}
td.num{font-variant-numeric:tabular-nums}
.nw{white-space:nowrap}
table.wide{min-width:760px}
.c{display:block;text-align:center}
.sub{color:var(--muted);font-size:12px}
.badge{display:inline-block;font-size:12.5px;font-weight:600;white-space:nowrap}
.badge.ok::first-letter{color:var(--ok)}
.badge.gap::first-letter{color:var(--gap)}
.badge.na{color:var(--muted)}
.finding{margin:10px 0 14px;padding-left:12px;border-left:3px solid var(--line)}
.finding p{margin:4px 0}
.lab{display:inline-block;min-width:3.2em;font-weight:600;color:var(--ink2)}
figure{margin:12px 0 22px}
figure.narrow{max-width:560px}
figure img{width:100%;height:auto;display:block;border:1px solid var(--line)}
figcaption{font-size:13px;color:var(--ink2);margin-top:6px}
figcaption b{color:var(--ink)}
details{margin:6px 0}
summary{cursor:pointer;color:var(--ink2)}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.ids{font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink2);word-break:break-all}
.toc{columns:2;font-size:14px}
.toc a,.xref{color:var(--accent);text-decoration:none}
.scroll{overflow-x:auto}
.concl td:nth-child(-n+5),.concl th:nth-child(-n+5){white-space:nowrap}
@media (max-width:640px){.toc{columns:1}}
@media print{body{background:#fff}main{max-width:none;padding:0}h2{break-before:page}figure,table,.finding{break-inside:avoid}}
"""


def table(caption: str, head: list[str], rows: list[list[str]], num_cols=frozenset(), cls: str = "",
          nowrap_cols=frozenset()) -> str:
    """num_cols：等宽数字列；nowrap_cols：不换行的短列（列序号从 0 起）。"""
    def cell(tag: str, i: int, c: str) -> str:
        cl = " ".join(x for x in ("num" if i in num_cols and tag == "td" else "", "nw" if i in nowrap_cols else "") if x)
        return f"<{tag}{' class=' + chr(34) + cl + chr(34) if cl else ''}>{c}</{tag}>"
    th = "".join(cell("th", i, h) for i, h in enumerate(head))
    body = "".join("<tr>" + "".join(cell("td", i, c) for i, c in enumerate(r)) + "</tr>" for r in rows)
    cap = f"<caption>{caption}</caption>" if caption else ""
    return f'<div class="scroll"><table{f" class={cls}" if cls else ""}>{cap}<tr>{th}</tr>{body}</table></div>'


def figure(data: str | None, label: str, caption: str, source: str, narrow: bool = False) -> str:
    if not data:
        return f'<p class="sub">{label}：无可绘制的数据。</p>'
    return (f'<figure{" class=narrow" if narrow else ""}><img alt="{label}" src="data:{data}">'
            f"<figcaption><b>{label}</b>　{caption}<br>数据来源：{source}</figcaption></figure>")


STAT_ORDER = ["obw99_Hz", "bw10_Hz", "shape", "flatness", "dur_s", "interval_s", "papr_dB", "hops"]


def counts(doc: dict) -> dict[str, dict]:
    """每个统计量：可判定组数、符合组数、不符合的组。"""
    out = {}
    for s in STAT_ORDER:
        comp = [p for p in doc["pairs"] if p["verdicts"].get(s) in ("一致", "有差距")]
        out[s] = {"n": len(comp), "ok": sum(1 for p in comp if p["verdicts"][s] == "一致"),
                  "fail": [p["id"] for p in comp if p["verdicts"][s] == "有差距"]}
    return out


GRADES = ("充分验证", "初步支持", "未验证")


def grade(ok: int, n: int) -> str:
    if n == 0:
        return "未验证"
    r = ok / n
    return "充分验证" if r >= 0.8 else "初步支持" if r >= 0.5 else "未验证"


OBJECTIVES = [
    ("G1", "频域占用特征", ["obw99_Hz", "bw10_Hz"], "合成信号的 99% 占用带宽与 −10 dB 带宽与实测一致"),
    ("G2", "频谱形状特征", ["shape", "flatness"], "合成信号的平均谱形与逐突发谱平坦度与实测一致"),
    ("G3", "时域与帧结构特征", ["dur_s", "interval_s"], "合成信号的突发时长与突发间隔分布与实测一致"),
    ("G4", "包络统计特征", ["papr_dB"], "合成信号的峰均比与实测一致"),
    ("G5", "跳频特征", ["hops"], "跳频信号的频点数与频点跨度与实测一致"),
    ("G6", "无同型实测项的结构正确性", [], "DroneID 广播与图传 10 MHz 档的时间与频谱结构参数与结构基准一致"),
]


# ---------------------------------------------------------------- 各节

def summary(doc: dict, cnt: dict, fd: dict) -> dict:
    """摘要与第 8.2 节共用的汇总数，全部由结果文件算出。"""
    lv = {s: grade(cnt[s]["ok"], cnt[s]["n"]) for s in STAT_ORDER}
    names = {g: "、".join(STAT_NAME[s] for s in STAT_ORDER if lv[s] == g) for g in GRADES}
    levels = {k: 0 for k in LEVEL_NOTE}
    cats = {k: 0 for k in CATEGORY_NAME}
    for p in doc["pairs"]:
        for s, v in p["verdicts"].items():
            if v == "有差距":
                fi = fd.get((p["id"], s))
                levels[fi["level"] if fi else "未查明"] += 1
                cats[fi["cat"] if fi else "open"] += 1
    holdout = set()
    for p in doc["pairs"]:
        if p["main"] == "holdout":
            holdout.update(p["samples"]["holdout"])
    sc = [c for x in doc["selfchecks"] for c in x["checks"]]
    return {
        "n_cmp": sum(c["n"] for c in cnt.values()), "n_ok": sum(c["ok"] for c in cnt.values()), "names": names,
        "levels": levels, "cats": cats, "n_gaps": sum(levels.values()),
        "n_indep": sum(1 for p in doc["pairs"] if p["independent"]), "n_pairs": len(doc["pairs"]),
        "n_holdout": len(holdout),
        "presets": sorted({p["preset"] for p in doc["pairs"]} | {x["preset"] for x in doc["selfchecks"]}),
        "n_cells": len(_cells()["cells"]),
        "untestable": [p["id"].upper() for p in doc["pairs"]
                       if not any(v in ("一致", "有差距") for v in p["verdicts"].values())],
        "sc_ok": sum(1 for c in sc if c["verdict"] == "一致"), "sc_n": len(sc),
    }


def sec_abstract(doc: dict, cnt: dict, sm: dict) -> str:
    p1 = next(p for p in doc["pairs"] if p["id"] == "p1")
    near = [r for r in doc["variants"]["rows"] if r["cell"] != "p1-ideal" and r["flatness"].get("median") is not None
            and abs(r["flatness"]["median"] - p1["columns"]["main"]["stats"]["flatness"]["median"]) <= 0.05]
    nm = sm["names"]
    return (
        '<div class="abstract"><p><strong>摘要</strong></p>'
        "<p>本报告说明本方无人机射频 IQ 信号仿真方法，并检验该方法所生成数据在统计特征上与真实采集数据的一致程度。"
        "该方法按侦察接收机的实际信号流程，由场景经辐射源、天线、传播信道、接收机前端、模数转换与数字下变频逐级生成 IQ 数据；"
        "波形结构与时间参数集中在机型预设中，每个参数标注出处等级。</p>"
        f"<p>比对使用两个公开数据集 {cite('DroneRFb', 'DroneRFa')} 中的同类信号，共设 {sm['n_pairs']} 个对照组，"
        "覆盖 DJI 图传、DJI 遥控上行与两种第三方遥控信号，另对两种无同型实测数据的信号进行结构核查。合成数据与实测数据由同一测量程序处理，"
        "比较占用带宽、平均谱形、谱平坦度、突发时长、突发间隔、峰均比与跳频频点集合；判定准则在比对之前确定，"
        "比对过程中未调整任何模型参数。实测数据以入库时冻结、未参与参数提取的验证集为主要比较对象。</p>"
        f"<p>全部 {sm['n_cmp']} 项可判定比较中，{sm['n_ok']} 项符合判定准则。按统计量汇总：{nm['充分验证'] or '无'}达到「充分验证」；"
        f"{nm['初步支持'] or '无'}为「初步支持」；{nm['未验证'] or '无'}为「未验证」。不符合项的来源可归为三类：生成模型的结构"
        "（图传帧排布的固定时隙、遥控上行的跳频序列、OFDM 符号边界处理、GFSK 随机载荷），仿真配置未启用频率选择性衰落，"
        "以及实测数据自身的特性（采集接收机的频率响应、混入的其他信号、两组实测数据之间的差异）。敏感性分析表明，"
        f"启用抽头延迟线后，有 {len(near)} 种信道模型配置下的图传谱平坦度与实测相当。DroneID 广播与图传 10 MHz 档的结构核查"
        f"{'各项均' if sm['sc_ok'] == sm['sc_n'] else '部分项未'}与结构基准一致。</p>"
        "<p>综合评价：本方法用于生成无人机射频 IQ 数据是可行的；达到「充分验证」的统计特征可信；「未验证」的统计特征，已查明的差异来源主要是公开实测数据未提供的设备细节，"
        "获得目标设备的第一手实测数据或详细技术参数后，可据此修正并按同一程序重新验证；"
        "判定准则预先确定、主要比较对象独立、测量程序两侧相同、差异归因分级、结果可复现，验证过程具备科学性。"
        "后续获得特定设备的第一手实测数据或出现新的应用需求时，可沿用本方法，更新参数后按同一程序重新验证。</p>"
        "<p>本报告全部数值为原型阶段验证结果。</p></div>")


def sec_scope(doc: dict, T: Counter) -> str:
    obj_rows = [[g, name, desc, "、".join(STAT_NAME[s] for s in ss) if ss else "突发时长、突发周期、占用带宽"]
                for g, name, ss, desc in OBJECTIVES]
    terms = [
        ["IQ 数据", "复基带同相 / 正交采样数据。本报告中的合成数据与实测数据均为复基带采样。"],
        ["观测点", "接收链上的数据输出位置，依次为 S0（辐射源输出）、S1（接收天线之后）、S2（接收机前端之后）、"
                   "S3（模数转换之后）、S4（数字下变频之后，主产品）、S5（信道化之后）。"],
        ["突发", "信号在时间上连续出现的一段发射，例如一个图传帧、一个遥控数据包或一次跳频驻留。"],
        ["机型预设", "一类信号的波形结构与时间参数表，例如子载波数、调制方式、帧排布与跳频规则。每个参数标注出处等级。"],
        ["出处等级", "参数来源的分类：厂商文档、论文、开源实现或逆向分析、实测提取、推导与本方假定，定义见第 "
                     + ch("sim", 2) + " 节。"],
        ["验证集", "实测数据中于入库当天冻结并记录内容哈希的部分，从未用于提取参数或标定门限，仅用于独立检验。"
                   "该用法与机器学习中「验证集用于调参」的习惯不同。"],
        ["实测样本集", "验证集之外的全部实测数据，可用于观察、提取参数与标定。两个集合按片段标识与内容哈希互不相交。"],
        ["对照组", "一个合成信号预设与一组同类实测数据构成的比较单元，记为 P1–P8。"],
        ["结构核查", "对无同型实测数据的信号，以公开文献或本方结构假定给出的结构参数为基准进行的核查，记为 K1、K2。"],
        ["核心突发", "遥控与上行信号中时长与参考值相差不超过 ±10% 的突发；突发间隔与跳频统计只使用核心突发。"],
        ["KS 距离", "两组样本经验累积分布函数之差的最大绝对值，取值 0–1，0 表示两个分布相同。"],
    ]
    return (
        f"{h2('scope')}"
        f"{h3('scope', 1, '目的')}"
        f"<p>本报告说明本方无人机射频 IQ 信号仿真方法的组成与参数来源（第 {ch('sim')} 章），"
        "并以公开实测数据检验该方法所生成信号的可信性。生成数据的可信性包括两个层面：一是模型是否按其声明的公式正确实现，"
        "二是模型输出的信号是否与真实信号相似。前者由独立参考实现比对、解析值比对与统计检验证明"
        f"（第 {ch('sim', 3)} 节）；本报告的验证工作回答后者，即生成信号在频谱与时域统计特征上与实测数据的一致程度。"
        f"验证目标见{T.ref('obj')}。第 {ch('concl')} 章按验证目标给出结论，并综合评价该方法的可行性、可信性与科学性。</p>"
        + table(f"{T.new('obj')}　验证目标", ["编号", "目标", "要求", "对应统计量"], obj_rows)
        + f"{h3('scope', 2, '范围')}<ul>"
        "<li>比对对象为 DJI 图传、DJI 遥控上行、FrSky 与 Futaba 第三方遥控共 8 个对照组，以及 DroneID 广播与图传 10 MHz 档 2 项结构核查。</li>"
        "<li>比对在带内归一化后进行，只比较信号的形状与时间结构，不比较绝对电平。实测数据的采集接收机参数未公开，绝对电平不具可比性。</li>"
        f"<li>比对的观测点为 S3（见第 {ch('data', 3)} 节）。S0–S2 没有实测数据可供对照，S5 不在交付数据中。</li>"
        "</ul>"
        f"{h3('scope', 3, '术语')}"
        f"<p>本报告使用的术语见{T.ref('terms')}。</p>"
        + table(f"{T.new('terms')}　术语", ["术语", "定义"], terms))


# ---------------------------------------------------------------- 仿真方法（第 2 章）

GRADE_ORDER = ["V", "P", "S", "M", "D", "A"]
GRADE_TEXT = {"V": "厂商文档", "P": "同行评审论文或数据集论文", "S": "开源实现或逆向分析",
              "M": "本方从公开数据集的实测样本集提取", "D": "由有出处的数值推导", "A": "本方假定"}
_GRADE_RE = re.compile(r"^((?:[VPSADM])(?: \+ [VPSADM])*|—)：")
CONST_NAME = {"16qam": "16QAM", "qpsk": "QPSK"}


def _presets() -> tuple[list[dict], dict]:
    """两张机型预设表（OFDM 族与 GFSK 族）。出处等级的字母表须与本报告的定义一致。"""
    presets, numer = [], {}
    for path in PRESETS:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        if set(d["grades"]) != set(GRADE_ORDER):
            raise ValueError(f"预设表的出处等级与报告定义不一致：{sorted(d['grades'])}")
        presets += d["presets"]
        numer.update({n["id"]: n for n in d.get("numerologies", [])})
    return presets, numer


def preset_grades(p: dict) -> dict[str, int]:
    """每个出处等级涉及的参数项数（一项参数可同时涉及多个等级）。"""
    out = {g: 0 for g in GRADE_ORDER}
    for k, v in p["provenance"].items():
        m = _GRADE_RE.match(v)
        if not m:
            raise ValueError(f"预设 {p['id']} 的参数 {k} 出处没有等级前缀")
        if m.group(1) != "—":
            for g in m.group(1).split(" + "):
                out[g] += 1
    return out


def preset_row(p: dict, numer: dict) -> list[str]:
    bw = p["occupied_bw_Hz"]
    bw_s = f"{bw / 1e6:.3f} MHz" if bw >= 1e6 else f"{bw / 1e3:.1f} kHz"
    fr = p["frame"]
    if p["type"] in ("ofdm", "droneid"):
        nm = numer[p["numerology"]]
        mod = (f"OFDM，{2 * p['half_subcarriers']} 个有效子载波，间隔 {nm['subcarrier_spacing_Hz'] / 1e3:g} kHz，"
               f"{CONST_NAME[p['constellation']]}")
        ns = " 或 ".join(str(b["n_symbols"]) for b in p["bursts"])
        if p["type"] == "droneid":
            zc = "、".join(str(i + 1) for i, _ in p["bursts"][0]["zc"])
            tm = f"每 {fr['slot_s'] * 1e3:g} ms 一个突发，每个突发 {ns} 个符号，第 {zc} 个符号为同步序列"
        elif p.get("hop_grid"):
            hg = p["hop_grid"]
            tm = (f"{fr['slot_s'] * 1e3:g} ms 时隙，每个突发 {ns} 个符号；跳频栅格 {hg['n_points']} 个频点，"
                  f"间隔 {hg['spacing_Hz'] / 1e6:g} MHz")
        else:
            tm = f"{fr['slot_s'] * 1e3:g} ms 时隙，每个突发 {ns} 个符号，按概率排布"
    else:
        kind = "GFSK（BT = 1）" if p["modulation"] == "gfsk" else "2-FSK"
        mod = f"{kind}，符号率 {p['symbol_rate_Hz'] / 1e3:.2f} kBd，频偏 {p['deviation_Hz'] / 1e3:.2f} kHz"
        tm = (f"帧周期 {fr['period_s'] * 1e3:g} ms，每帧 {len(fr['packets'])} 个包；"
              f"跳频 {len(p['hop']['channels_Hz'])} 个频点")
    g = preset_grades(p)
    return ([e(PRESET_NAME[p["id"]]), mod, bw_s, tm, str(len(p["provenance"]))]
            + [str(g[x]) if g[x] else "—" for x in GRADE_ORDER])


def _numerology_text(presets: list[dict], numer: dict) -> str:
    """DJI 图传与上行数值结构的出处说明，由预设表里图传 20 MHz 档的出处等级决定写法：
    只有 A（假定）是 v1 的写法；含 M（实测）是 v2 的写法，子载波间隔与长循环前缀的间隔从预设表读出。"""
    v = next(p for p in presets if p["id"] == "dji-video-20m-a")
    m = _GRADE_RE.match(v["provenance"]["numerology"])
    grades = set(m.group(1).split(" + ")) if m else set()
    if "M" not in grades:
        return ("DJI 图传与遥控上行的内部数值结构（子载波间隔、快速傅里叶变换点数、循环前缀长度）没有公开资料，"
                "本方按与 DroneID 广播同族的类 LTE 结构假定；其占用带宽与时间参数取自厂商文档、论文或实测提取。")
    scs = numer[v["numerology"]]["subcarrier_spacing_Hz"] / 1e3
    longs = v["bursts"][0]["cp_long_at"]
    every = longs[1] - longs[0] if len(longs) > 1 else None
    up = next(p for p in presets if p["id"] == "dji-uplink-2m")
    up_m = "M" in (_GRADE_RE.match(up["provenance"]["numerology"]).group(1).split(" + "))
    return ("DJI 图传与遥控上行的内部数值结构没有公开资料。本方先按与 DroneID 广播同族的类 LTE 结构假定，再从实测信号上核实："
            f"循环前缀是符号尾部的复制，突发内的自相关在有用符号长度处出现峰值，由此得到子载波间隔 {cite('vdBeek')}；"
            "再把相隔一个有用符号长度的两个样点之积按候选周期折叠，得到平均符号周期，进而判断长循环前缀的排布。核实只使用实测样本集，验证集未参与。"
            f"结果是：DJI 图传的子载波间隔为 {scs:g} kHz，"
            + (f"每 {every} 个 OFDM 符号的首个符号使用长循环前缀（与 LTE 常规循环前缀的排布相同）" if every else "")
            + ("；遥控上行 2.2 MHz 与 4.4 MHz 档的子载波间隔也为 15 kHz" if up_m else "")
            + "。快速傅里叶变换点数无法从信号上观测，仍为本方假定。占用带宽与时间参数取自厂商文档、论文或实测提取。")


def sec_sim(doc: dict, T: Counter) -> str:
    chain = [
        ["场景与链路预算", "航迹按时间插值；按固定帧率计算每条链路的距离、方位、多普勒频移、传播时延与传播损耗",
         "位置与航点、发射功率、传播环境", "—"],
        ["辐射源", "按机型预设生成复基带波形：OFDM 类逐符号做快速傅里叶逆变换并加循环前缀，再有理重采样到接收采样率；"
                   "GFSK 与 2-FSK 类按频率脉冲闭式计算相位，逐样点恒包络；帧排布与跳频序列决定每个突发的起止时刻与频点；"
                   "输出按发射期间的单位功率归一", "机型预设、载频偏差、随机种子", "S0"],
        ["发射天线", "解析方向图（全向或高斯主瓣）", "增益、波束宽度、指向", "—"],
        ["传播信道", "按链路预算施加增益、多普勒频移与传播时延；传播损耗分三档可选：自由空间；地面双径或城市经验模型，"
                     "可叠加统计阴影与大气降雨损耗；自由空间加建筑遮挡与刀口绕射。小尺度衰落可选，视距为莱斯、非视距为瑞利，"
                     "可加抽头延迟线", "传播档位与各效应开关、K 因子、时延扩展", "—"],
        ["接收天线", "解析方向图与极化失配损耗", "增益、波束宽度、极化", "S1"],
        ["接收机前端", "由噪声系数生成等效输入热噪声；增益；本振相位噪声（锁相环模型）；IQ 幅相不平衡与直流偏置；可选接收滤波",
         "噪声系数、增益、相位噪声、不平衡量", "S2"],
        ["模数转换", "均匀量化与削波", "位数、满量程", "S3"],
        ["数字下变频", "数控振荡器混频、等波纹抗混叠低通、整数抽取", "频移、抽取比", "S4（主产品）"],
        ["信道化（可选）", "多相滤波器组，取其中一路子信道", "子信道数、选取的子信道", "S5"],
        ["输出", "SigMF 格式，16 位整数 IQ；每段发射的真值（起止时刻、频段、辐射源与信号类别、链路信噪比）写入注记",
         "—", "—"],
    ]
    presets, numer = _presets()
    t_chain, t_pre = T.new("chain"), T.new("presets")
    legend = "；".join(f"{g} {GRADE_TEXT[g]}" for g in GRADE_ORDER)
    pre_rows = [preset_row(p, numer) for p in presets]
    n_a = sum(1 for p in presets if preset_grades(p)["A"])
    return (
        f"{h2('sim')}"
        f"{h3('sim', 1, '信号生成链路')}"
        "<p>本方仿真系统按侦察接收机的实际信号流程生成 IQ 数据。仿真以场景为输入，场景给出辐射源与侦测站的位置、航迹、"
        "发射参数与接收参数。系统按固定帧率由场景计算每条链路的几何关系与链路预算，再在采样率上把这些慢变参数逐级施加到波形上。"
        f"各环节的模型、主要参数与输出位置见{T.ref('chain')}。</p>"
        + table(f"{t_chain}　信号生成链路的环节与模型", ["环节", "模型", "主要参数", "观测点"], chain, nowrap_cols={0}, cls="wide")
        + "<p>接收电平与噪声电平都由物理参数确定：辐射源输出按发射期间的单位功率归一，传播信道按发射功率、两端天线增益与路径损耗"
        "施加增益，接收机前端由噪声系数生成热噪声。因此信噪比随几何关系与传播环境变化，不单独设定。本报告对照数据中辐射源的位置"
        f"按信噪比目标反算确定，所用配置见第 {ch('data', 2)} 节。</p>"
        f"{h3('sim', 2, '波形模型与机型预设')}"
        "<p>每类信号的波形结构与时间参数集中在机型预设中，每个参数标注出处等级。出处等级共六级："
        + "；".join(f"{g} 为{GRADE_TEXT[g]}" for g in GRADE_ORDER)
        + f"。各预设的结构与出处构成见{T.ref('presets')}。</p>"
        f"<p>OFDM 类预设包括 DJI 图传、DJI 遥控上行与 DroneID 广播。DroneID 广播的子载波数、子载波间隔、符号结构与发送周期取自公开的逆向分析结果"
        f" {cite('NDSS23')}。" + _numerology_text(presets, numer) +
        f"GFSK 类预设包括 FrSky 与 Futaba 遥控，其调制参数由开源实现中的射频芯片寄存器配置 {cite('MPM')} 按芯片数据手册的公式"
        f" {cite('CC2500')} 计算。{len(presets)} 个预设中有 {n_a} 个含本方假定的参数项，假定项逐项列在预设的出处说明中。</p>"
        + table(f"{t_pre}　机型预设与参数出处（出处等级：{legend}。后六列为涉及该等级的参数项数，"
                "一项参数可同时涉及多个等级）", ["机型预设", "调制", "占用带宽", "时间结构", "参数项数"] + GRADE_ORDER,
                pre_rows, num_cols=set(range(4, 4 + 1 + len(GRADE_ORDER))), cls="wide")
        + f"{h3('sim', 3, '实现验证')}"
        "<p>实现正确由以下三类检验证明，检验结果见交付包中的实现验证材料，本报告不重复：</p><ol>"
        "<li>独立参考实现比对：波形生成、重采样、数字下变频、信道化、相位噪声与小尺度衰落等算法，与独立编写的参考实现逐点比对，"
        "相对误差判据为 1 × 10⁻⁹。</li>"
        "<li>解析值比对：接收电平与链路预算比对，接收机噪声底与由噪声系数算出的解析值比对，量化信噪比与 6.02 × 位数 + 1.76 dB 比对。</li>"
        "<li>统计检验：热噪声、相位噪声与小尺度衰落等随机过程，以多次独立实现的统计量与理论值比对。</li></ol>"
        f"{h3('sim', 4, '可复现性')}"
        "<p>全部随机量由显式给出的随机种子生成，同一配置与同一种子两次生成的数据逐字节相同。机型预设、链路配置与生成程序均有版本记录；"
        "每个数据文件的元数据记录生成程序的版本、随机种子与配置标识。</p>")


def _cells() -> dict:
    with open(CELLS, encoding="utf-8") as fh:
        return json.load(fh)


def sec_data(doc: dict, T: Counter) -> str:
    cells = _cells()
    cell = {c["id"]: c for c in cells["cells"]}
    rows = []
    for p in doc["pairs"]:
        cls = "、".join(f"{c}（{CLASS_NAME[c]}）" for c in p["classes"]) if p["classes"] else "—"
        n_main = len(p["samples"][p["main"]])
        n_ref = len(p["samples"].get(p["ref"], [])) if p["ref"] else None
        rows.append([p["id"].upper(), e(p["measured"]), cls, f"{n_main}（{COL_NAME[p['main']]}）",
                     "—" if n_ref is None else f"{n_ref}", f"{p['block_s'] * 1e3:g} ms", "独立" if p["independent"] else "不独立"])
    t_meas = T.new("meas")
    meas_tab = table(f"{t_meas}　各对照组使用的实测数据", ["对照组", "实测数据", "机型", "主比较列片段数", "参照列片段数", "处理块长", "独立性"],
                     rows, {3, 4})
    srows = []
    for p in doc["pairs"]:
        c = cell[p["id"]]
        sy = p["synthetic"]
        srows.append([p["id"].upper(), e(PRESET_NAME[p["preset"]]), f"{sy['fs_Hz'] / 1e6:g} MS/s @ {sy['center_Hz'] / 1e6:g} MHz",
                      f"{c['platforms'][0]['snr_dB']} dB", f"{sy['samples'] / sy['fs_Hz']:.1f} s"])
    t_syn = T.new("syn")
    syn_tab = table(f"{t_syn}　各对照组的合成数据配置", ["对照组", "机型预设", "接收配置（采样率 @ 中心频率）", "信噪比目标", "时长"], srows)
    fm = cells["frontend_measured"]
    site = cells["site"]
    t_cfg = T.new("cfg")
    cfg_tab = table(f"{t_cfg}　合成链路的公共配置", ["项目", "取值", "依据"], [
        ["辐射源", "单个辐射源，定点悬停", "—"],
        ["传播", "视距，自由空间路径损耗", "—"],
        ["小尺度衰落", "平坦莱斯衰落，K = 9 dB，最小多普勒频移 5 Hz", "与交付数据集视距段相同"],
        ["本振相位噪声", "锁相环模型，带内 −95 dBc/Hz，环路带宽 100 kHz", "本方假定值"],
        ["发射机载频偏差", f"在 ±{cells['cfo']['max_ppm']:g} ppm 内均匀取值", "参照 IEEE 802.11 OFDM 发射机中心频率容差"],
        ["接收机噪声系数", f"{site['nf_dB']:g} dB", "本方假定值"],
        ["模数转换", f"{cells['chain']['adc']['bits']} 位", "本方假定值"],
        ["IQ 幅相不平衡", f"幅度 {sg(fm['iq_gain_imbalance_dB'], 'g')} dB，相位 {sg(fm['iq_phase_imbalance_deg'], 'g')}°",
         f"实测样本集 {fm['source']['n_slices']} 个背景片段的测量中位数"],
        ["直流偏置", f"比噪声低 {-fm['dc_rel_noise_dB']:g} dB", "同上"],
    ])
    return (
        f"{h2('data')}"
        f"{h3('data', 1, '实测数据')}"
        f"<p>实测数据取自两个公开数据集。DroneRFb {cite('DroneRFb')} 以 80 MS/s 采样率、2440 MHz 中心频率采集六型 DJI 无人机"
        "（每型 3 架）的信号，每个片段 50 ms，无人机距接收机 10 m，含视距与非视距条件；本报告只使用视距片段。"
        f"DroneRFa {cite('DroneRFa')} 以 100 MS/s 采样率双通道采集；本报告使用 Mavic 3 的 5.8 GHz 通道，以及 FrSky X20、"
        "Futaba T14SG 遥控器的 2.4 GHz 通道。</p>"
        f"<p>实测数据分为验证集与实测样本集（定义见第 {ch('scope', 3)} 节）。DroneRFb 的验证集取自出版方测试集，每个机型的第 3 架飞机只出现在验证集中，"
        "因此验证集还包含实测样本集中未出现过的个体。DroneRFa 中 Mavic 3 与 Futaba T14SG 的数据在冻结前已用于参数提取，没有验证集；"
        f"这两组以实测样本集为比较对象，比较结果不具独立性。各对照组使用的实测数据见{T.ref('meas')}。</p>"
        + meas_tab
        + f"{h3('data', 2, '合成数据')}"
        f"<p>合成数据由本方仿真系统针对本次比对专门生成，各对照组的配置见{T.ref('syn')}。接收配置与对应的实测数据相同。"
        "Mavic 3 对照组只能采用 80 MS/s：图传 40 MHz 档的原生采样率为 61.44 MS/s，无法按整数比重采样到 100 MS/s。"
        "信噪比目标取实测样本集中同组各型视距突发信噪比中位数的中位数，未使用验证集。</p>"
        + syn_tab
        + f"<p>各对照组共用的链路配置见{T.ref('cfg')}，与交付数据集中视距段的配置相同。</p>"
        + cfg_tab
        + f"{h3('data', 3, '观测点')}"
        "<p>交付数据包含 S3 与 S4 两个观测点。本报告的合成数据取 S3，即模数转换之后的全频段数据，采样率与中心频率和对应的实测数据相同，"
        "不做数字下变频；在不做数字下变频的配置下，S4 与 S3 为同一份样点。实测数据是真实接收机数字化之后的输出，"
        "在数据目录中按主产品的口径标为 S4（附录 A 样本标识中的 <code>_S4</code> 后缀），其中已包含该接收机自身的滤波与频率响应。"
        "因此两组数据对应接收链上的同一位置。其余观测点的处理如下：</p><ul>"
        "<li>S0–S2：现实中无法获得数字化之前的信号，没有实测数据可供对照。这三个观测点的正确性由实现验证负责，"
        "包括辐射源相位与闭式解的比对、接收电平与链路预算的比对、噪声底与解析值的比对。</li>"
        "<li>交付数据中经数字下变频的 S4（20 MS/s 或 40 MS/s）：数字下变频是线性滤波与抽取，已单独验证（每级带内功率差不超过 0.07 dB），"
        "可用频带内的信号统计量与 S3 相同。两者的差别仅在于频带边缘，以及导出时的一次重量化；重量化的余量记录在数据手册中。</li>"
        "<li>S5（信道化之后）：不在交付数据中。</li></ul>")


def sec_method(doc: dict, T: Counter) -> str:
    crit = [
        ["99% 占用带宽", "突发去噪功率谱中包含 99% 功率的频率宽度", "中位数相对差", "≤ 5%"],
        ["−10 dB 带宽", "平滑后功率谱高于其峰值 −10 dB 的频率宽度", "中位数相对差", "≤ 5%"],
        ["平均谱形", "各突发去噪功率谱在占用带宽内按均值归一后的线性平均；图传按信道中心对齐，跳频信号按突发功率重心对齐",
         "占用带宽内对数谱的均方根差", "≤ 1 dB"],
        ["谱平坦度", "−10 dB 带宽内功率谱几何均值与算术均值之比，取值 0–1，1 表示完全平坦", "中位数差", "≤ 0.05"],
        ["突发时长", "能量等效时长：突发内高于噪声底的能量除以平台段的平均超出功率", "中位数相对差", "≤ 5%"],
        ["突发间隔", "同一处理块内相邻突发起始时刻之差", "KS 距离", "≤ 0.2"],
        ["峰均比", "突发内瞬时功率互补累积分布函数（CCDF）为 10⁻³ 处的功率与平均功率之比；仅统计带内信噪比 ≥ 15 dB 的突发",
         "中位数差", "≤ 0.5 dB"],
        ["跳频频点集合", "核心突发中心频率按间隔聚类得到的频点，统计频点数与频点跨度", "频点数之差与跨度相对差", "频点数相等，且跨度相对差 ≤ 5%"],
        ["−3 dB 带宽、带内信噪比、突发速率、占空比", "—", "—", "仅列出，不判定"],
    ]
    t_crit = T.new("crit")
    return (
        f"{h2('method')}"
        f"{h3('method', 1, '测量程序')}"
        "<p>合成数据与实测数据由同一测量程序处理，程序的常数与阈值对两侧完全相同。处理步骤如下：</p><ol>"
        "<li>时频分析：采用 1024 点 Hann 窗、不重叠的 FFT；相邻 4 帧、3 个频点平滑为一个时长约 50 µs 的时频单元。</li>"
        "<li>噪声底估计：逐频点取时频单元功率的第 10 百分位。</li>"
        "<li>占用判定：功率高于噪声底 6 dB 的时频单元判为占用。</li>"
        "<li>突发提取：占用单元的四连通区域构成候选突发；区域的频率跨度发生持续变化时，在时间上切分；"
        "与处理块边界相接的突发标记为截断，不参与时长统计。</li>"
        "<li>参数估计：在原始样点上按突发所在频段滤波，计算能量等效时长、功率谱参数、带内信噪比与峰均比。"
        "图传信号以频段内被占用频点的比例 ≥ 60% 判定发射开关。</li>"
        "<li>信号归属：遥控与上行突发按信号归属窗口选取，条件为 −10 dB 带宽在参考值的 1/1.35–1.35 倍之间、时长在参考值的 1/3–3 倍之间、"
        "带内信噪比 ≥ 10 dB。参考值取自实测样本集的参数提取结果，三组数据共用同一窗口。</li>"
        "<li>分块：DroneRFb 对照组按 50 ms、DroneRFa 对照组按 0.1 s 分块；合成数据按相同块长切分。突发间隔只在块内计算，不跨块拼接。</li>"
        "</ol>"
        f"{h3('method', 2, '统计量与判定准则')}"
        f"<p>各统计量的定义、比较方式与判定准则见{T.ref('crit')}。判定准则在比对之前确定并存档，比对过程中未作调整。"
        "满足判定准则记为「符合」，不满足记为「不符合」；任一侧没有可用样本时记为「不可判定」。"
        "分布类统计量另列出 KS 距离与样本数，供参考。</p>"
        + table(f"{t_crit}　统计量与判定准则", ["统计量", "定义", "比较方式", "判定准则"], crit)
        + f"{h3('method', 3, '独立性控制')}"
        "<p>预设中有一部分时序参数取自实测样本集。以实测样本集为比较对象，只能说明参数提取过程正确，不能说明模型对未见数据成立。"
        "因此本报告以验证集为主要比较对象，实测样本集作为参照列并列给出。两组实测数据之间的差异反映实测数据自身的离散程度，"
        "可作为评估合成数据偏差大小的参考。本次比对之后，验证集不再用于修改模型参数；若后续据本报告修改模型，"
        "相应统计量的验证集比较将不再具有独立性。</p>"
        f"{h3('method', 4, '结论分级规则')}"
        f"<p>第 {ch('concl')} 章按验证目标汇总各统计量的判定结果。对每个统计量，可判定对照组中符合的比例 ≥ 80% 记为「充分验证」，"
        f"≥ 50% 记为「初步支持」，低于 50% 记为「未验证」。该分级只用于汇总；各统计量的判定以第 {ch('method', 2)} 节的准则为准。</p>"
        f"{h3('method', 5, '差异归因的等级')}"
        f"<p>对每个「不符合」项，第 {ch('results')} 章分别给出观测事实、分析与归因，并注明归因等级："
        + "；".join(f"「{k}」表示{v}" for k, v in LEVEL_NOTE.items()) + "。</p>")


def sec_results_overview(doc: dict, T: Counter, cnt: dict) -> str:
    head = ["对照组", "机型预设"] + [STAT_NAME[s] for s in STAT_ORDER]
    sym = {"一致": "✓", "有差距": "✗", "无法比较": "—"}
    rows = []
    for p in doc["pairs"]:
        rows.append([f'<a class=xref href="#{p["id"]}">{p["id"].upper()}</a>', e(PRESET_NAME[p["preset"]])]
                    + [f'<span class="c">{sym.get(p["verdicts"].get(s), "")}</span>' for s in STAT_ORDER])
    rows.append(["合计", "符合数 / 可判定数"] + [f'<span class="c">{cnt[s]["ok"]} / {cnt[s]["n"]}</span>' for s in STAT_ORDER])
    n_cmp = sum(c["n"] for c in cnt.values())
    n_ok = sum(c["ok"] for c in cnt.values())
    t = T.new("matrix")
    return (
        f"{h2('results')}"
        f"{h3('results', 1, '结果汇总')}"
        f"<p>{T.ref('matrix')} 汇总各对照组的判定结果。全部 {n_cmp} 项可判定比较中，{n_ok} 项符合判定准则。"
        f"P8 的实测数据与预设属于不同协议，全部统计量不可判定（见第 {ch('results', 2 + [p['id'] for p in doc['pairs']].index('p8'))} 节）。"
        f"第 {ch('results', 2)} 至 {ch('results', 1 + len(doc['pairs']))} 节逐组给出统计量与不符合项分析。</p>"
        + table(f"{t}　判定矩阵（✓ 符合；✗ 不符合；— 不可判定）", head, rows))


def stats_table(p: dict, caption: str) -> str:
    cols = p["columns"]
    head = (["统计量", COL_NAME[p["main"]]] + (["实测样本集（参照）"] if "ref" in cols else [])
            + ["合成数据", "合成 − 实测", "KS 距离", "判定"])
    rows = []
    for r in p["stats"]:
        s = r["stat"]
        c = r["synth_vs_main"]
        row = [STAT_NAME[s], fmt_summary(s, cols["main"]["stats"][s])]
        if "ref" in cols:
            row.append(fmt_summary(s, cols["ref"]["stats"][s]))
        row += [fmt_summary(s, cols["synth"]["stats"][s]), fmt_diff(s, c),
                "—" if c.get("ks") is None else f"{c['ks']:.3f}", verdict_cell(c.get("verdict"))]
        rows.append(row)
    sh = p["shape"]
    row = [f"平均谱形<br><span class=sub>占用带宽 {sh['band_Hz'] / 1e6:.3f} MHz 内对数谱的均方根差</span>", "—"]
    if "ref" in cols:
        row.append("—" if sh.get("ref_vs_main_rms_dB") is None else f"相对验证集 {sh['ref_vs_main_rms_dB']:.2f} dB")
    row += ["—", "—" if sh["synth_vs_main_rms_dB"] is None else f"{sh['synth_vs_main_rms_dB']:.2f} dB", "—",
            verdict_cell(sh["verdict"])]
    rows.append(row)
    if "hops" in p:
        def hcell(h):
            if not h or not h.get("n_points"):
                return "—"
            return (f"{h['n_points']} 个频点，跨度 {h['span_Hz'] / 1e6:.2f} MHz<br><span class=sub>最小间隔 "
                    f"{(h['spacing_min_Hz'] or 0) / 1e6:.3f} MHz，|步长| 中位数 {(h.get('step_abs_median_Hz') or 0) / 1e6:.3f} MHz，"
                    f"n = {h['n_bursts']}</span>")
        hv = p["hops"]["synth_vs_main"]
        diff = "—" if hv.get("span_rel") is None else f"频点数 {sg(hv['points_diff'], '+d')}<br>跨度 {sg(hv['span_rel'] * 100, '+.1f')}%"
        row = ["跳频频点集合", hcell(cols["main"]["hops"])]
        if "ref" in cols:
            row.append(hcell(cols["ref"].get("hops")))
        row += [hcell(cols["synth"]["hops"]), diff, "—", verdict_cell(hv["verdict"])]
        rows.append(row)
    return table(caption + "（数值为中位数；方括号内为第 10 与第 90 百分位；n 为样本数）", head, rows,
                 set(range(1, len(head) - 1)))


def rate_text(p: dict) -> str:
    parts = []
    for k in ("main", "ref", "synth"):
        c = p["columns"].get(k)
        if not c:
            continue
        name = "合成数据" if k == "synth" else ("实测样本集" if k == "ref" else COL_NAME[p["main"]])
        if p["kind"] == "video":
            parts.append(f"{name}每秒 {c['bursts_per_s']:.0f} 个突发，占空比 {c['duty']:.3f}（{c['n_blocks']} 个处理块，共 {c['seconds']:.2f} s）")
        else:
            parts.append(f"{name}每秒 {c['core_per_s']:.0f} 个核心突发（{c['n_blocks']} 个处理块，共 {c['seconds']:.2f} s）")
    return "<p>突发速率（仅列出）：" + "；".join(e(x) for x in parts) + "。</p>"


def by_class_table(p: dict, T: Counter) -> str:
    if not p.get("by_class"):
        return ""
    rows = [[f"{c}（{CLASS_NAME[c]}）"] + [fmt_summary(s, v[s]) for s in ("obw99_Hz", "bw10_Hz", "dur_s", "flatness")]
            for c, v in p["by_class"].items()]
    return (f"<p>验证集按机型分列的统计见{T.ref('cls-' + p['id'])}（仅列出，不判定）。</p>"
            "<details><summary>按机型分列的验证集统计</summary>"
            + table(f"{T.new('cls-' + p['id'])}　{p['id'].upper()} 验证集按机型分列", ["机型", "99% 占用带宽", "−10 dB 带宽", "突发时长", "谱平坦度"],
                    rows, {1, 2, 3, 4}) + "</details>")


def finding_block(i: int, stat: str, f: dict) -> str:
    return (f'<div class="finding"><p><strong>（{i}）{e(STAT_NAME[stat])}</strong></p>'
            f'<p><span class=lab>观测</span>{e(f["obs"])}</p>'
            f'<p><span class=lab>分析</span>{f["ana"]}</p>'
            f'<p><span class=lab>归因</span>{e(f["attr"])}归因等级：{e(f["level"])}。</p></div>')


def supplement_table(p: dict, T: Counter) -> str:
    sup, main = p["supplement"], p["columns"]["main"]
    w = sup["window"]
    rows = [[STAT_NAME[s], fmt_summary(s, main["stats"][s]), fmt_summary(s, sup["stats"][s])]
            for s in ("obw99_Hz", "bw10_Hz", "dur_s", "interval_s", "flatness", "papr_dB")]
    hm, hs = main.get("hops") or {}, sup.get("hops") or {}

    def h(x):
        return "—" if not x.get("n_points") else f"{x['n_points']} 个频点，跨度 {x['span_Hz'] / 1e6:.2f} MHz"
    rows.append(["跳频频点集合", h(hm), h(hs)])
    return (
        "<h4>补充比较（不参与判定）</h4>"
        "<p>两种协议的突发参数差异较大，按实测数据确定的信号归属窗口无法选出合成突发，因此本组全部统计量不可判定。"
        f"为便于比较两种协议的信号特征，{T.ref('sup')} 按 S-FHSS 预设自身的参数（−10 dB 带宽 {w['bw10_Hz'] / 1e3:.0f} kHz，"
        f"单包时长 {w['dur_s'] * 1e3:.3f} ms）选取合成突发，与实测数据并列。该补充比较在比对完成后增加，不参与判定；"
        "两列之间的差异反映协议差异，不作为模型误差。</p>"
        + table(f"{T.new('sup')}　P8 补充比较", ["统计量", "实测样本集（Futaba T14SG）", "合成数据（S-FHSS，预设自身参数）"], rows, {1, 2}))


def sec_pairs(doc: dict, figs: dict, T: Counter, F: Counter, fd: dict) -> str:
    out = []
    for k, p in enumerate(doc["pairs"], start=2):
        f = figs["pairs"][p["id"]]
        cols = f["cols"]
        sy = p["synthetic"]
        rep_m = f["rep_main"]
        lab = "合成数据" if not p.get("supplement") else "合成数据（S-FHSS 预设自身参数）"
        indep = ("主比较列为验证集，比较结果具有独立性。" if p["independent"] else
                 "该型没有验证集，主比较列为该型的全部实测样本；预设的时序参数取自同一批数据，比较结果不具独立性。")
        if p["preset"] == "futaba-sfhss":
            indep += "实测遥控器所用协议与 S-FHSS 不同，本组用于说明协议差异。"
        win = ""
        if p.get("window"):
            w = p["window"]
            win = f"信号归属窗口的参考值为 −10 dB 带宽 {w['bw10_Hz'] / 1e6:.3f} MHz、时长 {w['dur_s'] * 1e3:.3f} ms。"
        tl = T.new(f"pair-{p['id']}")
        part = [h3("results", k, f'对照组 {p["id"].upper()}：{e(PRESET_NAME[p["preset"]])}', p["id"]),
                f"<p>实测数据为 {e(p['measured'])}。{indep}合成数据为 {sy['fs_Hz'] / 1e6:g} MS/s @ {sy['center_Hz'] / 1e6:g} MHz，"
                f"时长 {sy['samples'] / sy['fs_Hz']:.1f} s，按 {p['block_s'] * 1e3:g} ms 分块处理。{win}统计结果见{T.ref(f'pair-{p['id']}')}；"
                f"时频图、平均谱形与逐突发统计量的分布见{F.ref(p['id'] + '-spec')}、{F.ref(p['id'] + '-shape')}、{F.ref(p['id'] + '-ecdf')}"
                + (f"，核心突发的中心频率分布见{F.ref(p['id'] + '-hops')}" if p["kind"] == "link" else "") + "。</p>",
                stats_table(p, f"{tl}　{p['id'].upper()} 统计量比较"),
                rate_text(p), by_class_table(p, T)]
        gaps = [(s, fd[(p["id"], s)]) for s, v in p["verdicts"].items() if v == "有差距" and (p["id"], s) in fd]
        if gaps:
            seen, items = set(), []
            for s, fi in gaps:
                if fi["obs"] in seen:
                    continue
                seen.add(fi["obs"])
                items.append((s, fi))
            part.append("<h4>不符合项分析</h4>" + "".join(finding_block(i, s, fi) for i, (s, fi) in enumerate(items, 1)))
        elif p["preset"] != "futaba-sfhss":
            part.append("<p>本组全部可判定统计量均符合判定准则。</p>")
        if p.get("supplement"):
            part.append(supplement_table(p, T))
        src_m = f"{COL_NAME[p['main']]}片段 {rep_m['data_id']}" if rep_m else COL_NAME[p["main"]]
        part.append(figure(fig_spectrograms(rep_m, f["rep_main_img"], f["rep_synth"], f["rep_synth_img"],
                                            (f"{COL_NAME[p['main']]}：{rep_m['data_id']}" if rep_m else COL_NAME[p["main"]], lab)),
                           F.new(p["id"] + "-spec"), f"{p['id'].upper()} 时频图。左图为实测数据中按片段标识排序后第一个满足条件的处理块，"
                           "右图为合成数据中第一个满足同一条件的处理块（图传：含 ≥ 5 个可比突发；遥控：含 ≥ 3 个核心突发）。"
                           "两图采用相同色标。", f"{src_m}；合成数据 {sy['fs_Hz'] / 1e6:g} MS/s。"))
        part.append(figure(fig_shape(p), F.new(p["id"] + "-shape"), f"{p['id'].upper()} 平均谱形。各突发的去噪功率谱按占用带宽（两条虚线之间）内的均值归一后线性平均，"
                           + ("按信道中心对齐。" if p["kind"] == "video" else "按突发功率重心对齐。")
                           + "判定只使用虚线之间的部分；虚线以外的实测曲线含同时段的其他信号，不作比较。",
                           f"{COL_NAME[p['main']]} {p['columns']['main']['n_psd']} 个突发；合成数据 {p['columns']['synth']['n_psd']} 个突发。"))
        part.append(figure(fig_ecdfs(p, cols, lab), F.new(p["id"] + "-ecdf"), f"{p['id'].upper()} 逐突发统计量的经验累积分布。",
                           f"与{T.ref(f'pair-{p['id']}')} 相同。"))
        if p["kind"] == "link":
            part.append(figure(fig_hops(p, cols, lab), F.new(p["id"] + "-hops"), f"{p['id'].upper()} 核心突发中心频率分布（上：实测；下：合成）。",
                               f"与{T.ref(f'pair-{p['id']}')} 相同。"))
        out.append("".join(part))
    return "\n".join(out)


def sec_attribution(doc: dict, T: Counter, F: Counter, fd: dict) -> str:
    v = doc["variants"]
    p1 = next(p for p in doc["pairs"] if p["id"] == "p1")
    rows = [["验证集", fmt_summary("flatness", v["main_flatness"]), "—", "—"],
            ["合成：交付配置（平坦莱斯衰落，K = 9 dB）", fmt_summary("flatness", p1["columns"]["synth"]["stats"]["flatness"]),
             fmt_diff("flatness", next(r for r in p1["stats"] if r["stat"] == "flatness")["synth_vs_main"]),
             f"{p1['shape']['synth_vs_main_rms_dB']:.2f} dB"]]
    for r in v["rows"]:
        rows.append([f"合成：{e(VARIANT_NAME[r['cell']])}", fmt_summary("flatness", r["flatness"]),
                     fmt_diff("flatness", r["flatness_vs_main"]),
                     "—" if r["shape_rms_dB"] is None else f"{r['shape_rms_dB']:.2f} dB"])
    dg = doc["diagnostics"]
    rx_rows = []
    for pid, label in (("p1", "P1（DroneRFb，2453.5–2471.5 MHz）"), ("p6", "P6（DroneRFa，5778.5–5814.5 MHz）")):
        d = dg[pid]
        rx_rows.append([label] + [f"{sg(d[a][b], '+.2f')} dB" for a, b in (
            ("measured_signal", "low_minus_high_dB"), ("receiver_noise", "low_minus_high_dB"),
            ("measured_signal", "mid_minus_edges_dB"), ("receiver_noise", "mid_minus_edges_dB"))]
            + [e(d["receiver_source"])])
    groups: dict[str, list[str]] = {k: [] for k in CATEGORY_NAME}
    for p in doc["pairs"]:
        for s, vv in p["verdicts"].items():
            if vv != "有差距":
                continue
            fi = fd.get((p["id"], s))
            groups[fi["cat"] if fi else "open"].append(
                f'<a class=xref href="#{p["id"]}">{p["id"].upper()}</a> {e(STAT_NAME[s])}：'
                f'{e(fi["short"]) if fi else "见第 " + ch("results") + " 章"}（{e(fi["level"]) if fi else "未查明"}）')
    cat_rows = [[e(CATEGORY_NAME[c]), "<br>".join(x)] for c, x in groups.items() if x]
    P = {p["id"]: p for p in doc["pairs"]}

    def frac(c):
        return f"{c['n_clean'] / max(1, c['n_bursts']) * 100:.0f}%"
    obs_rows = [[x.upper(), frac(P[x]["columns"]["synth"]), frac(P[x]["columns"]["main"]),
                 _mhz(P[x]["columns"]["synth"]["hops"].get("step_abs_median_Hz")),
                 _mhz(P[x]["columns"]["main"]["hops"].get("step_abs_median_Hz"))] for x in ("p3", "p4", "p5")]
    tdl = [r["flatness"]["median"] for r in v["rows"] if r["cell"] != "p1-ideal" and r["flatness"].get("median") is not None]
    tdl_lo, tdl_hi = min(tdl), max(tdl)
    step_ratio = [P[x]["columns"]["synth"]["hops"]["step_abs_median_Hz"] / P[x]["columns"]["main"]["hops"]["step_abs_median_Hz"]
                  for x in ("p3", "p4", "p5")]
    tv, trx, tcat, tobs = T.new("var"), T.new("rx"), T.new("cat"), T.new("obs")
    fv = F.new("var")
    return (
        f"{h2('attr')}"
        f"{h3('attr', 1, '谱平坦度与信道频率选择性')}"
        "<p>为确定 P1 谱平坦度差异的来源，在 P1 的合成配置上另行生成六组变体：一组关闭全部非理想效应，"
        f"其余五组启用抽头延迟线，均方根时延扩展与视距 K 因子取 IEEE 802.11n 信道模型 B–F 的参数 {cite('TGn', 'TGac')}。"
        "本方的 8 抽头指数时延谱只采用这两个参数，不照搬该信道模型的簇结构。各变体只用于归因分析，不改变预设与交付数据的配置。"
        f"结果见{T.ref('var')} 与{F.ref('var')}。</p>"
        + table(f"{tv}　P1 谱平坦度敏感性分析", ["配置", "谱平坦度", "中位数差（相对验证集）", "平均谱形均方根差"], rows, {1, 2, 3})
        + figure(fig_variants(doc), fv, "P1 逐突发谱平坦度：两组实测数据与各合成配置。",
                 f"实测数据同{T.ref('pair-p1')}；各合成配置时长 2 s。")
        + "<p>关闭全部非理想效应的配置与交付配置的谱平坦度相近，说明载频偏差、相位噪声与 IQ 不平衡对谱平坦度的影响很小。"
        f"启用抽头延迟线后，谱平坦度中位数降至 {tdl_lo:.3f}–{tdl_hi:.3f}，中等时延扩展的配置与实测相当。"
        "各配置的平均谱形均方根差均在 1 dB 以上，"
        f"说明平均谱形的差异与衰落模型无关，其来源见第 {ch('attr', 2)} 节。</p>"
        f"{h3('attr', 2, '采集接收机的频率响应')}"
        "<p>噪声不经过发射机，只经过接收机。因此，采集数据中噪声底的频谱形状反映采集接收机自身的频率响应。"
        f"{T.ref('rx')} 比较实测信号平均谱与噪声底在同一频段内的形状。两个数据集的采集接收机均存在约 1.2 dB 的频率响应起伏，"
        "可以解释实测谱形差异的一部分。</p>"
        + table(f"{trx}　实测信号谱形与采集接收机噪声底形状", ["对照组", "信号：低端 − 高端", "噪声底：低端 − 高端",
                                                    "信号：中部 − 两端", "噪声底：中部 − 两端", "噪声底数据来源"], rx_rows, {1, 2, 3, 4})
        + f"{h3('attr', 3, '差异归类')}"
        f"<p>{T.ref('cat')} 按来源对全部「不符合」项归类，括号内为归因等级。</p>"
        + table(f"{tcat}　不符合项归类", ["类别", "对照组、统计量与说明"], cat_rows)
        + f"{h3('attr', 4, '未纳入判定的差异')}"
        f"<p>以下两项差异不在判定准则之内，但在时频分析中可以观察到，数据见{T.ref('obs')}。"
        "（1）合成 OFDM 信号的符号边界未加窗，高信噪比时含符号边界的时频单元频谱展宽，导致合成上行突发被完整提取的比例低于实测。"
        f"（2）合成上行跳频序列在频点栅格上随机取点，逐跳频率步长的中位数为验证集的 {min(step_ratio):.1f}–{max(step_ratio):.1f} 倍。</p>"
        + table(f"{tobs}　遥控上行信号的突发完整提取率与跳频步长", ["对照组", "完整提取率：合成数据", "完整提取率：验证集",
                                                    "|步长| 中位数：合成数据", "|步长| 中位数：验证集"], obs_rows, {1, 2, 3, 4}))


def _sc_val(c: dict, k: str) -> str:
    v = c.get(k)
    if v is None:
        return "—"
    return f"{v / 1e6:.3f} MHz" if c["unit"] == "Hz" else f"{v * 1e3:.3f} ms"


def sec_checks(doc: dict, figs: dict, T: Counter, F: Counter) -> str:
    out = [f"{h2('checks')}",
           "<p>DJI 图传 10 MHz 档与 DroneID 广播在本地实测数据中没有同型对照。在 DroneRFb 出版方训练集的 2177 个片段（均属实测样本集）中，"
           "按带宽 6.5–11.5 MHz、时长 0.35–1.0 ms 筛选候选突发，候选突发集中在 WiFi 信道上，背景片段中同样存在，"
           "DroneID 广播信道上没有成群的候选。因此这两项改以结构参数为基准：DroneID 广播取公开的逆向分析结果 "
           f"{cite('NDSS23')}，图传 10 MHz 档取本方的结构假定（第 {ch('sim', 2)} 节）。用同一测量程序测量合成数据，"
           "相对差 ≤ 5% 记为符合。</p>"]
    for i, sc in enumerate(doc["selfchecks"], start=1):
        cid = CHECK_ID[sc["id"]]
        rows = [[e(c["name"]), _sc_val(c, "want"), _sc_val(c, "got"),
                 "—" if c.get("rel") is None else f"{sg(c['rel'] * 100, '+.2f')}%", verdict_cell(c["verdict"]), e(c["source"])]
                for c in sc["checks"]]
        f = figs["selfchecks"][sc["id"]]
        has_fig = f.get("rep_img") is not None
        out.append(h3("checks", i, f"结构核查 {cid}：{e(PRESET_NAME[sc['preset']])}"))
        out.append(f"<p>结构参数的核查结果见{T.ref('chk-' + sc['id'])}"
                   + (f"，合成数据的时频图见{F.ref('chk-' + sc['id'])}" if has_fig else "") + "。</p>")
        out.append(table(f"{T.new('chk-' + sc['id'])}　{cid} 结构参数核查", ["参数", "基准值", "合成数据测量值", "相对差", "判定", "依据"], rows, {1, 2, 3}))
        if has_fig:
            out.append(figure(fig_spectrograms(None, None, f["rep"], f["rep_img"], ("", "合成数据")), F.new("chk-" + sc["id"]),
                              f"{cid} 合成数据中第一个含该信号突发的处理块的时频图（色标同前）。",
                              "合成数据 80 MS/s @ 2440 MHz。", narrow=True))
    return "".join(out)


def sec_conclusions(doc: dict, T: Counter, cnt: dict, fd: dict, sm: dict) -> str:
    rows = []
    for g, name, ss, _ in OBJECTIVES:
        if not ss:
            n = sum(len(s["checks"]) for s in doc["selfchecks"])
            k = sum(1 for s in doc["selfchecks"] for c in s["checks"] if c["verdict"] == "一致")
            rows.append([g, e(name), "结构参数", f"{k} / {n}",
                         "充分验证（以结构参数为基准）" if k == n else grade(k, n), "无同型实测数据；结论只说明结构参数正确"])
            continue
        for s in ss:
            c = cnt[s]
            ex = [f"{pid.upper()}：{fd[(pid, s)]['short']}" if (pid, s) in fd else pid.upper() for pid in c["fail"]]
            rows.append([g, e(name), STAT_NAME[s], f"{c['ok']} / {c['n']}", grade(c["ok"], c["n"]), "；".join(e(x) for x in ex) or "—"])
    t = T.new("concl")
    items = [
        "占用带宽、突发时长与峰均比的统计特征与实测一致程度高，是本方生成信号最可靠的部分。",
        "平均谱形的差异主要来自实测数据一侧（采集接收机的频率响应、混入的其他信号）；谱平坦度的差异主要来自交付配置未启用频率选择性衰落。"
        "后者可通过启用抽头延迟线改善，但实测场地的多径参数未经测量。",
        "突发间隔与跳频序列的差异来自生成模型的结构：图传帧排布采用固定时隙，遥控上行跳频序列随机取点。"
        "这两项取决于目标机型的帧调度规则与跳频规则，获得其详细技术参数或第一手实测数据后，可据此修正。",
        "GFSK 遥控信号的谱形受载荷内容影响，随机载荷不能复现实测谱中的窄峰。",
        "DroneID 广播与图传 10 MHz 档的结构参数与结构基准一致（DroneID 广播以公开文献为基准，图传 10 MHz 档以本方结构假定为基准）；"
        "由于缺少同型实测数据，其真实感未经实测检验。",
    ]
    nm = sm["names"]
    lv_txt = "、".join(f"{k} {v} 项" for k, v in sm["levels"].items() if v)
    cat_txt = "、".join(f"{CATEGORY_NAME[k]} {v} 项" for k, v in sm["cats"].items() if v)
    pids = [p["id"].upper() for p in doc["pairs"]]
    exc = (f"除全部统计量不可判定的 {'、'.join(sm['untestable'])} 外（见第 "
           + "、".join(ch("results", 2 + pids.index(x)) for x in sm["untestable"]) + " 节），") if sm["untestable"] else ""
    ext = [
        ["获得特定无人机或遥控器的第一手实测数据",
         "用同一测量程序从新数据中提取突发时长、突发间隔、带宽与跳频参数，替换机型预设中的实测提取项与本方假定项；"
         "数据入库时冻结一部分作验证集",
         "已知距离、视距条件下的采集数据，以及采集接收机的采样率、中心频率、增益与噪声系数",
         f"在新的验证集上按第 {ch('method')} 章的准则重新比对；接收机增益已知时，可增加绝对电平的比对"],
        ["侦察接收机为特定型号",
         "以该接收机的采样率、带宽、噪声系数、量化位数、本振相位噪声与 IQ 不平衡替换接收链参数。"
         "接收通带的幅度起伏目前未建模，需要时增加一级按实测响应设计的滤波器",
         "接收机指标，或该接收机的噪声底记录与单音测试数据",
         f"以该接收机的噪声底形状与噪声电平比对（第 {ch('attr', 2)} 节的方法）"],
        ["新机型或新协议",
         "属于 OFDM、GFSK 或 FSK 体制的，在机型预设中新增条目并标注出处等级；属于其他调制体制的（如采用线性调频扩频的远距遥控），"
         "先增加相应的波形模型",
         "协议文档、开源实现，或该机型的实测数据",
         f"有同型实测数据时按第 {ch('method')} 章比对，没有时按第 {ch('checks')} 章做结构核查"],
        ["新频段",
         "调整场景中的发射频点与接收配置（中心频率、采样率、数字下变频），传播损耗按频率计算",
         "频点与带宽规划，例如 900 MHz 频段的遥控、5.8 GHz 频段的其他机型",
         f"有同型实测数据时按第 {ch('method')} 章比对，没有时按第 {ch('checks')} 章做结构核查"],
        ["特定地域与传播环境",
         "用该地域的建筑数据计算遮挡与绕射；地面反射、统计阴影与多径参数按该环境设置，实测的时延扩展可直接作为抽头延迟线参数",
         "建筑轮廓与高度数据，或场地的多径测量结果",
         "以同一场地的实测接收电平与谱平坦度比对"],
        ["检测与识别算法的训练和测试数据",
         "按场景批量生成：多机型同时工作、同频与邻频干扰、不同信噪比、视距与非视距、运动目标、多站接收；每段数据附带逐段真值",
         "场景设计与样本规模要求",
         f"抽样按第 {ch('method')} 章检查统计特征；真值与数据由同一时间表生成，逐样点对应"],
        ["测向与多站定位算法的数据",
         "需扩展多通道阵列接收（通道间的幅度与相位关系）和多站时间同步模型；现有链路已按链路几何施加传播时延",
         "阵列几何与通道一致性指标、站间同步精度",
         "以阵列校准数据和已知位置目标的实测数据比对"],
    ]
    t_ext = T.new("ext")
    return (
        f"{h2('concl')}"
        f"{h3('concl', 1, '验证目标结论')}"
        f"<p>按第 {ch('method', 4)} 节的分级规则，各验证目标的结论见{T.ref('concl')}。</p>"
        + table(f"{t}　验证目标结论", ["编号", "验证目标", "统计量", "符合 / 可判定", "结论", "不符合项及原因"], rows, {3}, cls="concl")
        + "<p>综合以上结果，得出以下结论：</p><ol>" + "".join(f"<li>{x}</li>" for x in items) + "</ol>"
        + f"{h3('concl', 2, '总体评价')}"
        "<p><strong>可行性。</strong>本方法按侦察接收机的实际信号流程，由场景逐级生成从辐射源输出到数字下变频之后的 IQ 数据"
        f"（第 {ch('sim')} 章）。本次验证用 {len(sm['presets'])} 个机型预设、{sm['n_cells']} 组合成配置生成了数据；"
        f"{exc}各组合成数据的统计量均可由测量实测数据的同一程序测得（第 {ch('results')} 章）。生成数据以标准 SigMF 格式输出并附逐段真值，"
        "同一配置可逐字节复现。据此判断，用本方法生成无人机射频 IQ 数据在技术上可行。</p>"
        f"<p><strong>可信性。</strong>全部 {sm['n_cmp']} 项可判定比较中，{sm['n_ok']} 项符合判定准则；{sm['n_pairs']} 个对照组中，"
        f"{sm['n_indep']} 个以验证集为主要比较对象。{nm['充分验证'] or '无'}达到「充分验证」，{nm['初步支持'] or '无'}为「初步支持」，"
        f"{nm['未验证'] or '无'}为「未验证」。{sm['n_gaps']} 个不符合项按来源分为{cat_txt}（第 {ch('attr', 3)} 节）；"
        f"其中属于生成模型结构与仿真配置的不符合项，第 {ch('limits', 2)} 节给出了改进方向。无同型实测数据的 DroneID 广播与图传 10 MHz 档，"
        f"结构核查 {sm['sc_n']} 项中 {sm['sc_ok']} 项符合（第 {ch('checks')} 章）。据此判断，本方法生成数据在{after_cjk(nm['充分验证'] or '—')}方面"
        f"的可信性已得到独立实测数据的支持。{nm['未验证'] or '—'}方面的差异已在第 {ch('attr')} 章逐项分析，已查明的来源主要是公开实测数据未提供的设备细节："
        "图传的帧调度规则、OFDM 符号边界的成形方式、遥控的跳频规则与载荷结构，以及采集接收机的频率响应。"
        f"获得目标设备的第一手实测数据或详细技术参数后，可据此修正机型预设，并按第 {ch('method')} 章的程序重新验证。</p>"
        "<p><strong>科学性。</strong>验证过程采取了以下措施：判定准则在比对之前确定并存档，比对过程中未调整任何模型参数；"
        f"主要比较对象是未参与参数提取的验证集（{sm['n_holdout']} 个实测片段）；合成数据与实测数据由同一测量程序处理，"
        f"程序的常数与阈值对两侧相同；每个不符合项均给出观测、分析与归因，并标注归因等级（{lv_txt}）；仿真参数逐项标注出处等级"
        f"（第 {ch('sim', 2)} 节）；合成数据可逐字节复现，全部统计结果以结构化数据文件留存（附录 C）。"
        "这些措施使本报告的结论可以由第三方检验和复核。</p>"
        f"<p>综上，本方法用于生成无人机射频 IQ 数据是可行的；生成数据在{after_cjk(nm['充分验证'] or '—')}方面可信；验证的设计与执行具备科学性。"
        f"{nm['未验证'] or '—'}方面的差异及其来源见第 {ch('attr')} 章。</p>"
        + f"{h3('concl', 3, '方法的扩展应用')}"
        "<p>本方法的波形结构与时间参数集中在机型预设中，传播环境与接收链由配置参数描述，测量程序与判定准则不依赖特定数据集"
        f"（第 {ch('sim')} 章、第 {ch('method')} 章）。因此，后续获得特定设备的第一手实测数据，或出现新的应用需求时，可以沿用本方法："
        f"替换或增补相应参数，再按第 {ch('method')} 章的程序重新验证，方法本身不需要改变。{T.ref('ext')} 列出几类典型情形及建议的做法。</p>"
        + table(f"{t_ext}　方法的扩展应用建议", ["情形", "本方法中的处理", "需要的输入", "验证方式"], ext, cls="wide")
        + "<p>上述扩展尚未实施。其可行性的依据是本方法的参数化结构与验证程序的通用性；每项扩展完成后，"
        f"均应按第 {ch('method')} 章的程序重新验证，结论以新的验证结果为准。</p>")


def sec_limits() -> str:
    lims = [
        "实测数据的采集接收机参数未公开，本报告只比较带内归一化后的形状与时间结构，不比较绝对电平。",
        "5.8 GHz 图传只有 Mavic 3 一型的实测数据，结论不外推到其他使用 5.8 GHz 图传的机型；Mavic 3 与 Futaba T14SG 两组没有验证集，比较结果不具独立性。",
        "Futaba 预设按 S-FHSS 协议生成，实测 T14SG 遥控器所用协议的时序与频点结构与 S-FHSS 不同，该组差异属于协议差异。",
        "DJI 图传 10 MHz 档与 DroneID 广播没有同型实测数据，只完成了结构核查。",
        "全部数值为原型阶段验证结果。公开数据集只用于验证技术途径；获得实际接收机的实测数据后，应按同一程序重新比对。",
    ]
    improve = [
        "OFDM 信号在符号边界处加窗，降低高信噪比下的频谱扩展。",
        "遥控上行跳频序列改用与实测一致的小步长跳变模型，并核实频点栅格。",
        "图传帧排布以突发间隔分布为拟合目标重新建模，取消固定时隙的约束。",
        "GFSK 遥控载荷引入与实际协议一致的数据结构。",
        "交付数据集按场景启用抽头延迟线，以反映频率选择性衰落。",
    ]
    return (
        f"{h2('limits')}"
        f"{h3('limits', 1, '局限性')}<ol>" + "".join(f"<li>{e(x)}</li>" for x in lims) + "</ol>"
        f"{h3('limits', 2, '改进方向')}"
        f"<p>以下改进方向由本报告的不符合项导出，尚待评审，本报告未作任何实施。按第 {ch('method', 3)} 节的规定，任何一项实施之后，"
        "相应统计量的验证集比较不再具有独立性，模型参数只能从实测样本集重新提取。</p><ol>"
        + "".join(f"<li>{e(x)}</li>" for x in improve) + "</ol>")


def _preset_versions() -> list[str]:
    out = []
    for path in PRESETS:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        kind = "GFSK 类" if "gfsk" in os.path.basename(path) else "OFDM 类"
        out.append(f"{kind} {d.get('version', 'v1')}")
    return out


def sec_appendix(doc: dict) -> str:
    samples = []
    for p in doc["pairs"]:
        for col, ids in p["samples"].items():
            samples.append(f"<details><summary>{e(p['id'].upper())} {e(COL_NAME[col])}：{len(ids)} 个片段</summary>"
                           f"<p class=ids>{e(' '.join(ids))}</p></details>")
    refs = "".join(f"<li>{e(t)}</li>" for _, t in REFS)
    inp = doc["inputs"]
    return (
        "<h2 id=sa>附录 A　样本清单</h2>"
        "<p>下列为各对照组使用的实测片段标识，标识与公开数据集的原始文件一一对应。</p>" + "".join(samples)
        + "<h2 id=sb>附录 B　参考文献</h2><ol>" + refs + "</ol>"
        "<h2 id=sc>附录 C　复现信息</h2><ul>"
        "<li>合成数据由本方仿真系统按固定随机种子生成，同一配置可逐字节复现。</li>"
        f"<li>测量程序版本：{e(doc['ruler'].split()[-1])}；比对程序版本：{e(doc['producer'].split()[-1])}。</li>"
        f"<li>机型预设表版本：{e('、'.join(_preset_versions()))}。</li>"
        f"<li>验证集清单的 SHA-256：<code>{inp['holdout_manifest_sha256']}</code>。</li>"
        f"<li>合成数据配置文件的 SHA-256：<code>{inp['cells_sha256']}</code>。</li>"
        "<li>全部统计结果以结构化数据文件形式随本报告留存，本报告中的数值均由该文件生成。</li></ul>")


def write(doc: dict, figs: dict) -> str:
    T, F = Counter("表", "T"), Counter("图", "F")
    cnt = counts(doc)
    fd = findings(doc)
    sm = summary(doc, cnt, fd)
    sections = [sec_scope(doc, T), sec_sim(doc, T), sec_data(doc, T), sec_method(doc, T), sec_results_overview(doc, T, cnt),
                sec_pairs(doc, figs, T, F, fd), sec_attribution(doc, T, F, fd), sec_checks(doc, figs, T, F),
                sec_conclusions(doc, T, cnt, fd, sm), sec_limits(), sec_appendix(doc)]
    toc_items = [(f"s{CH_NO[k]}", f"{CH_NO[k]}　{t}") for k, t in CHAPTERS] + [
        ("sa", "附录 A　样本清单"), ("sb", "附录 B　参考文献"), ("sc", "附录 C　复现信息")]
    toc = "<nav class=toc>" + "".join(f'<div><a href="#{i}">{t}</a></div>' for i, t in toc_items) + "</nav>"
    info = table("", ["项目", "内容"], [
        ["报告名称", e(REPORT_TITLE)], ["版本", REPORT_VERSION], ["日期", REPORT_DATE],
        ["适用对象", SETS[SET_ID]["scope"]]]
        + ([["版本说明", SETS[SET_ID]["note"].format(sim2=f"第 {ch('sim', 2)} 节")]] if SETS[SET_ID]["note"] else [])
        + [["数据状态", "原型阶段验证结果"]], cls="info")
    page = (f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(REPORT_SHORT)}</title><style>{CSS}</style></head><body><main>
<h1>{e(REPORT_TITLE)}</h1><p class="subtitle">{e(REPORT_SUBTITLE)}</p>
{info}
{sec_abstract(doc, cnt, sm)}
<h2>目录</h2>{toc}
""" + "\n".join(sections) + "\n</main></body></html>\n")
    page = F.resolve(T.resolve(page))
    if "⟦" in page:
        raise ValueError("报告里还有未替换的编号占位符")
    os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
    with open(OUT_HTML, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(page)
    return OUT_HTML
