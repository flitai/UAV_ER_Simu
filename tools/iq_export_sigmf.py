#!/usr/bin/env python3
"""Q-1：把一次运行的观测点原始样点导出成 SigMF（14 号报告 §5.2–§5.3、§6；06 §9K Q-1；D-087）。

输入是 `cuav_run --run --out <运行目录>` 的产物：观测点子目录里的 `iq.cf32` + `iq.index.json`（引擎内部格式，
复 float32 交织），外加 `events.jsonl`、`truth.jsonl`、`links.jsonl` 与框图文件。输出每个观测点一组：

    <stem>.sigmf-data          复 int16 交织小端（ci16_le，铁律 4）
    <stem>.sigmf-meta          SigMF 1.2.6 元数据；真值写 annotations，本方字段在 cuav: 命名空间
    <stem>.cuav-links.jsonl    该站各链路的逐帧几何（links.jsonl 的子集，SigMF 注记是区间，装不下逐帧量）

**这一步是交付物成形的唯一地方**：量化、元数据、真值换算都在这里，引擎不写 SigMF（14 §5.2）。

## 量化（14 §5.2）

满量程 A = 10^(full_scale_dBm/20)，取观测点上游 `AdcQuantizer` 的参数（同一接收配置下所有文件共用一个满量程，
不做逐文件自适应——真实接收机是固定增益录的，逐文件缩放会让码值不可比）。int16 码 = x / A × 32768。

- **S3（ADC 后）无损**：ADC 是中置量化（码 × 2A/2^bits），8–16 位的每个电平都恰好落在 int16 的整数码上
  （码 × 2^(16−bits)）。先断言每个样点离整数码不超过 0.01 码（float32 存储误差约 0.002 码），不满足就中止——
  那说明数据不是这台 ADC 出来的，四舍五入会静默改数据（铁律 10、`docs/iq-format.md` §3.2）；写完再按
  float32 逐位回读对拍。
- **S4 / S5（DDC、信道化后）一次重量化**：FIR 输出不在格点上。取整口径与 ADC 相同（floor(v + 0.5)），
  削顶照实计数；量化噪声 (A/32768)²/6 相对该点底噪（kT + nf + 前端增益 + 10·log10 fs，dBm）的余量不足
  20 dB 即 `degraded` 并写明。回读误差 ≤ 半个码（未削顶的样点）。

## 真值注记（14 §5.3）

`truth.jsonl` 每段一条，只取本观测点所在站的行。样点号用与引擎同一个取整口径 `sample_at(t) = floor(t·fs + 0.5)`
（D-069 ①），DDC 后按「输出样点 m ↔ 输入样点 m·D」（D-070 ⑧）即直接按观测点采样率换算。
`cuav:snr_dB` 是按链路预算算的带内信噪比：P_rx − (kT + nf + 10·log10 B)，P_rx = 发射功率 + 两端天线增益 −
路损 − 馈线损耗，取段中点时刻的链路帧；天线不是全向或收发极化不同时写 null 并在 `cuav:snr_basis` 说明，不拿
峰值增益顶替（铁律 15）。

## 可用频带与实测信噪比（0.3.0，试样集，D-092）

`cuav:usable_band_Hz` = 观测点上不混叠、不在滤波器过渡带里的那段频率 [下沿, 上沿]（Hz，绝对频率）。
从观测点自己的索引（采样率、中心）往上游反推：信道化与 DDC 各取冻结抽头表的通带边缘
（`passband_edge_rel_out` × 输出采样率；DDC 不抽取时是纯频移，取 ±fs/2），再到 S3 的 ±fs/2，
再到接收滤波的 ±bw/2，逐级取交集。每条注记的 `cuav:capture` 说它落在可用频带的哪里：
`full`（整段在内）、`partial`（跨边）、`none`（在外）。`cuav:in_capture_band` 仍是原义（与文件频带相交）。

`cuav:snr_measured_dB` 用观测点的谱产品 `spectrum.f32` 在数据上实测，不重做 FFT：
  1. 频段取注记的上下沿，两边各加宽 2 个 bin（Hann 主瓣），谱行取线性功率按 bin 求和；
  2. 信号行 = 整行落在注记区间里、且不与其他（加宽后频段相交的）注记在时间上重叠的谱行；
  3. 噪声参照行 = 同一频段上不与任何注记（时间两边各外扩一行）重叠、且在 DDC / 信道化起始暂态之后的谱行；
  4. 信噪比 = (信号行均值 − 参照行均值) / (参照行均值 × 占用带宽 / 加宽后的频段宽)。
     Hann 窗的等效噪声带宽因子在信号与噪声上相同，相除即消掉。
写 null 时 `cuav:snr_measured_basis` 写缘由：`no_spectrum_product`、`spectrum_layout`、`no_band`、`capture_partial`、
`capture_none`、`too_short`、`overlapped:<辐射源>`、`no_noise_reference`（参照行少于 64）、`not_above_noise`。

## 用法

    # 运行目录里有 diagram.json（经应用服务提交的任务）时可省 --diagram
    uv run --quiet --with numpy python tools/iq_export_sigmf.py data/runs/<task_id> -o <输出目录> [--op s3 --op s4]
    # 附带用 SigMF 官方包校验（开发期工具，不进交付包）
    uv run --quiet --with numpy --with sigmf python tools/iq_export_sigmf.py <运行目录> -o <输出目录> --validate

引擎二进制取环境变量 `CUAV_RUN`，缺省 `engine/build/cuav_run`（读组件目录拿参数缺省值与模型标识）。
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass, field

import numpy as np

VERSION = "0.4.0"                 # 0.4.0（D-102）：cuav:presets_version 按表给出；0.3.0（试样集，D-092）：可用频带、capture、实测信噪比；0.2.0（Q-4，D-091）：上下沿按实际载频
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGMF_VERSION = "1.2.6"            # sigmf 包 1.13.0 实现的规范版本（2026-09-29 锁定）
CUAV_EXT_VERSION = "1.3.0"
FULL_SCALE = 32768
CHUNK = 1 << 22                    # 分块处理的样点数（每块约 32 MB cf32）
S3_GRID_TOL = 0.01                 # S3 样点离整数码的最大允许偏差（码）
REQUANT_MARGIN_MIN_dB = 20.0       # S4 / S5 重量化噪声相对底噪的最小余量（14 §5.2）
BOLTZMANN = 1.380649e-23           # J/K；热噪声密度按前端的 reference_temperature_K 算，与引擎同式（290 K 时 −173.98 dBm/Hz）
SNR_WIDEN_BINS = 2                 # 实测信噪比的频段两边各加宽的 bin 数（Hann 主瓣 ±2 bin）
SNR_MIN_REF_ROWS = 64              # 噪声参照行的最少行数
FIR_DIR = {"DDC": "adc-ddc", "Channelizer": "channelizer"}   # 冻结抽头表所在目录（models/<目录>/fir_<版本>.json）


class ExportError(RuntimeError):
    pass


# ---------------------------------------------------------------- 读输入

def load_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def read_events(run_dir: str) -> tuple[dict, dict]:
    """events.jsonl 的第一条与最后一条 task.state（cuav_run 自己写，不依赖应用服务的 task.json）。"""
    path = os.path.join(run_dir, "events.jsonl")
    if not os.path.exists(path):
        raise ExportError(f"运行目录里没有 events.jsonl：{run_dir}")
    first = last = None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if '"task.state"' not in line:
                continue
            ev = json.loads(line)
            if ev.get("type") == "task.state":
                if first is None:
                    first = dict(ev["payload"], task_id=ev.get("task_id"))
                last = ev["payload"]
    if not first or not last:
        raise ExportError("events.jsonl 里没有 task.state 事件")
    return first, last


def read_jsonl(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def find_scenario(scenario_id: str, sha256: str, path: str | None = None) -> tuple[str, dict]:
    """在 data/scene/*/scenarios/ 里找场景文件并核对字节哈希（与框图 scenario_ref 同一把尺子）。

    path 给了就只认它（回归夹具在 tests/regression/scenarios/、Q-6 的数据集场景另有目录）：
    照样核对字节哈希，对不上就拒，不退回去找别处的同名文件（Q-2，D-088）。"""
    if path:
        if sha256_file(path) != sha256:
            raise ExportError(f"给的场景文件 {os.path.basename(path)} 的哈希与框图 scenario_ref 不符")
        return path, load_json(path)
    base = os.path.join(ROOT, "data", "scene")
    hits = []
    for aoi in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        p = os.path.join(base, aoi, "scenarios", f"{scenario_id}.scenario.json")
        if os.path.exists(p):
            hits.append(p)
    if not hits:
        raise ExportError(f"找不到场景文件 {scenario_id}.scenario.json（data/scene/*/scenarios/）")
    for p in hits:
        if sha256_file(p) == sha256:
            return p, load_json(p)
    raise ExportError(f"场景 {scenario_id} 的文件哈希与框图 scenario_ref 不符：场景改过了，运行结果与现在的场景对不上")


