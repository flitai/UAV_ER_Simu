"""正式集的矩阵：按 14 号报告 §8.2 展开成格子文件（Q-6，D-104）。

写出的是意图（接收配置、传播、S4、平台与辐射源、信噪比目标、非视距的搜索范围）；位置照旧由
`gen_eval_dataset.py resolve` 解算并冻结。重跑本模块时，意图没变的格子保留已解算的位置。

矩阵（104 段；14 §8.2 原定 106 段，两格在本站址达不到，见 OMITTED）：
- 2.4 GHz 单源 60：图传 10 MHz（带 DroneID 广播）、图传 20 MHz、DJI 遥控上行、FrSky、Futaba
  × 信噪比 30 / 20 / 10 / 5 / 0 / −5 dB × 视距 / 非视距；
- 2.4 GHz 多源 12：图传 + 本机遥控；两架同频 + 一架邻频的 10 MHz 图传；DJI + 第三方遥控
  × 20 / 10 dB × 视距 / 非视距；
- 5.8 GHz 24：图传 20 MHz、40 MHz（都带 DroneID 广播）× 6 档 × 2，去掉两档 30 dB 的非视距格（见 OMITTED），
  另加多源两段（视距 20 dB、非视距 10 dB）；
- 纯背景 8：每种 S4 配置一段（5），另加三段理想接收机（不含接收机非理想效应）作对照；全部合成（用户 2026-10-11）。

平台与辐射源的定义照抄样本集（sample-v1）的格子，同一机型在两个集合里一字不差。样本集的 10 格按原定义
并入（`seed_from`：同种子、同位置；D-102 之后图传预设是 v2，含图传的 5 格数据因循环前缀排布不同而不同）。

两条规则（用户 2026-10-11 定）：
- **视距格的地平线限距**：按链路预算反解的水平距离超过无线电视距（4/3 等效地球半径）的 80% 时，
  把平台放在该距离上，差额用降低发射功率补，记在平台的 `power_reduction` 里；
- **非视距格**：按环搜索被楼挡住、刀口损耗不低于 10 dB 的点；无人机的高度也是解算变量（40 → 10 m），
  标称功率下都对不上时把发射功率上调到恰好够，最多 30 dBm；多源格后解的平台与先解的平台至少相隔 100 m。
"""
from __future__ import annotations

import copy
import math

from . import cells as C
from . import scenario as S

SET_ID = "formal-v1"
SOURCE = "sample-v1"
SAMPLE_NAME = "仿真合成数据样本集 v1"     # 样本集的对外名称（D-101），正式集的数据说明引用它
SNRS = (30, 20, 10, 5, 0, -5)
MULTI_SNRS = (20, 10)
K_EARTH = 4.0 / 3.0
R_EARTH_M = 6371000.0
HORIZON_SHARE = 0.8
NLOS_MIN_DIFFRACTION_DB = 10.0
NLOS_MAX_DIFFRACTION_DB = 45.0
NLOS_UAV_ALT_M = 40.0
NOMINAL_TX_DBM = 20.0
NLOS_UAV_ALTS_M = (40.0, 30.0, 20.0, 10.0)
MAX_TX_DBM = 30.0          # 上调的上限：等效全向辐射功率 32 dBm，在 DJI 设备 FCC 档的上限 33 dBm 以内
MIN_SEPARATION_M = 100.0

# 不做的格：上调到 MAX_TX_DBM 仍达不到（用户 2026-10-11 定）。站址周边楼高、楼后阴影深，5.8 GHz 宽带图传在
# 刀口损耗不低于 10 dB 的点上，标称功率下的带内信噪比最高约 16.5 dB（20 MHz）与 13.5 dB（40 MHz）。
OMITTED = {
    "o20-nlos-p30": "5.8 GHz 图传 20 MHz 在本站址的非视距点（刀口损耗 ≥ 10 dB）上，标称功率下带内信噪比最高约 16.5 dB，发射功率上调到 30 dBm 也到不了 30 dB",
    "o40-nlos-p30": "5.8 GHz 图传 40 MHz 在本站址的非视距点（刀口损耗 ≥ 10 dB）上，标称功率下带内信噪比最高约 13.5 dB，发射功率上调到 30 dBm 也到不了 30 dB",
}

