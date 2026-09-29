#!/usr/bin/env python3
"""原生采样率 OFDM 调制的 Python 第二参考（Q-2，14 号报告 §2，决策 D-088）。

与 engine/src/ofdm.cpp 同契约（头注 ①–④），但时域变换用 numpy 的 ifft（pocketfft）——
与引擎自带的基 2 FFT 是两家实现，于是「逐符号结果在 1e-9 内一致」是一次独立对拍，
不是同一段代码跑两遍。载荷随机数用 gen_engine_golden.py 里那份 Xoshiro256pp 复刻
（「改这里必须同时改那里」的唯一一份），不再造第三份。

自检（--selftest）量的是结构，不是对拍：
  · 每个符号恰有 2K 个非零子载波、直流为零；
  · CP 与符号尾部逐位相同；
  · ZC（删点之前的完整序列）周期自相关在非零时延上为零（CAZAC）；
  · ZC 符号的符号内平均功率恰为 1、数据符号在期望上为 1（Parseval）；
  · DroneID 一个突发 9880 个样点。
另打印图传连续突发的峰均比（CCDF 1e-3 处），与复高斯的 8.39 dB 对照。

用法：
    uv run --quiet --with numpy python algos/reference/ofdm_ref.py --selftest
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
PRESETS_REL = os.path.join("models", "radiator", "presets-v1.json")


def _xoshiro():
    sys.path.insert(0, _HERE)
    from gen_engine_golden import Xoshiro256pp  # noqa: E402  唯一一份复刻
    return Xoshiro256pp


def load_presets(path: str | None = None) -> dict:
    with open(path or os.path.join(_ROOT, PRESETS_REL), "r", encoding="utf-8") as f:
        return json.load(f)


class Preset:
    """把 JSON 里的一项预设展开成调制要用的数（与 geo/src/radiator_presets.cpp 同义）。"""

    BITS = {"qpsk": 1, "16qam": 2, "64qam": 3}

    def __init__(self, doc: dict, pid: str):
        p = next(x for x in doc["presets"] if x["id"] == pid)
        num = next(n for n in doc["numerologies"] if n["id"] == p["numerology"])
        self.id = pid
        self.fft = num["fft_size"]
        self.fs = float(num["fs_native_Hz"])
        self.K = p["half_subcarriers"]
        self.bits = self.BITS[p["constellation"]]
        self.bursts = []
        for b in p["bursts"]:
            cs = b.get("cp_short", num["cp_short"])
            cl = b.get("cp_long", num["cp_long"])
            cp = [cl if i in b["cp_long_at"] else cs for i in range(b["n_symbols"])]
            zc = [0] * b["n_symbols"]
            for idx, root in b["zc"]:
                zc[idx] = root
            self.bursts.append({"cp": cp, "zc": zc, "length": sum(self.fft + c for c in cp)})
        L = 1 << self.bits
        norm = math.sqrt(2.0 * (L * L - 1.0) / 3.0)
        self.levels = [(2.0 * i - (L - 1)) / norm for i in range(L)]
        self.gain = 1.0 / math.sqrt(2 * self.K)

    def k_of(self, i: int) -> int:
        return i - self.K if i < self.K else i - self.K + 1


def zc_value(root: int, n_zc: int, n: int) -> complex:
    m = (root * ((n * (n + 1)) % (2 * n_zc))) % (2 * n_zc)
    ang = -math.pi * m / n_zc
    return complex(math.cos(ang), math.sin(ang))


def zc_carriers(p: Preset, root: int) -> list:
    nzc = 2 * p.K + 1
    return [zc_value(root, nzc, n) for n in range(nzc) if n != p.K]


def symbol_carriers(p: Preset, variant: int, symbol: int, rng) -> list:
    root = p.bursts[variant]["zc"][symbol]
    if root:
        return zc_carriers(p, root)
    mask = (1 << p.bits) - 1
    out = []
    for _ in range(2 * p.K):
        u = rng.next_u64()
        out.append(complex(p.levels[u & mask], p.levels[(u >> p.bits) & mask]))
    return out


def symbol_time(p: Preset, carriers: list) -> np.ndarray:
    """x[n] = g·Σ X_k·e^{+j2πkn/N}；numpy 的 ifft 自带 1/N，故乘回 N。"""
    bins = np.zeros(p.fft, dtype=np.complex128)
    for i, x in enumerate(carriers):
        bins[p.k_of(i) % p.fft] = x
    return np.fft.ifft(bins) * (p.fft * p.gain)


def burst(p: Preset, variant: int, seed: int, want_carriers: bool = False):
    rng = _xoshiro()(seed)
    parts, allc = [], []
    for s, cp in enumerate(p.bursts[variant]["cp"]):
        c = symbol_carriers(p, variant, s, rng)
        x = symbol_time(p, c)
        parts.append(x[p.fft - cp:])
        parts.append(x)
        allc.append(c)
    y = np.concatenate(parts)
    return (y, allc) if want_carriers else y


def papr_ccdf_dB(x: np.ndarray, prob: float = 1e-3) -> float:
    pw = np.abs(x) ** 2
    return 10.0 * math.log10(float(np.quantile(pw, 1.0 - prob)) / float(np.mean(pw)))


def _selftest() -> int:
    doc = load_presets()
    fails = 0

    def check(cond: bool, what: str) -> None:
        nonlocal fails
        print(("  通过  " if cond else "  失败  ") + what)
        fails += 0 if cond else 1

    for pid in ("dji-droneid", "dji-uplink-2m", "dji-video-10m", "dji-video-20m-a", "dji-video-40m"):
        p = Preset(doc, pid)
        y, cs = burst(p, 0, 20260929, want_carriers=True)
        print(f"{pid}：{len(y)} 个原生样点")
        check(len(y) == p.bursts[0]["length"], "突发长度 = Σ(FFT + CP)")
        off = 0
        ok_bins = ok_cp = True
        for s, cp in enumerate(p.bursts[0]["cp"]):
            sym = y[off + cp: off + cp + p.fft]
            ok_cp &= bool(np.array_equal(y[off: off + cp], sym[p.fft - cp:]))
            X = np.fft.fft(sym) / (p.fft * p.gain)
            nz = int(np.count_nonzero(np.abs(X) > 1e-9))
            ok_bins &= nz == 2 * p.K and abs(X[0]) < 1e-9
            off += cp + p.fft
        check(ok_bins, f"每个符号恰 {2 * p.K} 个非零子载波、直流为零")
        check(ok_cp, "CP 与符号尾部逐位相同")
        zc_syms = [s for s, r in enumerate(p.bursts[0]["zc"]) if r]
        for s in zc_syms:
            off = sum(p.fft + c for c in p.bursts[0]["cp"][:s]) + p.bursts[0]["cp"][s]
            pw = float(np.mean(np.abs(y[off: off + p.fft]) ** 2))
            check(abs(pw - 1.0) < 1e-12, f"ZC 符号 {s} 的符号内平均功率 = 1（{pw:.15f}）")
    # CAZAC：删点之前的完整 ZC 序列
    for root, nzc in ((600, 601), (147, 601), (29, 149), (29, 1201), (29, 2401), (29, 75), (29, 295)):
        z = np.array([zc_value(root, nzc, n) for n in range(nzc)])
        ac = np.array([abs(np.vdot(z, np.roll(z, lag))) for lag in (1, 2, 7, nzc // 2)]) / nzc
        check(float(ac.max()) < 1e-9, f"ZC 根 {root}、长 {nzc}：周期自相关非零时延处 < 1e-9（{ac.max():.1e}）")
    p = Preset(doc, "dji-droneid")
    check(p.bursts[0]["length"] == 9880, "DroneID 突发 9880 个原生样点（643.23 µs）")
    # 数据符号的功率与峰均比：连续 40 个 16QAM 突发
    p = Preset(doc, "dji-video-20m-a")
    ys = np.concatenate([burst(p, 0, 1000 + i) for i in range(40)])
    pw = float(np.mean(np.abs(ys) ** 2))
    check(abs(pw - 1.0) < 0.01, f"图传 40 个突发的平均功率 ≈ 1（{pw:.5f}）")
    papr = papr_ccdf_dB(ys)
    print(f"  记录  图传峰均比（CCDF 1e-3，原生率、未重采样）{papr:.2f} dB；复高斯 8.39 dB")
    print("自检" + ("全部通过" if fails == 0 else f"有 {fails} 项失败"))
    return 0 if fails == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
