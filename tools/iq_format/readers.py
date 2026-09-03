"""源数据适配器：把公开数据集的 HDF5 读成本项目要的样点流与元数据。

**两个数据集的全部专有知识集中在本文件**，别处不得再写死数据集细节。
事实依据是 `WORKLOG.md` 2026-09-03 第一、三、四条日志（实测核实与论文引用已在其中分列），
接入步骤是 06 备忘录 §11.4 与 §11.5。

一条硬规矩（06 §11.4 DS-3、§11.5 DA-3）：凡是论文给出、文件本身不携带的参数，`field_sources`
一律标 `paper`，并在 quality.reasons 里留下对应条目。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Iterator

import h5py
import numpy as np

CHUNK_SAMPLES = 4_000_000   # 每块 400 万复样点：float64 源约 64 MB，可控

# ---------------------------------------------------------------- DroneRFb-DIR

# 机型码对照，引自论文（WORKLOG 2026-09-03 第一条）
DRONERFB_MODELS = {
    "A": "DJI Mavic 3 Pro", "C": "DJI Mini 2 SE", "D": "DJI Mini 4 Pro",
    "E": "DJI Mini 3", "F": "DJI Air 3", "G": "DJI Air 2S",
}
# 文件名形态：A1_IN_S0_slice_43.mat / A1_OUT_slice_10.mat / background_slice_1.mat
_RFB_NAME = re.compile(
    r"^(?P<cls>[A-G])(?P<indiv>\d)_(?P<vis>IN|OUT)(?:_S(?P<sess>\d))?_slice_(?P<slice>\d+)$")
_RFB_BG = re.compile(r"^background_slice_(?P<slice>\d+)$")

# ------------------------------------------------------------------- DroneRFa

# 机型码对照，引自论文表 3（WORKLOG 2026-09-03 第三条）
DRONERFA_MODELS = {
    "T0000": "背景(含蓝牙、WiFi)", "T0001": "DJI Phantom 3", "T0010": "DJI Phantom 4 Pro",
    "T0011": "DJI MATRICE 200", "T0100": "DJI MATRICE 100", "T0101": "DJI Air 2S",
    "T0110": "DJI Mini 3 Pro", "T0111": "DJI Inspire 2", "T1000": "DJI Mavic Pro",
    "T1001": "DJI Mini 2", "T1010": "DJI Mavic 3", "T1011": "DJI MATRICE 300",
    "T1100": "DJI Phantom 4 Pro RTK", "T1101": "DJI MATRICE 30T", "T1110": "DJI AVATA",
    "T1111": "DJI通信模块自组机", "T10000": "DJI MATRICE 600 Pro",
    "T10001": "VBar 飞控器", "T10010": "FrSky X20 飞控器", "T10011": "Futaba T6IZ 飞控器",
    "T10100": "Taranis Plus 飞控器", "T10101": "RadioLink AT9S 飞控器",
    "T10110": "Futaba T14SG 飞控器", "T10111": "云卓 T12 飞控器", "T11000": "云卓 T10 飞控器",
}
# 距离档，引自论文；**是区间不是点值**（D-019）
DRONERFA_DISTANCE = {"D00": (20.0, 40.0), "D01": (40.0, 80.0), "D10": (80.0, 150.0)}
# 通道到中心频率的映射。这两类与其余相反，实测确认（WORKLOG 2026-09-03 第三条 4.4 节）
DRONERFA_INVERTED = {"T10010", "T10100"}
DRONERFA_FREQ_NORMAL = {"RF0": 2.44e9, "RF1": 5.8e9}
DRONERFA_FREQ_INVERTED = {"RF0": 915e6, "RF1": 2.44e9}
# 文件名两种形态
_RFA_OUTDOOR = re.compile(r"^(?P<cls>T\d+)_(?P<dist>D\d{2})_S(?P<state>[01])(?P<seq>\d{3})$")
_RFA_INDOOR = re.compile(r"^(?P<cls>T\d+)_S(?P<state>[01])(?P<seq>\d{3})$")


@dataclass
class SourceRead:
    """一个可转换的源：一条通道的样点流加上它的元数据。"""

    dataset: str
    doi: str | None
    source_file: str
    channel_id: str
    sample_rate_Hz: float
    center_frequency_Hz: float
    effective_bandwidth_Hz: float
    sample_count: int
    device: str
    antenna: str | None
    gain_dB: float | None
    time_basis: str
    continuity_flag: str
    continuity_note: str
    truth: dict | None
    field_sources: dict[str, str]
    quality_reasons: list[str]
    permission: dict
    credibility: str
    stem: str
    _path: str = field(repr=False, default="")
    _keys: tuple[str, str] = field(repr=False, default=("I", "Q"))

    def chunks(self, chunk_samples: int = CHUNK_SAMPLES) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        ik, qk = self._keys
        with h5py.File(self._path, "r") as h:
            n = self.sample_count
            for start in range(0, n, chunk_samples):
                stop = min(start + chunk_samples, n)
                yield h[ik][0, start:stop], h[qk][0, start:stop]


def _base_permission(dataset: str) -> dict:
    return {
        "owner": "浙江大学（公开发布）",
        "usage_scope": "研发内部使用；能否随交付系统分发待确认",
        "classification": "unconfirmed",
        "export_limit": None,
    }


def _rfb_truth(path: str, stem: str) -> tuple[dict | None, list[str]]:
    """DroneRFb 的真值。测试集文件名是纯数字，真值只在 <split>_labels.txt 里。"""
    notes: list[str] = []
    split_dir = os.path.dirname(os.path.abspath(path))
    split = os.path.basename(split_dir)
    label_file = os.path.join(os.path.dirname(split_dir), f"{split}_labels.txt")

    original = stem
    label = None
    if stem.isdigit() and os.path.exists(label_file):
        # 测试集：标签文件每行「原始文件名 序号」，序号即本文件名
        with open(label_file, encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == 2 and parts[1] == stem:
                    original, label = parts[0][:-4], parts[1]
                    break
        if label is None:
            notes.append(f"测试集文件 {stem} 在 {os.path.basename(label_file)} 中查不到，真值缺失")
            return None, notes
    elif os.path.exists(label_file):
        with open(label_file, encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == 2 and parts[0][:-4] == stem:
                    label = parts[1]
                    break

    m = _RFB_NAME.match(original)
    if m:
        cls = m.group("cls")
        return {
            "class_code": f"{cls}{m.group('indiv')}",
            "class_name": DRONERFB_MODELS.get(cls, "未知机型"),
            "individual": int(m.group("indiv")),
            "visibility": "LOS" if m.group("vis") == "IN" else "NLOS",
            "session": m.group("sess"),
            "slice_index": int(m.group("slice")),
            "split": split,
            "original_name": original,
            "label_in_file": label,
            "distance_m": 10.0,
            "motion": "static",
        }, notes
    if _RFB_BG.match(original):
        return {
            "class_code": "B", "class_name": "背景（现场无无人机开机）", "individual": None,
            "visibility": None, "session": None,
            "slice_index": int(_RFB_BG.match(original).group("slice")),
            "split": split, "original_name": original, "label_in_file": label,
            "distance_m": 10.0, "motion": "static",
        }, notes
    notes.append(f"文件名 {original!r} 不符合 DroneRFb 已知的两种形态，真值缺失")
    return None, notes


def open_source(path: str, channel: str | None = None) -> list[SourceRead]:
    """打开源文件，返回可转换的通道列表。源类型按 HDF5 根节点结构自动识别。"""
    stem = os.path.basename(path)
    stem = stem[:-4] if stem.lower().endswith(".mat") else stem
    with h5py.File(path, "r") as h:
        keys = set(h.keys())
        shapes = {k: h[k].shape for k in keys if isinstance(h[k], h5py.Dataset)}
        dtypes = {k: h[k].dtype for k in keys if isinstance(h[k], h5py.Dataset)}

    if {"I", "Q"} <= keys:
        return [_open_dronerfb(path, stem, shapes, dtypes)]
    if {"RF0_I", "RF0_Q"} <= keys:
        chans = [channel] if channel else ["RF0"]
        return [_open_dronerfa(path, stem, c, shapes, dtypes) for c in chans]
    raise ValueError(
        f"无法识别的源结构，根节点键为 {sorted(keys)}；"
        "已知两种：DroneRFb-DIR 的 {I,Q}，DroneRFa 的 {RF0_I,RF0_Q,RF1_I,RF1_Q}"
    )


def _open_dronerfb(path: str, stem: str, shapes: dict, dtypes: dict) -> SourceRead:
    n = int(shapes["I"][1])
    truth, notes = _rfb_truth(path, stem)
    reasons = [
        "源文件内无任何元数据，采样率、中心频率、设备型号取自论文（field_sources 标 paper）",
        "无绝对功率标定：缺接收增益、天线增益、馈线损耗与标定常数，量化码无法换算 dBm",
        "片内连续、片间不连续，且发布版无绝对时间戳",
    ] + notes
    return SourceRead(
        dataset="DroneRFb-DIR", doi="10.11999/JEIT240804", source_file=os.path.basename(path),
        channel_id="CH0", sample_rate_Hz=80e6, center_frequency_Hz=2.44e9,
        effective_bandwidth_Hz=80e6, sample_count=n, device="USRP-2955",
        antenna=None, gain_dB=None, time_basis="file_acquisition",
        continuity_flag="continuous",
        continuity_note="片内连续；片间不连续，不得跨片拼接（04 §9.2 连续性标志）",
        truth=truth,
        field_sources={
            "sampling.sample_rate_Hz": "paper", "frequency.center_frequency_Hz": "paper",
            "frequency.effective_bandwidth_Hz": "paper", "time.start_time": "absent",
            "time.time_basis": "derived", "time.continuity.flag": "paper",
            "channel.station_id": "absent", "channel.channel_id": "derived",
            "channel.antenna": "absent", "power.scale": "absent",
            "power.gain_dB": "absent", "power.agc": "absent",
        },
        quality_reasons=reasons, permission=_base_permission("DroneRFb-DIR"),
        credibility="V2",
        stem=f"dronerfb_{_ascii_stem(stem)}_CH0_S4",
        _path=path, _keys=("I", "Q"),
    )


def _open_dronerfa(path: str, stem: str, channel: str, shapes: dict, dtypes: dict) -> SourceRead:
    ik, qk = f"{channel}_I", f"{channel}_Q"
    if ik not in shapes:
        raise ValueError(f"源文件没有通道 {channel}，可用键 {sorted(shapes)}")
    n = int(shapes[ik][1])

    m_out = _RFA_OUTDOOR.match(stem)
    m_in = _RFA_INDOOR.match(stem)
    m = m_out or m_in
    if not m:
        raise ValueError(f"文件名 {stem!r} 不符合 DroneRFa 的两种形态 T#_D#_S# 与 T#_S#")
    cls = m.group("cls")
    inverted = cls in DRONERFA_INVERTED
    freq_map = DRONERFA_FREQ_INVERTED if inverted else DRONERFA_FREQ_NORMAL
    center = freq_map[channel]

    reasons = [
        "源文件内无任何元数据，采样率、中心频率、接收增益、天线取自论文（field_sources 标 paper）",
        "无绝对功率标定：论文给出接收增益 50 dB 与天线 3 dBi，但缺馈线损耗与一次标定常数，"
        "量化码仍无法换算 dBm",
        "每 1000 万点内连续、块间有连续性损伤（采—存交替模式），且无绝对时间戳",
    ]
    if inverted:
        reasons.append(f"{cls} 的通道映射与其余文件相反：RF0=915 MHz、RF1=2440 MHz（实测确认）")

    if m_out:
        lo, hi = DRONERFA_DISTANCE[m_out.group("dist")]
        truth = {
            "class_code": cls, "class_name": DRONERFA_MODELS.get(cls, "未知机型"),
            "scene": "城市户外飞行",
            "distance_bin": m_out.group("dist"), "distance_range_m": [lo, hi],
            "distance_point_m": None,   # 区间不得取点值（D-019）
            "motion": "flying, 5-15 m/s",
            "band_state": "initial" if m_out.group("state") == "0" else "switched",
            "segment_index": int(m_out.group("seq"), 2),
        }
    else:
        truth = {
            "class_code": cls, "class_name": DRONERFA_MODELS.get(cls, "未知机型"),
            "scene": "城市室内固定，距接收机约 2 m（论文）",
            "distance_bin": None, "distance_range_m": None, "distance_point_m": 2.0,
            "motion": "static",
            "band_state": "initial" if m_in.group("state") == "0" else "switched",
            "segment_index": int(m_in.group("seq"), 2),
        }

    return SourceRead(
        dataset="DroneRFa", doi="10.11999/JEIT230570", source_file=os.path.basename(path),
        channel_id=channel, sample_rate_Hz=100e6, center_frequency_Hz=center,
        effective_bandwidth_Hz=100e6, sample_count=n, device="USRP-2955",
        antenna="全向垂直，3 dBi", gain_dB=50.0, time_basis="file_acquisition",
        continuity_flag="damaged",
        continuity_note="每 1000 万点（0.1 s）内连续，块间有连续性损伤（采—存交替模式）",
        truth=truth,
        field_sources={
            "sampling.sample_rate_Hz": "paper", "frequency.center_frequency_Hz": "paper",
            "frequency.effective_bandwidth_Hz": "paper", "time.start_time": "absent",
            "time.time_basis": "derived", "time.continuity.flag": "paper",
            "channel.station_id": "absent", "channel.channel_id": "measured",
            "channel.antenna": "paper", "power.scale": "absent",
            "power.gain_dB": "paper", "power.agc": "absent",
        },
        quality_reasons=reasons, permission=_base_permission("DroneRFa"),
        credibility="V2",
        stem=f"dronerfa_{_ascii_stem(stem)}_{channel}_S4",
        _path=path, _keys=(ik, qk),
    )


def _ascii_stem(stem: str) -> str:
    """把源文件名收敛到文件名允许的字符集（铁律 15）。"""
    return re.sub(r"[^A-Za-z0-9._-]", "_", stem)
