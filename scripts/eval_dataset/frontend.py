"""接收机 IQ 不平衡与直流：在 DroneRFb 训练部分的背景片段上量（M 档；用户 2026-10-04 定，D-092）。

为什么取 DroneRFb：接收配置 R1（80 MS/s @ 2440 MHz）就是照它定的（14 §8.1）。DroneRFa 的安静帧
I/Q 标准差比约 0.7，不平衡在噪声路径上（D-020），与 R1 不是同一台接收机，不取。

量法沿用 tools/iq_survey.py 的口径：1024 点一帧，功率最低的一成帧为「安静帧」，在安静帧上量
I/Q 标准差比 r 与 I/Q 相关系数 ρ（去掉整片均值）、噪声功率；直流功率取整片均值的模方。逐片量、取中位数。

换成 ReceiverFrontEnd 的参数：前端的不平衡模型是 y = K1·x + K2·conj(x)，K1,2 = (1 ± g·e^{jφ})/2
（receiver.cpp，与 comm.IQImbalance 同定义），展开即 y = I + j·g·Q·e^{jφ}。对独立同方差的噪声，
  std(I_out)² ∝ 1 + g²sin²φ，std(Q_out)² ∝ g²cos²φ，cov ∝ −g²·sinφ·cosφ，
于是 g·sinφ = −ρ / √(1 − ρ²)，g·cosφ = 1 / (r·√(1 − ρ²))，g 与 φ 由此反解（不是小角度近似）。
直流按「直流功率 / 噪声功率」这个比值搬到本方接收机：dc_offset_mW = 比值 × 本方 ADC 输入端的噪声功率。

只用训练部分：先按 holdout.manifest.json 剔除验收集，再用 tools/freeze_holdout.py 同一判据复核
实际用到的全部产物，相交即作废退出（同 Q-0b，D-086）。
"""
from __future__ import annotations

import math
import os
import statistics
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, os.path.join(ROOT, "algos", "reference"))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import q0b_param_extract as q0b  # noqa: E402  索引读取、按类挑选、验收集剔除

NFFT = 1024
QUIET_PCT = 10.0                     # 与 tools/iq_survey.py 的 QUIET_FRAME_PCT 同


def slice_stats(iq_path: str) -> dict:
    raw = np.fromfile(iq_path, dtype="<i2").astype(np.float64)
    i, q = raw[0::2], raw[1::2]
    mi, mq = float(i.mean()), float(q.mean())
    k = i.size // NFFT
    fi = (i[:k * NFFT] - mi).reshape(k, NFFT)
    fq = (q[:k * NFFT] - mq).reshape(k, NFFT)
    pw = np.sum(fi * fi + fq * fq, axis=1)
    quiet = pw <= np.percentile(pw, QUIET_PCT)
    qi, qq = fi[quiet].ravel(), fq[quiet].ravel()
    vi, vq = float(np.mean(qi * qi)), float(np.mean(qq * qq))
    cov = float(np.mean(qi * qq))
    return {"std_ratio": math.sqrt(vi / vq), "rho": cov / math.sqrt(vi * vq),
            "dc_rel_noise": (mi * mi + mq * mq) / (vi + vq)}


def to_params(r: float, rho: float) -> tuple[float, float]:
    """(I/Q 标准差比, 相关系数) → (iq_gain_imbalance_dB, iq_phase_imbalance_deg)。"""
    s = math.sqrt(1.0 - rho * rho)
    gs, gc = -rho / s, 1.0 / (r * s)
    return 20 * math.log10(math.hypot(gs, gc)), math.degrees(math.atan2(gs, gc))


def measure() -> dict:
    import freeze_holdout
    ids, hashes, holdout_sha = q0b.load_holdout()
    recs = q0b.select(q0b.load_index("dronerfb"), {"split": "train", "class": ["B"]})
    recs, dropped = q0b.drop_holdout(recs, ids, hashes)
    if not recs:
        raise SystemExit("DroneRFb 训练部分没有背景片段（data/iq/measured/dronerfb/ 不在本机？）")
    rows = []
    for rec in recs:
        iq = rec.path[: -len(".manifest.json")] + ".iq"
        st = slice_stats(iq)
        rows.append((rec.data_id, st))
    if freeze_holdout.check(sorted(r.path for r in recs)) != 0:
        raise SystemExit("用到的产物与验收集相交，结果作废（铁律 10）")
    r = statistics.median(s["std_ratio"] for _, s in rows)
    rho = statistics.median(s["rho"] for _, s in rows)
    dc = statistics.median(s["dc_rel_noise"] for _, s in rows)
    g_dB, ph_deg = to_params(r, rho)
    return {
        "use": True,
        "iq_gain_imbalance_dB": float(f"{g_dB:.4g}"),
        "iq_phase_imbalance_deg": float(f"{ph_deg:.4g}"),
        "dc_rel_noise_dB": float(f"{10 * math.log10(dc):.4g}"),
        "source": {
            "grade": "M",
            "data": "DroneRFb 训练部分的背景片段（类码 B），逐片量、取中位数",
            "method": "scripts/eval_dataset/frontend.py：安静帧（功率最低一成）上的 I/Q 标准差比与相关系数、"
                      "整片均值的模方对安静帧噪声功率之比；按前端不平衡模型精确反解",
            "n_slices": len(rows),
            "median": {"std_ratio": float(f"{r:.6g}"), "rho": float(f"{rho:.6g}"),
                       "dc_rel_noise": float(f"{dc:.6g}")},
            "spread": {"std_ratio": [float(f"{min(s['std_ratio'] for _, s in rows):.6g}"),
                                     float(f"{max(s['std_ratio'] for _, s in rows):.6g}")],
                       "rho": [float(f"{min(s['rho'] for _, s in rows):.6g}"),
                               float(f"{max(s['rho'] for _, s in rows):.6g}")]},
            "holdout_dropped": len(dropped),
            "holdout_manifest_sha256": holdout_sha,
            "status": "原型阶段验证值（D-028）",
        },
    }
