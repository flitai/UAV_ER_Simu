"""DS-8 / DA-8：为两个公开数据集估算功率标定常数 full_scale_dBm（决策 D-047）。

full_scale_dBm 的定义：量化码满量程（|x| = 32768）对应的接收功率（dBm，接收机天线端口）。
引擎回放时按 x = code / 32768 × 10^(full_scale_dBm / 20) 换算到内部单位（|x|² = mW）。

两种估法：
  方法 A（论文法）  full_scale_dBm = P_fs0 − gain_dB。P_fs0 是 0 dB 增益时满量程对应的输入功率，
                    USRP-2955 规格只给了最大输入 +10 dBm 与增益范围 0–93 dB，P_fs0 取 0 dBm 是假定值。
                    只有 DroneRFa 的论文给了接收增益（50 dB），DroneRFb 没有。
  方法 B（链路预算反推）full_scale_dBm = P_rx_pred − P_sig_dBFS。P_rx_pred = EIRP + G_rx − FSPL(f, d)，
                    EIRP 取 2.4 GHz 图传在国内的上限 20 dBm（假定），G_rx 3 dBi（RFa 论文 / RFb 假定），
                    d 取论文标注（RFb 固定 10 m；RFa 取区间中点，与 DA-6 同一假设）。
                    P_sig_dBFS 是突发期间的带内信号功率（相对满量程，减去底噪），逐片实测。
取舍规则（06 §11.2、D-047 ③）：论文给了接收增益的数据集（RFa）优先方法 A、来源标 paper，但要过一道物理一致性
检查——按该常数换算的底噪相对热噪声（−174 dBm/Hz + 10·log10(B)）得出的等效噪声系数必须落在 0–15 dB 内；
过不了才退到方法 B 标 model。RFb 论文没有增益，只能方法 B，标 model。两法的分歧与各自隐含的噪声系数都写进
derived_from（2026-09-06 实测：RFa 两法差 40 dB，方法 A 隐含噪声系数约 2 dB、方法 B 约 42 dB，故取 A）。
所有数字都是「原型阶段验证值」（D-028），甲方数据到货后按本脚本重估。

验收集不参与：DroneRFb 只用出版方训练集里的视距片，并与 holdout.manifest.json 核对无交集。

用法：uv run --quiet --with numpy python scripts/ds8_calibration.py [--out data/iq/measured/calibration.json] [--per-class 2]
"""
import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from iq_format import store  # noqa: E402

VERSION = "0.1.0"
C = 299792458.0            # 新写代码统一 c = 299792458（D-009）
NFFT = 1024
FULL_SCALE = 32768.0

# 假定与论文参数，全部进 derived_from
EIRP_DBM = 20.0            # 2.4 GHz 图传，国内上限（假定）
G_RX_DBI = 3.0             # RFa 论文「全向垂直，3 dBi」；RFb 无记录，按同型天线假定
P_FS0_DBM = 0.0            # 0 dB 增益时满量程输入功率（假定；规格最大输入 +10 dBm）
RFA_GAIN_DB = 50.0         # RFa 论文
RFB_DISTANCE_M = 10.0      # RFb 论文固定
RFA_D00_RANGE_M = (20.0, 40.0)
ON_THRESHOLD_DB = 6.0      # 帧总功率高于底噪 6 dB 视为突发期间
NF_PLAUSIBLE_DB = (0.0, 15.0)   # 常数隐含的等效噪声系数必须落在这个区间，方法 A 才可信
KTB_DBM_PER_HZ = -174.0


def fspl_dB(f_Hz: float, d_m: float) -> float:
    return 20.0 * math.log10(4.0 * math.pi * d_m * f_Hz / C)


