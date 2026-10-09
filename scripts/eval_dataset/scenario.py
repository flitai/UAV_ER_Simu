"""按格子写场景与链路规格（试样集，D-092；14 号报告 §8.2–§8.3）。

场景：一个站（格子文件的 site + 接收配置）、每个平台的辐射源定点悬停（位置取 resolve 冻结的值）。
- 机型预设的辐射源：`emission.bw_Hz` 照抄预设的占用带宽（引擎按 1e-6 核对）；跳频预设的
  `center_Hz` 是序列的第一跳；
- 跳频序列：OFDM 上行由 `algos/reference/ofdm_ref.py` 的 `uplink_hop_sequence` 按场景种子生成，
  时隙数 = ceil(时长 / 时隙长)，一秒不重复；GFSK 由 `gfsk_ref.py` 的 `hop_activity` 按协议规则生成一整轮；
- 载频偏差按平台抽（同一部电台的图传与 DroneID 共用晶振，D-091 ①）；
- 只作占位的辐射源（纯背景段）在 t = 0 关断，全程不发射。

链路规格（`cuav-eval-chain/1`）交 `web/src/chain/examples/_gen.ts eval` 编译成框图（evalChain.ts）。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys

from . import cells, seeds

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, os.path.join(ROOT, "algos", "reference"))

import aoa_fix  # noqa: E402  严格 WGS-84 站心换算（不用 111320 常数）
import gfsk_ref  # noqa: E402
import ofdm_ref  # noqa: E402

BOLTZMANN = 1.380649e-23
T_REF_K = 290.0                     # ReceiverFrontEnd.reference_temperature_K 的目录缺省


def _load(rel: str) -> dict:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return json.load(fh)


OFDM_DOC = _load(ofdm_ref.PRESETS_REL)
GFSK_DOC = _load(gfsk_ref.PRESETS_REL)


def preset(pid: str) -> tuple[str, dict]:
    """(族, 预设原文)；族 ∈ ofdm / droneid / gfsk。"""
    for p in OFDM_DOC["presets"]:
        if p["id"] == pid:
            return ("droneid" if p["type"] == "droneid" else "ofdm"), p
    for p in GFSK_DOC["presets"]:
        if p["id"] == pid:
            return "gfsk", p
    raise KeyError(f"预设表里没有 {pid}")


def is_hopping(pid: str) -> bool:
    fam, raw = preset(pid)
    return (fam == "ofdm" and "hop_grid" in raw) or fam == "gfsk"


def noise_density_dBm_Hz(nf_dB: float) -> float:
    """kT·F（dBm/Hz），与导出工具、引擎同式（290 K 时 −173.98 + nf）。"""
    return 10 * math.log10(BOLTZMANN * T_REF_K * 1e3) + nf_dB


def target_path_loss_dB(site: dict, emitter: dict, snr_dB: float) -> float:
    """使主辐射源的链路预算带内信噪比恰为 snr_dB 的路损：P_tx + G_t + G_r − (kT + nf + 10·log10 B) − SNR。"""
    bw = emitter_bw(emitter)
    noise = noise_density_dBm_Hz(site["nf_dB"]) + 10 * math.log10(bw)
    return emitter["tx_power_dBm"] + emitter["antenna_gain_dBi"] + site["antenna_gain_dBi"] - noise - snr_dB


def emitter_bw(e: dict) -> float:
    if "preset" in e:
        return float(preset(e["preset"])[1]["occupied_bw_Hz"])
    return float(e["bw_Hz"])


def lonlat_at(site: dict, azimuth_deg: float, range_m: float, alt_m: float) -> tuple[float, float]:
    """站心东北天坐标 → 经纬度：方位真北顺时针（铁律 1），水平距离 range_m，高度离地 alt_m（平地）。"""
    az = math.radians(azimuth_deg)
    lon, lat, _ = aoa_fix.from_enu(range_m * math.sin(az), range_m * math.cos(az), alt_m - site["alt_m"],
                                   (site["lon"], site["lat"], site["alt_m"]))
    return round(lon, 7), round(lat, 7)


def _n(x):
    """整数值的浮点写成整数（读起来干净；JSON 本来不分）。"""
    if isinstance(x, float) and x.is_integer() and abs(x) < 2 ** 53:
        return int(x)
    return x


def _hop_activity(e: dict, scenario_seed: int, duration_s: float) -> tuple[dict, float] | None:
    """跳频预设的 hop 活动与第一跳频点；不跳频返回 None。"""
    fam, raw = preset(e["preset"])
    if fam == "ofdm" and "hop_grid" in raw:
        slot = float(raw["frame"]["slot_s"])
        n_slots = int(math.ceil(duration_s / slot - 1e-9))
        seq = ofdm_ref.uplink_hop_sequence(OFDM_DOC, e["preset"], scenario_seed, n_slots)
        return ({"emitter_id": e["id"], "t_s": 0, "event": "hop",
                 "args": {"sequence": [_n(float(f)) for f in seq], "dwell_s": slot}}, float(seq[0]))
    if fam == "gfsk":
        p = gfsk_ref.Preset(GFSK_DOC, e["preset"])
        t0 = float(e.get("frame_offset_s", 0.0))
        act = gfsk_ref.hop_activity(p, scenario_seed, e["id"], t0)
        act.pop("_note", None)
        act["t_s"] = _n(act["t_s"])
        act["args"]["sequence"] = [_n(float(f)) for f in act["args"]["sequence"]]
        return act, float(act["args"]["sequence"][0])
    return None


def manifest_sha256(aoi_id: str) -> str:
    with open(os.path.join(ROOT, "data", "scene", aoi_id, "manifest.json"), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def scenario_id(doc: dict, cell: dict) -> str:
    return f"{doc['stem_prefix']}-{cell['id']}"


def build(doc: dict, cell: dict, positions: dict[str, tuple[float, float, float]] | None = None) -> dict:
    """一格的场景。positions：平台 id → (经度, 纬度, 离地高)；缺省取格子文件里冻结的 resolved。"""
    site, rcv = doc["site"], doc["receivers"][cell["receiver"]]
    sseed = seeds.derive(doc["set_seed"], cell["id"], "scenario")
    emitters, acts = [], []
    for p in cell["platforms"]:
        if positions and p["id"] in positions:
            lon, lat, alt = positions[p["id"]]
        else:
            r = p.get("resolved")
            if not r:
                raise ValueError(f"格子 {cell['id']} 平台 {p['id']} 还没有解算位置（先跑 gen_eval_dataset.py resolve）")
            lon, lat, alt = r["lon"], r["lat"], p["alt_m"]
        cfo = None if p.get("off") else seeds.cfo_ppm(doc["set_seed"], cell["id"], p["id"], doc["cfo"]["max_ppm"])
        for e in p["emitters"]:
            em: dict = {}
            if "preset" in e:
                fam, raw = preset(e["preset"])
                wf: dict = {"type": fam, "preset_id": e["preset"]}
                if "frame_offset_s" in e:
                    wf["frame_offset_s"] = e["frame_offset_s"]
                center = float(e.get("center_Hz", 0.0))
                hop = _hop_activity(e, sseed, cells.duration_s(doc, cell))
                if hop is not None:
                    acts.append(hop[0])
                    center = hop[1]
                em = {"center_Hz": _n(center), "bw_Hz": _n(float(raw["occupied_bw_Hz"]))}
            else:
                wf = dict(e["waveform"])
                em = {"center_Hz": _n(float(e["center_Hz"])), "bw_Hz": _n(float(e["bw_Hz"]))}
            em["tx_power_dBm"] = e["tx_power_dBm"]
            em["antenna_gain_dBi"] = e["antenna_gain_dBi"]
            if cfo:
                em["cfo_ppm"] = cfo
            em["waveform"] = wf
            emitters.append({"id": e["id"], "name": e["name"], "equipment_model": e["equipment_model"],
                             "platform_type": p["platform_type"],
                             "position": {"lon": lon, "lat": lat, "alt_m": _n(float(alt))}, "emission": em})
            if p.get("off"):
                acts.append({"emitter_id": e["id"], "t_s": 0, "event": "tx_off"})
    acts.sort(key=lambda a: (a["t_s"], a["emitter_id"]))
    return {
        "schema_version": "cuav-scenario/1",
        "scenario_id": scenario_id(doc, cell),
        "name": f"{doc['name']} · {cell['id']} {cell['title']}",
        "synthetic": True,
        "aoi": {"id": doc["aoi_id"], "manifest_sha256": manifest_sha256(doc["aoi_id"])},
        "coordinate": {"crs": "EPSG:4326", "alt_ref": "AGL", "terrainHeight_m": 0, "coord_version": "wgs84-2026-09"},
        "time": {"basis": "LogicalSim", "duration_s": cells.duration_s(doc, cell)},
        "seed": sseed,
        "sites": [{"id": site["id"], "name": site["name"],
                   "position": {"lon": site["lon"], "lat": site["lat"], "alt_m": site["alt_m"]},
                   "antenna": {"gain_dBi": site["antenna_gain_dBi"], "pattern": "omni"},
                   "receiver": {"fs_Hz": rcv["fs_Hz"], "center_Hz": rcv["center_Hz"], "bw_Hz": rcv["bw_Hz"],
                                "nf_dB": site["nf_dB"]}}],
        "emitters": emitters,
        "routes": [],
        "activities": acts,
        "trace": {"created_by": "scripts/gen_eval_dataset.py（评测数据集，D-092）", "created_at": doc["created_at"],
                  "notes": f"由格子文件 tests/regression/eval-dataset/{doc['set_id']}.json 的 {cell['id']} 生成；"
                           "各平台定点悬停，位置由 gen_eval_dataset.py resolve 解算后冻结在格子文件里。"},
    }


def dumps(doc: dict) -> bytes:
    """场景的规范序列化形式：两格缩进、保留中文、末尾换行（D-049 ⑧ 同形）。"""
    return (json.dumps(doc, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def frontend_params(doc: dict, cell: dict) -> dict:
    """前端参数：格子文件的公共项，加上实测换算的 IQ 不平衡与直流（缺席即不开，README 写明）。"""
    out = dict(doc["chain"]["rx_fe"])
    fm = doc.get("frontend_measured")
    if fm and fm.get("use"):
        out["iq_gain_imbalance_dB"] = fm["iq_gain_imbalance_dB"]
        out["iq_phase_imbalance_deg"] = fm["iq_phase_imbalance_deg"]
        rcv = doc["receivers"][cell["receiver"]]
        noise_dBm = noise_density_dBm_Hz(doc["site"]["nf_dB"]) + 10 * math.log10(rcv["fs_Hz"]) + out["gain_dB"]
        out["dc_offset_mW"] = float(f"{10 ** ((noise_dBm + fm['dc_rel_noise_dB']) / 10):.6g}")
    return out


def chain_spec(doc: dict, cell: dict, scenario_rel: str) -> dict:
    return {
        "schema_version": "cuav-eval-chain/1",
        "diagram_id": f"eval-{doc['set_id']}-{cell['id']}",
        "name": f"{doc['name']} · {cell['id']} {cell['title']}",
        "scenario": scenario_rel,
        "run": {"duration_s": cells.duration_s(doc, cell), "seed": seeds.derive(doc["set_seed"], cell["id"], "run")},
        "slots": {
            "rx_fe": frontend_params(doc, cell),
            "adc": dict(doc["chain"]["adc"]),
            "ddc": dict(cell["s4"]),
            "ch": dict(doc["propagation"][cell["propagation"]]),
            "det": dict(doc["chain"]["det"]),
        },
        "taps": ["s3", "s4"],
        "iq": ["s3", "s4"],
        "plan_allow": sorted(cell.get("plan_allow", {})),
    }
