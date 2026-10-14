#!/usr/bin/env python3
"""《本方基准结果》生成器（Q-7，D-106）：本方检测识别链在正式集交付的 S4 上的结果。读者是甲方。

数字全部取自：
- `data/eval/<集合>/baseline.json`（`gen_eval_dataset.py baseline` 写；每段的评价指标、S4 逐字节比对、框图哈希）；
- 格子文件 `tests/regression/eval-dataset/<集合>.json`（每段的组别、传播、信噪比目标、平台的主辐射源）；
- 组件目录黄金基准 `tests/golden/component-catalog.json`（检测器与识别器的缺省参数）；
- 识别库 `models/recognition/library-v2.json`（模板、接受门限）、其校准集格子文件（段数、信噪比档）；
- 两个识别错误现象的逐段特征 `data/eval/<集合>/baseline-diagnostics.json`（`baseline_diagnostics.py` 写）。

产物两件：HTML 报告与机器可读的 JSON（`cuav-baseline-results/1`，每段一条，字段在报告附录里定义）。
正文不出现决策编号、内部步骤号、文件路径与命令；版本与哈希在附录。

用法：python3 scripts/q7/baseline_doc.py [--set formal-v1] [--out-dir <目录>]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from report_kit import Chapters, Report, e, figure, finding, mpl, num, png, table  # noqa: E402

VERSION, DATE = "v1.0", "2026-10-12"
TITLE = "本方基准结果"
SUBTITLE = "本方检测识别算法在仿真合成数据集 v1 上的结果"
MODEL_DOC = "《仿真模型与实现验证说明》v1.0"
REALISM = "《无人机射频 IQ 信号仿真方法与可信性验证报告》v1.4"

LABEL_CN = OrderedDict([("video_link", "图传"), ("rc_hopping", "跳频遥控"), ("droneid", "DroneID 广播"),
                        ("telemetry_burst", "遥测突发"), ("cw_beacon", "单音信标"), ("unknown", "未知")])
GROUP_ORDER = ["v10", "v20", "o20", "o40", "up", "frsky", "futaba"]
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#8a5cd6", "#d6a12a", "#c2417a", "#52514e"]


def rp(*p: str) -> str:
    return os.path.join(ROOT, *p)


def load(*p: str):
    with open(rp(*p), encoding="utf-8") as fh:
        return json.load(fh)


def sha256(*p: str) -> str:
    h = hashlib.sha256()
    with open(rp(*p), "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def pct(x: float | None, nd: int = 1) -> str:
    return "—" if x is None else num(100 * x, nd, "%")


def frac(a: int | None, b: int | None) -> str:
    return "—" if not b else f"{a}/{b}"


def snr_label(s) -> str:
    return num(s, 0, "dB") if s is not None else "—"


# ---------------------------------------------------------------- 数据

class Data:
    def __init__(self, set_id: str):
        self.cells = load("tests", "regression", "eval-dataset", f"{set_id}.json")
        self.base = load("data", "eval", set_id, "baseline.json")
        self.man = load("data", "eval", set_id, "dataset.manifest.json")
        self.catalog = load("tests", "golden", "component-catalog.json")
        self.lib = load("models", "recognition", "library-v2.json")
        self.calib = load("tests", "regression", "eval-dataset", "calib-v1.json")
        self.diag = load("data", "eval", set_id, "baseline-diagnostics.json")
        self.cell_by_id = {c["id"]: c for c in self.cells["cells"]}
        ids_b = [r["id"] for r in self.base["cells"]]
        if sorted(ids_b) != sorted(self.cell_by_id):
            raise SystemExit("基准结果的段与数据集的段对不上")
        if not all(r["s4_identical_to_package"] for r in self.base["cells"]):
            raise SystemExit("有段的 S4 与交付文件不同，基准结果不能对外")
        if self.base["cuav_run_sha256"] != self.man["cuav_run_sha256"]:
            raise SystemExit("基准用的引擎与生成正式集的不是同一个可执行文件")
        self.recs = []
        for r in self.base["cells"]:
            c = self.cell_by_id[r["id"]]
            self.recs.append(self.record(r, c))
        self.group_name = {}
        for c in self.cells["cells"]:
            g = c["group"]["preset_group"]
            self.group_name.setdefault(g, c["title"].split("，")[0])

    def param_default(self, comp: str, name: str):
        for c in self.catalog["components"]:
            if c["type"] == comp:
                for p in c["params"]:
                    if p["name"] == name:
                        return p.get("default")
        raise KeyError(f"{comp}.{name}")

    @staticmethod
    def record(r: dict, c: dict) -> dict:
        """一段的对外记录：只留含义在附录里定义过的字段。"""
        st = r["site"]
        fr, tf, rc, det = st["frames"], st.get("segments_tf") or {}, st.get("recognition") or {}, st["detector"]
        prim = [p["primary"] for p in c["platforms"]] if c["group"]["kind"] != "background" else []
        emitters = {}
        for eid, v in sorted((tf.get("per_emitter") or {}).items()):
            emitters[eid] = {"truth": v["truth"], "matched": v["matched"], "merged": v["merged"],
                             "detection_rate": v["pd_burst"], "primary": eid in prim}
        labels = rc.get("labels") or []
        return OrderedDict([
            ("segment", r["segment"]), ("title", c["title"]), ("kind", c["group"]["kind"]),
            ("group", c["group"]["preset_group"]), ("propagation", c["propagation"]), ("snr_target_dB", c["group"]["snr_dB"]),
            ("s4_identical_to_package", r["s4_identical_to_package"]),
            ("s4", {"sample_rate_Hz": det["sample_rate_Hz"], "detection_band_Hz": [det["f_lo_Hz"], det["f_hi_Hz"]],
                    "frame_s": det["frame_dt_s"]}),
            ("frames", {k: fr[k] for k in ("total", "truth_on", "tp", "fp", "fn", "tn", "pd", "pfa")}),
            ("bursts", {"truth": tf.get("truth"), "out_of_band": tf.get("truth_out_of_band"),
                        "partial": tf.get("truth_partial"), "segments": tf.get("segments"), "matched": tf.get("matched"),
                        "merged": tf.get("merged_truth"), "fragments": tf.get("fragments"),
                        "false_segments": tf.get("false_segments"), "detection_rate": tf.get("pd_burst"),
                        "emitters": emitters}),
            ("recognition", {"evaluated": rc.get("evaluated"), "accuracy": rc.get("accuracy"),
                             "unknown_rate": rc.get("unknown_rate"), "unmatched": rc.get("unmatched"),
                             "labels": labels, "confusion": rc.get("confusion")}),
            ("diagram_sha256", r["diagram_sha256"]),
        ])


def primary_rate(rec: dict) -> tuple[float | None, int | None, int | None]:
    """单源段主辐射源的突发检出率（配上 / 真值）。"""
    for v in rec["bursts"]["emitters"].values():
        if v["primary"]:
            return v["detection_rate"], v["matched"], v["truth"]
    return None, None, None


def correct(r: dict) -> int:
    """判对的段数：混淆矩阵对角线（不含未知）。"""
    labs, cf = r["recognition"]["labels"] or [], r["recognition"]["confusion"] or []
    return sum(cf[i][i] for i, lab in enumerate(labs) if lab != "unknown")


def merge_confusion(recs: list[dict]) -> tuple[list[str], list[list[int]]]:
    labels = []
    for r in recs:
        for lab in r["recognition"]["labels"] or []:
            if lab not in labels:
                labels.append(lab)
    order = [x for x in LABEL_CN if x in labels] + sorted(x for x in labels if x not in LABEL_CN)
    m = [[0] * len(order) for _ in order]
    for r in recs:
        labs, cf = r["recognition"]["labels"], r["recognition"]["confusion"]
        if not labs or not cf:
            continue
        for i, a in enumerate(labs):
            for j, b in enumerate(labs):
                m[order.index(a)][order.index(b)] += cf[i][j]
    return order, m


# ---------------------------------------------------------------- 作图

def fig_vs_snr(D: Data, key: str, ylabel: str) -> str:
    plt = mpl("baseline-" + key)
    fig, axes = plt.subplots(1, 2, figsize=(9.6, 3.6), sharey=True)
    for ax, prop, ttl in ((axes[0], "los", "视距"), (axes[1], "nlos", "非视距")):
        for i, g in enumerate(GROUP_ORDER):
            pts = []
            for r in D.recs:
                if r["kind"] == "single" and r["group"] == g and r["propagation"] == prop:
                    y = primary_rate(r)[0] if key == "det" else r["recognition"]["accuracy"]
                    if y is not None:
                        pts.append((r["snr_target_dB"], 100 * y))
            pts.sort()
            if pts:
                ax.plot([p[0] for p in pts], [p[1] for p in pts], marker="o", ms=3.5, lw=1.4, color=PALETTE[i],
                        label=D.group_name[g])
        ax.set_title(ttl, fontsize=10)
        ax.set_xlabel("信噪比目标（dB）")
        ax.set_xticks([-5, 0, 5, 10, 20, 30])
        ax.set_ylim(-3, 103)
    axes[0].set_ylabel(ylabel)
    h, lab = axes[0].get_legend_handles_labels()
    fig.legend(h, lab, loc="lower center", ncol=4, fontsize=8, bbox_to_anchor=(0.5, -0.02))
    fig.tight_layout(rect=(0, 0.12, 1, 1))
    return png(fig)


# ---------------------------------------------------------------- 识别错误的三种情形（数字全部取自结果文件）

VIDEO_GROUPS = ("v10", "v20", "o20", "o40")


def video_to_hopping(single: list[dict], lo: bool) -> tuple[int, int]:
    """图传单源段中，参与识别的图传段与其中判为跳频遥控的段（lo：信噪比目标 ≤ 5 dB，否则 ≥ 10 dB）。"""
    n = k = 0
    for r in single:
        if r["group"] not in VIDEO_GROUPS or (r["snr_target_dB"] <= 5) != lo:
            continue
        labs, cf = r["recognition"]["labels"] or [], r["recognition"]["confusion"] or []
        if "video_link" not in labs:
            continue
        i = labs.index("video_link")
        n += sum(cf[i])
        if "rc_hopping" in labs:
            k += cf[i][labs.index("rc_hopping")]
    return k, n


def findings_html(D, single: list[dict], multi: list[dict], T, C) -> str:
    dv, dd = D.diag["video_low_snr"], D.diag["droneid"]
    k_lo, n_lo = video_to_hopping(single, True)
    k_hi, n_hi = video_to_hopping(single, False)
    g = {x["label"]: x for x in dv["groups"]}
    gh, gv = g["rc_hopping"], g["video_link"]
    iv, iu = dv["template_intervals"]["ofdm_video"], dv["template_intervals"]["ofdm_uplink"]
    b = dv["bursts"]
    mhz = lambda x: num(x / 1e6, 2, "MHz")            # noqa: E731
    f1 = finding(
        "低信噪比下图传被识别为跳频遥控",
        f"图传单源段中，信噪比目标不高于 5 dB 时，参与识别的 {n_lo} 个图传段有 {k_lo} 个判为跳频遥控；"
        f"不低于 10 dB 时为 {k_hi}/{n_hi}。",
        f"以 {dv['segment']} 为例：{b['truth']} 次图传突发全部检出，检测器另产生 {b['fragments']} 个碎片段。"
        f"持续时间不短于 {num(dv['long_segment_min_s'] * 1e3, 1, 'ms')} 的检测段中，判为跳频遥控的 {gh['segments']} 段与上一段的频率差"
        f"中位数为 {mhz(gh['hop_from_prev_abs_Hz']['median'])}（10%–90% 分位 {mhz(gh['hop_from_prev_abs_Hz']['p10'])}–"
        f"{mhz(gh['hop_from_prev_abs_Hz']['p90'])}），落在图传模板区间（{num(iv['hop_from_prev_Hz'][0] / 1e3, 1)}–"
        f"{num(iv['hop_from_prev_Hz'][1] / 1e3, 0, 'kHz')}）内的有 {gh['hop_in_video_interval']} 段，落在遥控上行模板区间内的有 "
        f"{gh['hop_in_uplink_interval']} 段；判为图传的 {gv['segments']} 段，频率差中位数为 {mhz(gv['hop_from_prev_abs_Hz']['median'])}。"
        f"判为跳频遥控的段，占用带宽中位数为 {mhz(gh['bandwidth_Hz']['median'])}，判为图传的段为 {mhz(gv['bandwidth_Hz']['median'])}。",
        "低信噪比下，一次图传突发在频率上被检测为几段；识别器把同一突发中的另一段当作上一段，"
        "两段的频率差与跳频遥控的跳频间隔相当。特征值已逐段核实，碎片的成因未单独验证。",
        "推断")
    did, em = next(iter(dd["droneid_emitter"].items()))
    bs = dd["bursts"]
    first, second = bs[0]["segments"][0], bs[1]["segments"][0]
    idr, ivd = dd["template_intervals"]["droneid"], dd["template_intervals"]["ofdm_video"]
    labs, cm = merge_confusion(single + multi)
    di = labs.index("droneid") if "droneid" in labs else None
    n_did = sum(cm[di]) if di is not None else 0
    ok_did = cm[di][di] if di is not None else 0
    f2 = finding(
        "DroneID 广播没有被识别出来",
        f"全部段中配上真值的 DroneID 广播共 {n_did} 段，判对 {ok_did} 段（{T.ref('cm')}）。",
        f"以 {dd['segment']} 为例，DroneID 广播在 {num(bs[0]['t_s'], 3, 's')} 与 {num(bs[1]['t_s'], 3, 's')} 各发送一次。"
        f"第一次与同时发送的图传突发合成一段（占用带宽 {mhz(first['bandwidth_Hz'])}），计为并入。"
        f"第二次单独成段：占用带宽 {mhz(second['bandwidth_Hz'])}、持续时间 {num(second['duration_s'] * 1e3, 3, 'ms')}、"
        f"频谱平坦度 {num(second['spectral_flatness'], 3)}，三项都同时落在 DroneID 广播模板与图传模板的区间内；"
        f"该段没有可比的上一段，「与上一段的间隔」缺失，识别结果为图传（后验概率 {num(second['posterior'], 3)}）。"
        f"两个模板的区别主要在间隔：DroneID 广播 {num(idr['interval_from_prev_s'][0], 2)}–"
        f"{num(idr['interval_from_prev_s'][1], 2, 's')}，图传 {num(ivd['interval_from_prev_s'][0] * 1e3, 2)}–"
        f"{num(ivd['interval_from_prev_s'][1] * 1e3, 2, 'ms')}。",
        "DroneID 广播每 640 ms 发送一次，1 s 的段内最多出现两次，间隔特征往往取不到；取不到时，"
        "它的带宽、时长与平坦度和 10 MHz 档图传重叠，模板匹配无法区分。",
        "已确认")
    co = [r for r in multi if r["group"] == "mxco"]
    mer = sum(r["bursts"]["merged"] for r in co)
    tru = sum(r["bursts"]["truth"] for r in co)
    f3 = finding(
        "同频与邻频多架图传的突发被并入",
        f"三架 10 MHz 图传（两架同频、一架邻频）的 {len(co)} 段中，{tru} 次突发有 {mer} 次计为并入，"
        f"邻频那一架也有并入（{T.ref('multi_e')}）。",
        "同频两架的突发在时间上重叠时，或邻频那一架的突发与它们在时间上重叠且频带相接时，检测器在时频面上得到一个连成一片的检测段，"
        f"按第 {C.ch('method')} 章的一对一配对规则，只有一次发射能配上，其余计为并入。",
        "能量检测只看时频面上的能量，无法分开同时出现、频带重叠或相接的信号；这是检测方法本身的局限，不是数据缺陷。",
        "已确认")
    return f1 + f2 + f3


# ---------------------------------------------------------------- 正文

def build(D: Data) -> Report:
    C = Chapters([
        ("scope", "目的与范围"),
        ("algo", "被测算法"),
        ("method", "评价方法"),
        ("res", "结果"),
        ("repro", "输入一致性与复现"),
        ("concl", "结论"),
        ("limit", "局限性"),
    ])
    recs = D.recs
    single = [r for r in recs if r["kind"] == "single"]
    multi = [r for r in recs if r["kind"] == "multi"]
    bg = [r for r in recs if r["kind"] == "background"]
    n = len(recs)
    pfa = D.param_default("EnergyDetector", "pfa")
    nfft = int(D.param_default("EnergyDetector", "nfft"))
    win = int(D.param_default("EnergyDetector", "noise_window_frames"))
    gap = int(D.param_default("EnergyDetector", "merge_gap_frames"))
    k0 = D.base["config"]["subband_bins"]
    acc_thr = D.lib["decision"]["accept_threshold"]
    band_rel = sorted({round((r["s4"]["detection_band_Hz"][1] - r["s4"]["detection_band_Hz"][0]) / r["s4"]["sample_rate_Hz"], 6)
                       for r in recs})
    if len(band_rel) != 1:
        raise SystemExit(f"各段检测频段相对 S4 采样率的比例不一致：{band_rel}")
    fs_set = sorted({r["s4"]["sample_rate_Hz"] for r in recs})
    tmpl = D.lib["templates"]
    lab_set = sorted({t["label"] for t in tmpl}, key=lambda x: list(LABEL_CN).index(x) if x in LABEL_CN else 99)
    calib_cells = D.calib["cells"]
    calib_snr = sorted({p["snr_dB"] for c in calib_cells for p in c["platforms"]})
    if {c["propagation"] for c in calib_cells} != {"los"}:
        raise SystemExit("校准集不全是视距，正文的说法要改")

    rpt = Report(TITLE, subtitle=SUBTITLE, short_title=TITLE, info=[
        ("文件名称", e(TITLE)), ("版本", VERSION), ("日期", DATE),
        ("适用对象", f"仿真合成数据集 v1（{n} 段）的观测点 S4"),
        ("报告类型", "算法基准结果"),
        ("数据状态", "原型阶段结果"),
        ("配套文件", f"数据包内的数据说明；{e(MODEL_DOC)}；{e(REALISM)}；机器可读结果 baseline-results.json"),
    ])
    T, F, R = rpt.tables, rpt.figures, rpt.refs
    R.add("ed", "H. Urkowitz. Energy detection of unknown deterministic signals. Proceedings of the IEEE, 55(4): 523–531, 1967.")
    R.add("lr", "R. Lugannani, S. Rice. Saddle point approximation for the distribution of the sum of independent random "
                "variables. Advances in Applied Probability, 12(2): 475–490, 1980.")

    # 汇总用的数
    def agg(rs, f):
        a = sum(f(r)[0] for r in rs)
        b = sum(f(r)[1] for r in rs)
        return a, b
    los_hi = [r for r in single if r["propagation"] == "los" and r["snr_target_dB"] >= 10]
    m_hi, t_hi = agg(los_hi, lambda r: (primary_rate(r)[1] or 0, primary_rate(r)[2] or 0))
    rc_hi = agg(los_hi, lambda r: (correct(r), r["recognition"]["evaluated"] or 0))
    lo = [r for r in single if r["snr_target_dB"] <= 0]
    m_lo, t_lo = agg(lo, lambda r: (primary_rate(r)[1] or 0, primary_rate(r)[2] or 0))
    bg_fp = agg(bg, lambda r: (r["frames"]["fp"], r["frames"]["fp"] + r["frames"]["tn"]))

    rpt.abstract(
        f"本文件给出本方检测识别算法在仿真合成数据集 v1 全部 {n} 段的观测点 S4 上的结果，供数据使用方比较自己的算法。"
        f"算法由三部分组成：子带能量检测（滑动噪声估计，设计虚警概率 {num(pfa, 3)}）、按突发提取特征、按模板匹配识别。"
        f"评价以仿真真值为准，在帧、突发与识别三个层次上计数。",
        f"信噪比目标不低于 10 dB 的视距单源段，主辐射源的突发检出 {m_hi}/{t_hi}（{pct(m_hi / t_hi if t_hi else None)}），"
        f"识别正确 {rc_hi[0]}/{rc_hi[1]}（{pct(rc_hi[0] / rc_hi[1] if rc_hi[1] else None)}）；"
        f"信噪比目标不高于 0 dB 的单源段，突发检出 {m_lo}/{t_lo}（{pct(m_lo / t_lo if t_lo else None)}）。"
        f"{len(bg)} 段纯背景的帧级虚警率为 {num(bg_fp[0] / bg_fp[1], 5) if bg_fp[1] else '—'}。"
        f"全部 {n} 段的输入与交付的 S4 文件逐字节相同。",
        "识别模板由独立的仿真校准数据生成，与本数据集使用同一套信号模型，因此识别结果不能代表算法对真实信号的性能。"
        "本文件的全部数值为原型阶段结果，不设判定准则，只列出数值。")

    # ------------------------------------------------ 1
    s1 = (
        "<p>本文件回答一个问题：本方的检测识别算法在交付的数据上得到什么结果。数据使用方可以在同一批文件上运行自己的算法，"
        "按第 " + C.ch("method") + " 章的同一套计数方法比较。本文件给出的是一个参照点，不是算法性能的指标，也不设判定准则。</p>"
        f"<p>输入是交付的观测点 S4（DDC 之后的复基带），每段 1 s，采样率为 {e('、'.join(num(x / 1e6, 0, 'MS/s') for x in fs_set))}。"
        f"数据由哪些模型生成、实现怎样校核，见{e(MODEL_DOC)} ；仿真数据与公开实测数据的统计比较，见{e(REALISM)} 。</p>"
        f"<p>逐段结果在附录 A；机器可读的逐段结果在配套文件 baseline-results.json 中，字段定义在附录 B。</p>"
    )
    rpt.section(C.sid("scope"), C.title("scope"), s1)

    # ------------------------------------------------ 2
    det_rows = [
        ["FFT 点数与窗", f"{nfft} 点，周期 Hann 窗，相邻帧不重叠"],
        ["检测频段", f"S4 中心 ±{num(band_rel[0] / 2, 2)} 倍 S4 采样率"],
        ["噪声估计", f"每个频点一个长 {win} 帧的环，取中位数除以 ln 2；判为信号的频点及其两侧各 2 个频点不进环"],
        ["多级块", f"最小块宽 {k0} 个频点，逐级加倍，直到检测频段宽度"],
        ["门限", f"每帧总虚警概率 {num(pfa, 3)}，按各级块的检验总数平均分摊；单块门限由鞍点近似精确求出"],
        ["成簇与成段", f"相邻标记频点的间隙不超过 {k0} 个频点即成一簇；簇与最近 64 帧的同一段频段重叠即连成一段；"
                     f"段内允许的空帧不超过 {gap} 帧"],
    ]
    feat_rows = [
        ["中心频率", "段内信号频点的功率加权平均"],
        ["占用带宽", "包含 99% 功率的频率宽度"],
        ["持续时间", "首帧起点到末帧终点"],
        ["频谱平坦度", "占用带宽内功率谱的几何均值与算术均值之比"],
        ["与上一段的频率差、间隔", "同一检测频段内上一个可比的段；用于区分跳频与定频"],
    ]
    s2 = (
        C.h3("algo", 1, "检测")
        + f"<p>检测器是能量检测{R.cite('ed')}的子带形式：在每一帧的功率谱上，把检测频段切成宽度逐级加倍的块，"
          f"块内功率与噪声估计之比超过门限即命中。门限按 Hann 窗下相邻频点的相关结构，用鞍点近似{R.cite('lr')}求出，"
          f"不是矩匹配的近似。命中的频点连成簇，簇在时间上连成段；一段对应一次检测到的突发。"
          f"{T.ref('det')} 列出参数。</p>"
        + table(f"{T.new('det')}　检测参数", ["项目", "取值"], det_rows, cls="wide")
        + C.h3("algo", 2, "特征提取")
        + f"<p>每个检测段提取 {len(feat_rows)} 类特征（{T.ref('feat')}），只在段的频率范围内计算。</p>"
        + table(f"{T.new('feat')}　特征", ["特征", "定义"], feat_rows)
        + C.h3("algo", 3, "识别")
        + f"<p>识别器把每段的特征与模板库逐一比较。每个模板对每类特征给出一个取值区间，特征落在区间外的距离按权重累加，"
          f"再换算为后验概率；最大后验低于接受门限 {num(acc_thr, 1)}，或特征与所有模板都相距过远，判为未知。"
          f"模板库有 {len(tmpl)} 个模板、{len(lab_set)} 个类别（{e('、'.join(LABEL_CN.get(x, x) for x in lab_set))}）。</p>"
        + f"<p>模板的取值区间由两部分数据按固定规则生成：一组 {len(calib_cells)} 段的仿真校准数据，"
          f"每段只有一个辐射源，信噪比 {e('、'.join(num(s, 0) for s in calib_snr))} dB，视距；以及从公开实测数据集提取的统计。"
          f"校准数据与本数据集使用同一套信号模型，但随机数种子、平台方位与距离都不同；模板库在本数据集生成之前冻结，之后没有修改。"
          f"校准数据的机型参数是上一版，与本数据集的差别只在 DJI 图传的长循环前缀排布（突发长约 1 µs）。</p>"
    )
    rpt.section(C.sid("algo"), C.title("algo"), s2)

    # ------------------------------------------------ 3
    s3 = (
        "<p>真值取自仿真记录，与数据文件中的注记一一对应。一次发射的真值频段是名义中心频率加载频偏差、两侧各取占用带宽的一半。"
        "计数分三个层次：</p>"
        "<ol>"
        "<li><strong>帧级</strong>：一帧的中点落在任一发射的真值区间内即为「有信号帧」。"
        "检出率 = 判为命中的有信号帧 / 有信号帧；虚警率 = 判为命中的无信号帧 / 无信号帧。</li>"
        "<li><strong>突发级</strong>：检测段的频段取其核心，即在该段至少一半的帧里命中的频点。"
        "检测段与真值的时间重叠比、频率重叠比都不小于 0.5（都对较短或较窄的一方计）时成为候选；按两比之积一对一配对。"
        "配对后：配上的真值为「检出」；有候选但没配上的真值为「并入」，即被另一次发射的检测段覆盖；"
        "有候选但没配上的检测段为「碎片」；没有任何候选的检测段为「虚警段」。突发检出率 = 检出 / 真值。</li>"
        "<li><strong>识别</strong>：只对配上真值的检测段计。真值类别取配对的发射的类别；识别准确率 = 判对的段 / 参与识别的段。"
        "判为未知的段计为错误。</li>"
        "</ol>"
        "<p>真值频段在检测频段内不足一半的发射，不进突发级与识别的分母，单独计数：完全在检测频段外的计「频段外」，"
        "部分在内的计「部分在内」。这类发射主要是 S4 只覆盖一部分跳频点的遥控、以及 S4 之外的 DroneID 广播。</p>"
        "<p>本文件不设判定准则，全部结果仅列出。比较两个算法时，应使用同一套计数方法、同一检测频段。</p>"
    )
    rpt.section(C.sid("method"), C.title("method"), s3)

    # ------------------------------------------------ 4 结果
    snrs = [-5, 0, 5, 10, 20, 30]

    def grid(key):
        rows = []
        for g in GROUP_ORDER:
            for prop, pcn in (("los", "视距"), ("nlos", "非视距")):
                row = [e(D.group_name[g]), pcn]
                for s in snrs:
                    r = next((x for x in single if x["group"] == g and x["propagation"] == prop and x["snr_target_dB"] == s), None)
                    if r is None:
                        row.append("未生成")
                    elif key == "det":
                        v, a, b = primary_rate(r)
                        row.append(f"{pct(v)}<br><span class=sub>{frac(a, b)}</span>")
                    else:
                        rc = r["recognition"]
                        row.append(f"{pct(rc['accuracy'])}<br><span class=sub>{rc['evaluated'] if rc['evaluated'] is not None else '—'} 段</span>")
                rows.append(row)
        return rows

    head = ["信号", "传播"] + [f"{snr_label(s)}" for s in snrs]
    multi_rows = []
    for r in multi:
        for eid, v in r["bursts"]["emitters"].items():
            multi_rows.append([e(r["segment"]), e(eid), str(v["truth"]), str(v["matched"]), str(v["merged"]),
                               pct(v["detection_rate"])])
    multi_sum = []
    for r in multi:
        b, rc = r["bursts"], r["recognition"]
        multi_sum.append([e(r["segment"]), e(r["title"]), str(b["truth"]), str(b["matched"]), str(b["merged"]),
                          str(b["fragments"]), str(b["false_segments"]), pct(rc["accuracy"]), str(rc["evaluated"])])
    bg_rows = []
    for r in bg:
        fr = r["frames"]
        bg_rows.append([e(r["segment"]), e(r["title"]), num(r["s4"]["sample_rate_Hz"] / 1e6, 0, "MS/s"),
                        str(fr["total"]), str(fr["fp"]), num(fr["pfa"], 5) if fr["pfa"] is not None else "—",
                        str(r["bursts"]["false_segments"])])
    labs, cm = merge_confusion(single + multi)
    cm_rows = []
    for i, a in enumerate(labs):
        tot = sum(cm[i])
        if tot == 0:
            continue
        cm_rows.append([e(LABEL_CN.get(a, a))] + [str(x) for x in cm[i]] + [str(tot), pct(cm[i][i] / tot if a != "unknown" else None)])
    fs_single = [r["bursts"]["false_segments"] for r in single]
    fr_single = [r["bursts"]["fragments"] for r in single]
    pfa_single = [r["frames"]["pfa"] for r in single if r["frames"]["pfa"] is not None]
    oob = sum((r["bursts"]["out_of_band"] or 0) for r in recs)
    part = sum((r["bursts"]["partial"] or 0) for r in recs)
    s4_ = (
        C.h3("res", 1, "单源段的突发检出率")
        + f"<p>{T.ref('det_grid')} 与{F.ref('det_fig')} 给出 {len(single)} 段单源段中主辐射源的突发检出率。"
          f"含 DroneID 广播的段，DroneID 广播另行计数，不计入主辐射源。</p>"
        + table(f"{T.new('det_grid')}　单源段主辐射源的突发检出率（检出 / 真值）", head, grid("det"),
                num_cols=set(range(2, 8)), nowrap_cols={1}, cls="wide")
        + figure(fig_vs_snr(D, "det", "突发检出率（%）"), F.new("det_fig"),
                 "单源段主辐射源的突发检出率随信噪比目标的变化。", f"{T.ref('det_grid')}")
        + C.h3("res", 2, "单源段的识别准确率")
        + f"<p>{T.ref('rec_grid')} 与{F.ref('rec_fig')} 给出单源段的识别准确率，分母是配上真值的检测段数。</p>"
        + table(f"{T.new('rec_grid')}　单源段的识别准确率（参与识别的段数）", head, grid("rec"),
                num_cols=set(range(2, 8)), nowrap_cols={1}, cls="wide")
        + figure(fig_vs_snr(D, "rec", "识别准确率（%）"), F.new("rec_fig"),
                 "单源段的识别准确率随信噪比目标的变化。", f"{T.ref('rec_grid')}")
        + C.h3("res", 3, "混淆矩阵")
        + f"<p>{T.ref('cm')} 是单源段与多源段合计的混淆矩阵，行为真值类别，列为识别结果。</p>"
        + table(f"{T.new('cm')}　混淆矩阵（单源段与多源段合计）", ["真值 \\ 识别"] + [e(LABEL_CN.get(x, x)) for x in labs]
                + ["合计", "准确率"], cm_rows, num_cols=set(range(1, len(labs) + 3)), cls="wide")
        + C.h3("res", 4, "多源段")
        + f"<p>{T.ref('multi')} 汇总 {len(multi)} 段多源段，{T.ref('multi_e')} 按辐射源列出突发检出。"
          f"同频的两个发射在时间上重叠时，检测器得到一个检测段，其中一个计为并入。</p>"
        + table(f"{T.new('multi')}　多源段汇总", ["段", "内容", "真值", "检出", "并入", "碎片", "虚警段", "识别准确率",
                                               "参与识别"], multi_sum, num_cols={2, 3, 4, 5, 6, 7, 8}, nowrap_cols={0}, cls="wide")
        + table(f"{T.new('multi_e')}　多源段按辐射源的突发检出", ["段", "辐射源", "真值", "检出", "并入", "检出率"],
                multi_rows, num_cols={2, 3, 4, 5}, nowrap_cols={0, 1}, cls="wide")
        + C.h3("res", 5, "纯背景段与虚警")
        + f"<p>{T.ref('bg')} 给出 {len(bg)} 段纯背景的帧级虚警与虚警段数。合计 {bg_fp[1]} 帧中命中 {bg_fp[0]} 帧，"
          f"帧级虚警率 {num(bg_fp[0] / bg_fp[1], 5) if bg_fp[1] else '—'}；设计值为每帧 {num(pfa, 3)}。"
          f"噪声估计在每段开头的 {win} 帧内逐帧建立，这期间的虚警率高于设计值，表中的计数含这一段。</p>"
        + table(f"{T.new('bg')}　纯背景段", ["段", "内容", "S4 采样率", "帧数", "命中帧", "帧级虚警率", "虚警段"],
                bg_rows, num_cols={2, 3, 4, 5, 6}, nowrap_cols={0}, cls="wide")
        + f"<p>含信号的单源段中，虚警段每段 {min(fs_single)}–{max(fs_single)} 个（中位数 {sorted(fs_single)[len(fs_single) // 2]}），"
          f"碎片每段 {min(fr_single)}–{max(fr_single)} 个；帧级虚警率 {num(min(pfa_single), 4)}–{num(max(pfa_single), 4)}。"
          f"有信号段的虚警率高于纯背景段：无信号帧中包括突发开关时刻与强信号带外的能量，检测器把它们判为命中，"
          f"而真值不计这些能量。</p>"
        + C.h3("res", 6, "识别错误的主要情形")
        + findings_html(D, single, multi, T, C)
        + C.h3("res", 7, "不进分母的发射")
        + f"<p>全部 {n} 段中，真值频段完全在检测频段外的发射 {oob} 次，部分在内的 {part} 次，按第 {C.ch('method')} 章的规则不进分母。</p>"
    )
    rpt.section(C.sid("res"), C.title("res"), s4_)

    # ------------------------------------------------ 5
    s5 = (
        f"<p>为证明基准使用的就是交付的数据，每段运行之后把这次运行的 S4 按交付的格式再导出一次，与交付文件逐字节比较："
        f"{n} 段全部相同。运行使用的仿真配置、随机数种子与生成数据集时相同，只是给检测器开了子带检测、只保留观测点 S4；"
        f"检测、特征提取、识别与评价只读信号，不改变信号。</p>"
        f"<p>每段运行配置的 SHA-256 记在机器可读结果中；引擎可执行文件与生成数据集的是同一个文件（附录 C）。"
        f"同一配置两次运行的结果逐字节相同。</p>"
    )
    rpt.section(C.sid("repro"), C.title("repro"), s5)

    # ------------------------------------------------ 6, 7
    s6 = (
        "<ol>"
        f"<li>信噪比目标不低于 10 dB 的视距单源段，主辐射源的突发检出率为 {pct(m_hi / t_hi if t_hi else None)}，"
        f"识别准确率为 {pct(rc_hi[0] / rc_hi[1] if rc_hi[1] else None)}（第 {C.ch('res', 1)}、{C.ch('res', 2)} 节）。</li>"
        f"<li>信噪比目标不高于 0 dB 的单源段，突发检出率为 {pct(m_lo / t_lo if t_lo else None)}；"
        f"各信号与传播条件下的变化见{T.ref('det_grid')} 。</li>"
        f"<li>纯背景段的帧级虚警率为 {num(bg_fp[0] / bg_fp[1], 5) if bg_fp[1] else '—'}，设计值为 {num(pfa, 3)}（第 {C.ch('res', 5)} 节）。</li>"
        f"<li>全部 {n} 段的输入与交付的 S4 文件逐字节相同（第 {C.ch('repro')} 章）。</li>"
        "</ol>"
    )
    rpt.section(C.sid("concl"), C.title("concl"), s6)
    s7 = (
        "<ol>"
        "<li>识别模板由同一套信号模型的仿真校准数据生成，本数据集上的识别结果偏乐观，不能代表算法对真实信号的性能。"
        f"仿真数据与实测数据的差异见{e(REALISM)} 。</li>"
        "<li>检测与识别只在 S4 上运行。S4 只覆盖一部分跳频点，跳频遥控的识别依赖的「与上一段的频率差」因此按 S4 内的跳频点计算。</li>"
        "<li>识别只到信号类别（图传、跳频遥控、DroneID 广播等），不到机型。</li>"
        "<li>算法参数是缺省值，没有针对本数据集调整。</li>"
        "<li>本文件的全部数值为原型阶段结果。</li>"
        "</ol>"
    )
    rpt.section(C.sid("limit"), C.title("limit"), s7)

    # ------------------------------------------------ 附录
    app_rows = []
    for r in recs:
        v, a, b = primary_rate(r) if r["kind"] == "single" else (r["bursts"]["detection_rate"], r["bursts"]["matched"],
                                                                 r["bursts"]["truth"])
        fr, bb, rc = r["frames"], r["bursts"], r["recognition"]
        app_rows.append([e(r["segment"]), num(fr["pd"], 4) if fr["pd"] is not None else "—",
                         num(fr["pfa"], 5) if fr["pfa"] is not None else "—", frac(a, b), str(bb["false_segments"]),
                         str(bb["fragments"]), str(bb["merged"]), pct(rc["accuracy"]),
                         str(rc["evaluated"]) if rc["evaluated"] is not None else "—"])
    rpt.section("sa", "附录 A　逐段结果",
                f"<p>{T.ref('app')} 列出全部 {n} 段。单源段的「突发检出」为主辐射源，多源段为全部辐射源，纯背景段没有真值。</p>"
                + table(f"{T.new('app')}　逐段结果", ["段", "帧级检出率", "帧级虚警率", "突发检出", "虚警段", "碎片", "并入",
                                                     "识别准确率", "参与识别"], app_rows,
                        num_cols=set(range(1, 9)), nowrap_cols={0}, cls="wide"))
    fields = [
        ["segment / title", "段标识与内容，与数据包的文件名前缀一致"],
        ["kind / group / propagation / snr_target_dB", "段的类别（single 单源、multi 多源、background 纯背景）、信号组、传播条件与信噪比目标"],
        ["s4_identical_to_package", "本次运行的 S4 与交付文件是否逐字节相同"],
        ["s4", "S4 采样率、检测频段（Hz，绝对频率）、帧长（s）"],
        ["frames", "帧级计数：total 总帧数、truth_on 有信号帧、tp / fp / fn / tn、pd 检出率、pfa 虚警率"],
        ["bursts", "突发级计数：truth 真值、out_of_band 频段外、partial 部分在内、segments 检测段、matched 检出、"
                   "merged 并入、fragments 碎片、false_segments 虚警段、detection_rate 检出率；emitters 按辐射源给出 truth、matched、"
                   "merged、detection_rate，primary 表示主辐射源"],
        ["recognition", "识别：evaluated 参与识别的段、accuracy 准确率、unknown_rate 判为未知的比例、unmatched 未配上真值的识别段、"
                        "labels 类别顺序、confusion 混淆矩阵（行为真值、列为识别结果）"],
        ["diagram_sha256", "该段运行配置的 SHA-256"],
    ]
    rpt.section("sb", "附录 B　机器可读结果的字段",
                f"<p>baseline-results.json 的顶层为 schema_version、dataset、config 与 segments；segments 每段一条，字段见{T.ref('fields')} 。"
                f"比值的分母为 0 时取 null。</p>"
                + table(f"{T.new('fields')}　逐段记录的字段", ["字段", "含义"], fields, nowrap_cols={0}, cls="wide"))
    hashes = [
        ["仿真引擎（可执行文件）", e(D.base["engine_version"]), f"<span class=ids>{D.base['cuav_run_sha256']}</span>"],
        ["识别模板库", e(D.lib["library_version"]), f"<span class=ids>{sha256('models', 'recognition', 'library-v2.json')}</span>"],
    ]
    rpt.section("sc", "附录 C　版本与哈希",
                f"<p>{T.ref('hash')} 列出基准使用的引擎与识别模板库。引擎可执行文件与生成数据集的是同一个文件。</p>"
                + table(f"{T.new('hash')}　版本与哈希", ["对象", "版本", "SHA-256"], hashes, nowrap_cols={1}, cls="wide"))
    rpt.section("sd", "附录 D　参考文献", R.list_html())
    return rpt


def results_json(D: Data, set_id: str) -> dict:
    return OrderedDict([
        ("schema_version", "cuav-baseline-results/1"),
        ("dataset", {"name": D.cells["name"], "segments": len(D.recs)}),
        ("config", {"observation_point": "S4",
                    "detector": {"type": "subband energy detector, sliding median noise estimate",
                                 "nfft": int(D.param_default("EnergyDetector", "nfft")),
                                 "pfa": D.param_default("EnergyDetector", "pfa"),
                                 "noise_window_frames": int(D.param_default("EnergyDetector", "noise_window_frames")),
                                 "merge_gap_frames": int(D.param_default("EnergyDetector", "merge_gap_frames")),
                                 "subband_min_bins": D.base["config"]["subband_bins"]},
                    "recognition": {"library_version": D.lib["library_version"],
                                    "accept_threshold": D.lib["decision"]["accept_threshold"],
                                    "templates": len(D.lib["templates"])},
                    "matching": {"overlap": 0.5, "rule": "time and frequency overlap ratios >= 0.5, one-to-one greedy"},
                    "engine_sha256": D.base["cuav_run_sha256"]}),
        ("segments", D.recs),
    ])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--set", default="formal-v1")
    ap.add_argument("--out-dir", default=None)
    a = ap.parse_args(argv)
    D = Data(a.set)
    out = a.out_dir or rp("data", "eval", a.set, "docs")
    os.makedirs(out, exist_ok=True)
    build(D).write(os.path.join(out, "baseline-results.html"))
    with open(os.path.join(out, "baseline-results.json"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(results_json(D, a.set), ensure_ascii=False, indent=1) + "\n")
    print(f"写了 {os.path.relpath(out, ROOT)}/baseline-results.{{html,json}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