def engine_catalog(run_version: str) -> dict:
    exe = os.environ.get("CUAV_RUN") or os.path.join(ROOT, "engine", "build", "cuav_run")
    if not os.path.exists(exe):
        raise ExportError(f"找不到引擎二进制（CUAV_RUN 或 engine/build/cuav_run）：要用它的组件目录取参数缺省值")
    out = subprocess.run([exe, "--catalog"], capture_output=True, check=True).stdout
    cat = json.loads(out)
    if cat.get("engine_version") != run_version:
        raise ExportError(f"引擎版本对不上：运行用的是 {run_version}，现在的二进制是 {cat.get('engine_version')}")
    return {c["type"]: c for c in cat["components"]}


# ---------------------------------------------------------------- 框图遍历

@dataclass
class Chain:
    op_id: str
    node: str
    point: str                          # S3 / S4 / S5
    site_id: str
    adc: dict
    rx_fe: dict | None
    stages: list[dict]                  # 观测点上游的节点（按拓扑近似顺序：离观测点由远到近）
    emitters: dict[str, dict] = field(default_factory=dict)   # emitter_id → {tx_gain, rx_gain, feeder, snr_basis, fading}


def _param(node: dict, name: str, catalog: dict):
    p = (node.get("params") or {})
    if name in p:
        return p[name]
    for spec in catalog[node["type"]]["params"]:
        if spec["name"] == name:
            if "default" not in spec or spec["default"] is None:
                raise ExportError(f"节点 {node['id']} 缺参数 {name} 且组件目录没有缺省值")
            return spec["default"]
    raise ExportError(f"组件 {node['type']} 没有参数 {name}")


def _upstream(diagram: dict, start: str) -> list[str]:
    preds: dict[str, list[str]] = {}
    for e in diagram["edges"]:
        preds.setdefault(e["to"]["node"], []).append(e["from"]["node"])
    seen, order, stack = {start}, [], [start]
    while stack:
        n = stack.pop()
        order.append(n)
        for p in sorted(preds.get(n, [])):
            if p not in seen:
                seen.add(p)
                stack.append(p)
    return order


def _downstream(diagram: dict, start: str) -> set[str]:
    succ: dict[str, list[str]] = {}
    for e in diagram["edges"]:
        succ.setdefault(e["from"]["node"], []).append(e["to"]["node"])
    seen, stack = {start}, [start]
    while stack:
        for s in succ.get(stack.pop(), []):
            if s not in seen:
                seen.add(s)
                stack.append(s)
    return seen


POINT_OF = {"AdcQuantizer": "S3", "DDC": "S4", "Channelizer": "S5"}