# 样本集的格子在正式集里的位置（格子标识 → 样本集格子）
FROM_SAMPLE = {
    "v10-los-p30": "s01", "v20-los-p30": "s02", "up-los-p30": "s03", "frsky-los-p30": "s04",
    "futaba-los-p30": "s05", "o40-los-p30": "s06", "mx3rd-los-p20": "s07", "bg-rc": "s08",
    "v20-nlos-p10": "s09", "up-nlos-p10": "s10",
}


def snr_token(x: float) -> str:
    return ("p" if x >= 0 else "m") + f"{abs(int(x)):02d}"


def horizon_m(h1: float, h2: float) -> float:
    """两个离地高度之间的无线电视距（m），4/3 等效地球半径。"""
    return math.sqrt(2 * K_EARTH * R_EARTH_M * h1) + math.sqrt(2 * K_EARTH * R_EARTH_M * h2)


def _sample_cell(src: dict, cid: str) -> dict:
    return copy.deepcopy(next(c for c in src["cells"] if c["id"] == cid))


def _strip(platform: dict) -> dict:
    p = {k: v for k, v in platform.items() if k not in ("resolved", "search")}
    return p


# 单源组：组标识 → (样本集里的模板格、对外名称、接收配置)
SINGLE = {
    "v10": ("s01", "DJI 图传 10 MHz + DroneID 广播"),
    "v20": ("s02", "DJI 图传 20 MHz"),
    "up": ("s03", "DJI 遥控上行（2.2 MHz 跳频）"),
    "frsky": ("s04", "FrSky D16 遥控（FCC）"),
    "futaba": ("s05", "Futaba S-FHSS 遥控"),
    "o20": (None, "DJI 图传 20 MHz + DroneID 广播（5.8 GHz）"),
    "o40": ("s06", "DJI 图传 40 MHz + DroneID 广播（5.8 GHz）"),
}


def _o20_template(src: dict) -> dict:
    """5.8 GHz 的 20 MHz 档：s06 的平台换成 20 MHz 预设（中心 5796.5 MHz，标 A），S4 抽取 2。"""
    c = _sample_cell(src, "s06")
    p = c["platforms"][0]
    v = next(e for e in p["emitters"] if e["id"] == "uav-1")
    v.update({"name": "DJI 图传下行（20 MHz，5.8 GHz）", "equipment_model": "DJI 20 MHz 图传",
              "preset": "dji-video-20m-a", "center_Hz": 5796500000})
    d = next(e for e in p["emitters"] if e["id"] == "uav-1-droneid")
    d["name"] = "同一架机的 DroneID 广播（5.8 GHz）"
    p["azimuth_deg"] = 45
    c["s4"] = {"decim": 2, "f_shift_Hz": 6500000}
    c["plan_allow"] = {"transition": "S4 对准图传（40 MS/s @ 5796.5 MHz）；同机的 DroneID 广播在 S4 通带外，只在 S3 里（同样本集 s07）"}
    return c


def _template(src: dict, key: str) -> dict:
    sid = SINGLE[key][0]
    return _o20_template(src) if sid is None else _sample_cell(src, sid)


def _need_range_m(doc: dict, cell: dict, p: dict, snr: float) -> float:
    """主辐射源按标称功率达到 snr 所需的水平距离（自由空间，按主辐射源的第一个频点）。"""
    from . import resolve as R
    e = next(x for x in p["emitters"] if x["id"] == p["primary"])
    pl = S.target_path_loss_dB(doc["site"], e, snr)
    f = R._freq(doc, cell, e["id"])
    slant = 10 ** ((pl - 20 * math.log10(4 * math.pi * f / R.C0)) / 20)
    dh = p["alt_m"] - doc["site"]["alt_m"]
    return math.sqrt(max(slant * slant - dh * dh, 1.0))


def _apply_los(doc: dict, cell: dict, p: dict, snr: float) -> None:
    p["snr_dB"] = snr
    need = _need_range_m(doc, cell, p, snr)
    cap = HORIZON_SHARE * horizon_m(p["alt_m"], doc["site"]["alt_m"])
    if need > cap:
        red = math.ceil(20 * math.log10(need / cap) * 10 - 1e-9) / 10
        for e in p["emitters"]:
            e["tx_power_dBm"] = round(e["tx_power_dBm"] - red, 1)
        p["power_reduction"] = {
            "dB": red, "nominal_dBm": NOMINAL_TX_DBM, "horizon_m": round(cap / HORIZON_SHARE, 1),
            "max_range_m": round(cap, 1),
            "rule": "按标称功率所需的水平距离超过无线电视距（4/3 等效地球半径）的 80%：平台放在该距离以内，差额由降低发射功率补"}


