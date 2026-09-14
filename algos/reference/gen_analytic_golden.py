#!/usr/bin/env python3
"""生成 EM-S-02 解析检出率（D-026 两式）在浏览器侧复刻的黄金基准（C-9）。

## 为什么浏览器里要有第二份实现

结果页「评价」页签在 `?dev=1` 下把解析 ROC 曲线族叠在实测 ROC 上（06 §9G C-9 的验收项）。
曲线族按门限扫描算 `Pfa(η) = Q(M, M·η)` 与 `Pd(η)`，纯前端算一遍最省事——服务端算要新开一个
端点，引擎算要把它写进 `metrics.json`（那是基准变更）。代价是正则化上不完全伽马函数
`Q(a, x)` 在 TS 里多一份实现，因此必须与 `algos/reference/energy_detector.py` 的那一份
逐值对拍（铁律 10，判据 rel ≤ 1e-9）。

## 取值覆盖什么

- `gamma_q`：`a` 从 1 到 2000（跨 `x < a+1` 的级数支与连分式支的切换）、`x` 覆盖 0、远小于、
  接近、远大于 `a` 四档，含两支边界上的点。
- `threshold`：`Q(M, M·η) = pfa` 的反解，取本项目实际会碰到的 M 与 pfa。
- `pd_random` / `pd_deterministic`：s 从 -20 dB 到 +10 dB；确定型另取小 M（浏览器里不用它画族，
  但前端仍复刻了这一式，要对拍）。

用法（仓库根目录）：
    uv run --quiet python algos/reference/gen_analytic_golden.py --out tests/golden/analytic-pd.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import energy_detector as ed  # noqa: E402


def build() -> dict:
    gamma_q = []
    for a in (1, 2, 5, 32, 100, 512, 921, 2000):
        for mul in (0.0, 0.2, 0.5, 0.9, 1.0, 1.001, 1.1, 1.5, 3.0):
            x = a * mul
            gamma_q.append({"a": a, "x": x, "q": ed.regularized_gamma_q(a, x)})
    # 两支切换点 x = a + 1 的两侧
    for a in (5, 921):
        for x in (a + 0.999, a + 1.0, a + 1.001):
            gamma_q.append({"a": a, "x": x, "q": ed.regularized_gamma_q(a, x)})

    thresholds = []
    for m in (5, 32, 921, 2000):
        for pfa in (1e-1, 1e-2, 1e-3, 1e-4, 1e-6):
            thresholds.append({"m_bins": m, "pfa": pfa, "eta": ed.threshold_for_pfa(m, pfa)})

    pd_random, pd_det = [], []
    for m in (5, 32, 921):
        eta = ed.threshold_for_pfa(m, 1e-3)
        for snr_dB in (-20.0, -12.0, -9.0, -6.0, -3.0, 0.0, 3.0, 6.0, 10.0):
            s = ed.snr_db_to_linear(snr_dB)
            pd_random.append({"m_bins": m, "eta": eta, "snr_dB": snr_dB,
                              "pd": ed.pd_random_signal(m, eta, s)})
    # 确定型是泊松混合级数，项数随 M·s 涨，只在小 M 上取点（前端同样只在小 M·s 上调用）
    for m in (5, 32):
        eta = ed.threshold_for_pfa(m, 1e-3)
        for snr_dB in (-20.0, -12.0, -6.0, 0.0, 6.0):
            s = ed.snr_db_to_linear(snr_dB)
            pd_det.append({"m_bins": m, "eta": eta, "snr_dB": snr_dB,
                           "pd": ed.pd_deterministic_signal(m, eta, s)})
    # s → 0 时两式都退化为 Pfa（energy_detector.py 行 310 的不变量），前端单测也钉这一条
    degenerate = []
    for m in (5, 921):
        eta = ed.threshold_for_pfa(m, 1e-3)
        degenerate.append({"m_bins": m, "eta": eta, "pfa": ed.regularized_gamma_q(m, m * eta)})

    return {
        "schema": "cuav-golden-analytic-pd/1",
        "purpose": "EM-S-02 解析检出率（D-026 两式）的 TS 复刻对拍基准；浏览器侧 web/src/results/analytic.ts",
        "generator": "algos/reference/gen_analytic_golden.py",
        "reference": "algos/reference/energy_detector.py",
        "tolerance": {"relative": 1e-9},
        "gamma_q": gamma_q,
        "thresholds": thresholds,
        "pd_random": pd_random,
        "pd_deterministic": pd_det,
        "degenerate": degenerate,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="输出的黄金基准 JSON（仓库相对路径）")
    args = ap.parse_args()
    doc = build()
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    n = len(doc["gamma_q"]) + len(doc["thresholds"]) + len(doc["pd_random"]) + len(doc["pd_deterministic"])
    print(f"写出 {args.out}：{n} 个取值点")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