def chain_for(diagram: dict, op: dict, catalog: dict) -> Chain:
    nodes = {n["id"]: n for n in diagram["nodes"]}
    node = nodes[op["node"]]
    if node["type"] not in POINT_OF:
        raise ExportError(f"观测点 {op['id']} 挂在 {node['type']} 上；导出只支持 ADC 之后的观测点"
                          "（S3 ADC / S4 DDC / S5 信道化），ADC 之前没有量化器、没有满量程")
    up = _upstream(diagram, node["id"])
    upn = [nodes[i] for i in up]
    adcs = [n for n in upn if n["type"] == "AdcQuantizer"]
    if len(adcs) != 1:
        raise ExportError(f"观测点 {op['id']} 上游有 {len(adcs)} 个 ADC，应恰好一个")
    fes = [n for n in upn if n["type"] == "ReceiverFrontEnd"]
    sites = sorted({(n.get("scene_binding") or {}).get("site_id") for n in upn
                    if n["type"] == "ScenarioSource" and (n.get("scene_binding") or {}).get("site_id")})
    if len(sites) != 1:
        raise ExportError(f"观测点 {op['id']} 上游绑定了 {len(sites)} 个站（{sites}），应恰好一个")
    ch = Chain(op["id"], node["id"], POINT_OF[node["type"]], sites[0], adcs[0], fes[0] if len(fes) == 1 else None,
               list(reversed(upn)))
    up_set = set(up)
    for n in upn:
        if n["type"] != "SceneEmitterSource":
            continue
        eid = (n.get("scene_binding") or {}).get("entity_id")
        path = _downstream(diagram, n["id"]) & up_set
        info = {"tx_gain_dBi": 0.0, "rx_gain_dBi": 0.0, "feeder_loss_dB": 0.0, "snr_basis": "omni_matched",
                "fading": None}
        for a in (nodes[i] for i in sorted(path)):
            if a["type"] == "SceneBoundChannel" and _param(a, "fading", catalog) != "off":
                # 小尺度衰落（Q-4，D-091）：这条链路的参数进 cuav:impairments，信噪比注记改标「均值」
                info["fading"] = {"node_id": a["id"], "model": _param(a, "fading", catalog),
                                  "k_los_dB": float(_param(a, "fading_k_los_dB", catalog)),
                                  "min_doppler_Hz": float(_param(a, "fading_min_doppler_Hz", catalog)),
                                  "delay_spread_ns": float(_param(a, "fading_delay_spread_ns", catalog))}
            if a["type"] != "AntennaGain":
                continue
            role = _param(a, "role", catalog)
            if _param(a, "pattern", catalog) != "omni":
                info["snr_basis"] = f"directional_antenna:{a['id']}"
            pol, peer = _param(a, "polarization", catalog), _param(a, "peer_polarization", catalog)
            if pol != peer:
                info["snr_basis"] = f"polarization_mismatch:{a['id']}"
            if role == "tx":
                info["tx_gain_dBi"] = float(_param(a, "gain_dBi", catalog))
            else:
                info["rx_gain_dBi"] = float(_param(a, "gain_dBi", catalog))
                info["feeder_loss_dB"] = float(_param(a, "feeder_loss_dB", catalog))
        ch.emitters[eid] = info
    return ch


# ---------------------------------------------------------------- 量化与写盘

@dataclass
class QuantResult:
    samples: int
    sha512: str
    sha256: str
    clipped_export: int
    max_readback_err_codes: float
    lossless: bool
    requant_margin_dB: float | None
    noise_floor_dBm: float | None
    requant_noise_dBm: float | None


def _floor_half(v: np.ndarray) -> np.ndarray:
    return np.floor(v + 0.5)


def quantize(cf32_path: str, n: int, amp: float, point: str, out_path: str) -> QuantResult:
    raw = np.memmap(cf32_path, dtype="<f4", mode="r", shape=(2 * n,))
    h512, h256 = hashlib.sha512(), hashlib.sha256()
    clipped = 0
    max_err = 0.0
    scale = FULL_SCALE / amp
    with open(out_path, "wb") as fh:
        for a in range(0, 2 * n, 2 * CHUNK):
            v = np.asarray(raw[a:a + 2 * CHUNK], dtype=np.float64)
            codes = v * scale
            if point == "S3":
                q = _floor_half(codes)
                off = float(np.max(np.abs(codes - q))) if codes.size else 0.0
                if off > S3_GRID_TOL:
                    raise ExportError(f"S3 样点不在 ADC 格点上（最大偏离 {off:.4f} 码）：数据不是这台 ADC 出来的，"
                                      "不四舍五入蒙混（铁律 10）")
                if q.min(initial=0) < -FULL_SCALE or q.max(initial=0) > FULL_SCALE - 1:
                    raise ExportError("S3 码值越出 int16：ADC 位数超过 16 或满量程与数据不符")
                back = (q / FULL_SCALE * amp).astype(np.float32)
                if not np.array_equal(back, raw[a:a + 2 * CHUNK]):
                    bad = int(np.count_nonzero(back != raw[a:a + 2 * CHUNK]))
                    raise ExportError(f"S3 回读与引擎 float32 不逐位相同（{bad} 个分量）：无损承诺不成立")
            else:
                q = _floor_half(codes)
                over = (q > FULL_SCALE - 1) | (q < -FULL_SCALE)
                # 削顶按复样点计（I、Q 任一削顶即计一次），与 ADC 同口径
                clipped += int(np.count_nonzero(over.reshape(-1, 2).any(axis=1)))
                q = np.clip(q, -FULL_SCALE, FULL_SCALE - 1)
                ok = ~over
                if np.any(ok):
                    max_err = max(max_err, float(np.max(np.abs(q[ok] - codes[ok]))))
            b = q.astype("<i2").tobytes()
            h512.update(b)
            h256.update(b)
            fh.write(b)
    return QuantResult(n, h512.hexdigest(), h256.hexdigest(), clipped, max_err, point == "S3",
                       None, None, None)


# ---------------------------------------------------------------- 真值注记

def sample_at(t_s: float, fs: float) -> int:
    """与引擎 geo::sample_at 同式（D-069 ①）。"""
    if not t_s > 0.0:
        return 0
    return int(t_s * fs + 0.5)


def _link_at(links: list[dict], starts: list[float], t: float) -> dict | None:
    """离 t 最近的一条链路帧（按帧中点比）。links.jsonl 是抽稀记录——20 Hz 的帧只落每隔一帧（实测
    valid_from 相隔 0.1 s、每帧有效 0.05 s），t 常落在两帧之间，所以不能要求 t 落在某帧的有效区间里；
    用的是哪一帧写进注记的 cuav:link_frame_t_s。links 按 valid_from 升序。"""
    if not links:
        return None
    i = bisect.bisect_right(starts, t)
    best = None
    for j in (i - 1, i):
        if 0 <= j < len(links):
            r = links[j]
            d = abs(0.5 * (r["valid_from_s"] + r["valid_to_s"]) - t)
            if best is None or d < best[0]:
                best = (d, r)
    return best[1]


PRESET_TABLE = {"ofdm": "ofdm", "droneid": "ofdm", "gfsk": "gfsk"}   # 波形类型 → 预设表