def _apply_nlos(doc: dict, cell: dict, p: dict, snr: float, multi: bool) -> None:
    """非视距搜索的范围。无人机的高度也是解算变量（40、30、20、10 m 依次试）；标称功率下都对不上时，
    发射功率最多上调到 MAX_TX_DBM（用户 2026-10-11 定）。上调 R 时可达的最远距离是 need·10^((R − D_min)/20)，
    故上限取 need 与地平线限距中较小的一个。"""
    p["snr_dB"] = snr
    p.pop("azimuth_deg", None)
    uav = p["alt_m"] > 10
    if uav:
        p["alt_m"] = NLOS_UAV_ALT_M
    need = _need_range_m(doc, cell, p, snr)
    cap = HORIZON_SHARE * horizon_m(p["alt_m"], doc["site"]["alt_m"])
    raise_max = MAX_TX_DBM - max(e["tx_power_dBm"] for e in p["emitters"])
    r_max = min(cap, need * 10 ** ((raise_max - NLOS_MIN_DIFFRACTION_DB) / 20))
    r_min = max(20.0, need * 10 ** (-NLOS_MAX_DIFFRACTION_DB / 20))
    step = max(10, int(round((r_max - r_min) / 150 / 10.0)) * 10)
    lo = int(math.floor(r_min / 10.0)) * 10
    hi = int(math.ceil(r_max / 10.0)) * 10
    p["search"] = {"range_m": [lo, max(hi, lo + step), step], "azimuth_step_deg": 1,
                   "min_diffraction_dB": NLOS_MIN_DIFFRACTION_DB, "tol_dB": 0.5,
                   "altitudes_m": list(NLOS_UAV_ALTS_M) if uav else [p["alt_m"]],
                   "max_tx_power_dBm": MAX_TX_DBM}
    if multi:
        p["search"]["min_separation_m"] = MIN_SEPARATION_M


def _cell(cid: str, title: str, group: dict, base: dict) -> dict:
    c = {"id": cid, "title": title, "group": group}
    for k in ("receiver", "propagation", "s4", "plan_allow", "platforms"):
        if k in base:
            c[k] = base[k]
    return c