def burst_power_dBFS(x: np.ndarray, nfft: int = NFFT) -> dict:
    """突发期间的总功率（相对满量程）与底噪。逐帧 hann 窗功率谱，底噪 = 逐 bin 帧维中位数之和。"""
    x = x / FULL_SCALE
    n = len(x) // nfft
    w = np.hanning(nfft)
    P = np.abs(np.fft.fft(x[: n * nfft].reshape(n, nfft) * w, axis=1)) ** 2 / (w.sum() ** 2)
    tot = P.sum(axis=1)
    floor = float(np.median(P, axis=0).sum())
    on = tot > floor * 10 ** (ON_THRESHOLD_DB / 10)
    if not on.any():
        return {"frames": n, "on_frames": 0, "floor_dBFS": 10 * math.log10(floor), "sig_dBFS": None}
    sig = float((tot[on] - floor).mean())      # 线性域求均值（铁律 5）
    return {"frames": n, "on_frames": int(on.sum()), "floor_dBFS": 10 * math.log10(floor),
            "sig_dBFS": 10 * math.log10(sig), "duty": float(on.mean())}


def implied_nf_dB(floor_dBFS: float, full_scale_dBm: float, bandwidth_Hz: float) -> float:
    """按常数换算的底噪相对热噪声的超出量 = 等效噪声系数（含增益前的一切损耗）。"""
    floor_dBm = floor_dBFS + full_scale_dBm
    return floor_dBm - (KTB_DBM_PER_HZ + 10.0 * math.log10(bandwidth_Hz))


def holdout_ids() -> set:
    p = os.path.join(ROOT, "data", "iq", "measured", "holdout.manifest.json")
    if not os.path.exists(p):
        return set()
    with open(p, encoding="utf-8") as f:
        return {e["data_id"] for e in json.load(f)["holdout"]}


def pick_rfb(index: dict, per_class: int, banned: set) -> list:
    """出版方训练集里的视距片，每个机型取前 per_class 片（按 data_id 排序，确定性）。"""
    by_class = {}
    for p in sorted(index["products"], key=lambda r: r["data_id"]):
        t = p.get("truth") or {}
        if t.get("split") != "train" or t.get("visibility") != "LOS":
            continue
        if p["data_id"] in banned:
            continue
        by_class.setdefault(t["class_code"], []).append(p["data_id"])
    return [(c, d) for c, ids in sorted(by_class.items()) for d in ids[:per_class]]


def estimate_rfb(dir_: str, per_class: int) -> dict:
    with open(os.path.join(dir_, "index.manifest.json"), encoding="utf-8") as f:
        index = json.load(f)
    banned = holdout_ids()
    picks = pick_rfb(index, per_class, banned)
    f_Hz = 2.44e9
    p_rx = EIRP_DBM + G_RX_DBI - fspl_dB(f_Hz, RFB_DISTANCE_M)
    rows = []
    for cls, did in picks:
        prod = store.open_product(os.path.join(dir_, did + ".manifest.json"))
        r = burst_power_dBFS(prod.read(0, prod.sample_count))
        r.update({"data_id": did, "class_code": cls})
        rows.append(r)
        print(f"  {did:<40} {cls:<3} 帧 {r['frames']:5d} 突发帧 {r['on_frames']:5d} 底噪 {r['floor_dBFS']:7.1f} dBFS"
              f" 信号 {r['sig_dBFS'] if r['sig_dBFS'] is None else round(r['sig_dBFS'], 1)} dBFS")
    sig = np.array([r["sig_dBFS"] for r in rows if r["sig_dBFS"] is not None])
    med = float(np.median(sig))
    per_class_med = {}
    for r in rows:
        if r["sig_dBFS"] is not None:
            per_class_med.setdefault(r["class_code"], []).append(r["sig_dBFS"])
    per_class_med = {k: round(float(np.median(v)), 2) for k, v in per_class_med.items()}
    fs_dBm = p_rx - med
    floor_med = float(np.median([r["floor_dBFS"] for r in rows]))
    nf = implied_nf_dB(floor_med, fs_dBm, 80e6)
    return {
        "dataset": "DroneRFb-DIR",
        "receiver": "USRP-2955",
        "full_scale_dBm": round(fs_dBm, 1),
        "source": "model",
        "note": (f"由 10 m 视距自由空间链路预算反推：P_rx = {EIRP_DBM:.0f} dBm(EIRP，假定) + {G_RX_DBI:.0f} dBi(假定)"
                 f" − FSPL({f_Hz/1e9:.2f} GHz, {RFB_DISTANCE_M:.0f} m) = {p_rx:.1f} dBm；"
                 f"实测突发功率中位 {med:.1f} dBFS（{len(sig)} 片、{len(per_class_med)} 型）。"
                 f"隐含等效噪声系数 {nf:.0f} dB，对应近零增益录制（10 m 强信号避免削顶），论文无增益记录无法核对。"
                 f"原型阶段验证值（D-028）"),
        "derived_from": {
            "method": "B_link_budget",
            "EIRP_dBm": {"value": EIRP_DBM, "source": "assumed", "note": "2.4 GHz 图传国内上限"},
            "G_rx_dBi": {"value": G_RX_DBI, "source": "assumed"},
            "distance_m": {"value": RFB_DISTANCE_M, "source": "paper"},
            "frequency_Hz": f_Hz,
            "fspl_dB": round(fspl_dB(f_Hz, RFB_DISTANCE_M), 2),
            "p_rx_pred_dBm": round(p_rx, 2),
            "sig_dBFS_median": round(med, 2),
            "sig_dBFS_min": round(float(sig.min()), 2),
            "sig_dBFS_max": round(float(sig.max()), 2),
            "sig_dBFS_per_class_median": per_class_med,
            "floor_dBFS_median": round(floor_med, 2),
            "implied_noise_figure_dB": round(nf, 1),
            "pieces": [r["data_id"] for r in rows],
            "selection": f"出版方训练集视距片，每型前 {per_class} 片，已排除验收集",
            "on_threshold_dB": ON_THRESHOLD_DB,
            "nfft": NFFT,
        },
    }