def _preset_keys(scen: dict, first: dict) -> dict:
    """场景里用到的机型预设（Q-2 OFDM 族 D-088、Q-3 GFSK 族 D-089；两张表的 id 互不重名）与各表的版本。

    版本取自 cuav_run 写在第一条 task.state 里的 presets（D-102）：只列场景实际用到的表，如 {"ofdm": "v2"}；
    没有这一项的运行出自 D-102 之前，那时两张表都是 v1。没有按预设发射的辐射源时一个键都不写。"""
    ids, tables = set(), set()
    for e in scen.get("emitters", []):
        w = (e.get("emission") or {}).get("waveform", {})
        if w.get("preset_id") is not None:
            ids.add(w["preset_id"])
            tables.add(PRESET_TABLE[w.get("type")])
    if not ids:
        return {}
    run = first.get("presets") or {}
    return {"cuav:preset_ids": sorted(ids),
            "cuav:presets_version": {t: (run.get(t) or {}).get("version", "v1") for t in sorted(tables)}}


def _impairments(ch: Chain, scen: dict, catalog: dict) -> dict:
    """非理想与衰落的参数（Q-4，D-091）：只在任一项不是缺省时写 cuav:impairments，既有导出元数据不变。
    前端 trace 会被后级覆写（D-091），相噪等参数只能从框图读、在这里带出。"""
    out: dict = {}
    if ch.rx_fe is not None:
        fe = ch.rx_fe
        rec: dict = {}
        for k in ("lo_offset_Hz", "iq_gain_imbalance_dB", "iq_phase_imbalance_deg", "dc_offset_mW"):
            v = float(_param(fe, k, catalog))
            if v != 0.0:
                rec[k] = v
        if _param(fe, "phase_noise", catalog) != "off":
            lvl = float(_param(fe, "pn_level_dBc_Hz", catalog))
            fc = float(_param(fe, "pn_corner_Hz", catalog))
            rec["phase_noise"] = {"model": "pll_single_pole", "level_dBc_Hz": lvl, "corner_Hz": fc,
                                  "rms_phase_deg": round(math.sqrt(math.pi * fc * 10.0 ** (lvl / 10.0)) * (180.0 / math.pi), 6)}
        if rec:
            out["receiver"] = {"node_id": fe["id"], **rec}
    fad = [{"emitter_id": eid, **info["fading"]} for eid, info in sorted(ch.emitters.items()) if info.get("fading")]
    if fad:
        out["fading"] = fad
    cfo = {e["id"]: e["emission"]["cfo_ppm"] for e in scen.get("emitters", [])
           if e["id"] in ch.emitters and (e.get("emission") or {}).get("cfo_ppm")}
    if cfo:
        out["cfo_ppm"] = dict(sorted(cfo.items()))
    return {"cuav:impairments": out} if out else {}


# ---------------------------------------------------------------- 可用频带（0.3.0，D-092）

def _fir_table(stage_type: str, version: str) -> dict:
    path = os.path.join(ROOT, "models", FIR_DIR[stage_type], f"fir_{version}.json")
    if not os.path.exists(path):
        raise ExportError(f"找不到冻结抽头表 models/{FIR_DIR[stage_type]}/fir_{version}.json：算不出可用频带")
    return load_json(path)


def _fir_ntaps(table: dict, key: str, value: int) -> int:
    for e in table["entries"]:
        if int(e[key]) == value:
            return int(e["ntaps"])
    raise ExportError(f"冻结抽头表 {table.get('version')} 里没有 {key} = {value} 这一档")


def _one_stage(ch: Chain, typ: str) -> dict | None:
    xs = [s for s in ch.stages if s["type"] == typ]
    if len(xs) > 1:
        raise ExportError(f"观测点 {ch.op_id} 上游有 {len(xs)} 个 {typ}，应至多一个")
    return xs[0] if xs else None


def usable_band(ch: Chain, catalog: dict, fs: float, fc: float) -> tuple[float, float, float]:
    """观测点上可用的频带 [下沿, 上沿]（Hz）与上游滤波器的起始暂态（秒）。

    从观测点自己的采样率与中心往上游反推，逐级取交集：信道化 → DDC → S3 的 ±fs/2 → 接收滤波的 ±bw/2。
    暂态按抽头数 / 该级输入采样率计（零历史起步，偏保守），只用来让噪声参照行避开开头。"""
    lo, hi = -math.inf, math.inf
    c, f = fc, fs
    transient = 0.0
    chan = _one_stage(ch, "Channelizer")
    if chan is not None:
        m = int(_param(chan, "channels", catalog))
        j = int(_param(chan, "select_channel", catalog))
        table = _fir_table("Channelizer", _param(chan, "fir_version", catalog))
        e = float(table["spec"]["passband_edge_rel_out"]) * f
        lo, hi = max(lo, c - e), min(hi, c + e)
        c = c - (j - m / 2) * f
        f = f * m
        transient += _fir_ntaps(table, "channels", m) / f
    ddc = _one_stage(ch, "DDC")
    if ddc is not None:
        d = int(_param(ddc, "decim", catalog))
        table = _fir_table("DDC", _param(ddc, "fir_version", catalog))
        e = float(table["spec"]["passband_edge_rel_out"]) * f if d > 1 else f / 2
        lo, hi = max(lo, c - e), min(hi, c + e)
        c = c - float(_param(ddc, "f_shift_Hz", catalog))
        f = f * d
        transient += _fir_ntaps(table, "decim", d) / f
    lo, hi = max(lo, c - f / 2), min(hi, c + f / 2)
    rx = _one_stage(ch, "RxFilter")
    if rx is not None:
        bw = float(_param(rx, "bw_Hz", catalog))
        lo, hi = max(lo, c - bw / 2), min(hi, c + bw / 2)
    return lo, hi, transient


def capture_of(lo: float, hi: float, band: tuple[float, float]) -> str:
    if lo >= band[0] and hi <= band[1]:
        return "full"
    if hi > band[0] and lo < band[1]:
        return "partial"
    return "none"


# ---------------------------------------------------------------- 实测信噪比（0.3.0，D-092）

def _floor_div(a: int, b: int) -> int:
    return a // b