def build_cells(doc: dict, src: dict) -> list[dict]:
    out: list[dict] = []
    # ---- 单源（2.4 GHz 与 5.8 GHz）
    for key, (_, label) in SINGLE.items():
        for prop in ("los", "nlos"):
            for snr in SNRS:
                cid = f"{key}-{prop}-{snr_token(snr)}"
                if cid in OMITTED:
                    continue
                group = {"kind": "single", "preset_group": key, "propagation": prop, "snr_dB": snr}
                title = f"{label}，{'视距' if prop == 'los' else '非视距'}，信噪比 {snr:g} dB"
                if cid in FROM_SAMPLE:
                    out.append(_from_sample(src, cid, title, group))
                    continue
                t = _template(src, key)
                t["id"] = cid                      # 跳频预设的第一跳由本格的种子定，算距离要用本格的标识
                t["propagation"] = prop
                p = t["platforms"][0]
                p.pop("resolved", None)
                p.pop("search", None)
                if prop == "los":
                    _apply_los(doc, t, p, snr)
                else:
                    _apply_nlos(doc, t, p, snr, False)
                out.append(_cell(cid, title, group, t))
    # ---- 2.4 GHz 多源
    s07 = _sample_cell(src, "s07")
    for kind, label in (("mxvrc", "DJI 图传 + 本机遥控上行"), ("mxco", "三架 DJI 10 MHz 图传：两架同频、一架邻频"),
                        ("mx3rd", "DJI 图传 + 本机遥控 + 第三方遥控（FrSky）")):
        for prop in ("los", "nlos"):
            for snr in MULTI_SNRS:
                cid = f"{kind}-{prop}-{snr_token(snr)}"
                group = {"kind": "multi", "preset_group": kind, "propagation": prop, "snr_dB": snr}
                title = f"{label}，{'视距' if prop == 'los' else '非视距'}，各平台信噪比 {snr:g} dB"
                if cid in FROM_SAMPLE:
                    out.append(_from_sample(src, cid, title, group))
                    continue
                if kind == "mxco":
                    t = _co_adjacent(src)
                else:
                    t = copy.deepcopy(s07)
                    if kind == "mxvrc":
                        t["platforms"] = [p for p in t["platforms"] if p["id"] != "rc-frsky"]
                        t["plan_allow"] = {
                            "edge": "遥控的最低跳频点离 S3 带边不到界面的 5% 保护带；引擎的铁律 4 闸不含保护带、放行（同 D-089 ⑫）",
                            "transition": "S4 对准图传；DroneID 广播与遥控的大部分跳频点在 S4 通带外，只在 S3 里"}
                t["id"] = cid
                t["propagation"] = prop
                _place_all(doc, t, prop, snr)
                out.append(_cell(cid, title, group, t))
    # ---- 5.8 GHz 多源
    for prop, snr in (("los", 20), ("nlos", 10)):
        cid = f"mx58-{prop}-{snr_token(snr)}"
        group = {"kind": "multi", "preset_group": "mx58", "propagation": prop, "snr_dB": snr}
        title = f"5.8 GHz：DJI 图传 40 MHz + DroneID 广播，另一架 DJI 10 MHz 图传邻频，{'视距' if prop == 'los' else '非视距'}，各平台信噪比 {snr:g} dB"
        t = _sample_cell(src, "s06")
        uav2 = copy.deepcopy(_sample_cell(src, "s01")["platforms"][0])
        uav2["id"] = "dji-2"
        uav2["name"] = "第二架 DJI 无人机"
        uav2["azimuth_deg"] = 210
        uav2["primary"] = "uav-2"
        v = next(e for e in uav2["emitters"] if e["id"] == "uav-1")
        # 5820.5 MHz：与主图传（上沿 5814.5 MHz）隔 1.5 MHz，离 S3 带边留出界面的 5% 保护带，且在 S4 可用频带内
        v.update({"id": "uav-2", "name": "第二架机的图传下行（10 MHz，5.8 GHz）", "center_Hz": 5820500000})
        uav2["emitters"] = [v]
        t["platforms"].append(uav2)
        t["id"] = cid
        t["propagation"] = prop
        _place_all(doc, t, prop, snr)
        out.append(_cell(cid, title, group, t))
    # ---- 纯背景
    idle = _sample_cell(src, "s08")
    bgs = [("bg-v10", "R1", "s01", True, "S4 与图传 10 MHz 段相同"),
           ("bg-v20", "R1", "s02", True, "S4 与图传 20 MHz 段相同"),
           ("bg-rc", "R1", "s08", True, "S4 与跳频遥控段相同"),
           ("bg-o20", "R2", None, True, "S4 与 5.8 GHz 图传 20 MHz 段相同"),
           ("bg-o40", "R2", "s06", True, "S4 与 5.8 GHz 图传 40 MHz 段相同"),
           ("bg-rc-ideal", "R1", "s08", False, "理想接收机，S4 与跳频遥控段相同"),
           ("bg-v20-ideal", "R1", "s02", False, "理想接收机，S4 与图传 20 MHz 段相同"),
           ("bg-o40-ideal", "R2", "s06", False, "理想接收机，S4 与 5.8 GHz 图传 40 MHz 段相同")]
    for cid, rcv, s4_from, impaired, note in bgs:
        group = {"kind": "background", "preset_group": cid, "propagation": "los", "snr_dB": None}
        what = "仅含接收机噪声与接收机非理想效应" if impaired else "仅含接收机噪声（理想接收机，不含接收机非理想效应）"
        title = f"纯背景：{what}；{note.replace('理想接收机，', '')}"
        if cid in FROM_SAMPLE:
            out.append(_from_sample(src, cid, title, group))
            continue
        t = copy.deepcopy(idle)
        t["receiver"] = rcv
        t["s4"] = copy.deepcopy(_template(src, "o20")["s4"] if s4_from is None else _sample_cell(src, s4_from)["s4"])
        if cid != "bg-rc":                       # 占位辐射源（全程关断）放在 S4 中心，免得频率计划把它当作通带外的目标
            t["platforms"][0]["emitters"][0]["center_Hz"] = doc["receivers"][rcv]["center_Hz"] + t["s4"]["f_shift_Hz"]
        t["platforms"][0].pop("resolved", None)
        c = _cell(cid, title, group, t)
        if not impaired:
            c["impairments"] = False
        out.append(c)
    return out


