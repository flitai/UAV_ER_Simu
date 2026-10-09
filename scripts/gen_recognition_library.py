#!/usr/bin/env python3
"""由校准统计与 Q-0b 实测机械生成识别库 v2（Q-4c，D-094；规则见 14 号报告 §8.6「区间从哪来」）。

输入（都入库）：
  models/recognition/v2-calibration.json   校准调查的统计表（algos/reference/q4c_feature_survey.py 生成，只取校准集）
  data/iq/measured/q0b-params.json         Q-0b 实测参数（D-086），只用预设出处里点名的那些组、可比的三项
输出：
  models/recognition/library-v2.json       库格式 cuav-recognition-library/2，feature_basis = subband

规则（先写死、再取数；改规则就是改基准，要记决策）：
  进哪几项    某项在该模板 ≥ 80% 的校准行里可用才进（跳频差与间隔要有上一段）
  区间        合成 [p2.5, p97.5] 与实测各组 [p10, p90] 取并；对数特征下界 ÷ e^0.3、上界 × e^0.3（0.3 = log_scale），
              线性特征 ±0.05 截在 [0, 1]；对数特征的下界低于 10 × log_floor 视为不设下界（写 0）
  取整        下界按 4 位有效数字向下、上界向上取整（只往宽里取）
  权重        带宽、时长 2，其余 1
  出处档      逐特征 S（只有合成）或 S+M（合成与实测取并）

用法：
    uv run --quiet python scripts/gen_recognition_library.py           # 生成
    uv run --quiet python scripts/gen_recognition_library.py --check   # 只核对入库的库与重新生成的逐字节相同
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALIB = os.path.join("models", "recognition", "v2-calibration.json")
Q0B = os.path.join("data", "iq", "measured", "q0b-params.json")
OUT = os.path.join("models", "recognition", "library-v2.json")

LOG_SCALE = 0.3
LOG_FLOOR = {"bandwidth_Hz": 1.0, "duration_s": 1e-06, "hop_from_prev_Hz": 1.0, "interval_from_prev_s": 1e-06}
FEATURE_ORDER = ["bandwidth_Hz", "duration_s", "spectral_flatness", "hop_from_prev_Hz", "interval_from_prev_s"]
LOG_FEATURES = {"bandwidth_Hz", "duration_s", "hop_from_prev_Hz", "interval_from_prev_s"}
WEIGHTS = {"bandwidth_Hz": 2.0, "duration_s": 2.0}       # 其余 1
AVAILABLE_MIN = 0.8
LINEAR_PAD = 0.05
MIN_ROWS = 100           # 预设模板：校准行少于它，p2.5 / p97.5 就由一两行决定了
MIN_ROWS_LEGACY = 2      # 旧合成波形：连续发射一个真值行只配上一段，行数天然很少（区间因此很薄，notes 里写明）
LEGACY_TEMPLATES = {"noise_video", "burst_fixed", "burst_hopping", "tone"}
SIG = 4

# 模板表：标签按评价器混淆矩阵的基础标签序，同一标签的模板按这里的顺序（并列时库序在前的赢）
TEMPLATES = [
    ("ofdm_video", "video_link", "DJI 图传下行：OFDM、9–36 MHz、毫秒级突发（Q-2 预设）"),
    ("noise_video", "video_link", "带限噪声图传：连续发射（golden-02 的旧合成波形）"),
    ("burst_fixed", "telemetry_burst", "定频突发（golden-03 的旧合成波形）"),
    ("ofdm_uplink", "rc_hopping", "DJI 遥控上行：OFDM、1–4.4 MHz、0.5 ms、跳频（Q-2 预设）"),
    ("gfsk_fhss", "rc_hopping", "第三方遥控：GFSK / 2-FSK 跳频、约 0.2 MHz、1.4–2.9 ms（Q-3 预设）"),
    ("burst_hopping", "rc_hopping", "跳频突发（golden-02 的旧合成波形）"),
    ("tone", "cw_beacon", "单音（golden-01 / 03 的旧合成波形）"),
    ("droneid", "droneid", "DJI DroneID：9 MHz、0.643 ms、每 640 ms 一次（Q-2 预设）"),
]
# 实测只取预设出处里点名的组（14 §8.6）：(Q-0b 数据源 id, 组, 角色)；角色 video 指该组的图传
MEASURED = {
    "ofdm_video": [("dronerfb_dji", g, "video") for g in ("A", "C", "D", "E", "F", "G")]
                  + [("dronerfa_mavic3_5g8", "all", "video")],
    "ofdm_uplink": [("dronerfb_dji", g, "uplink") for g in ("A", "C", "D", "E", "F", "G")]
                   + [("dronerfa_mavic3_5g8", "all", "uplink_5g8")],
    "gfsk_fhss": [("dronerfa_frsky_x20", "all", "rc")],
}
# Q-0b 统计量 → 特征（可比的三项）
MEASURED_FEATURE = {"bandwidth_Hz": "obw99_Hz", "duration_s": "dur_s", "interval_from_prev_s": "gap_s"}


def sig_round(x: float, rounding: str) -> float:
    """按 SIG 位有效数字取整（十进制精确，ROUND_FLOOR 往下、ROUND_CEILING 往上）。"""
    if x <= 0.0:
        return 0.0
    e = math.floor(math.log10(x)) - (SIG - 1)
    return float(Decimal(repr(x)).quantize(Decimal(1).scaleb(e), rounding=rounding))


def load(rel: str) -> dict:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return json.load(fh)


def sha256(rel: str) -> str:
    with open(os.path.join(ROOT, rel), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def measured_range(q0b: dict, tpl: str, feature: str) -> tuple[float, float] | None:
    stat = MEASURED_FEATURE.get(feature)
    if stat is None or tpl not in MEASURED:
        return None
    src = {s["id"]: s for s in q0b["sources"]}
    lo, hi = math.inf, -math.inf
    for sid, grp, role in MEASURED[tpl]:
        g = next(x for x in src[sid]["groups"] if x["group"] == grp)
        block = g["video"] if role == "video" else next(l for l in g["links"] if l["role"] == role)
        st = block[stat]
        lo, hi = min(lo, float(st["p10"])), max(hi, float(st["p90"]))
    return lo, hi


def build() -> dict:
    cal = load(CALIB)
    q0b = load(Q0B)
    templates = []
    for tid, label, desc in TEMPLATES:
        s = cal["templates"].get(tid)
        need = MIN_ROWS_LEGACY if tid in LEGACY_TEMPLATES else MIN_ROWS
        if s is None or s["rows"] < need:
            raise SystemExit(f"模板 {tid} 的校准行不够（{0 if s is None else s['rows']} < {need}）：先查校准调查")
        intervals, weights, prov = {}, {}, {}
        for f in FEATURE_ORDER:
            fs = s["features"][f]
            if fs["available_frac"] < AVAILABLE_MIN:
                continue
            lo, hi = fs["p2.5"], fs["p97.5"]
            m = measured_range(q0b, tid, f)
            if m is not None:
                lo, hi = min(lo, m[0]), max(hi, m[1])
            if f in LOG_FEATURES:
                lo_w, hi_w = lo / math.exp(LOG_SCALE), hi * math.exp(LOG_SCALE)
                lo_w = 0.0 if lo_w < 10.0 * LOG_FLOOR[f] else sig_round(lo_w, ROUND_FLOOR)
                hi_w = sig_round(hi_w, ROUND_CEILING)
            else:
                lo_w = round(max(0.0, lo - LINEAR_PAD), 6)
                hi_w = round(min(1.0, hi + LINEAR_PAD), 6)
            if not hi_w > lo_w:
                raise SystemExit(f"模板 {tid} 的 {f} 区间退化：[{lo_w}, {hi_w}]")
            intervals[f] = [lo_w, hi_w]
            weights[f] = WEIGHTS.get(f, 1.0)
            prov[f] = "S+M" if m is not None else "S"
        templates.append({"id": tid, "label": label, "description": desc, "intervals": intervals,
                          "weights": weights, "provenance": prov})
    return {
        "schema": "cuav-recognition-library/2",
        "library_version": "v2",
        "label_layer": "signal_role",
        "source": "calibrated",
        "feature_basis": "subband",
        "calibration": {"ref": CALIB.replace(os.sep, "/"), "sha256": sha256(CALIB)},
        "notes": [
            "由 scripts/gen_recognition_library.py 机械生成，不手改（Q-4c，D-094；规则见 14 号报告 §8.6）。",
            "按分子带段的特征标定（feature_basis = subband）：带宽、时长、平坦度在这一段自己的频段上量，上一段只取占用带宽相差不到 2 倍的段；占空比与峰均比无定义，不进库。",
            "区间 = 校准集合成特征的 [p2.5, p97.5] 与 Q-0b 实测各组的 [p10, p90] 取并，再往外放：对数特征 ×/÷ e^0.3、线性 ±0.05；只取校准集（tests/regression/eval-dataset/calib-v1.json）与 golden 场景，不含试样集。",
            "实测只取预设出处点名的组、可比的三项（99% 带宽、时长、末到始间隔）：DroneRFb A/C/D/E/F/G 与 DroneRFa Mavic 3 5.8 GHz 的图传与 DJI 上行、DroneRFa FrSky X20；不取 Phantom 4 Pro / Matrice 200（老一代图传）、AVATA、Futaba T14SG（不是 S-FHSS）。",
            "DroneID 没有实测；旧合成波形（单音、定频 / 跳频突发、带限噪声图传）的模板取自 golden 场景，那些波形本来就是编的，自洽而已；其中连续发射的两种（单音、带限噪声图传）一个真值行只配上一段，只有 2–4 行，区间很薄。",
            "可信度：区间来自本方合成波形与公开实测（原型阶段验证值，D-028）；甲方数据到货后按同一规则重标、升版本号。",
        ],
        "distance": {"log_scale": LOG_SCALE, "log_floor": LOG_FLOOR},
        "feature_order": FEATURE_ORDER,
        "features": {f: ({"domain": "log", "abs": True} if f == "hop_from_prev_Hz" else
                         {"domain": "log"} if f in LOG_FEATURES else {"domain": "linear"}) for f in FEATURE_ORDER},
        "templates": templates,
    }


def dumps(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="由校准统计与 Q-0b 实测机械生成识别库 v2")
    ap.add_argument("--check", action="store_true", help="只核对入库的库与重新生成的逐字节相同")
    args = ap.parse_args(argv)
    text = dumps(build())
    path = os.path.join(ROOT, OUT)
    if args.check:
        with open(path, encoding="utf-8") as fh:
            ok = fh.read() == text
        print("识别库 v2 与重新生成的逐字节相同" if ok else "识别库 v2 与重新生成的不同：先查是统计表变了还是规则变了")
        return 0 if ok else 1
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    for t in json.loads(text)["templates"]:
        iv = "；".join(f"{k} [{v[0]:g}, {v[1]:g}]（{t['provenance'][k]}）" for k, v in t["intervals"].items())
        print(f"{t['label']:16s} {t['id']:14s} {iv}")
    print(f"已写 {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