def _ceil_div(a: int, b: int) -> int:
    return -((-a) // b)


@dataclass
class Spectrum:
    mm: np.ndarray                      # (rows, nfft) float32，dB 值
    rows: int
    nfft: int
    start: int                          # 第一行的起始样点（观测点采样率上的绝对样点号）
    hop: int
    fs: float
    fc: float
    cache: dict = field(default_factory=dict)

    def row_sums(self, k0: int, k1: int) -> np.ndarray:
        """每行在 bin k0..k1 上的线性功率和（按行全算一遍并缓存）。"""
        key = (k0, k1)
        if key not in self.cache:
            out = np.empty(self.rows, dtype=np.float64)
            step = 8192
            for a in range(0, self.rows, step):
                blk = np.asarray(self.mm[a:a + step, k0:k1 + 1], dtype=np.float64)
                out[a:a + step] = np.sum(np.power(10.0, blk / 10.0), axis=1)
            self.cache[key] = out
        return self.cache[key]

    def rows_inside(self, a0: int, a1: int) -> tuple[int, int]:
        """整行落在 [a0, a1) 里的行号范围 [r_lo, r_hi]（可能为空：r_lo > r_hi）。"""
        r_lo = max(0, _ceil_div(a0 - self.start, self.hop))
        r_hi = min(self.rows - 1, _floor_div(a1 - self.nfft - self.start, self.hop))
        return r_lo, r_hi

    def rows_touching(self, b0: int, b1: int) -> tuple[int, int]:
        """与 [b0, b1) 有交叠的行号范围 [r_lo, r_hi]。"""
        r_lo = max(0, _floor_div(b0 - self.nfft - self.start, self.hop) + 1)
        r_hi = min(self.rows - 1, _ceil_div(b1 - self.start, self.hop) - 1)
        return r_lo, r_hi


def load_spectrum(op_dir: str) -> tuple[Spectrum | None, str]:
    idx_path = os.path.join(op_dir, "spectrum.index.json")
    f32 = os.path.join(op_dir, "spectrum.f32")
    if not (os.path.exists(idx_path) and os.path.exists(f32)):
        return None, "no_spectrum_product"
    idx = load_json(idx_path)
    nfft = int(idx["nfft"])
    if idx.get("window") != "hann" or int(idx.get("segments_per_frame", 1)) != 1 \
            or int(idx.get("frame_hop_samples", nfft)) != nfft:
        return None, "spectrum_layout"
    rows = os.path.getsize(f32) // (4 * nfft)                  # 读端以文件长度定行数（D-046 ③）
    if rows == 0:
        return None, "no_spectrum_product"
    mm = np.memmap(f32, dtype="<f4", mode="r", shape=(rows, nfft))
    return Spectrum(mm, rows, nfft, int(idx["start_sample"]), nfft, float(idx["sample_rate_Hz"]),
                    float(idx["center_Hz"])), ""


def _bins_of(lo: float, hi: float, sp: Spectrum) -> tuple[int, int] | None:
    df = sp.fs / sp.nfft
    u_lo = (lo - sp.fc) / df + sp.nfft / 2
    u_hi = (hi - sp.fc) / df + sp.nfft / 2
    ka = math.ceil(u_lo)
    kb = math.ceil(u_hi) - 1
    if kb < ka:                                               # 比一个 bin 还窄：取离中心最近的那个
        ka = kb = math.floor((u_lo + u_hi) / 2 + 0.5)
    k0 = max(ka - SNR_WIDEN_BINS, 0)
    k1 = min(kb + SNR_WIDEN_BINS, sp.nfft - 1)
    return (k0, k1) if k0 <= k1 else None


def measure_snr(ann: list[dict], sp: Spectrum | None, sp_reason: str, iq_start: int, band: tuple[float, float],
                transient_s: float) -> None:
    """给每条注记写 cuav:snr_measured_dB 与 cuav:snr_measured_basis（就地改 ann）。"""
    if sp is None:
        for a in ann:
            a["cuav:snr_measured_dB"] = None
            a["cuav:snr_measured_basis"] = sp_reason
        return
    # bins：没有上下沿的注记按全带算（"all"）；有上下沿但整段在谱外的是空（None），不与任何频段相交
    items = []                                                 # (a0, a1, bins, emitter)
    for a in ann:
        a0 = iq_start + int(a["core:sample_start"])
        a1 = a0 + int(a["core:sample_count"])
        bins = "all"
        if "core:freq_lower_edge" in a:
            bins = _bins_of(float(a["core:freq_lower_edge"]), float(a["core:freq_upper_edge"]), sp)
        items.append((a0, a1, bins, a.get("cuav:emitter_id")))

    def touches(bins_a, bins_b) -> bool:
        if bins_a is None or bins_b is None:
            return False
        if bins_a == "all" or bins_b == "all":
            return True
        return bins_b[0] <= bins_a[1] and bins_b[1] >= bins_a[0]

    t_start = math.ceil(transient_s * sp.fs)                   # 起始暂态（样点）
    r_first = max(0, _ceil_div(t_start - sp.start, sp.hop))
    ref_cache: dict = {}
    for i, a in enumerate(ann):
        a0, a1, bins, _ = items[i]
        if bins == "all":
            a["cuav:snr_measured_dB"] = None
            a["cuav:snr_measured_basis"] = "no_band"
            continue
        cap = capture_of(float(a["core:freq_lower_edge"]), float(a["core:freq_upper_edge"]), band)
        if cap != "full" or bins is None:
            a["cuav:snr_measured_dB"] = None
            a["cuav:snr_measured_basis"] = f"capture_{cap if cap != 'full' else 'none'}"
            continue
        r_lo, r_hi = sp.rows_inside(a0, a1)
        if r_hi < r_lo:
            a["cuav:snr_measured_dB"] = None
            a["cuav:snr_measured_basis"] = "too_short"
            continue
        keep = np.ones(r_hi - r_lo + 1, dtype=bool)
        hit: set[str] = set()
        for j, (b0, b1, bb, eid) in enumerate(items):
            if j == i or not touches(bins, bb) or b1 <= a0 or b0 >= a1:
                continue
            t_lo, t_hi = sp.rows_touching(b0, b1)
            lo_, hi_ = max(t_lo, r_lo), min(t_hi, r_hi)
            if lo_ <= hi_:
                keep[lo_ - r_lo:hi_ - r_lo + 1] = False
                hit.add(str(eid))
        if not keep.any():
            a["cuav:snr_measured_dB"] = None
            a["cuav:snr_measured_basis"] = "overlapped:" + ",".join(sorted(hit))
            continue
        if bins not in ref_cache:
            mask = np.zeros(sp.rows, dtype=bool)
            mask[r_first:] = True
            for (b0, b1, bb, _) in items:
                if not touches(bins, bb):
                    continue
                t_lo, t_hi = sp.rows_touching(b0 - sp.nfft, b1 + sp.nfft)   # 两边各外扩一行，避开突发的拖尾
                if t_lo <= t_hi:
                    mask[t_lo:t_hi + 1] = False
            rs = sp.row_sums(*bins)
            n_ref = int(np.count_nonzero(mask))
            ref_cache[bins] = (float(np.sum(rs[mask])) / n_ref if n_ref else 0.0, n_ref)
        noise, n_ref = ref_cache[bins]
        if n_ref < SNR_MIN_REF_ROWS:
            a["cuav:snr_measured_dB"] = None
            a["cuav:snr_measured_basis"] = "no_noise_reference"
            continue
        rs = sp.row_sums(*bins)
        sig_rows = rs[r_lo:r_hi + 1][keep]
        sig = float(np.sum(sig_rows)) / sig_rows.size
        p = sig - noise
        bw = float(a["core:freq_upper_edge"]) - float(a["core:freq_lower_edge"])
        nb = bins[1] - bins[0] + 1
        noise_bw = noise * bw / (nb * sp.fs / sp.nfft)
        if not p > 0.0:
            a["cuav:snr_measured_dB"] = None
            a["cuav:snr_measured_basis"] = "not_above_noise"
            continue
        a["cuav:snr_measured_dB"] = round(10 * math.log10(p / noise_bw), 6)
        a["cuav:snr_measured_basis"] = "spectrum_rows"
        a["cuav:snr_measured_rows"] = int(sig_rows.size)
        a["cuav:snr_noise_ref_rows"] = n_ref


def annotations(truth: list[dict], links_by_id: dict[str, list[dict]], scen: dict, ch: Chain, n0_dBm_Hz: float | None,
                fs: float, fc: float, start_sample: int, n: int,
                band: tuple[float, float] | None = None) -> tuple[list[dict], dict]:
    """n0_dBm_Hz：接收机输入端的噪声密度 kT·F（dBm/Hz）；前端不注入热噪声（混合增强，噪声来自实测背景）时为 None。"""
    starts = {k: [r["valid_from_s"] for r in v] for k, v in links_by_id.items()}
    emitters = {e["id"]: e for e in scen["emitters"]}
    out, stats = [], {"truth_rows_site": 0, "outside_capture": 0}
    t0 = start_sample / fs
    for r in truth:
        if r.get("site_id") not in (None, ch.site_id):
            continue
        stats["truth_rows_site"] += 1
        s0 = sample_at(r["t_s"] - t0, fs) if r["t_s"] > t0 else 0
        s1 = min(sample_at(r["t_end_s"] - t0, fs), n)
        if s1 <= s0:
            stats["outside_capture"] += 1
            continue
        eid = r.get("emitter_id")
        em = emitters.get(eid, {})
        a = {"core:sample_start": s0, "core:sample_count": s1 - s0, "core:label": r["label"]}
        if r.get("center_Hz") is not None and r.get("bw_Hz") is not None:
            # 上下沿按**实际载频**：真值行的 center_Hz 是名义中心（跳频点或 emission.center_Hz），
            # 实际载频还要加场景的基带偏移 offset_Hz 与载频偏差 cfo_Hz（Q-4，D-091；此前漏算 offset_Hz）
            wf = (em.get("emission") or {}).get("waveform") or {}
            c = r["center_Hz"] + float(wf.get("offset_Hz", 0.0)) + float(r.get("cfo_Hz", 0.0))
            lo, hi = c - r["bw_Hz"] / 2, c + r["bw_Hz"] / 2
            a["core:freq_lower_edge"] = lo
            a["core:freq_upper_edge"] = hi
            a["cuav:in_capture_band"] = bool(hi > fc - fs / 2 and lo < fc + fs / 2)
            if band is not None:
                a["cuav:capture"] = capture_of(lo, hi, band)
        a["cuav:emitter_id"] = eid
        for k in ("platform_type", "equipment_model"):
            if em.get(k) is not None:
                a[f"cuav:{k}"] = em[k]
        a["cuav:waveform"] = r.get("waveform")
        if r.get("preset_id"):            # OFDM 族（Q-2，D-088）：机型预设；其余波形没有这个键
            a["cuav:preset_id"] = r["preset_id"]
        if "cfo_Hz" in r:                  # 载频偏差（Q-4，D-091）：场景写了非零 cfo_ppm 才有
            a["cuav:cfo_Hz"] = r["cfo_Hz"]
        lid = f"{ch.site_id}-{eid}"      # 链路标识由站与源拼成（geo::Link::link_id），不反向拆（D-061 ⑩）
        link = _link_at(links_by_id.get(lid, []), starts.get(lid, []), 0.5 * (r["t_s"] + r["t_end_s"]))
        if link is not None:
            for k_src, k_dst in (("distance_m", "distance_m"), ("line_of_sight", "line_of_sight"),
                                 ("path_loss_dB", "path_loss_dB"), ("doppler_Hz", "doppler_Hz")):
                a[f"cuav:{k_dst}"] = link[k_src]
            a["cuav:diffraction_dB"] = link.get("diffraction_dB", 0.0)
            a["cuav:link_frame_t_s"] = link["valid_from_s"]
        gains = ch.emitters.get(eid)
        tx_power = (em.get("emission") or {}).get("tx_power_dBm")
        if n0_dBm_Hz is None:
            a["cuav:snr_dB"] = None
            a["cuav:snr_basis"] = "no_thermal_noise_model"
        elif link is None or gains is None or tx_power is None or not r.get("bw_Hz"):
            a["cuav:snr_dB"] = None
            a["cuav:snr_basis"] = "missing_input"
        elif gains["snr_basis"] != "omni_matched":
            a["cuav:snr_dB"] = None
            a["cuav:snr_basis"] = gains["snr_basis"]
        else:
            p_rx = tx_power + gains["tx_gain_dBi"] + gains["rx_gain_dBi"] - link["path_loss_dB"] - gains["feeder_loss_dB"]
            noise = n0_dBm_Hz + 10 * math.log10(r["bw_Hz"])
            a["cuav:snr_dB"] = round(p_rx - noise, 6)
            # 开了小尺度衰落时链路预算给的是平均信噪比，逐段的实现值随衰落起伏（Q-6 的 snr_measured_dB 量它）
            a["cuav:snr_basis"] = "link_budget_mean" if gains.get("fading") else "link_budget"
        out.append(a)
    out.sort(key=lambda a: (a["core:sample_start"], a.get("cuav:emitter_id") or "", a["core:sample_count"]))
    return out, stats


# ---------------------------------------------------------------- 一个观测点

def export_op(run_dir: str, diagram: dict, diagram_sha: str, scen_path: str, scen: dict, first: dict, last: dict,
              catalog: dict, op: dict, out_dir: str, stem: str) -> dict:
    ch = chain_for(diagram, op, catalog)
    op_dir = os.path.join(run_dir, op["id"])
    idx_path = os.path.join(op_dir, "iq.index.json")
    cf_path = os.path.join(op_dir, "iq.cf32")
    if not os.path.exists(idx_path):
        raise ExportError(f"观测点 {op['id']} 没有 iq.index.json：iq 产品没开，或运行没有正常收尾")
    idx = load_json(idx_path)
    n = int(idx["samples"])
    if os.path.getsize(cf_path) != 8 * n:
        raise ExportError(f"iq.cf32 长度 {os.path.getsize(cf_path)} 字节与索引 {n} 个样点对不上")
    fs, fc = float(idx["sample_rate_Hz"]), float(idx["center_Hz"])

    fs_dBm = float(_param(ch.adc, "full_scale_dBm", catalog))
    bits = int(_param(ch.adc, "bits", catalog))
    amp = 10.0 ** (fs_dBm / 20.0)
    nf = float(_param(ch.rx_fe, "nf_dB", catalog)) if ch.rx_fe else None
    gain = float(_param(ch.rx_fe, "gain_dB", catalog)) if ch.rx_fe else None
    thermal = ch.rx_fe is not None and _param(ch.rx_fe, "noise_mode", catalog) == "thermal"
    n0 = (10 * math.log10(BOLTZMANN * float(_param(ch.rx_fe, "reference_temperature_K", catalog)) * 1e3) + nf
          if thermal else None)

    data_path = os.path.join(out_dir, f"{stem}.sigmf-data")
    q = quantize(cf_path, n, amp, ch.point, data_path)

    reasons: list[str] = []
    state = idx.get("state", "valid")
    reasons += list(idx.get("state_reasons") or [])
    requant = None
    if ch.point != "S3":
        q_noise = 10 * math.log10((amp / FULL_SCALE) ** 2 / 6)
        floor = n0 + gain + 10 * math.log10(fs) if n0 is not None else None
        margin = None if floor is None else floor - q_noise
        requant = {"step_codes": 1, "full_scale_dBm": fs_dBm, "quantization_noise_dBm": round(q_noise, 4),
                   "noise_floor_dBm": None if floor is None else round(floor, 4),
                   "margin_dB": None if margin is None else round(margin, 4),
                   "max_readback_error_codes": round(q.max_readback_err_codes, 6)}
        if margin is None:
            state = "degraded"
            reasons.append("export_requantization：接收机前端不注入热噪声（或链上没有前端），算不出底噪，重量化余量未知")
        elif margin < REQUANT_MARGIN_MIN_dB:
            state = "degraded"
            reasons.append(f"export_requantization：量化噪声只比底噪低 {margin:.1f} dB（线 {REQUANT_MARGIN_MIN_dB:g} dB）")
        if q.clipped_export > 0:
            ratio = q.clipped_export / n
            if ratio > float(_param(ch.adc, "degrade_clip_ratio", catalog)):
                state = "degraded"
            reasons.append(f"export_clip：{q.clipped_export} / {n} 个样点在导出量化时削顶")

    links = read_jsonl(os.path.join(run_dir, "links.jsonl"))
    by_id: dict[str, list[dict]] = {}
    for r in links:
        by_id.setdefault(r["link_id"], []).append(r)
    for v in by_id.values():
        v.sort(key=lambda r: r["valid_from_s"])
    truth = read_jsonl(os.path.join(run_dir, "truth.jsonl"))
    b_lo, b_hi, transient_s = usable_band(ch, catalog, fs, fc)
    ann, ann_stats = annotations(truth, by_id, scen, ch, n0, fs, fc, int(idx["start_sample"]), n, (b_lo, b_hi))
    sp, sp_reason = load_spectrum(op_dir)
    measure_snr(ann, sp, sp_reason, int(idx["start_sample"]), (b_lo, b_hi), transient_s)

    # 旁挂链路序列：本站各链路，按时间、链路标识排
    site_links = [r for eid in sorted(ch.emitters) for r in by_id.get(f"{ch.site_id}-{eid}", [])]
    site_links.sort(key=lambda r: (r["valid_from_s"], r["link_id"]))
    with open(os.path.join(out_dir, f"{stem}.cuav-links.jsonl"), "w", encoding="utf-8", newline="\n") as fh:
        for r in site_links:
            fh.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")

    stages = [{"node_id": s["id"], "type": s["type"], "model_id": catalog[s["type"]]["model_id"],
               "model_version": catalog[s["type"]]["version"], "model_level": catalog[s["type"]]["model_level"],
               "model_layer": catalog[s["type"]]["model_layer"], "implementation": catalog[s["type"]]["implementation"]}
              for s in ch.stages]
    hw = (f"仿真接收机：噪声系数 {nf:g} dB、前端增益 {gain:g} dB；" if nf is not None else "仿真接收机；") + \
         f"ADC {bits} 位、满量程 {fs_dBm:g} dBm；" + \
         "；".join(f"{s['type']} {s['node_id']}" for s in stages if s["type"] in ("RxFilter", "DDC", "Channelizer"))
    meta = {
        "global": {
            "core:datatype": "ci16_le",
            "core:sample_rate": fs,
            "core:version": SIGMF_VERSION,
            "core:num_channels": 1,
            "core:sha512": q.sha512,
            "core:description": f"场景 {scen['scenario_id']}，站 {ch.site_id}，观测点 {ch.point}（{op['id']}），"
                                f"{n / fs:g} s，{fs / 1e6:g} MS/s @ {fc / 1e6:g} MHz",
            "core:hw": hw,
            "core:recorder": f"cuav_run {first.get('engine_version')}",
            "core:extensions": [{"name": "cuav", "version": CUAV_EXT_VERSION, "optional": True}],
            "cuav:observation_point": ch.point,
            "cuav:op_id": op["id"],
            "cuav:site_id": ch.site_id,
            "cuav:usable_band_Hz": [b_lo, b_hi],
            "cuav:full_scale_dBm": fs_dBm,
            "cuav:full_scale_code": FULL_SCALE,
            "cuav:calibration_source": (idx.get("calibration") or {}).get("source"),
            "cuav:scale": idx.get("scale"),
            "cuav:adc_bits": bits,
            "cuav:time_basis": "logical_sim",
            "cuav:continuity": "continuous",
            "cuav:start_sample": int(idx["start_sample"]),
            "cuav:t0_s": float(idx["t0_s"]),
            "cuav:seed": first.get("seed"),
            "cuav:seed_source": first.get("seed_source"),
            "cuav:diagram_id": first.get("diagram_id"),
            "cuav:diagram_sha256": diagram_sha,
            "cuav:scenario_id": scen["scenario_id"],
            "cuav:scenario_sha256": diagram["scenario_ref"]["sha256"],
            "cuav:origin_kind": "mixed" if (diagram.get("template_ref") or {}).get("mode") == "mixed" else "synthetic",
            "cuav:content_sha256": q.sha256,
            "cuav:lossless": q.lossless,
            "cuav:quality": {"state": state, "reasons": reasons,
                             "engine_clipped_samples": int(idx.get("clipped_samples", 0)),
                             "export_clipped_samples": q.clipped_export,
                             "export_requantization": requant},
            "cuav:signal_trace": idx.get("trace"),
            **_preset_keys(scen, first),
            **_impairments(ch, scen, catalog),
            "cuav:model_trace": stages,
            "cuav:links_file": f"{stem}.cuav-links.jsonl",
            "cuav:exporter": f"tools/iq_export_sigmf.py {VERSION}",
        },
        "captures": [{"core:sample_start": 0, "core:frequency": fc}],
        "annotations": ann,
    }
    with open(os.path.join(out_dir, f"{stem}.sigmf-meta"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return {"op_id": op["id"], "point": ch.point, "stem": stem, "samples": n, "state": state,
            "lossless": q.lossless, "export_clipped": q.clipped_export,
            "max_readback_error_codes": q.max_readback_err_codes,
            "requant_margin_dB": None if not requant else requant["margin_dB"],
            "annotations": len(ann), **ann_stats}


def export_run(run_dir: str, out_dir: str, diagram_path: str | None = None, ops: list[str] | None = None,
               stem_prefix: str | None = None, scenario_path: str | None = None) -> list[dict]:
    diagram_path = diagram_path or os.path.join(run_dir, "diagram.json")
    if not os.path.exists(diagram_path):
        raise ExportError(f"找不到框图文件 {diagram_path}（经应用服务提交的任务在运行目录里有 diagram.json，否则用 --diagram 给）")
    with open(diagram_path, "rb") as fh:
        diagram_bytes = fh.read()
    diagram = json.loads(diagram_bytes)
    first, last = read_events(run_dir)
    if last.get("run_state") != "finished":
        raise ExportError(f"运行没有正常结束（run_state = {last.get('run_state')}）")
    if last.get("result") == "invalid":
        raise ExportError("运行结果是 invalid，不导出")
    if first.get("diagram_id") != diagram.get("diagram_id"):
        raise ExportError(f"框图文件（{diagram.get('diagram_id')}）不是这次运行用的（{first.get('diagram_id')}）")
    if not diagram.get("scenario_ref"):
        raise ExportError("框图没有 scenario_ref：本工具只导出合成与混合增强运行（真值与链路几何都来自场景）")
    scen_path, scen = find_scenario(diagram["scenario_ref"]["scenario_id"], diagram["scenario_ref"]["sha256"],
                                    scenario_path)
    catalog = engine_catalog(first.get("engine_version"))
    want = [op for op in diagram.get("observation_points", []) if "iq" in op.get("products", [])]
    if ops:
        missing = sorted(set(ops) - {op["id"] for op in want})
        if missing:
            raise ExportError(f"这些观测点没开 iq 产品：{missing}")
        want = [op for op in want if op["id"] in ops]
    if not want:
        raise ExportError("框图里没有开 iq 产品的观测点（observation_points[].products 要含 iq）")
    os.makedirs(out_dir, exist_ok=True)
    prefix = stem_prefix or first.get("task_id") or os.path.basename(os.path.normpath(run_dir))
    dsha = hashlib.sha256(diagram_bytes).hexdigest()
    return [export_op(run_dir, diagram, dsha, scen_path, scen, first, last, catalog, op, out_dir,
                      f"{prefix}_{op['id']}") for op in want]


def validate_with_sigmf(out_dir: str, stems: list[str]) -> None:
    """用 SigMF 官方包逐文件校验（开发期工具，经 uv --with sigmf 拉起）。"""
    import sigmf
    for s in stems:
        f = sigmf.sigmffile.fromfile(os.path.join(out_dir, s))
        f.validate()
        if f.get_global_field("core:sha512") != f.calculate_hash():
            raise ExportError(f"{s}：数据文件的 SHA-512 与元数据不符")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Q-1：观测点原始样点导出 SigMF（14 报告 §5）")
    ap.add_argument("run_dir", help="cuav_run --out 的运行目录")
    ap.add_argument("-o", "--out", required=True, help="输出目录")
    ap.add_argument("--diagram", help="框图文件（运行目录里没有 diagram.json 时必给）")
    ap.add_argument("--op", action="append", help="只导出这些观测点（可多次给）")
    ap.add_argument("--stem", help="输出文件名前缀，缺省取任务标识")
    ap.add_argument("--scenario", help="场景文件（不在 data/scene/*/scenarios/ 里时给；照样核对字节哈希）")
    ap.add_argument("--validate", action="store_true", help="导出后用 SigMF 官方包校验（需 --with sigmf）")
    args = ap.parse_args(argv)
    try:
        res = export_run(args.run_dir, args.out, args.diagram, args.op, args.stem, args.scenario)
        if args.validate:
            validate_with_sigmf(args.out, [r["stem"] for r in res])
    except ExportError as e:
        print(f"导出中止：{e}", file=sys.stderr)
        return 2
    for r in res:
        extra = "无损" if r["lossless"] else (f"重量化余量 {r['requant_margin_dB']} dB，回读最大误差 "
                                              f"{r['max_readback_error_codes']:.3f} 码，导出削顶 {r['export_clipped']}")
        print(f"{r['stem']}：{r['point']} {r['samples']} 样点，{r['state']}，{extra}；注记 {r['annotations']} 条"
              + (f"（{r['outside_capture']} 段落在录制时间外）" if r["outside_capture"] else ""))
    if args.validate:
        print("SigMF 官方校验：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