def estimate_rfa(dir_: str) -> dict:
    with open(os.path.join(dir_, "index.manifest.json"), encoding="utf-8") as f:
        index = json.load(f)
    f_Hz = 2.44e9
    d_mid = sum(RFA_D00_RANGE_M) / 2
    p_rx = EIRP_DBM + G_RX_DBI - fspl_dB(f_Hz, d_mid)
    picks = [p["data_id"] for p in sorted(index["products"], key=lambda r: r["data_id"])
             if (p.get("truth") or {}).get("distance_bin") == "D00"
             and (p.get("truth") or {}).get("band_state") == "initial"
             and (p.get("truth") or {}).get("class_code") != "T0000"]
    rows = []
    for did in picks:
        prod = store.open_product(os.path.join(dir_, did + ".manifest.json"))
        n = prod.sample_count
        # 与 DA-6 同法：6 个偏移 × 200 万点，避免整片读入
        offs = [0, 30_000_000, 60_000_000, 90_000_000, 120_000_000, min(146_000_000, n - 2_000_000)]
        parts = [burst_power_dBFS(prod.read(o, 2_000_000)) for o in offs if o + 2_000_000 <= n]
        sig_lin = [10 ** (q["sig_dBFS"] / 10) for q in parts if q["sig_dBFS"] is not None]
        r = {"data_id": did, "floor_dBFS": float(np.mean([q["floor_dBFS"] for q in parts])),
             "sig_dBFS": 10 * math.log10(float(np.mean(sig_lin))) if sig_lin else None,
             "on_frames": int(sum(q["on_frames"] for q in parts))}
        rows.append(r)
        print(f"  {did:<40} 突发帧 {r['on_frames']:5d} 底噪 {r['floor_dBFS']:7.1f} dBFS 信号 "
              f"{r['sig_dBFS'] if r['sig_dBFS'] is None else round(r['sig_dBFS'], 1)} dBFS")
    sig = np.array([r["sig_dBFS"] for r in rows if r["sig_dBFS"] is not None])
    med = float(np.median(sig))
    floor_mean = float(np.mean([r["floor_dBFS"] for r in rows]))
    fs_a = P_FS0_DBM - RFA_GAIN_DB
    fs_b = p_rx - med
    nf_a = implied_nf_dB(floor_mean, fs_a, 100e6)
    nf_b = implied_nf_dB(floor_mean, fs_b, 100e6)
    a_ok = NF_PLAUSIBLE_DB[0] <= nf_a <= NF_PLAUSIBLE_DB[1]
    chosen = fs_a if a_ok else fs_b
    src = "paper" if a_ok else "model"
    note = (f"方法 A（论文法）：P_fs0 {P_FS0_DBM:.0f} dBm(假定) − 接收增益 {RFA_GAIN_DB:.0f} dB(论文) = {fs_a:.1f} dBm，"
            f"隐含等效噪声系数 {nf_a:.1f} dB；"
            f"方法 B（链路预算，D00 取区间中点 {d_mid:.0f} m）：{p_rx:.1f} dBm − 实测突发功率中位 {med:.1f} dBFS = {fs_b:.1f} dBm，"
            f"隐含噪声系数 {nf_b:.1f} dB；两法差 {abs(fs_a - fs_b):.1f} dB。"
            f"取方法 {'A：噪声系数落在物理合理区间，链路预算一侧的 EIRP 或距离标注不可靠' if a_ok else 'B：论文增益隐含的噪声系数不合理'}。"
            f"原型阶段验证值（D-028）")
    return {
        "dataset": "DroneRFa",
        "receiver": "USRP-2955",
        "full_scale_dBm": round(chosen, 1),
        "source": src,
        "note": note,
        "derived_from": {
            "method": "A_paper" if a_ok else "B_link_budget",
            "rule": f"论文有增益时优先方法 A，条件是隐含噪声系数在 {NF_PLAUSIBLE_DB} dB 内",
            "implied_noise_figure_dB": {"method_A": round(nf_a, 1), "method_B": round(nf_b, 1)},
            "method_A": {"p_fs0_dBm": {"value": P_FS0_DBM, "source": "assumed"},
                         "gain_dB": {"value": RFA_GAIN_DB, "source": "paper"}, "result_dBm": round(fs_a, 2)},
            "method_B": {"EIRP_dBm": {"value": EIRP_DBM, "source": "assumed"},
                         "G_rx_dBi": {"value": G_RX_DBI, "source": "paper"},
                         "distance_m": {"value": d_mid, "source": "assumed", "note": f"D00 区间 {RFA_D00_RANGE_M} 取中点，同 DA-6"},
                         "fspl_dB": round(fspl_dB(f_Hz, d_mid), 2), "p_rx_pred_dBm": round(p_rx, 2),
                         "sig_dBFS_median": round(med, 2),
                         "sig_dBFS_min": round(float(sig.min()), 2), "sig_dBFS_max": round(float(sig.max()), 2),
                         "result_dBm": round(fs_b, 2)},
            "disagreement_dB": round(abs(fs_a - fs_b), 2),
            "floor_dBFS_mean": round(floor_mean, 2),
            "pieces": [r["data_id"] for r in rows],
            "selection": "D00 档、2.4 GHz 初始频段状态、非背景；每片 6 个偏移 × 200 万点（同 DA-6）",
            "nfft": NFFT,
        },
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DS-8 / DA-8 功率标定常数估算")
    ap.add_argument("--measured", default=os.path.join(ROOT, "data", "iq", "measured"))
    ap.add_argument("--out", default=None, help="写常数表；不给只打印")
    ap.add_argument("--per-class", type=int, default=2, help="DroneRFb 每型取几片")
    args = ap.parse_args(argv)

    print("DroneRFb-DIR：")
    rfb = estimate_rfb(os.path.join(args.measured, "dronerfb"), args.per_class)
    print(f"  → full_scale_dBm = {rfb['full_scale_dBm']} ({rfb['source']})")
    print("DroneRFa：")
    rfa = estimate_rfa(os.path.join(args.measured, "dronerfa"))
    print(f"  → full_scale_dBm = {rfa['full_scale_dBm']} ({rfa['source']})；{rfa['note']}")

    table = {
        "schema": "cuav-calibration/1",
        "status": "prototype",
        "estimated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "producer": f"scripts/ds8_calibration.py {VERSION}",
        "definition": "full_scale_dBm = 量化码满量程 |x| = 32768 对应的接收功率（dBm，天线端口）；"
                      "引擎回放按 x = code / 32768 × 10^(full_scale_dBm/20) 换算到 |x|^2 = mW（D-047）",
        "note": "两个公开数据集都没有设备标定记录，本表是按论文参数与链路预算估算的原型阶段验证值（D-028），"
                "只用于让显示与计算落在物理合理的量级；甲方数据到货后按本脚本重估并替换。",
        "datasets": {rfb["dataset"]: rfb, rfa["dataset"]: rfa},
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(table, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"已写 {os.path.relpath(args.out, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
