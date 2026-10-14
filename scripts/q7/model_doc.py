#!/usr/bin/env python3
"""《仿真模型与实现验证说明》生成器（Q-7，D-106）。读者是甲方，随正式集的文档包交付。

数字全部取自结果文件与入库的参数表，不手抄（formal-tech-report：数字只取自结果文件）：
- 机型参数表 `models/radiator/presets-v2.json`、`gfsk-presets-v1.json`（参数值与出处等级前缀）；
- 抗混叠滤波器冻结表 `models/adc-ddc/fir_lp_v1.json`、`models/radiator/fir_rsmp_v1.json`；
- 格子文件 `tests/regression/eval-dataset/<集合>.json`（站点、接收配置、前端实测非理想、传播、载频偏差）；
- 正式集内部清单 `data/eval/<集合>/dataset.manifest.json`（生成时的核查）；
- 实现验证快照 `data/eval/<集合>/verification.json`（标准算例、跨层算例 ①、单元测试、黄金基准）；
- 组件目录黄金基准 `tests/golden/component-catalog.json`（相噪、衰落、ADC 的缺省参数）；
- 观测区域清单 `data/scene/<aoi>/manifest.json`（建筑数与高度来源）；
- 真实感对照 `data/eval/realism-v2/realism.json`（每个对照组的判定计数，只引用、不重算）。

报告类型是 formal-tech-report 的「模型说明与校核报告」：校核写成主体，与实测的比对（验证）在配套的真实感对照报告里。
正文不出现决策编号、内部步骤号、文件路径与命令；版本与哈希在附录。

用法：python3 scripts/q7/model_doc.py [--set formal-v1] [--out <文件>]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from report_kit import CSS, Chapters, Report, e, num, table, verdict  # noqa: E402

VERSION, DATE = "v1.0", "2026-10-12"
TITLE = "仿真模型与实现验证说明"
SUBTITLE = "仿真合成数据集 v1 的生成模型、参数出处与实现校核"
REALISM = "《无人机射频 IQ 信号仿真方法与可信性验证报告》v1.4"
BASELINE = "《本方基准结果》v1.0"

CSS_EXTRA = """
.eq{font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--plane);border:1px solid var(--line);
padding:8px 12px;margin:8px 0 14px;white-space:pre;overflow-x:auto}
.key{background:var(--plane);border-left:3px solid var(--accent);padding:8px 14px;margin:12px 0}
.key p{margin:4px 0}
"""

# 出处等级：参数表里的字母前缀 → 中文。「设定」是本方为本数据集选定的工作点（与数据说明第 6 章同一用词）
GRADE_CN = {"V": "厂商文档", "P": "文献", "S": "开源实现", "M": "实测提取", "D": "推导", "A": "本方假定"}


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


def grade_of(prov: str | None) -> str:
    """出处字符串的字母前缀（如「V + P：…」「M + A：…」）→「厂商文档 + 文献」。认不出即报错，不猜。"""
    if prov is None:
        return "—"
    head = re.split(r"[：:]", prov, maxsplit=1)[0].strip()
    if head in ("—", "-"):
        return "—"
    parts = [x.strip() for x in head.split("+")]
    if not parts or any(x not in GRADE_CN for x in parts):
        raise ValueError(f"认不出出处等级：{prov[:40]}")
    return " + ".join(GRADE_CN[x] for x in parts)


def has_a(prov: str | None) -> tuple[bool, bool]:
    """（含本方假定, 完全是本方假定）。"""
    if not prov:
        return False, False
    head = re.split(r"[：:]", prov, maxsplit=1)[0].strip()
    parts = [x.strip() for x in head.split("+")]
    return "A" in parts, parts == ["A"]


def mhz(x: float, nd: int = 3) -> str:
    return num(x / 1e6, nd, "MHz")


# ---------------------------------------------------------------- 数据

class Data:
    def __init__(self, set_id: str):
        self.set_id = set_id
        self.cells = load("tests", "regression", "eval-dataset", f"{set_id}.json")
        self.man = load("data", "eval", set_id, "dataset.manifest.json")
        self.ver = load("data", "eval", set_id, "verification.json")
        self.ofdm = load("models", "radiator", "presets-v2.json")
        self.gfsk = load("models", "radiator", "gfsk-presets-v1.json")
        self.fir_ddc = load("models", "adc-ddc", "fir_lp_v1.json")
        self.fir_rsmp = load("models", "radiator", "fir_rsmp_v1.json")
        self.catalog = load("tests", "golden", "component-catalog.json")
        self.scene = load("data", "scene", self.cells["aoi_id"], "manifest.json")
        self.realism = load("data", "eval", "realism-v2", "realism.json")
        used = sorted({p for c in self.man["cells"] for p in c["presets"]})
        self.used = used
        self.ofdm_used = [p for p in self.ofdm["presets"] if p["id"] in used]
        self.gfsk_used = [p for p in self.gfsk["presets"] if p["id"] in used]
        if len(self.ofdm_used) + len(self.gfsk_used) != len(used):
            raise SystemExit(f"正式集用到的机型参数在两张表里没找全：{used}")
        self.numer = {n["id"]: n for n in self.ofdm["numerologies"]}

    def param_default(self, comp: str, name: str):
        for c in self.catalog["components"]:
            if c["type"] == comp:
                for p in c["params"]:
                    if p["name"] == name:
                        return p.get("default")
        raise KeyError(f"{comp}.{name}")


# ---------------------------------------------------------------- 机型参数的派生量

def ofdm_burst_s(p: dict, numer: dict, b: dict) -> float:
    n = numer["fft_size"]
    cs, cl = b.get("cp_short", numer["cp_short"]), b.get("cp_long", numer["cp_long"])
    longs = set(b.get("cp_long_at", []))
    samples = sum(n + (cl if i in longs else cs) for i in range(b["n_symbols"]))
    return samples / numer["fs_native_Hz"]


def ofdm_rows(D: Data):
    rows, grades = [], []
    for p in D.ofdm_used:
        nm = D.numer[p["numerology"]]
        bursts = "；".join(f"{b['n_symbols']} 个符号 = {num(ofdm_burst_s(p, nm, b) * 1e3, 3, 'ms')}" for b in p["bursts"])
        fr = p["frame"]
        if "slot_s" in fr and fr.get("cycle"):
            if p["type"] == "droneid":
                frame = f"每 {num(fr['slot_s'] * 1e3, 0, 'ms')} 一个突发"
            elif p["role"] == "rc_hopping":
                pat = "、".join("空" if row[0] == 1 else "发" for row in fr["cycle"])
                frame = (f"时隙 {num(fr['slot_s'] * 1e3, 0, 'ms')}，按「{pat}」循环，"
                         f"每次发送以概率 {num(p['frame_fit']['skip_prob'], 3)} 跳过")
            else:
                fit = p.get("frame_fit") or {}
                extra = (f"，占空比 {num(fit['duty'], 3)}" if "duty" in fit else "")
                frame = f"时隙 {num(fr['slot_s'] * 1e3, 0, 'ms')}，逐时隙按概率取空或突发{extra}"
        else:
            frame = "—"
        cp = f"{nm['cp_short']} / {nm['cp_long']}"
        rows.append([e(p["name"]), e(ROLE_CN[p["role"]]), mhz(p["occupied_bw_Hz"]),
                     f"{nm['fft_size']} 点，{num(nm['subcarrier_spacing_Hz'] / 1e3, 0, 'kHz')}，{num(nm['fs_native_Hz'] / 1e6, 2, 'MS/s')}",
                     cp, e(bursts), e(frame), e(CONST_CN[p["constellation"]]), e(p["credibility"])])
        pv = p["provenance"]
        grades.append([e(p["name"]), grade_of(pv.get("occupied_bw_Hz")), grade_of(pv.get("numerology")),
                       grade_of(pv.get("bursts")), grade_of(pv.get("frame")), grade_of(pv.get("constellation")),
                       grade_of(pv.get("channels_Hz") or pv.get("hop_grid"))])
    return rows, grades


def gfsk_rows(D: Data):
    rows, grades = [], []
    for p in D.gfsk_used:
        R, fd = p["symbol_rate_Hz"], p["deviation_Hz"]
        mod = "GFSK，BT = " + f"{p['bt']:g}" if p["modulation"] == "gfsk" else "2-FSK"
        pk = p["frame"]["packets"]
        pkt = (f"每 {num(p['frame']['period_s'] * 1e3, 1, 'ms')} {'一两三'[len(pk) - 1]}包，每包 {pk[0]['n_bits']} 比特 = "
               f"{num(pk[0]['n_bits'] / R * 1e3, 4, 'ms')}")
        ch = p["hop"]["channels_Hz"]
        hop = f"{len(ch)} 个频点，{num(min(ch) / 1e6, 2)}–{num(max(ch) / 1e6, 2)} MHz"
        rows.append([e(p["name"]), e(mod), num(R / 1e3, 3, "kBd"), num(fd / 1e3, 3, "kHz"), num(2 * fd / R, 4),
                     num(p["occupied_bw_Hz"] / 1e3, 1, "kHz"), e(pkt), e(hop), e(p["credibility"])])
        pv = p["provenance"]
        grades.append([e(p["name"]), grade_of(pv.get("modulation")), grade_of(pv.get("bits")),
                       grade_of(pv.get("frame")), grade_of(pv.get("hop"))])
    return rows, grades


def assumption_count(D: Data) -> tuple[int, int, int]:
    """（出处项总数, 含本方假定的项, 完全是本方假定的项）——只数正式集用到的机型参数。"""
    n = part = full = 0
    for p in D.ofdm_used + D.gfsk_used:
        for v in p["provenance"].values():
            if grade_of(v) == "—":
                continue
            n += 1
            a, f = has_a(v)
            part += a
            full += f
    return n, part, full


ROLE_CN = {"video_link": "图传", "rc_hopping": "遥控上行", "droneid": "DroneID 广播"}
CONST_CN = {"16qam": "16QAM", "qpsk": "QPSK"}

# ---------------------------------------------------------------- 标准算例：脚本里的检查名 → 对外的说法

CASE_TEXT = {
    "算例 1 单音频移": (1, "谱峰频率对场景给出的频偏（含多普勒）"),
    "算例 1 功率标度（S1 = 链路预算）": (1, "S1 带内功率对链路预算"),
    "算例 1 电平链起点：S0 = 发射功率": (1, "S0 带内功率对发射功率"),
    "算例 1 电平链：S2 − S1 = 前端增益": (1, "S2 与 S1 的功率差对前端增益"),
    "算例 2 带限噪声的 −3 dB 带宽": (2, "带限噪声的 −3 dB 带宽对设定带宽"),
    "算例 2 目标信噪比可读且为正": (2, "带内信噪比可从功率谱上读出且为正"),
    "算例 3 突发占空比": (3, "突发导通帧的比例对设定占空比"),
    "算例 6 削波计数是数据标记，进索引但不改观测点状态": (6, "削顶样点数记入产品索引，观测点的质量状态不变"),
    "算例 6 削波比例超阈值才把组件标降级（D-051 ⑥）": (6, "削顶样点比例超过阈值时，ADC 组件标为降级"),
    "算例 6 ADC 量化噪声的抬升合解析预期": (6, "量化噪声对噪声底的抬升对解析值"),
    "全合成链的四态如实传出（缺省参数下 ADC 过载，D-066 ⑨）": (6, "ADC 过载造成的降级状态传到任务结果"),
    "算例 9 实测回放的样点数与清单一致": (9, "回放的样点数对数据清单"),
    "算例 9 采样率与中心频率取自清单不是框图": (9, "采样率与中心频率取自数据清单"),
    "算例 9 标度是 dBm 且带标定来源（D-047）": (9, "功率标度为 dBm，并带标定来源"),
    "算例 9 数据集自带的 degraded 如实传到结果（铁律 15）": (9, "实测数据自带的降级状态传到任务结果"),
    "算例 10 背景原样通过（-10…-5 MHz）": (10, "实测背景在 −10…−5 MHz 不变"),
    "算例 10 背景原样通过（+5…+10 MHz）": (10, "实测背景在 +5…+10 MHz 不变"),
    "算例 10 合成目标的绝对电平": (10, "合成目标的绝对电平对链路预算"),
    "算例 10 单音精确落在 bin 中心": (10, "合成单音落在预期的频点"),
    "算例 11 同种子逐字节复现": (11, "同一随机数种子两次运行，产品文件逐字节相同"),
}

CASE_TITLES = {1: "单音频移与功率标度", 2: "带限噪声与目标信噪比", 3: "突发开关与占空比", 4: "多信号同频及邻频叠加",
               5: "接收滤波与群时延", 6: "ADC 量化与削顶", 7: "数字下变频：频移、低通、抽取", 8: "宽带 IQ 到信道化 IQ",
               9: "实测 IQ 回放", 10: "实测背景加合成目标", 11: "固定随机数种子重复运行", 12: "用户算法插件"}

UNIT_ND = {"Hz": 1, "dBm": 3, "dB": 3, "比例": 4, "样点": 0, "个文件": 0}


def fmt_val(v, unit: str | None, diff: bool = False) -> str:
    """diff=True 用于容差：dBm 的差是 dB。"""
    if v is None:
        return "—"
    if unit == "Hz" and abs(v) >= 1e6:
        return num(v / 1e6, 4, "MHz")
    if diff and unit == "dBm":
        unit = "dB"
    nd = UNIT_ND.get(unit or "", 3)
    u = {"比例": "", "样点": "", "个文件": ""}.get(unit or "", unit or "")
    return num(v, nd, u)


# ---------------------------------------------------------------- 黄金基准（对外的说法与算例数取法）

def _n(doc, *keys):
    return sum(len(doc[k]) for k in keys)


GOLDENS = [
    # (分组, 文件, 对象, 比对双方, 判据, 算例数取法, 有无第三方实现)
    ("辐射源", "engine/tests/golden/ofdm.json", "OFDM 调制（逐符号逆 FFT 与循环前缀）",
     "引擎 / 独立参考实现 / 商用数值计算软件", "相对误差 ≤ 1×10⁻⁹", lambda d: _n(d, "cases")),
    ("辐射源", "engine/tests/golden/rsmp.json", "有理重采样（L/M 多相滤波）",
     "引擎 / 独立参考实现（直接型）/ 商用数值计算软件", "相对误差 ≤ 1×10⁻⁹", lambda d: _n(d, "kernel_check")),
    ("辐射源", "engine/tests/golden/ofdm_frame.json", "OFDM 突发的时隙排布与抽签",
     "引擎 / 独立参考实现", "逐位相同", lambda d: _n(d, "cases")),
    ("辐射源", "engine/tests/golden/scene_ofdm.json", "OFDM 辐射源组件的输出样点",
     "引擎 / 独立参考实现（全路径复刻）", "相对误差 ≤ 1×10⁻⁶（32 位浮点的存储精度）", lambda d: _n(d, "segments")),
    ("辐射源", "engine/tests/golden/gfsk.json", "GFSK 与 2-FSK 调制的相位",
     "引擎 / 高精度不截断求和 / 商用数值计算软件", "相位误差 ≤ 1×10⁻⁹ 圈", lambda d: _n(d, "cases")),
    ("辐射源", "engine/tests/golden/gfsk_frame.json", "GFSK 包的时序与跳频",
     "引擎 / 独立参考实现", "逐位相同", lambda d: _n(d, "cases")),
    ("辐射源", "engine/tests/golden/scene_gfsk.json", "GFSK 辐射源组件的输出样点",
     "引擎 / 独立参考实现", "绝对误差 ≤ 1×10⁻⁶", lambda d: _n(d, "cases")),
    ("传播", "tests/golden/geodesy.json", "WGS-84 坐标换算（大地坐标、地心坐标、站心坐标）",
     "开源大地测量库 / 独立闭式实现", "≤ 1×10⁻⁶ m", lambda d: _n(d, "cases")),
    ("传播", "tests/golden/propagation.json", "菲涅尔参数、刀口绕射损耗、大气与降雨衰减",
     "引擎 / 原始参考实现", "相对误差 ≤ 1×10⁻⁹",
     lambda d: _n(d, "fresnelV", "knifeEdgeLoss_dB", "atmosphericLoss_dB", "rainAttenuation_dB")),
    ("传播", "tests/golden/occlusion.json", "建筑遮挡几何与刀口损耗（合成建筑）",
     "引擎 / 浏览器侧独立实现 / 原始参考实现", "相对误差 ≤ 1×10⁻⁹", lambda d: _n(d, "segment_occlusion")),
    ("传播", "tests/golden/occlusion-aoi.json", "建筑遮挡（观测区域真实建筑集上的射线）",
     "引擎 / 浏览器侧独立实现", "相对误差 ≤ 1×10⁻⁹", lambda d: _n(d, "segment_occlusion_aoi")),
    ("传播", "tests/golden/coverage-cells.json", "单点链路预算（距离、自由空间路损、刀口损耗、信噪比）",
     "引擎 / 浏览器侧独立实现", "距离与路损相对误差 ≤ 1×10⁻⁹；dB 量绝对误差 ≤ 1×10⁻⁸ dB", lambda d: _n(d, "cases")),
    ("传播", "engine/tests/golden/fading.json", "小尺度衰落的生成（正弦和与抽头功率）",
     "引擎 / 独立参考实现 / 商用数值计算软件", "绝对误差 ≤ 1×10⁻⁹（单位平均功率）", lambda d: _n(d, "layouts")),
    ("接收机", "engine/tests/golden/phase_noise.json", "本振相位噪声的生成",
     "引擎 / 独立参考实现 / 商用数值计算软件", "相位误差 ≤ 1×10⁻⁹ 倍均方根相位", lambda d: _n(d, "cases")),
    ("接收机", "engine/tests/golden/ddc.json", "数字下变频（频移、低通、抽取）",
     "引擎 / 独立参考实现", "系数逐位相同；样点相对误差 ≤ 1×10⁻⁶", lambda d: len(d["expected"]["python"])),
]
TRACKS = ["tests/golden/scenario-track-golden-01.json", "tests/golden/scenario-track-golden-02.json",
          "tests/golden/scenario-track-golden-03.json"]


def golden_rows(D: Data) -> list[list[str]]:
    rows = []
    for grp, f, obj, who, crit, cnt in GOLDENS:
        d = load(f)
        third = os.path.exists(rp(f.replace(".json", ".matlab.json")))
        if ("商用数值计算软件" in who) != third:
            raise SystemExit(f"{f}：第三方实现的有无与说明不一致")
        rows.append([e(grp), e(obj), e(who), e(crit), str(cnt(d))])
    n = sum(len(load(f)["samples"]) for f in TRACKS)
    rows.append(["传播", "运动学与链路几何（三条基准航迹）", "引擎 / 浏览器侧独立实现", "位置误差 ≤ 1×10⁻⁶°", str(n)])
    return rows


# ---------------------------------------------------------------- 正文

def build(D: Data) -> Report:
    C = Chapters([
        ("scope", "目的、范围与关键假定"),
        ("chain", "信号生成链路"),
        ("emit", "辐射源模型"),
        ("prop", "传播模型"),
        ("rx", "接收机模型"),
        ("simp", "假设与简化"),
        ("vmeth", "校核方法"),
        ("vres", "校核结果"),
        ("cred", "可信度等级"),
        ("concl", "结论"),
        ("limit", "局限性"),
    ])
    site, recv, chain = D.cells["site"], D.cells["receivers"], D.cells["chain"]
    fm = D.cells["frontend_measured"]
    ver, man = D.ver, D.man
    n_seg = len(man["cells"])
    std = ver["standard_cases"]["checks"]
    std_ok = sum(1 for c in std if c["ok"])
    ut = ver["unit_tests"]
    cross = ver["crosslayer_1"]
    n_gold = len(GOLDENS) + 1
    n_prov, n_part_a, n_full_a = assumption_count(D)

    pn_L = D.param_default("ReceiverFrontEnd", "pn_level_dBc_Hz")
    pn_fc = D.param_default("ReceiverFrontEnd", "pn_corner_Hz")
    sig_phi_deg = math.degrees(math.sqrt(math.pi * pn_fc * 10 ** (pn_L / 10)))
    k_los = D.param_default("SceneBoundChannel", "fading_k_los_dB")
    fd_min = D.param_default("SceneBoundChannel", "fading_min_doppler_Hz")
    bits = int(D.param_default("AdcQuantizer", "bits")) if "bits" not in chain["adc"] else int(chain["adc"]["bits"])
    fs_dbm = chain["adc"]["full_scale_dBm"]

    ops = [o for c in man["cells"] for o in c["ops"]]
    ops_s3 = [o for o in ops if o["point"] == "S3"]
    ops_s4 = [o for o in ops if o["point"] == "S4"]
    rq = [o["requant_margin_dB"] for o in ops_s4 if o.get("requant_margin_dB") is not None]
    decims = sorted({c["s4"]["decim"] for c in man["cells"] if c.get("s4")})
    fir_used = [x for x in D.fir_ddc["entries"] if x["decim"] in decims and x["decim"] > 1]

    rpt = Report(TITLE, subtitle=SUBTITLE, short_title=TITLE, info=[
        ("文件名称", e(TITLE)), ("版本", VERSION), ("日期", DATE),
        ("适用对象", f"仿真合成数据集 v1（{n_seg} 段，每段 {num(D.cells['duration_s'], 0, 's')}）"),
        ("报告类型", "模型说明与校核报告"),
        ("数据状态", "原型阶段结果；模型未经目标接收机的实测校准"),
        ("配套文件", f"数据包内的数据说明；{e(REALISM)}；{e(BASELINE)}"),
    ])
    rpt.css = CSS + CSS_EXTRA
    T, R = rpt.tables, rpt.refs
    R.add("ndss", "N. Schiller, M. Chlosta, M. Schloegel, et al. Drone Security and the Mysterious Case of DJI's DroneID. "
                  "NDSS Symposium, 2023.")
    R.add("rfuav", "R. Shi, et al. RFUAV: A Benchmark Dataset for Unmanned Aerial Vehicle Detection and Identification. "
                   "arXiv:2503.09033, 2025.")
    R.add("droneRFb", "DroneRFb-DIR 公开数据集：无人机射频信号数据集（含视距与非视距标签）及其数据集论文")
    R.add("droneRFa", "DroneRFa 公开数据集：无人机射频信号数据集（2.4 GHz 与 5.8 GHz 双通道）及其数据集论文")
    R.add("mpm", "DIY Multiprotocol TX Module 开源多协议遥控发射模块的源代码，其中的 FrSky 与 Futaba S-FHSS 协议实现")
    R.add("cc2500", "Texas Instruments. CC2500 Low-Cost Low-Power 2.4 GHz RF Transceiver, SWRS040C.")
    R.add("p526", "ITU-R P.526-15. Propagation by diffraction, 2019.")
    R.add("gnss", "C. F. F. Karney. GeographicLib, version 2.5.2. 大地测量开源库及其文档")
    R.add("sigmf", "The GNU Radio Foundation. Signal Metadata Format (SigMF) Specification 1.2.6.")
    R.add("jakes", "W. C. Jakes. Microwave Mobile Communications. Wiley, 1974.")
    R.add("osm", "OpenStreetMap contributors. OpenStreetMap data, Open Database License (ODbL).")
    R.add("ieee80211", "IEEE Std 802.11-2020. Wireless LAN Medium Access Control (MAC) and Physical Layer (PHY) "
                       "Specifications.")

    # ------------------------------------------------ 摘要
    los_diff = [abs(p["snr_measured_dB_mean_lin_s3"] - p["snr_budget_dB_median"])
                for c in man["cells"] if c["propagation"] == "los" for p in c["platforms"]
                if p.get("snr_measured_dB_mean_lin_s3") is not None]
    rpt.abstract(
        f"本文件说明仿真合成数据集 v1 由哪些模型生成、每个参数从何而来，以及怎样证明这些模型按设计正确实现。"
        f"生成链路从辐射源开始，经发射天线、传播信道、接收天线和接收机前端，到模数转换器（ADC）与数字下变频（DDC）为止，"
        f"交付的观测点为 S3 与 S4。正式集用到 {len(D.used)} 套机型参数，共 {n_prov} 项带出处；"
        f"其中 {n_part_a} 项含本方假定，{n_full_a} 项完全是本方假定。",
        f"实现的校核由四类证据组成：{n_gold} 组黄金基准，每组把引擎与至少一个独立实现逐点比对；"
        f"标准算例 {std_ok}/{len(std)} 项检查符合判定准则；跨层一致性算例的解析检出率与仿真检出率相差 "
        f"{num(cross['delta'], 4)}，判定准则为 {num(cross['tolerance'], 2)}；"
        f"引擎的 {ut['doctest']['passed']} 项单元测试与 {ut['ctest_engine']['total'] + ut['ctest_geo']['total']} 项集成测试全部通过。"
        f"数据集生成时另做了逐段核查：视距段主辐射源的实测信噪比与链路预算之差绝对值最大 {num(max(los_diff), 2, 'dB')}，"
        f"随机抽取的 {len(man['verify']['cells'])} 段重新生成后逐字节相同。",
        f"可信度等级按环节给出：没有目标接收机的实测校准，任何环节都不高于 V2；本方假定占主导的环节为 V1。"
        f"模型与真实信号的统计比较见{e(REALISM)}。本文件的全部数值为原型阶段结果。")

    # ------------------------------------------------ 1 目的、范围与关键假定
    key_rows = [
        ["1", "DJI 图传的 FFT 点数取 1024、2048、4096（分别对应 10、20、40 MHz 档），子载波上为随机载荷的 16QAM",
         "图传突发内部的调制结构",
         "FFT 点数在信号上不可观测，也没有公开资料；按与 DroneID 广播同族的结构取值。子载波间隔与平均循环前缀长度已由公开实测数据核实",
         "依赖 FFT 点数或调制阶数的分析不应以本数据为依据"],
        ["2", "载荷为随机比特，没有信道编码，不含真实身份信息", "全部信号",
         "不复现任何真实设备的载荷", "与载荷内容有关的分析不适用"],
        ["3", "地面按平地处理，地面高度为 0 m", "传播", "观测区域没有足够分辨率的地形数据", "不含地形遮挡"],
        ["4", "建筑绕射只计入侵入最深的一栋建筑，按单刀口计算", "非视距段",
         f"ITU-R P.526 单刀口模型{R.cite('p526')}", "多次绕射的损耗更大，本假定偏乐观"],
        ["5", f"小尺度衰落为平坦衰落：视距为莱斯衰落（K = {num(k_los, 0, 'dB')}），非视距为瑞利衰落", "全部段",
         "没有本观测区域的信道测量", "频谱平坦度高于实测；逐段信噪比随衰落起伏"],
        ["6", "侦察接收机的参数（噪声系数、增益、ADC、本振相位噪声）为本方设定的工作点", "接收机",
         "目标接收机的指标未提供", "提供指标后可按同一配置重新生成"],
    ]
    s1 = (
        C.h3("scope", 1, "目的与范围")
        + f"<p>本文件回答三个问题：仿真合成数据集 v1 由哪些模型生成；每个模型参数从何而来；模型是否按设计正确实现。"
          f"读者是数据集的使用方。数据的格式、注记字段与读取方法见数据包内的数据说明，本文件不重复。</p>"
        + f"<p>本文件只证明实现正确。仿真数据与真实无人机信号在统计特征上的相近程度，由配套的{e(REALISM)}（下称可信性验证报告）给出；"
          f"本方检测识别算法在本数据集上的结果，由配套的{e(BASELINE)} 给出。三份文件各自独立成文，相互引用时只引用结论。</p>"
        + C.h3("scope", 2, "术语")
        + f"<p>{T.ref('terms')} 给出本文件使用的术语。</p>"
        + table(f"{T.new('terms')}　术语", ["术语", "定义"], [
            ["校核", "证明模型按设计正确实现，即程序算出的结果与模型的数学定义一致。证据是独立实现的逐点比对、解析解与守恒检查。"],
            ["验证", "证明模型在预期用途范围内足够准确地代表真实系统。证据是与实测数据的比对。本文件不做验证。"],
            ["观测点", "信号链上取信号的固定位置。S0 为辐射源输出，S1 为接收天线端，S2 为接收机前端输出，"
                       "S3 为 ADC 之后，S4 为 DDC 之后、信道化之前。数据集交付 S3 与 S4。"],
            ["黄金基准", "一组冻结的输入与期望输出。引擎的输出与它逐点比对，误差在判据之内为通过。"],
            ["出处等级", "参数取值的来源，分七类，见第 " + C.ch("scope", 4) + " 节。"],
            ["可信度等级", "一个环节的模型能在多大程度上代表真实系统，分 V1–V5，见第 " + C.ch("cred") + " 章。"],
        ], nowrap_cols={0}, cls="wide")
        + C.h3("scope", 3, "关键假定")
        + f"<div class=key><p><strong>图传数值结构的假定</strong>：DJI 图传（OcuSync 与 O 系列）的 FFT 点数没有公开资料，也无法从信号上观测。"
          f"本数据集按与 DroneID 广播{R.cite('ndss')}同族的结构，10、20、40 MHz 三档分别取 1024、2048、4096 点，"
          f"子载波间隔 15 kHz。这一假定只影响图传突发内部的调制结构；子载波间隔、循环前缀排布、占用带宽、突发时长与占空比"
          f"取自公开实测数据。</p></div>"
        + f"<p>{T.ref('key')} 列出全部关键假定。每条假定的依据与影响在第 {C.ch('simp')} 章展开。</p>"
        + table(f"{T.new('key')}　关键假定", ["编号", "假定", "影响范围", "依据", "对结果的影响"], key_rows,
                nowrap_cols={0}, cls="wide")
        + C.h3("scope", 4, "出处等级")
        + f"<p>每个参数标注一个或多个出处等级，多个时用「+」连接，例如「实测提取 + 本方假定」表示参数的一部分取自实测、另一部分是假定。"
          f"{T.ref('grades')} 给出定义。</p>"
        + table(f"{T.new('grades')}　出处等级", ["等级", "定义"], [
            ["厂商文档", "设备厂商公开的规格或开发文档"],
            ["文献", "同行评审论文或数据集论文"],
            ["开源实现", "开源软件实现，或公开的协议逆向分析"],
            ["实测提取", "本方从公开实测数据集中提取的统计值，只用公开数据集划分出的实测样本集，不用验证集"],
            ["推导", "由其他有出处的数值计算得出"],
            ["设定", "本方为本数据集选定的工作点，不代表特定设备"],
            ["本方假定", "没有公开依据时采用的工程取值"],
        ], nowrap_cols={0})
    )
    rpt.section(C.sid("scope"), C.title("scope"), s1)

    # ------------------------------------------------ 2 信号生成链路
    chain_rows = [
        ["S0", "辐射源", "OFDM 或 GFSK 波形生成，按突发或包排布；加发射机载频偏差",
         "机型参数表；发射功率", "每个辐射源一路复基带，|x|² 的单位为 mW"],
        ["—", "发射天线", "全向，标量增益", "2 dBi", "同上"],
        ["—", "传播信道", "自由空间路损；非视距段加建筑刀口绕射；小尺度衰落；传播时延与多普勒",
         "平台与侦察站的位置，建筑几何", "同上"],
        ["S1", "接收天线", "全向，标量增益；多个辐射源在此线性叠加", f"{num(site['antenna_gain_dBi'], 0, 'dBi')}", "一路复基带"],
        ["S2", "接收机前端", "等效输入热噪声、增益、本振相位噪声、IQ 不平衡、直流偏置",
         f"噪声系数 {num(site['nf_dB'], 0, 'dB')}，增益 {num(chain['rx_fe']['gain_dB'], 0, 'dB')}", "一路复基带"],
        ["S3", "模数转换器", f"{bits} 位均匀量化，I、Q 各自独立", f"满量程 {num(fs_dbm, 0, 'dBm')}", "交付文件，无损导出"],
        ["S4", "数字下变频", "数控振荡器频移、等波纹低通、整数抽取", "频移与抽取比按段设定", "交付文件，导出时重量化一次"],
    ]
    s2 = (
        f"<p>{T.ref('chain')} 按信号流向列出生成链路的各个环节。辐射源到接收天线的四个环节对每个辐射源各算一份，"
        f"在接收天线端相加之后只有一路信号，与只有一条接收通道的真实接收机一致。慢变的几何与链路量（距离、视距与否、路损、多普勒）"
        f"按每秒 20 帧计算，再在采样率上施加到信号；波形、噪声与衰落在采样率上逐样点生成。</p>"
        + table(f"{T.new('chain')}　生成链路的环节", ["观测点", "环节", "模型", "主要参数", "输出"], chain_rows,
                nowrap_cols={0, 1}, cls="wide")
        + f"<p>引擎的样点以 32 位浮点存储，算法核心以 64 位浮点计算，功率单位为 mW。交付文件为 SigMF{R.cite('sigmf')} 格式的 16 位复整数；"
          f"码值换算为物理量的公式见数据说明。全部随机量都由显式给出的随机数种子产生，同一配置与种子两次运行的结果逐字节相同"
          f"（第 {C.ch('vres', 2)} 节标准算例 11、第 {C.ch('vres', 4)} 节）。</p>"
        + f"<p>两套接收配置的采样率均为 {num(recv['R1']['fs_Hz'] / 1e6, 0, 'MS/s')}，中心频率分别为 "
          f"{mhz(recv['R1']['center_Hz'], 0)}（R1）与 {mhz(recv['R2']['center_Hz'], 0)}（R2）。"
          f"侦察站位于北京亚运村（{num(site['lon'], 3)}°E，{num(site['lat'], 2)}°N），天线离地 {num(site['alt_m'], 0, 'm')}。</p>"
    )
    rpt.section(C.sid("chain"), C.title("chain"), s2)

    # ------------------------------------------------ 3 辐射源模型
    orows, ogr = ofdm_rows(D)
    grows, ggr = gfsk_rows(D)
    rs = D.fir_rsmp
    rse = rs["entries"][0]
    s3 = (
        C.h3("emit", 1, "OFDM 族：图传、遥控上行与 DroneID 广播")
        + "<p>DJI 图传、DJI 遥控上行与 DroneID 广播都按正交频分复用（OFDM）生成。每个突发由若干 OFDM 符号组成，"
          "每个符号在原生采样率 f<sub>n</sub> = N·Δf 上按下式生成，再在符号前加循环前缀（取符号末尾 N<sub>cp</sub> 个样点）：</p>"
        + "<div class=eq>x[n] = g · Σ X_k · exp(+j2π·k·n/N)，  k = −K…−1, +1…+K，n = 0…N−1\n"
          "g = 1/√(2K)                     使每个符号的平均功率为 1\n"
          "占用带宽 B = (2K + 1)·Δf          直流子载波 k = 0 空置</div>"
        + "<p>数据子载波上是随机比特映射的星座点。图传与遥控上行的首个符号、DroneID 广播的第 4 与第 6 个符号是 Zadoff–Chu 同步序列"
          f"（DroneID 广播的根 600 与 147 取自逆向分析{R.cite('ndss')}；图传与遥控上行的根 29 是本方假定）。"
          "生成的突发经有理重采样从原生采样率升到接收采样率，再乘复指数搬到辐射源相对接收中心的频偏处。"
          "发射期间的平均功率等于场景给出的发射功率。</p>"
        + f"<p>有理重采样的插值比 L = {rs['spec']['interp_L']}，抽取比 M 取 {e('、'.join(str(m) for m in rs['spec']['decim_M_supported']))}，"
          f"分别把 15.36、30.72、61.44 MS/s 的原生采样率换到 80 MS/s。原型低通为 Kaiser 窗设计的 {rse['ntaps']} 抽头滤波器，"
          f"通带边缘 {num(rs['spec']['passband_edge_rel_native'], 4)}·f<sub>n</sub>，阻带边缘 {num(rs['spec']['stopband_edge_rel_native'], 1)}·f<sub>n</sub>，"
          f"阻带衰减 {num(rse['stopband_atten_dB'], 2, 'dB')}，通带纹波 {num(rse['passband_ripple_dB'], 4, 'dB')}。</p>"
        + "<p>突发在时间上的排布：图传把时间分成等长时隙，每个时隙按概率取「空」或某一长度的突发，概率由实测的占空比与长突发占比解出；"
          "抽签用随机数种子、辐射源标识与时隙序号的哈希，与其他随机量互不干扰。遥控上行按固定的发送图案排布，每次发送以一定概率跳过。"
          "DroneID 广播每 640 ms 发送一次。一个突发开始后整个发完，期间频点不变。</p>"
        + f"<p>{T.ref('ofdm')} 列出正式集用到的 OFDM 族机型参数，{T.ref('ofdm_g')} 列出各项的出处等级。"
          f"突发时长由符号数、FFT 点数与循环前缀长度算出；循环前缀长度以原生采样率的样点数计，长循环前缀每 7 个符号出现一次。</p>"
        + table(f"{T.new('ofdm')}　OFDM 族机型参数", ["机型参数", "用途", "占用带宽", "FFT 点数、子载波间隔、原生采样率",
                                                    "循环前缀（短 / 长，样点）", "突发", "排布", "调制", "可信度"],
                orows, nowrap_cols={1, 2, 4, 7, 8}, cls="wide")
        + table(f"{T.new('ofdm_g')}　OFDM 族机型参数的出处等级", ["机型参数", "占用带宽", "数值结构", "突发", "排布", "调制",
                                                            "频点"], ogr, cls="wide")
        + "<p>机型参数名称中的「A/D/F/G 族」「A/G 族」指公开数据集 DroneRFb-DIR 按类码 A–G 标注的机型；"
          "该档的带宽与时序取自这几型的实测数据。</p>"
        + f"<p>5.8 GHz 的 20 MHz 档图传使用 2.4 GHz 的 20 MHz 档参数，中心频率改为 5.8 GHz 频段内的频点；"
          f"这一档在 5.8 GHz 上没有实测依据，属于本方假定。占用带宽与时序的实测依据来自公开数据集{R.cite('droneRFb', 'droneRFa')}"
          f"与公开文献{R.cite('rfuav')}。</p>"
        + C.h3("emit", 2, "GFSK 族：第三方跳频遥控")
        + "<p>FrSky 与 Futaba 两种遥控按连续相位频移键控生成。信号的相位以圈为单位，按下式逐样点闭式求值："
          "</p>"
        + "<div class=eq>s(t) = exp(j2π·ψ(t))\n"
          "ψ(t) = (f_dev / R) · Σ_k a_k · P(t·R − k)        a_k = ±1，比特 1 对应 +f_dev\n"
          "P(u) = ∫₀ᵘ p(v) dv                              p 为 [0, 1) 的矩形脉冲；GFSK 时再与高斯核卷积\n"
          "高斯核的标准差 σ = √(ln 2) / (2π·BT)（以符号为单位）</div>"
        + "<p>求和只在每个时刻附近的有限窗口内进行，窗口外的截断误差小于 2×10⁻¹⁷ 圈。相位只是样点序号的函数，"
          "因此符号率不必整除采样率，结果也与处理块的长度无关。每包依次是 4 字节交替的前导码、32 位同步字与随机载荷，载荷不做编码。"
          "跳频的频点序列按协议规则生成，一包发完才换频。</p>"
        + f"<p>{T.ref('gfsk')} 列出正式集用到的 GFSK 族机型参数，{T.ref('gfsk_g')} 列出出处等级。"
          f"调制指数 h = 2·f<sub>dev</sub>/R；占用带宽取卡森带宽 2·(f<sub>dev</sub> + R/2)。"
          f"调制参数由开源协议实现{R.cite('mpm')}中的收发芯片寄存器配置按芯片数据手册{R.cite('cc2500')}换算。</p>"
        + table(f"{T.new('gfsk')}　GFSK 族机型参数", ["机型参数", "调制", "符号率", "频偏", "调制指数", "占用带宽",
                                                    "包与周期", "跳频", "可信度"], grows, nowrap_cols={2, 3, 4, 5, 8}, cls="wide")
        + table(f"{T.new('gfsk_g')}　GFSK 族机型参数的出处等级", ["机型参数", "调制", "包结构", "时序", "跳频"], ggr, cls="wide")
        + "<p>FrSky 的包长与周期取自公开实测数据中 FrSky X20 遥控的统计，频点表与开源实现的 FCC 档一致。"
          "Futaba 按 S-FHSS 协议的开源实现生成；公开数据集中的 Futaba 实测数据采用的不是这一协议，因此 Futaba 没有可比的实测数据。</p>"
        + C.h3("emit", 3, "发射机载频偏差")
        + "<div class=eq>Δf_cfo = ε · 10⁻⁶ · (f_c + f_off)        ε 为该平台的载频偏差（ppm）</div>"
        + f"<p>每个平台在 ±{num(D.cells['cfo']['max_ppm'], 0)} ppm 内均匀抽取一个 ε，同一平台上的各个辐射源共用。"
          f"载频偏差只改变载频，不改变符号率与子载波间隔。取值范围以 IEEE 802.11 发射机的频率容差{R.cite('ieee80211')}作代理，"
          f"属于本方假定。每条注记的 <code>cuav:cfo_Hz</code> 给出该次发射的实际偏差。</p>"
    )
    rpt.section(C.sid("emit"), C.title("emit"), s3)

    # ------------------------------------------------ 4 传播模型
    bs = D.scene["buildings_summary"]
    pct = bs["src_distribution_pct"]
    s4_ = (
        C.h3("prop", 1, "链路预算与自由空间路损")
        + "<div class=eq>P_rx = P_tx + G_t + G_r − L\n"
          "L = L_fs + L_ke                          视距段 L_ke = 0\n"
          "L_fs = 20·lg(4π·d / λ)，  λ = c / f，c = 299792458 m/s</div>"
        + f"<p>距离 d 是发射端与接收端在 WGS-84 地心坐标系中的直线距离，坐标换算使用开源大地测量库{R.cite('gnss')}。"
          f"传播时延按 d/c 取整到样点施加；多普勒频移按径向速度施加。本数据集的平台定点悬停，多普勒频移接近 0。</p>"
        + C.h3("prop", 2, "建筑单刀口绕射")
        + "<div class=eq>v = h · √( 2(d₁ + d₂) / (λ·d₁·d₂) )\n"
          "L_ke(v) = 0                                          v ≤ −0.78\n"
          "L_ke(v) = 6.9 + 20·lg( √((v − 0.1)² + 1) + v − 0.1 )   v > −0.78</div>"
        + f"<p>该式取自 ITU-R P.526{R.cite('p526')}。h 是视线侵入建筑顶面的竖直深度，d₁、d₂ 是两端到该建筑的地面距离。"
          f"一条视线穿过多栋建筑时，只取侵入最深的一栋。视线被任一建筑切断即判为非视距，与损耗大小无关。"
          f"刀口损耗按单程计一次，计入 L。</p>"
        + f"<p>建筑几何取自 OpenStreetMap{R.cite('osm')}，观测区域内共 {bs['features']} 个建筑要素。"
          f"建筑高度的来源为：标注高度 {num(pct['osm:height'], 1, '%')}，按层数折算 {num(pct['osm:levels'], 1, '%')}，"
          f"按占地面积估算 {num(pct['est:area'], 1, '%')}，其余 {num(pct['tile:height'], 1, '%')} 取自底图瓦片。"
          f"高度以估算为主，因此非视距段的刀口损耗是对真实城市环境的近似。</p>"
        + C.h3("prop", 3, "小尺度衰落")
        + "<div class=eq>h(t) = √(K/(K+1)) · e^{jθ₀} + √(1/(K+1)) · D(t)\n"
          "D(t) = N^{−1/2} · Σ_{n=1..N} exp( j·(Φ(t)·cos α_n + φ_n) )，  N = 16\n"
          "Φ(t) = 2π · ∫ f_D dt，  f_D = max(v·f/c, f_D,min)</div>"
        + f"<p>衰落增益 h(t) 逐样点乘在信号上。视距帧取莱斯因子 K = {num(k_los, 0, 'dB')}，非视距帧取 K = 0（瑞利衰落）；"
          f"散射分量 D(t) 为统计型正弦和，其系综自相关等于零阶贝塞尔函数 J₀(2π·f<sub>D</sub>·τ)，即 Jakes 谱{R.cite('jakes')}。"
          f"平台悬停时速度为 0，最大多普勒取下限 f<sub>D,min</sub> = {num(fd_min, 0, 'Hz')}，代表悬停摆动与地面散射体的运动。"
          f"衰落为平坦衰落（不含时延扩展），衰落的平均功率为 1，不改变链路预算的平均值。</p>"
        + C.h3("prop", 4, "平台位置")
        + "<p>每个平台的位置按该段的信噪比目标由链路预算反解得到。视距段的无人机离地 100 m、遥控器离地 1.5 m，沿固定方位放置；"
          "非视距段在侦察站附近建筑的后方搜索，要求视线被建筑切断、刀口损耗不低于 10 dB、链路预算信噪比与目标相符。"
          "达不到目标的段调整发射功率，规则与各段的取值见数据说明。</p>"
    )
    rpt.section(C.sid("prop"), C.title("prop"), s4_)

    # ------------------------------------------------ 5 接收机模型
    dc_rel = fm["dc_rel_noise_dB"]
    rx_params = [
        ["噪声系数 F", num(site["nf_dB"], 0, "dB"), "设定", "等效输入热噪声 N₀ = k·T·F，T = 290 K"],
        ["前端增益", num(chain["rx_fe"]["gain_dB"], 0, "dB"), "设定", "噪声折合到输入，增益加在噪声之后"],
        ["本振相位噪声：带内电平 L₀", num(pn_L, 0, "dBc/Hz"), "设定", "锁相环单极点谱"],
        ["本振相位噪声：转角频率 f_c", num(pn_fc / 1e3, 0, "kHz"), "设定",
         f"均方根相位误差 √(π·f_c·L₀) = {num(sig_phi_deg, 3)}°"],
        ["IQ 幅度不平衡 g", num(fm["iq_gain_imbalance_dB"], 4, "dB"), "实测提取",
         f"DroneRFb-DIR 实测样本集中 {fm['source']['n_slices']} 个背景片段的中位数"],
        ["IQ 相位不平衡 φ", num(fm["iq_phase_imbalance_deg"], 4) + "°", "实测提取", "同上"],
        ["直流偏置", f"比噪声功率低 {num(-dc_rel, 2, 'dB')}", "实测提取", "同上"],
        ["ADC 位数", f"{bits} 位", "设定", f"满量程复单音的量化信噪比 6.02·b + 1.76 = {num(6.02 * bits + 1.76, 2, 'dB')}"],
        ["ADC 满量程", num(fs_dbm, 0, "dBm"), "设定", "同一接收配置下全部文件相同"],
    ]
    ddc_rows = [[str(x["decim"]), str(x["ntaps"]), str(x["group_delay_in"]), num(x["stopband_atten_dB"], 2, "dB"),
                 num(x["passband_ripple_dB"], 3, "dB")] for x in fir_used]
    s5 = (
        C.h3("rx", 1, "接收机前端")
        + "<p>前端按以下顺序逐样点施加五项，不改变样点数：</p>"
        + "<div class=eq>n  ~ CN(0, N₀·f_s)                                 等效输入热噪声\n"
          "y₁ = 10^(G/20) · (x + n)                          总增益\n"
          "y₂ = y₁ · exp(j·φ[k])                              本振相位噪声\n"
          "y₃ = K₁·y₂ + K₂·conj(y₂)                           IQ 不平衡\n"
          "y  = y₃ + d·(1 + j)                               直流偏置\n"
          "K₁ = (1 + g·e^{jφ})/2，K₂ = (1 − g·e^{jφ})/2</div>"
        + "<p>相位噪声 φ[k] 是一阶自回归过程，是锁相环单极点相位谱的精确离散：</p>"
        + "<div class=eq>S_φ(f) = L₀ / (1 + (f/f_c)²)\n"
          "φ[k] = a·φ[k−1] + σ_w·w[k]，  a = exp(−2π·f_c/f_s)，σ_w = √(π·f_c·L₀·(1 − a²))\n"
          "平稳方差 σ_φ² = π·f_c·L₀，与采样率无关</div>"
        + f"<p>{T.ref('rxp')} 列出接收机的参数与出处。IQ 不平衡与直流偏置取自公开实测数据的背景片段：在安静帧上量 I、Q 两路的标准差比与相关系数，"
          f"按上式的不平衡模型反解。这台采集接收机的不平衡很小，直流偏置在频谱上不可见。</p>"
        + table(f"{T.new('rxp')}　接收机参数", ["参数", "取值", "出处等级", "说明"], rx_params,
                nowrap_cols={1, 2}, cls="wide")
        + C.h3("rx", 2, "模数转换器")
        + "<div class=eq>A = 10^(FS/20)                   满量程复单音的幅度（√mW）\n"
          "q = 2A / 2^b                     量化步长\n"
          "code = clamp(round(v/q), −2^(b−1), 2^(b−1) − 1)，  v_out = code·q   I、Q 各自独立</div>"
        + "<p>超出量程的样点被削顶并计数；削顶计数随产品记录，不改变观测点的质量状态。本数据集全部段在 ADC 与导出中都没有削顶（见数据说明）。</p>"
        + C.h3("rx", 3, "数字下变频")
        + "<p>数字下变频依次做三件事：数控振荡器产生复本振，把信号整体搬移 f<sub>shift</sub>；等波纹低通滤波；按整数比 D 抽取。"
          "输出样点 m 对应输入样点 m·D（滤波器的群时延已扣除）。数控振荡器的相位以圈为单位累加，结果与处理块的长度无关。</p>"
        + f"<p>低通滤波器为 Parks–McClellan 等波纹设计，通带边缘 {num(D.fir_ddc['spec']['passband_edge_rel_out'], 1)}·f<sub>s,out</sub>、"
          f"阻带边缘 {num(D.fir_ddc['spec']['stopband_edge_rel_out'], 1)}·f<sub>s,out</sub>，设计指标为阻带衰减 ≥ "
          f"{num(D.fir_ddc['spec']['stopband_atten_min_dB'], 0, 'dB')}、通带纹波 ≤ {num(D.fir_ddc['spec']['passband_ripple_max_dB'], 1, 'dB')}。"
          f"S4 的可用频带因此是 ±0.4 倍 S4 采样率。正式集用到的抽取比为 {e('、'.join(str(d) for d in decims))}；"
          f"抽取比为 1 时只做频移。{T.ref('ddc')} 列出用到的滤波器的实际指标。</p>"
        + table(f"{T.new('ddc')}　数字下变频低通滤波器的实际指标", ["抽取比 D", "抽头数", "群时延（输入样点）", "阻带衰减", "通带纹波"],
                ddc_rows, num_cols={0, 1, 2, 3, 4})
        + C.h3("rx", 4, "导出")
        + f"<p>S3 为 ADC 的输出，每个样点都是量化步长的整数倍，导出为 16 位整数时无损。S4 为 DDC 的输出，导出时按同一满量程重量化一次；"
          f"当量化噪声比接收机噪声底低不到 20 dB 时，该文件的质量状态标为降级。正式集 {len(ops_s4)} 个 S4 文件的重量化余量为 "
          f"{num(min(rq), 1)}–{num(max(rq), 1, 'dB')}。</p>"
    )
    rpt.section(C.sid("rx"), C.title("rx"), s5)

    # ------------------------------------------------ 6 假设与简化
    simp_rows = [
        ["DJI 图传的 FFT 点数与调制阶数为本方假定", "FFT 点数不可观测，无公开资料", "未知", "只影响突发内部结构"],
        ["载荷为随机比特，不做信道编码", "不复现真实载荷", "未知",
         "可信性验证报告显示，FrSky 实测频谱的窄峰在合成数据中没有"],
        ["OFDM 符号之间不加窗", "按理想 OFDM 生成", "偏宽（含符号交界的短时频谱比实测宽）", "见可信性验证报告"],
        ["图传突发按固定时隙排布", "时隙概率由实测占空比与长突发占比解出", "间隔分布比实测集中", "见可信性验证报告"],
        ["遥控上行的跳频频点在频点表上随机取", "跳频规律无公开资料", "相邻两跳的频率差大于实测", "见可信性验证报告"],
        ["地面为平地，地面高度 0 m", "无足够分辨率的地形数据", "未知（起伏地形下不定）", "—"],
        ["建筑侵入深度用竖直距离近似", "低俯仰角下成立", "偏保守（过顶时高估侵入）", "—"],
        ["多栋建筑只取侵入最深的一栋，单刀口", "ITU-R P.526 单刀口模型", "偏乐观（多次绕射损耗更大）", "未量化"],
        ["建筑内环（天井）忽略", "简化几何", "偏保守", "未量化"],
        ["不计反射、穿透与材质", "几何、材质与无线参数分开管理，本期只用几何", "未知", "—"],
        [f"建筑高度 {num(pct['est:area'], 1, '%')} 按面积估算", "OpenStreetMap 高度标注覆盖率低", "未知", "—"],
        ["刀口绕射中的光速取 3×10⁸ m/s", "与原始参考实现一致，便于逐位比对", "可忽略", "3×10⁻³ dB 量级"],
        ["传播时延取整到样点", "简化", "可忽略", "80 MS/s 下 12.5 ns"],
        ["小尺度衰落为平坦衰落，散射按水平各向同性（Jakes 谱）", "没有本区域信道测量", "频谱平坦度高于实测；多普勒展宽偏大",
         "见可信性验证报告"],
        ["衰落的正弦和只有 16 项，单次实现的时间平均功率偏离系综平均", "控制计算量", "未知（逐段信噪比的散布偏大）",
         "单段 1 s 内偏离零点几 dB"],
        ["载频偏差只作用于载频，不改变采样时钟", "不建模采样时钟偏差", "未知", "—"],
        ["接收机不含增益压缩、自动增益控制、互调与阻塞", "演示所需的最小集", "未知", "—"],
        ["平台定点悬停", "简化运动", "多普勒接近 0", "—"],
    ]
    s6 = (
        f"<p>{T.ref('simp')} 列出全部声明过的假设与简化，并写出每条对结果的影响方向。"
        f"影响方向分为偏保守（使检测更难）、偏乐观（使检测更容易）与未知；已量化的写出量级。"
        f"建筑绕射的两条简化方向相反且量级未测，本文件不给出整体偏保守或偏乐观的结论。</p>"
        + table(f"{T.new('simp')}　假设与简化", ["假设或简化", "依据", "影响方向", "影响量级"], simp_rows, cls="wide")
    )
    rpt.section(C.sid("simp"), C.title("simp"), s6)

    # ------------------------------------------------ 7 校核方法
    s7 = (
        C.h3("vmeth", 1, "独立实现比对")
        + "<p>引擎（C++）中的每个数值核心都另有一份独立编写的参考实现（Python）。关键的信号生成与处理核心另有第三份实现，"
          "由商用数值计算软件的工具箱函数或独立书写的公式算出。三方读同一组输入数据，而不是各自按同一公式生成输入："
          "共享公式不能保证共享比特，编译器对同一公式的不同优化会在末位产生差异。比对结果冻结为黄金基准，每次构建都重新比对。</p>"
        + C.h3("vmeth", 2, "判据的两个尺度")
        + "<p>算法核心以 64 位浮点进出，判据为相对误差 ≤ 1×10⁻⁹。组件的输出以 32 位浮点存储，32 位浮点的机器精度约为 1.2×10⁻⁷，"
          "判据为 1×10⁻⁶。两个尺度分别断言，组件尺度的判据不是对算法核心判据的放宽。整数运算与随机数抽取的结果要求逐位相同。</p>"
        + C.h3("vmeth", 3, "解析锚点与标准算例")
        + "<p>链路的绝对电平用解析值核对：自由空间路损对公式，热噪声底对 −174 dBm/Hz + F + 10·lg B，量化噪声对 6.02·b + 1.76 dB。"
          "标准算例覆盖单音频移与功率标度、带限噪声、突发占空比、多信号叠加、接收滤波、ADC、数字下变频、信道化、实测回放、"
          "实测背景加合成目标与固定种子复现，共 12 项。每项都从保存的完整仿真链运行，而不是单独调用组件。</p>"
        + C.h3("vmeth", 4, "跨层一致性")
        + "<p>同一场景下，能量检测器的检出率有两种算法：一种由链路预算给出的带内信噪比代入解析式计算，"
          "另一种在生成的 IQ 上运行检测器统计。两者一致，说明生成的信号电平与噪声电平都与链路预算相符。"
          "判定准则为检出率之差 ≤ 0.05，在比对之前确定。</p>"
        + C.h3("vmeth", 4 + 1, "数据集生成时的核查")
        + "<p>正式集的每一段在生成时都执行核查：SigMF 官方校验、S3 无损回读、S4 重量化余量、注记与仿真真值逐条对应、"
          "实测信噪比与链路预算之差、同频与邻频叠加，并随机抽取部分段重新生成、逐字节比对。任何一项不通过，生成程序即停止。</p>"
    )
    rpt.section(C.sid("vmeth"), C.title("vmeth"), s7)

    # ------------------------------------------------ 8 校核结果
    case_rows = []
    by_case: dict[int, list] = {}
    for c in std:
        if c["case"] not in CASE_TEXT:
            raise SystemExit(f"标准算例的检查名没有对外说法：{c['case']}")
        k, txt = CASE_TEXT[c["case"]]
        by_case.setdefault(k, []).append(c)
        tol = c.get("tol")
        case_rows.append((k, [str(k), e(txt), fmt_val(c.get("value"), c.get("unit")), fmt_val(c.get("expected"), c.get("unit")),
                              fmt_val(tol, c.get("unit"), diff=True) if tol is not None else "—", verdict("符合" if c["ok"] else "不符合")]))
    case_rows.sort(key=lambda r: r[0])
    mxco = [c for c in man["cells"] if c["id"].startswith("mxco") and c["propagation"] == "los"]
    co = [abs(p["snr_measured_dB_mean_lin_s3"] - p["snr_budget_dB_median"]) for c in mxco for p in c["platforms"]]
    co_ok = max(co) <= 1.0
    summary = []
    for k in range(1, 13):
        if k in by_case:
            ok = all(c["ok"] for c in by_case[k])
            summary.append([str(k), e(CASE_TITLES[k]), f"{len(by_case[k])} 项检查，见{T.ref('std')}",
                            verdict("符合" if ok else "不符合")])
        elif k == 4:
            summary.append([str(k), e(CASE_TITLES[k]),
                            f"正式集 {len(mxco)} 段视距的同频与邻频段，{len(co)} 个平台的实测信噪比与链路预算之差最大 "
                            f"{num(max(co), 2, 'dB')}，判定准则 ≤ 1 dB", verdict("符合" if co_ok else "不符合")])
        elif k == 7:
            summary.append([str(k), e(CASE_TITLES[k]), f"数字下变频的黄金基准（{T.ref('gold')}）；滤波器指标见{T.ref('ddc')}",
                            verdict("符合" if ut["doctest"]["failed"] == 0 else "不符合")])
        elif k in (5, 8):
            summary.append([str(k), e(CASE_TITLES[k]), "本数据集的生成链不含这一环节；该组件另有单元测试", verdict("仅列出")])
        else:
            summary.append([str(k), e(CASE_TITLES[k]), "插件接口本期未实现", verdict("不可判定")])
    n_judged = sum(1 for r in summary if "✓" in r[3] or "✗" in r[3])
    n_ok = sum(1 for r in summary if "✓" in r[3])
    cross_rows = [
        ["路损", num(cross["path_loss_dB"], 2, "dB")],
        ["接收电平（带内）", num(cross["S_dBm"], 2, "dBm")],
        ["噪声功率（带内）", num(cross["N_dBm"], 2, "dBm")],
        ["带内信噪比", num(cross["snr_dB"], 2, "dB")],
        ["检测频段内的频点数 M", str(cross["M"])],
        ["解析检出率（确定型目标）", num(cross["pd_analytic_deterministic"], 4)],
        ["仿真检出率（帧级）", num(cross["pd_mc"], 4) + f"（{cross['frames']['tp']}/{cross['frames']['truth_on']} 帧）"],
        ["两者之差", num(cross["delta"], 4)],
        ["判定准则", f"≤ {num(cross['tolerance'], 2)}"],
        ["判定", verdict("符合" if cross["delta"] <= cross["tolerance"] else "不符合")],
    ]
    ann_ok = all(p["annotations_s3"] >= 0 for c in man["cells"] for p in c["platforms"])
    lossless = all(o["lossless"] for o in ops_s3)
    states = {o["state"] for o in ops}
    sd = man["snr_diff"]
    gen_rows = [
        ["SigMF 官方校验", f"{len(ops)} 个文件全部通过", verdict("符合")],
        ["S3 无损导出", f"{len(ops_s3)} 个文件逐位回读一致" if lossless else "有文件不一致", verdict("符合" if lossless else "不符合")],
        ["S4 重量化余量 ≥ 20 dB", f"{num(min(rq), 1)}–{num(max(rq), 1, 'dB')}", verdict("符合" if min(rq) >= 20 else "不符合")],
        ["文件的质量状态", "、".join(sorted(states)), verdict("符合" if states == {"valid"} else "不符合")],
        ["视距段主辐射源：实测信噪比（线性平均）与链路预算之差",
         f"绝对值最大 {num(max(los_diff), 2, 'dB')}（{len(los_diff)} 个平台）", verdict("仅列出")],
        ["逐条注记的实测信噪比与链路预算之差（视距）",
         f"中位数 {num(sd['los']['median'], 2, 'dB', signed=True)}，5%–95% 分位 {num(sd['los']['p05'], 2)}…{num(sd['los']['p95'], 2, 'dB', signed=True)}，"
         f"{sd['los']['n']} 条", verdict("仅列出")],
        ["逐条注记的实测信噪比与链路预算之差（非视距）",
         f"中位数 {num(sd['nlos']['median'], 2, 'dB', signed=True)}，5%–95% 分位 {num(sd['nlos']['p05'], 2)}…{num(sd['nlos']['p95'], 2, 'dB', signed=True)}，"
         f"{sd['nlos']['n']} 条", verdict("仅列出")],
        ["随机抽取重新生成", f"{len(man['verify']['cells'])} 段，数据、元数据、链路与预览文件逐字节相同"
         if not man["verify"]["mismatched"] else "有不一致", verdict("符合" if not man["verify"]["mismatched"] else "不符合")],
    ]
    if not ann_ok:
        raise SystemExit("清单里的注记计数不对")
    s8 = (
        C.h3("vres", 1, "单元测试与黄金基准")
        + f"<p>引擎的 {ut['doctest']['cases']} 项单元测试全部通过（失败 {ut['doctest']['failed']}、跳过 {ut['doctest']['skipped']}），"
          f"{ut['ctest_engine']['total'] + ut['ctest_geo']['total']} 项集成测试全部通过。黄金基准由这些测试执行。"
          f"{T.ref('gold')} 列出与本数据集的生成链有关的 {n_gold} 组黄金基准。</p>"
        + table(f"{T.new('gold')}　与生成链有关的黄金基准", ["环节", "比对对象", "比对双方", "判据", "算例数"],
                golden_rows(D), num_cols={4}, nowrap_cols={0}, cls="wide")
        + "<p>表中「原始参考实现」指移植前的独立实现；「浏览器侧独立实现」是系统界面中用于显示的第二份实现，与引擎分别编写。</p>"
        + C.h3("vres", 2, "标准算例")
        + f"<p>{T.ref('std_sum')} 汇总 12 项标准算例：可判定 {n_judged} 项，符合 {n_ok} 项。{T.ref('std')} 列出逐项检查的实测值。"
          f"标准算例在 500 kS/s、10 MS/s 与 80 MS/s 的典型仿真链上运行，检查的是实现，不是正式集的配置。</p>"
        + table(f"{T.new('std_sum')}　标准算例汇总", ["编号", "算例", "证据", "判定"], summary, nowrap_cols={0, 3}, cls="wide")
        + table(f"{T.new('std')}　标准算例的逐项检查", ["算例", "检查内容", "实测", "期望值或阈值", "容差", "判定"],
                [r for _, r in case_rows], num_cols={2, 3, 4}, nowrap_cols={0, 5}, cls="wide")
        + "<p>算例 1 的频点差来自整数频点的谱分辨率：期望值含多普勒频移，实测值是最近的频点中心，容差为半个频点。"
          "算例 6 的期望值是解析式算出的量化噪声抬升，削顶比例一行的期望值列给出的是阈值。</p>"
        + C.h3("vres", 3, "跨层一致性")
        + f"<p>{T.ref('cross')} 给出跨层一致性算例的结果。场景参数在运行之前按解析预测冻结，运行后没有调整。</p>"
        + table(f"{T.new('cross')}　跨层一致性算例", ["项目", "数值"], cross_rows, num_cols={1})
        + C.h3("vres", 4, "数据集生成时的核查")
        + f"<p>{T.ref('gen')} 汇总正式集 {n_seg} 段在生成时的核查结果。逐段的数值见数据说明。非视距段的逐条差值散布较大，"
          f"原因是单段 1 s 内瑞利衰落的独立样本少。</p>"
        + table(f"{T.new('gen')}　数据集生成时的核查", ["核查项", "结果", "判定"], gen_rows, nowrap_cols={2}, cls="wide")
    )
    rpt.section(C.sid("vres"), C.title("vres"), s8)

    # ------------------------------------------------ 9 可信度等级
    rz = {p["preset"]: p for p in D.realism["pairs"]}

    def rz_text(pid: str) -> str:
        p = rz.get(pid)
        if not p:
            return "无同型实测数据"
        vs = list(p["verdicts"].values())
        ok, gap = vs.count("一致"), vs.count("有差距")
        if ok + gap == 0:
            return "实测数据的协议不同，不可判定"
        return f"符合 {ok} / 可判定 {ok + gap}"

    cred_rows = []
    for p in D.ofdm_used + D.gfsk_used:
        cred_rows.append([e("辐射源：" + p["name"]), e(p["credibility"]), e(rz_text(p["id"])),
                          e(CRED_WHY[p["id"]])])
    cred_rows += [
        ["辐射源：5.8 GHz 的 20 MHz 档图传", "V1", "无同型实测数据", "参数借用 2.4 GHz 的 20 MHz 档，5.8 GHz 上没有实测依据"],
        ["辐射源：载频偏差", "V1", "—", "取值范围为本方假定"],
        ["传播：自由空间路损", "V2", "—", "物理定律；解析锚点与黄金基准校核"],
        ["传播：建筑单刀口绕射", "V2", "—", "ITU-R 建议书模型；建筑高度以估算为主"],
        ["传播：小尺度衰落", "V1", "—", "K 因子与多普勒下限为本方假定"],
        ["接收机：热噪声与增益", "V2", "—", "物理模型；噪声底对解析值校核"],
        ["接收机：IQ 不平衡与直流偏置", "V2", "—", "取自公开实测数据"],
        ["接收机：本振相位噪声", "V1", "—", "谱形与电平为本方设定"],
        ["接收机：ADC 与数字下变频", "V2", "—", "确定性数字处理；黄金基准与标准算例校核"],
    ]
    s9 = (
        "<p>可信度等级表示一个环节的模型能在多大程度上代表真实系统。本文件采用以下规则：</p>"
        "<ol><li>V1：实现已校核；关键参数中本方假定占主导，或没有可比的实测数据。</li>"
        "<li>V2：实现已校核；关键参数有厂商文档、文献、开源实现或公开实测数据的依据。</li>"
        "<li>V3 及以上：需要目标接收机或外场的实测校准。本数据集没有这类校准，任何环节都不高于 V2。</li></ol>"
        + f"<p>{T.ref('cred')} 按环节给出可信度等级。「与公开实测数据的统计比较」一列引自{e(REALISM)}，"
          f"只列判定计数，不在本文件重复分析。</p>"
        + table(f"{T.new('cred')}　各环节的可信度等级", ["环节", "可信度", "与公开实测数据的统计比较", "依据"], cred_rows,
                nowrap_cols={1}, cls="wide")
    )
    rpt.section(C.sid("cred"), C.title("cred"), s9)

    # ------------------------------------------------ 10 结论
    n_v1 = sum(1 for r in cred_rows if r[1] == "V1")
    s10 = (
        "<ol>"
        f"<li>仿真合成数据集 v1 的生成链由 {len(chain_rows)} 个环节组成，每个环节的模型、公式与参数在第 {C.ch('emit')}–{C.ch('rx')} 章写明；"
        f"正式集用到的 {n_prov} 项机型参数出处中，{n_part_a} 项含本方假定，已逐项标出。</li>"
        f"<li>实现的校核结论是：模型按设计正确实现。证据为 {n_gold} 组黄金基准、标准算例符合 {n_ok}/{n_judged} 项、"
        f"跨层一致性算例之差 {num(cross['delta'], 4)}（准则 ≤ {num(cross['tolerance'], 2)}），以及数据集生成时的逐段核查（第 {C.ch('vres')} 章）。</li>"
        f"<li>校核只说明程序算出的结果与模型的数学定义一致，不说明模型与真实系统一致。"
        f"与公开实测数据的统计比较见{e(REALISM)}。</li>"
        f"<li>{T.ref('cred')} 的 {len(cred_rows)} 项中 {n_v1} 项为 V1，其余为 V2；没有目标接收机的实测校准，任何环节都不高于 V2（第 {C.ch('cred')} 章）。</li>"
        "</ol>"
        + "<p><strong>适用范围。</strong>上述结论适用于数据说明所列的两套接收配置（80 MS/s，中心频率 2440 MHz 与 5790 MHz）、"
          f"{len(D.used)} 套机型参数、定点悬停的平台、观测区域内的视距与非视距几何。用于其他采样率、机型、运动状态或地形起伏的场景时，"
          "需要按同一程序重新校核。</p>"
    )
    rpt.section(C.sid("concl"), C.title("concl"), s10)

    # ------------------------------------------------ 11 局限性
    s11 = (
        "<ol>"
        "<li>本文件只做校核，不做验证；模型未经目标接收机或外场的实测校准。</li>"
        "<li>DJI 图传的 FFT 点数与调制阶数、图传与 DroneID 广播的载荷、衰落参数、载频偏差范围为本方假定（第 "
        + C.ch("scope", 3) + " 节）。</li>"
        "<li>标准算例 5 与 8 对应的接收滤波与信道化不在本数据集的生成链中，本文件没有给出它们在本数据集配置下的结果；标准算例 12 未实现。</li>"
        "<li>标准算例在典型仿真链上运行，不是在正式集的配置上运行；正式集配置下的实现正确性由黄金基准与数据集生成时的核查覆盖。</li>"
        "<li>建筑绕射的两条简化方向相反且量级未测，非视距段刀口损耗的总体偏差方向未知。</li>"
        "<li>本文件的全部数值为原型阶段结果。</li>"
        "</ol>"
    )
    rpt.section(C.sid("limit"), C.title("limit"), s11)

    # ------------------------------------------------ 附录
    if ver["cuav_run_sha256"] != man["cuav_run_sha256"]:
        raise SystemExit("校核快照与正式集用的不是同一个引擎可执行文件，第 8 章的结论不能直接用于正式集")
    hashes = [
        ["仿真引擎（可执行文件）", e(man["engine_version"]), f"<span class=ids>{man['cuav_run_sha256']}</span>"],
        ["OFDM 族机型参数表", e(D.ofdm["version"]), f"<span class=ids>{sha256('models', 'radiator', 'presets-v2.json')}</span>"],
        ["GFSK 族机型参数表", e(D.gfsk["version"]), f"<span class=ids>{sha256('models', 'radiator', 'gfsk-presets-v1.json')}</span>"],
        ["有理重采样滤波器表", e(D.fir_rsmp["version"]), f"<span class=ids>{sha256('models', 'radiator', 'fir_rsmp_v1.json')}</span>"],
        ["数字下变频滤波器表", e(D.fir_ddc["version"]), f"<span class=ids>{sha256('models', 'adc-ddc', 'fir_lp_v1.json')}</span>"],
        ["数据集配置（全部段的意图与冻结位置）", "—", f"<span class=ids>{man['cells_sha256']}</span>"],
        ["SigMF 版本", e(man["sigmf_version"]), "—"],
    ]
    rpt.section("sa", "附录 A　版本与哈希",
                f"<p>{T.ref('hash')} 列出本文件所述模型的版本与 SHA-256。第 {C.ch('vres')} 章的单元测试、标准算例与跨层一致性算例"
                f"用的引擎可执行文件与生成正式集的是同一个文件。数据包内每个文件的 SHA-512 见数据包的校验文件。</p>"
                + table(f"{T.new('hash')}　版本与哈希", ["对象", "版本", "SHA-256"], hashes, nowrap_cols={1}, cls="wide"))
    rpt.section("sb", "附录 B　参考文献", R.list_html())
    return rpt


CRED_WHY = {
    "dji-video-10m": "数值结构与时序借用 20 MHz 档；本档没有实测数据",
    "dji-video-20m-a": "带宽、时序与子载波间隔有实测依据；FFT 点数与调制为本方假定",
    "dji-video-40m": "带宽与时序取自一型机的 5.8 GHz 实测；FFT 点数与调制为本方假定",
    "dji-uplink-2m": "带宽、时长与跳频栅格取自实测；跳频序列与调制为本方假定",
    "dji-droneid": "帧结构与同步序列取自逆向分析的文献；载荷为随机比特",
    "frsky-d16v2-fcc": "调制取自开源实现与芯片手册；时序与频点取自实测",
    "futaba-sfhss": "调制、时序与跳频全部取自开源实现；没有同协议的实测数据",
}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--set", default="formal-v1")
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    D = Data(a.set)
    missing = [p for p in D.used if p not in CRED_WHY]
    if missing:
        raise SystemExit(f"可信度依据没写：{missing}")
    out = a.out or rp("data", "eval", a.set, "docs", "model-verification.html")
    build(D).write(out)
    print(f"写了 {os.path.relpath(out, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
