#!/usr/bin/env python3
"""GFSK 族波形的 Python 参考（Q-3，14 号报告 §3，决策 D-089）。

两份实现，用途不同：
  · phase_cycles() / inst_freq()：与 engine/src/gfsk.cpp **同式同序**的 float64 复刻（契约见 cuav/gfsk.h 五条），
    给组件尺度的全路径复刻用；
  · phase_cycles_mp()：**独立**的高精度实现——mpmath 40 位、对全部符号直接求 a_k·P(s − k)，
    不截窗口、不裂项。算法核的黄金基准取它（gen_engine_golden.py --mode gfsk），判据 1e-9 圈，
    于是引擎的窗口截断与裂项写法是被**检验**的对象，不是被照抄的对象。

--selftest 另做两件与实现无关的核对：
  · 数值积分：在细网格上对瞬时频率做梯形积分，与闭式相位之差按梯形法误差界（h²/12·max|f''|·长度）判；
  · 长游程斜率：连续 n 个同号比特中段每符号相位增量 = h/2 圈。

还有两件生成场景用的：frame_bursts()（与 geo/src/gfsk_frame.cpp 逐字同式的帧排布）、
--hop-activity（按协议规则生成一整轮跳频，写进场景的 hop 活动，同 D-088 上行的 --uplink-sequence）。

用法：
    uv run --quiet --with numpy --with mpmath python algos/reference/gfsk_ref.py --selftest
    uv run --quiet python algos/reference/gfsk_ref.py --hop-activity frsky-d16v2-fcc --seed 20260929 --emitter rc-1
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
PRESETS_REL = os.path.join("models", "radiator", "gfsk-presets-v1.json")


def _xoshiro():
    sys.path.insert(0, _HERE)
    from gen_engine_golden import Xoshiro256pp  # noqa: E402  唯一一份复刻
    return Xoshiro256pp


def load_presets() -> dict:
    with open(os.path.join(_ROOT, PRESETS_REL), "r", encoding="utf-8") as f:
        return json.load(f)


class Preset:
    """预设表里生成要用的几项（与 geo::GfskPreset 同名同义）。"""

    def __init__(self, doc: dict, pid: str):
        raw = next(p for p in doc["presets"] if p["id"] == pid)
        self.raw = raw
        self.id = pid
        self.role = raw["role"]
        self.gaussian = 1 if raw["modulation"] == "gfsk" else 0
        self.bt = raw["bt"] if raw["bt"] is not None else 0.0
        self.R = raw["symbol_rate_Hz"]
        self.fdev = raw["deviation_Hz"]
        self.occupied_bw = raw["occupied_bw_Hz"]
        self.preamble_bits = 8 * raw["preamble_bytes"]
        self.sync_word = int(raw["sync_word"], 16)
        self.sync_bits = 4 * (len(raw["sync_word"]) - 2)
        self.period = raw["frame"]["period_s"]
        self.packets = [(q["offset_s"], q["n_bits"]) for q in raw["frame"]["packets"]]
        self.hop = raw["hop"]


# ---------------------------------------------------------------- ① 比特


def packet_bits(p: Preset, n_bits: int, seed: int) -> list:
    """一个包的比特，取值 ±1（契约 ①）。"""
    out = []
    for k in range(p.preamble_bits):
        if len(out) >= n_bits:
            break
        out.append(1 if k % 2 == 0 else -1)
    for k in range(p.sync_bits - 1, -1, -1):
        if len(out) >= n_bits:
            break
        out.append(1 if (p.sync_word >> k) & 1 else -1)
    rng = _xoshiro()(seed)
    word, left = 0, 0
    while len(out) < n_bits:
        if left == 0:
            word, left = rng.next_u64(), 64
        left -= 1
        out.append(1 if (word >> left) & 1 else -1)
    return out


def prefix_sums(a: list) -> list:
    s = [0]
    for v in a:
        s.append(s[-1] + v)
    return s


# ---------------------------------------------------------------- ②–⑤ 与 C++ 同式同序


class Modulator:
    def __init__(self, gaussian: int, bt: float, R: float, fdev: float):
        self.gaussian = 1 if gaussian else 0
        self.R = R
        self.fdev = fdev
        if self.gaussian:
            self.sigma = math.sqrt(math.log(2.0)) / (2.0 * math.pi * bt)
            self.inv_s2 = 1.0 / (math.sqrt(2.0) * self.sigma)
            self.c_exp = self.sigma * math.sqrt(2.0 / math.pi)
            self.inv_2s2 = 1.0 / (2.0 * self.sigma * self.sigma)
            self.K = 1 + int(math.ceil(8.5 * self.sigma))
        else:
            self.sigma = self.inv_s2 = self.c_exp = self.inv_2s2 = 0.0
            self.K = 0

    @classmethod
    def of(cls, p: Preset) -> "Modulator":
        return cls(p.gaussian, p.bt, p.R, p.fdev)

    def I(self, x: float) -> float:
        return x * math.erf(x * self.inv_s2) + self.c_exp * math.exp(-x * x * self.inv_2s2)

    def phase_cycles(self, a: list, pre: list, tau: float) -> float:
        N = len(a)
        s = tau * self.R
        jf = math.floor(s)
        if not self.gaussian:
            if s < 0.0:
                phi = 0.0
            elif jf >= N:
                phi = float(pre[N])
            else:
                j = int(jf)
                phi = float(pre[j]) + float(a[j]) * (s - jf)
            return (self.fdev / self.R) * phi
        j = int(max(-1.0e12, min(1.0e12, jf)))
        lo = max(0, min(N, j - self.K))
        hi = max(-1, min(N - 1, j + self.K))
        acc = 0.0
        if lo <= hi:
            acc += float(a[lo]) * self.I(s - float(lo))
            for m in range(lo + 1, hi + 1):
                d = a[m] - a[m - 1]
                if d != 0:
                    acc += float(d) * self.I(s - float(m))
            acc -= float(a[hi]) * self.I(s - float(hi + 1))
        phi = 0.5 * float(pre[lo] + pre[hi + 1]) + 0.5 * acc
        return (self.fdev / self.R) * phi

    def inst_freq(self, a: list, tau: float) -> float:
        N = len(a)
        s = tau * self.R
        jf = math.floor(s)
        if not self.gaussian:
            if s < 0.0 or jf >= N:
                return 0.0
            return self.fdev * float(a[int(jf)])
        j = int(max(-1.0e12, min(1.0e12, jf)))
        lo = max(0, j - self.K)
        hi = min(N - 1, j + self.K)
        acc = 0.0
        for k in range(lo, hi + 1):
            x = s - float(k)
            acc += float(a[k]) * 0.5 * (math.erf(x * self.inv_s2) - math.erf((x - 1.0) * self.inv_s2))
        return self.fdev * acc


# ---------------------------------------------------------------- 独立的高精度实现


def phase_cycles_mp(gaussian: int, bt: float, R: float, fdev: float, a: list, tau: float, dps: int = 40):
    """全部符号直接求和、不截断、不裂项，mpmath dps 位（返回 float）。"""
    import mpmath as mp

    with mp.workdps(dps):
        s = mp.mpf(tau) * mp.mpf(R)
        if not gaussian:
            tot = mp.mpf(0)
            for k, v in enumerate(a):
                x = s - k
                tot += v * (0 if x <= 0 else (1 if x >= 1 else x))
            return float(mp.mpf(fdev) / mp.mpf(R) * tot)
        sig = mp.sqrt(mp.log(2)) / (2 * mp.pi * mp.mpf(bt))
        c = mp.sqrt(2) * sig

        def Imp(x):
            return x * mp.erf(x / c) + sig * mp.sqrt(2 / mp.pi) * mp.exp(-x * x / (2 * sig * sig))

        tot = mp.mpf(0)
        for k, v in enumerate(a):
            x = s - k
            tot += v * ((Imp(x) - Imp(x - 1)) / 2 + mp.mpf(1) / 2)
        return float(mp.mpf(fdev) / mp.mpf(R) * tot)


def inst_freq_mp(gaussian: int, bt: float, R: float, fdev: float, a: list, tau: float, dps: int = 40):
    import mpmath as mp

    with mp.workdps(dps):
        s = mp.mpf(tau) * mp.mpf(R)
        if not gaussian:
            j = int(mp.floor(s))
            return float(fdev * a[j]) if 0 <= j < len(a) else 0.0
        sig = mp.sqrt(mp.log(2)) / (2 * mp.pi * mp.mpf(bt))
        c = mp.sqrt(2) * sig
        tot = mp.mpf(0)
        for k, v in enumerate(a):
            x = s - k
            tot += v * (mp.erf(x / c) - mp.erf((x - 1) / c)) / 2
        return float(mp.mpf(fdev) * tot)


# ---------------------------------------------------------------- 帧排布（与 geo/src/gfsk_frame.cpp 逐字同式）


def burst_t0(p: Preset, frame_offset_s: float, frame: int, packet: int) -> float:
    base = frame_offset_s + float(frame) * p.period
    return base + p.packets[packet][0]


def burst_t1(p: Preset, t0: float, packet: int) -> float:
    return t0 + float(p.packets[packet][1]) / p.R


def frame_bursts(p: Preset, frame_offset_s: float, end_s: float) -> list:
    """起点 < end_s 的全部包：[(frame, packet, index, t0, t1, n_bits)]。"""
    out = []
    k = 0
    while frame_offset_s + float(k) * p.period < end_s:
        for q in range(len(p.packets)):
            t0 = burst_t0(p, frame_offset_s, k, q)
            if t0 >= end_s:
                break
            out.append((k, q, k * len(p.packets) + q, t0, burst_t1(p, t0, q), p.packets[q][1]))
        k += 1
    return out


def frame_table_sha256(bursts: list) -> str:
    """整张包表的指纹：逐包 <int64 frame, int32 packet, double t0, double t1> 小端拼接（C++ 同法）。"""
    import hashlib
    import struct

    h = hashlib.sha256()
    for k, q, _idx, t0, t1, _nb in bursts:
        h.update(struct.pack("<qidd", k, q, t0, t1))
    return h.hexdigest()


# ---------------------------------------------------------------- 跳频序列（写进场景的 hop 活动）

MASK64 = (1 << 64) - 1


def mix64(z: int) -> int:
    z = (z + 0x9E3779B97F4A7C15) & MASK64
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    return z ^ (z >> 31)


def fnv1a64(s: str) -> int:
    h = 0xCBF29CE484222325
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & MASK64
    return h


def sfhss_next(k: int, code: int) -> int:
    """MPM Futaba_cc2500.ino 的 SFHSS_calc_next_chan()，逐句转写（同 scripts/gen_gfsk_presets.py）。"""
    k += code + 2
    if k > 29:
        if k < 31:
            k += code + 2
        k -= 31
    return k


def hop_activity(p: Preset, seed: int, emitter_id: str, t_s: float = 0.0) -> dict:
    """按协议规则生成一整轮跳频（场景 hop 活动，dwell_s = 帧周期，按停留循环）。

    发射机相关的那个数（FrSky 的起始格 g0、S-FHSS 的 code）取 key = mix64(seed ^ mix64(fnv1a64(id)))
    （与 OFDM 帧排布的键同式）：FrSky g0 = key mod 47，S-FHSS code = key mod 28、起始信道 0（MPM 同）。
    FrSky 的逐跳 +step 格是实测主峰（协议里它是 inc·chanskip mod 47，随发射机标识变），取预设值。
    帧起点 frame_offset_s 须与 t_s 相同，一帧才恰落在一个停留里（场景作者的责任，生成夹具时照此写）。
    """
    ch = p.hop["channels_Hz"]
    key = mix64(seed ^ mix64(fnv1a64(emitter_id)))
    if p.hop["rule"] == "step_mod":
        n = len(ch)
        g0 = key % n
        seq = [ch[(g0 + p.hop["step"] * i) % n] for i in range(n)]
        note = f"g0 = {g0}，逐跳 +{p.hop['step']} 格，{n} 跳一轮"
    elif p.hop["rule"] == "sfhss":
        code = key % 28
        k, seq = 0, []
        for _ in range(30):
            seq.append(ch[k])
            k = sfhss_next(k, code)
        note = f"code = {code}，起始信道 0，30 跳一轮"
    else:
        raise ValueError(p.hop["rule"])
    return {"emitter_id": emitter_id, "t_s": t_s, "event": "hop",
            "args": {"sequence": seq, "dwell_s": p.hop["dwell_s"]}, "_note": note}


# ---------------------------------------------------------------- 自检


def _selftest() -> int:
    import numpy as np

    fails = 0

    def check(cond: bool, msg: str) -> None:
        nonlocal fails
        print(("  通过  " if cond else "  失败  ") + msg)
        if not cond:
            fails += 1

    doc = load_presets()
    for pid in ("frsky-d16v2-fcc", "futaba-sfhss"):
        p = Preset(doc, pid)
        m = Modulator.of(p)
        n = p.packets[0][1]
        a = packet_bits(p, n, 20260929)
        pre = prefix_sums(a)
        check(a[:8] == [1, -1, 1, -1, 1, -1, 1, -1], f"{pid}：前导起于 1010")
        sync = [1 if (0xD391D391 >> k) & 1 else -1 for k in range(31, -1, -1)]
        check(a[32:64] == sync, f"{pid}：同步字 0xD391D391 高位先发")
        T = 1.0 / p.R
        # float64 同式 对 mpmath 全和（独立实现）
        rng = np.random.default_rng(7)
        taus = list(rng.uniform(-2 * T, (n + 2) * T, 60)) + [0.0, 3 * T, 17.5 * T, n * T]
        worst = max(abs(m.phase_cycles(a, pre, t) - phase_cycles_mp(p.gaussian, p.bt, p.R, p.fdev, a, t))
                    for t in taus)
        check(worst < 1e-12, f"{pid}：窗口裂项 对 不截断全和，最坏 {worst:.2e} 圈（线 1e-12）")
        # 2-FSK 的瞬时频率在符号边界上是跳变：恰在边界上的 τ，float64 与高精度对「落在哪一侧」可能不同，
        # 那不是实现的差，只比离边界远的点（相位是连续的，上面的相位比较照样含边界）
        tf = [t for t in taus if p.gaussian or abs(t * p.R - round(t * p.R)) > 1e-6]
        worstf = max(abs(m.inst_freq(a, t) - inst_freq_mp(p.gaussian, p.bt, p.R, p.fdev, a, t)) for t in tf)
        check(worstf < 1e-9 * p.fdev, f"{pid}：瞬时频率 对 全和，最坏 {worstf:.2e} Hz")
        # 数值积分：细网格梯形积分瞬时频率 → 相位（与实现无关的核对）
        if p.gaussian:
            M = 4000
            h = T / M
            t0, t1 = 40 * T, 60 * T
            grid = [t0 + i * h for i in range(int(round((t1 - t0) / h)) + 1)]
            f = [m.inst_freq(a, t) for t in grid]
            integ = sum((f[i] + f[i + 1]) * 0.5 * h for i in range(len(f) - 1))
            closed = m.phase_cycles(a, pre, t1) - m.phase_cycles(a, pre, t0)
            # 梯形法误差 ≤ (t1 − t0)·h²/12·max|f''|；高斯脉冲 max|g̃''| ≈ 1/(σ̃²·√(2πe))·R²，量级放宽 10 倍
            fpp = p.fdev * p.R ** 2 / (m.sigma ** 2 * math.sqrt(2 * math.pi * math.e)) * 2
            bound = 10 * (t1 - t0) * h * h / 12 * fpp
            check(abs(integ - closed) < bound,
                  f"{pid}：瞬时频率梯形积分 对 闭式相位差 {abs(integ - closed):.2e} 圈（界 {bound:.1e}）")
        # 长游程：中段每符号相位增量 = h/2
        run = [1] * 12
        pre_r = prefix_sums(run)
        d = m.phase_cycles(run, pre_r, 7.3 * T) - m.phase_cycles(run, pre_r, 6.3 * T)
        check(abs(d - p.fdev / p.R) < 1e-14, f"{pid}：长游程每符号 {d:.12f} 圈 = h/2 {p.fdev / p.R:.12f}")
    # 帧排布与跳频序列
    fr = Preset(doc, "frsky-d16v2-fcc")
    sf = Preset(doc, "futaba-sfhss")
    bs = frame_bursts(sf, 0.0, 0.0203)
    check([(b[0], b[1]) for b in bs] == [(0, 0), (0, 1), (1, 0), (1, 1), (2, 0), (2, 1)],
          "S-FHSS：每帧两包，三帧六包")
    check(abs(bs[1][3] - 1.625e-3) < 1e-18 and abs(bs[2][3] - 6.8e-3) < 1e-18, "S-FHSS：第二包晚 1.625 ms、周期 6.8 ms")
    ha = hop_activity(fr, 20260929, "rc-frsky")
    seq = ha["args"]["sequence"]
    check(len(set(seq)) == 47, "FrSky：一轮访遍 47 个频点")
    steps = [round((b - a) / 1.5e6) % 47 for a, b in zip(seq, seq[1:])
             if abs((b - a) % 1.5e6) < 1 or abs((b - a) % 1.5e6 - 1.5e6) < 1]
    check(all(st == 3 for st in steps), "FrSky：栅格上的逐跳都是 +3 格（模 47）")
    hs = hop_activity(sf, 20260929, "rc-futaba")
    check(sorted(hs["args"]["sequence"]) == sf.hop["channels_Hz"], "S-FHSS：一轮访遍 30 个信道")
    print("自检" + ("全部通过" if fails == 0 else f"有 {fails} 项失败"))
    return 0 if fails == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--hop-activity", metavar="PRESET", help="打印该预设一整轮跳频的场景 hop 活动（JSON）")
    ap.add_argument("--seed", type=int, default=20260929, help="场景 seed")
    ap.add_argument("--emitter", default="rc-1", help="辐射源 id（与 seed 一起定发射机相关的数）")
    ap.add_argument("--t0", type=float, default=0.0, help="hop 活动的时刻，须等于 waveform.frame_offset_s")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    if a.hop_activity:
        act = hop_activity(Preset(load_presets(), a.hop_activity), a.seed, a.emitter, a.t0)
        print(act.pop("_note"), file=sys.stderr)
        print(json.dumps(act, ensure_ascii=False))
        return 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