def _co_adjacent(src: dict) -> dict:
    """三架 10 MHz 图传：uav-1、uav-2 同在 2462.5 MHz，uav-3 在 2452.5 MHz（与 uav-1 / uav-2 隔 1 MHz）。
    S4 取 40 MS/s @ 2457.5 MHz（抽取 2、频移 +17.5 MHz），三路都在可用频带 ±16 MHz 以内。不带 DroneID 广播。"""
    s01 = _sample_cell(src, "s01")
    base = s01["platforms"][0]
    plats = []
    for i, (az, fc) in enumerate(((40, 2462500000), (160, 2462500000), (280, 2452500000)), start=1):
        p = copy.deepcopy(base)
        p.pop("resolved", None)
        p["id"] = f"dji-{i}"
        p["name"] = f"DJI 无人机 {i}"
        p["azimuth_deg"] = az
        p["primary"] = f"uav-{i}"
        v = copy.deepcopy(next(e for e in base["emitters"] if e["id"] == "uav-1"))
        v.update({"id": f"uav-{i}", "name": f"无人机 {i} 的图传下行（10 MHz）", "center_Hz": fc})
        p["emitters"] = [v]
        plats.append(p)
    return {"title": "", "receiver": "R1", "propagation": "los", "s4": {"decim": 2, "f_shift_Hz": 17500000},
            "platforms": plats}


def _place_all(doc: dict, t: dict, prop: str, snr: float) -> None:
    n = len(t["platforms"])
    for p in t["platforms"]:
        p.pop("resolved", None)
        p.pop("search", None)
        p.pop("power_reduction", None)
        if prop == "los":
            _apply_los(doc, t, p, snr)
        else:
            _apply_nlos(doc, t, p, snr, n > 1)


def _from_sample(src: dict, cid: str, title: str, group: dict) -> dict:
    s = _sample_cell(src, FROM_SAMPLE[cid])
    c = {"id": cid, "title": title, "group": group,
         "seed_from": {"set": SOURCE, "cell": s["id"], "set_seed": src["set_seed"]}}
    for k, v in s.items():
        if k not in ("id", "title"):
            c[k] = v
    return c


def build(existing: dict | None = None) -> dict:
    """正式集格子文件。existing：已有的文件——意图没变的格子保留它的已解算位置。"""
    src = C.load(SOURCE)
    doc = {
        "schema_version": "cuav-eval-cells/1",
        "set_id": SET_ID,
        "name": "仿真合成数据集 v1",
        "purpose": "formal",
        "stem_prefix": "fv1",
        "set_seed": 20261011,
        "duration_s": src["duration_s"],
        "created_at": "2026-10-11T00:00:00Z",
        "aoi_id": src["aoi_id"],
        "notes": ("14 号报告 §8.2 的正式集（Q-6，D-104）：2.4 GHz 单源 60、多源 12、5.8 GHz 24、纯背景 8，共 104 段，每段 1 s；"
                  "原定 106 段，5.8 GHz 两档 30 dB 的非视距格在本站址达不到，见 omitted。"
                  "格子由 scripts/eval_dataset/matrix.py 展开，平台与辐射源的定义照抄样本集 sample-v1；样本集的 10 格经 seed_from 并入。"
                  "机型预设用 v2（D-102）。视距格按链路预算反解的水平距离超过无线电视距的 80% 时，差额由降低发射功率补（用户 2026-10-11 定）。"
                  "非视距格把无人机高度作为解算变量，仍达不到时发射功率最多上调到 30 dBm（用户 2026-10-11 定）。"
                  "纯背景全部合成，不放混合增强段（用户 2026-10-11 定）。信噪比目标只对每个平台的主辐射源，是链路预算的带内信噪比。"),
    }
    for k in C.GEN_KEYS:
        doc[k] = copy.deepcopy(src[k])
    doc["omitted"] = [{"id": k, "reason": v} for k, v in OMITTED.items()]
    doc["cells"] = []
    built = build_cells(doc, src)
    old = {c["id"]: c for c in (existing or {}).get("cells", [])}
    for c in built:
        o = old.get(c["id"])
        if o and "seed_from" not in c and _intent(o) == _intent(c):
            for p, op in zip(c["platforms"], o["platforms"]):
                if "resolved" in op:
                    p["resolved"] = op["resolved"]
        doc["cells"].append(c)
    return doc


def _intent(c: dict) -> dict:
    """决定位置的那部分意图：格子标识（跳频的第一跳由它的种子定）、接收配置、传播与平台。
    标题、分组、S4 与放行说明改了不影响位置，不该让已解的位置作废。"""
    d = {k: copy.deepcopy(c.get(k)) for k in ("id", "receiver", "propagation", "platforms")}
    for p in d["platforms"] or []:
        p.pop("resolved", None)
    return d
