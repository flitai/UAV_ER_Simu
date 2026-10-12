#!/usr/bin/env python3
"""按突发解调的 Python 参考：OFDM 族出均衡后的星座点，GFSK 族出符号中心频偏（决策 D-107）。

服务端 server/src/demod/ 是出货实现（交付包只带 Node，D-084 / D-090 同一理由），本文件是它的参考：
两边**同序同式**，由 tests/regression/demod_parity.py 逐项对拍。改算法的顺序固定为
改这里 → 改 TS → 对拍。

做法是接收机的做法（用户 2026-10-12 拍板）：不用发射载荷、不用真值的时延与载频偏差。
真值行只提供三样东西——粗窗（t_s / t_end_s，等同于检测器给出的段）、名义中心频率（跳频点）、
预设（数值结构、子载波数、CP、ZC 根、星座 / 符号率、频偏）。

OFDM（waveform ∈ {ofdm, droneid}）：
  ① 名义中心混频到基带，Kaiser 窗 sinc 原型做多相有理重采样到原生率（输出栅格对齐绝对时刻 j/fs_n）；
  ② van de Beek CP 相关（带能量项）定时、取小数倍频偏；
  ③ ZC 符号上联合搜整数倍频偏 q 与精定时：ZC 的频移等价于时移，所以对每个 q 做 IFFT(Y[k+q]·conj Z[k])、
     只在 CP 定时附近（时移 +b 处）取峰（只用每个子载波时移 ≥ 41 个原生样点的根判 q；DroneID 的根 600 ≡ −1 只用于信道估计）；
  ④ 以绝对时间校正总频偏，逐符号 FFT（窗起点在有用部分前 b = ⌊CP_short/4⌋），H = Y_zc / Z（多个 ZC 取平均）；
  ⑤ X = Y/H，逐符号相位跟踪：按前两个符号外推相位，判决引导求一个复标量（增益与相位），迭代两次；
     报出的频偏 = q·Δf + 小数倍 + 相位轨迹斜率（突发起止的滤波暂态会让 CP 相关偏几 Hz）。
GFSK：
  ① 名义跳频点混频，同一重采样函数整数抽取到约 8 样点每符号；② 鉴频；③ 与已知前导 + 同步字的 ±1 模板相关定时；
  ④ 载频偏差：先取前导 32 位符号中心的均值分出两簇，再取两簇均值的中点（用满全包）；
  ⑤ 全部符号中心频偏、前 64 位判决对已知比特。

自检（--selftest）量物理：合成突发（ofdm_ref.burst + resampler 升采样，已知时延与频偏）EVM、频偏、时延。

用法：
    uv run --quiet --with numpy python algos/reference/demod.py --selftest
    uv run --quiet --with numpy python algos/reference/demod.py <运行目录> --op s3 --emitter uav-1 --t 0.004
    uv run --quiet --with numpy python algos/reference/demod.py <运行目录> --op s3 --scan uav-1 [--limit 20]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from fractions import Fraction

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, _HERE)
import ofdm_ref  # noqa: E402
import gfsk_ref  # noqa: E402

ALGO_VERSION = "demod-v1"
STOP_DB = 70.0                # 重采样原型的阻带衰减（Kaiser 设计目标）
PRE_S = 4e-6                  # 粗窗前的搜索余量
POST_S = 60e-6                # 粗窗后的搜索余量（时延 ≤ 60 µs，约 18 km；小于一个 OFDM 符号 71.4 µs）
RHO = 0.9                     # van de Beek 度量的能量项权重
FINE_WIN = 12                 # 精定时：CP 定时附近 ±12 个原生样点内取 ZC 相关峰
MIN_ZC_SHIFT = 41             # 判 q 只用每个子载波时移 ≥ 41 个原生样点的根（> 2·(FINE_WIN + 余量)）
CFO_PPM = 30e-6               # 整数倍频偏的搜索范围按 ±30 ppm 定
SYNC_RATIO = 2.0              # 最高峰 / 次高峰（其他 q）低于它即同步失败
GFSK_SPS = 8                  # GFSK 抽取到约 8 样点每符号
GFSK_PASS_HZ = 200e3          # GFSK 低通通带（单边）
GFSK_HEADER_MIN = 56          # 前 64 位对上的个数低于它判 invalid
TRACE_MAX = 2000              # GFSK 频偏轨迹的点数上限


# ---------------------------------------------------------------- 滤波器与重采样

def bessel_i0(x: float) -> float:
    """第一类零阶修正贝塞尔函数，级数求和（与 TS 同式）。"""
    s, t, k = 1.0, 1.0, 1
    q = x * x / 4.0
    while True:
        t *= q / (k * k)
        s += t
        if t < 1e-17 * s:
            return s
        k += 1


def kaiser_beta(a_db: float) -> float:
    if a_db > 50.0:
        return 0.1102 * (a_db - 8.7)
    if a_db >= 21.0:
        return 0.5842 * (a_db - 21.0) ** 0.4 + 0.07886 * (a_db - 21.0)
    return 0.0


def design_lowpass(fs_in: float, U: int, f_pass: float, f_stop: float) -> tuple[np.ndarray, int]:
    """多相原型：采样率 fs_in·U 上的 Kaiser 窗 sinc，长 2·U·T + 1、中心 U·T，通带增益 1（乘 U）。"""
    n_in = (STOP_DB - 8.0) / (2.285 * 2.0 * math.pi * (f_stop - f_pass) / fs_in)
    T = int(math.ceil(n_in / 2.0))
    c = U * T
    wc = 0.5 * (f_pass + f_stop) / (fs_in * U)          # 周 / 原型样点
    beta = kaiser_beta(STOP_DB)
    i0b = bessel_i0(beta)
    h = np.empty(2 * c + 1, dtype=np.float64)
    for i in range(2 * c + 1):
        d = i - c
        r = d / c
        w = bessel_i0(beta * math.sqrt(max(0.0, 1.0 - r * r))) / i0b
        a = 2.0 * wc * d
        s = 1.0 if d == 0 else math.sin(math.pi * a) / (math.pi * a)
        h[i] = U * 2.0 * wc * s * w
    return h, T


def resample(x: np.ndarray, m0: int, U: int, D: int, h: np.ndarray, T: int, j_lo: int, j_hi: int) -> np.ndarray:
    """输出 j ∈ [j_lo, j_hi)，在输入的分数下标 j·D/U 处；x[i] 是输入样点 m0 + i，越界按 0。"""
    c = U * T
    out = np.zeros(j_hi - j_lo, dtype=np.complex128)
    n = x.size
    for j in range(j_lo, j_hi):
        p = j * D + c
        m_hi = p // U
        m_lo = -((-(p - 2 * c)) // U)
        a, b = max(m_lo, m0), min(m_hi, m0 + n - 1)
        if a > b:
            continue
        # h 下标 p − m·U，m 从 a 到 b 递增；按 m 递增顺序累加（与 TS 同序）
        hv = h[p - a * U::-U][: b - a + 1]
        out[j - j_lo] = np.dot(hv, x[a - m0:b - m0 + 1])
    return out


def mix(x: np.ndarray, m0: int, f_over_fs: float) -> np.ndarray:
    """乘 e^{−j2π·f·m/fs}，m 为绝对样点号，相位按周取小数部分（与 TS 同式）。"""
    m = np.arange(m0, m0 + x.size, dtype=np.float64)
    ph = m * f_over_fs
    ph = ph - np.floor(ph)
    return x * np.exp(-2j * np.pi * ph)


def ratio(fs_out: float, fs_in: float) -> tuple[int, int]:
    fr = Fraction(int(round(fs_out)), int(round(fs_in)))
    return fr.numerator, fr.denominator


# ---------------------------------------------------------------- 读段

class IqFile:
    def __init__(self, run_dir: str, op: str):
        d = os.path.join(run_dir, op)
        with open(os.path.join(d, "iq.index.json"), "r", encoding="utf-8") as f:
            self.idx = json.load(f)
        self.fs = float(self.idx["sample_rate_Hz"])
        self.fc = float(self.idx["center_Hz"])
        self.start = int(self.idx["start_sample"])
        self.n = int(self.idx["samples"])
        self.raw = np.memmap(os.path.join(d, "iq.cf32"), dtype="<f4", mode="r")
        if self.raw.size != 2 * self.n:
            raise ValueError("iq.cf32 长度与索引不符")

    def read(self, m_lo: int, m_hi: int) -> np.ndarray | None:
        """绝对样点 [m_lo, m_hi)；超出文件返回 None。"""
        a, b = m_lo - self.start, m_hi - self.start
        if a < 0 or b > self.n:
            return None
        v = np.asarray(self.raw[2 * a:2 * b], dtype=np.float64)
        return v[0::2] + 1j * v[1::2]


# ---------------------------------------------------------------- OFDM

def _slice_levels(v: np.ndarray, lv: np.ndarray) -> np.ndarray:
    return lv[np.argmin(np.abs(v[:, None] - lv[None, :]), axis=1)]


def _decide(X: np.ndarray, lv: np.ndarray) -> np.ndarray:
    return _slice_levels(X.real, lv) + 1j * _slice_levels(X.imag, lv)


def zc_shift(root: int, K: int, N: int) -> float:
    """ZC 频移一个子载波等价的时移（原生样点，折到 (−N/2, N/2]）。"""
    s = (root * N / (2 * K + 1)) % N
    return s - N if s > N / 2 else s


def demod_ofdm(iq: IqFile, row: dict, doc: dict) -> dict:
    p = ofdm_ref.Preset(doc, row["preset_id"])
    fs, fs_n, N, K = iq.fs, p.fs, p.fft, p.K
    df = fs_n / N
    n0 = int(round(row["t_s"] * fs_n))
    n_len = int(round((row["t_end_s"] - row["t_s"]) * fs_n))
    var = next((v for v, b in enumerate(p.bursts) if b["length"] == n_len), None)
    if var is None:
        return {"state": "invalid", "reasons": [f"突发长度 {n_len} 个原生样点不是预设的任一变体"]}
    cps = p.bursts[var]["cp"]
    zcs = [(s, r) for s, r in enumerate(p.bursts[var]["zc"]) if r]
    offs = [0]
    for c_ in cps:
        offs.append(offs[-1] + c_ + N)
    b = min(cps) // 4
    U, D = ratio(fs_n, fs)
    f_pass = 0.5 * row["bw_Hz"] + 0.5e6
    f_stop = 0.5 * row["bw_Hz"] + 1.5e6
    h, T = design_lowpass(fs, U, f_pass, f_stop)
    c = U * T
    th_lo = n0 - int(math.ceil(PRE_S * fs_n))
    th_hi = n0 + int(math.ceil(POST_S * fs_n))
    j_lo = th_lo - b - FINE_WIN - 4
    j_hi = th_hi + n_len + FINE_WIN + 4
    m_lo = (j_lo * D - c) // U
    m_hi = ((j_hi - 1) * D + c) // U + 1
    x = iq.read(m_lo, m_hi)
    if x is None:
        return {"state": "invalid", "reasons": ["取段超出文件"]}
    xb = mix(x, m_lo, (row["center_Hz"] - iq.fc) / fs)
    r = resample(xb, m_lo, U, D, h, T, j_lo, j_hi)

    # ② CP 相关定时与小数倍频偏
    pp = r[:-N] * np.conj(r[N:])
    ee = 0.5 * (np.abs(r[:-N]) ** 2 + np.abs(r[N:]) ** 2)
    P = np.concatenate([[0j], np.cumsum(pp)])
    E = np.concatenate([[0.0], np.cumsum(ee)])
    best, th_best, g_best = -math.inf, th_lo, 0j
    for th in range(th_lo, th_hi + 1):
        i = th - j_lo
        g, e = 0j, 0.0
        for s, cp in enumerate(cps):
            g += P[i + offs[s] + cp] - P[i + offs[s]]
            e += E[i + offs[s] + cp] - E[i + offs[s]]
        lam = abs(g) - RHO * e
        if lam > best:
            best, th_best, g_best = lam, th, g
    eps = -math.atan2(g_best.imag, g_best.real) * fs_n / (2.0 * math.pi * N)
    jj = np.arange(j_lo, j_hi, dtype=np.float64)
    ph = jj * (eps / fs_n)
    r1 = r * np.exp(-2j * np.pi * (ph - np.floor(ph)))

    # ③ ZC 上联合搜 q 与精定时
    ks = np.array([p.k_of(i) for i in range(2 * K)])
    Zs = {rt: np.array(ofdm_ref.zc_carriers(p, rt)) for _, rt in zcs}
    Yz = {}
    for s, rt in zcs:
        w = th_best + offs[s] + cps[s] - b
        Yz[s] = np.fft.fft(r1[w - j_lo:w - j_lo + N])
    judge = [(s, rt) for s, rt in zcs if abs(zc_shift(rt, K, N)) >= MIN_ZC_SHIFT]
    Q = int(math.ceil(CFO_PPM * row["center_Hz"] / df))
    per_q = []
    for q in range(-Q, Q + 1):
        acc = np.zeros(2 * FINE_WIN + 1)
        for s, rt in judge:
            V = np.zeros(N, dtype=np.complex128)
            V[ks % N] = Yz[s][(ks + q) % N] * np.conj(Zs[rt])
            cc = np.fft.ifft(V)
            idx = np.arange(b - FINE_WIN, b + FINE_WIN + 1) % N
            acc += np.abs(cc[idx])
        n_at = int(np.argmax(acc))
        per_q.append((float(acc[n_at]), q, b - FINE_WIN + n_at))
    per_q.sort(key=lambda t: -t[0])
    pk, q_best, n_best = per_q[0]
    sync_ratio = pk / per_q[1][0] if len(per_q) > 1 and per_q[1][0] > 0 else math.inf
    if sync_ratio < SYNC_RATIO:
        return {"state": "invalid", "reasons": [f"同步失败：ZC 相关峰比 {sync_ratio:.2f}（线 {SYNC_RATIO}）"],
                "sync_ratio": sync_ratio}
    th_f = th_best + (n_best - b)                       # 峰在 b′ 处（窗起点到有用起点的样点数），δ = b′ − b
    cfo = q_best * df + eps
    ph = jj * (q_best / N)
    r2 = r1 * np.exp(-2j * np.pi * (ph - np.floor(ph)))

    # ④ 逐符号 FFT 与信道估计
    Ys = []
    for s, cp in enumerate(cps):
        w = th_f + offs[s] + cp - b
        Ys.append(np.fft.fft(r2[w - j_lo:w - j_lo + N])[ks % N])
    H = np.zeros(2 * K, dtype=np.complex128)
    for s, rt in zcs:
        H += Ys[s] / Zs[rt]
    H /= len(zcs)
    # 到达时刻：H 相邻子载波相位斜率给出窗起点到有用起点的分数样点 b″
    pairs = [(i, i + 1) for i in range(2 * K - 1) if ks[i + 1] - ks[i] == 1]
    acc = sum(H[i1] * np.conj(H[i0]) for i0, i1 in pairs)
    b2 = -math.atan2(acc.imag, acc.real) * N / (2.0 * math.pi)
    s_ref = zcs[0][0]
    u_ref = th_f + offs[s_ref] + cps[s_ref] - b + b2
    delay = (u_ref - (n0 + offs[s_ref] + cps[s_ref])) / fs_n

    # ⑤ 均衡与逐符号相位跟踪
    lv = np.array(p.levels)
    data = [s for s in range(len(cps)) if not p.bursts[var]["zc"][s]]
    pts, phis, tts = [], [], []
    err = ref = 0.0
    for s in data:
        X = Ys[s] / H
        t_s = th_f + offs[s] + cps[s] + N / 2.0
        if len(phis) >= 2:
            pred = phis[-1] + (phis[-1] - phis[-2]) / (tts[-1] - tts[-2]) * (t_s - tts[-1])
        elif phis:
            pred = phis[-1]
        else:
            pred = 0.0
        Xr = X * complex(math.cos(-pred), math.sin(-pred))
        g = 1 + 0j
        for _ in range(2):
            d = _decide(Xr / g, lv)
            g = complex(np.sum(Xr * np.conj(d))) / float(np.sum(np.abs(d) ** 2))
        Xf = Xr / g
        phis.append(pred + math.atan2(g.imag, g.real))
        tts.append(t_s)
        d = _decide(Xf, lv)
        err += float(np.sum(np.abs(Xf - d) ** 2))
        ref += float(np.sum(np.abs(d) ** 2))
        pts.append(Xf)
    evm = math.sqrt(err / ref)
    # 剩余频偏：相位跟踪轨迹对符号中心时刻的最小二乘斜率（判决引导，比 CP 相关准）
    resid = 0.0
    if len(phis) >= 2:
        tm = sum(tts) / len(tts)
        pm = sum(phis) / len(phis)
        num = sum((t - tm) * (f - pm) for t, f in zip(tts, phis))
        den = sum((t - tm) ** 2 for t in tts)
        resid = num / den * fs_n / (2.0 * math.pi)
    cfo += resid
    P_ = np.concatenate(pts)
    ideal = [complex(a, b_) for a in lv for b_ in lv]
    return {"state": "valid", "reasons": [], "kind": "ofdm", "preset_id": p.id, "constellation":
            next(x["constellation"] for x in doc["presets"] if x["id"] == p.id),
            "variant": var, "n_symbols": len(data), "n_subcarriers": 2 * K, "points": P_,
            "evm_rms": evm, "mer_dB": -20.0 * math.log10(evm), "cfo_Hz": cfo, "delay_s": delay,
            "q": q_best, "eps_Hz": eps, "timing": th_f, "sync_ratio": sync_ratio, "ideal": ideal}


# ---------------------------------------------------------------- GFSK

def demod_gfsk(iq: IqFile, row: dict, gdoc: dict) -> dict:
    raw = next(x for x in gdoc["presets"] if x["id"] == row["preset_id"])
    R, fdev = float(raw["symbol_rate_Hz"]), float(raw["deviation_Hz"])
    n_bits = int(round((row["t_end_s"] - row["t_s"]) * R))
    fs = iq.fs
    D = max(1, int(fs // (GFSK_SPS * R)))
    fs_d = fs / D
    h, T = design_lowpass(fs, 1, GFSK_PASS_HZ, fs_d - GFSK_PASS_HZ)
    c = T
    j_lo = int(math.floor((row["t_s"] - PRE_S) * fs_d)) - 4
    j_hi = int(math.ceil((row["t_end_s"] + POST_S) * fs_d)) + 4
    m_lo = j_lo * D - c
    m_hi = (j_hi - 1) * D + c + 1
    x = iq.read(m_lo, m_hi)
    if x is None:
        return {"state": "invalid", "reasons": ["取段超出文件"]}
    xb = mix(x, m_lo, (row["center_Hz"] - iq.fc) / fs)
    y = resample(xb, m_lo, 1, D, h, T, j_lo, j_hi)
    z = y[1:] * np.conj(y[:-1])
    f = np.arctan2(z.imag, z.real) * fs_d / (2.0 * math.pi)        # f[i] 在时刻 (j_lo + i + 0.5)/fs_d
    t_f0 = (j_lo + 0.5) / fs_d

    def at(t: np.ndarray) -> np.ndarray:
        u = (t - t_f0) * fs_d
        i = np.clip(np.floor(u).astype(np.int64), 0, f.size - 2)
        a = u - i
        return f[i] * (1.0 - a) + f[i + 1] * a

    head = [1 if k % 2 == 0 else -1 for k in range(32)] + \
           [1 if (0xD391D391 >> k) & 1 else -1 for k in range(31, -1, -1)]
    hv = np.array(head, dtype=np.float64)
    kc = (np.arange(64) + 0.5) / R
    step = 1.0 / (8.0 * fs_d)
    n_step = int(math.ceil((PRE_S + POST_S) / step))
    cs = np.empty(n_step + 1)
    for i in range(n_step + 1):
        cs[i] = float(np.dot(hv, at(row["t_s"] - PRE_S + i * step + kc)))
    i_pk = int(np.argmax(cs))
    # 2-FSK 的相关在一个符号内是平台：取峰附近 ≥ 98% 峰值的连续段的中点
    thr = cs[i_pk] - 0.02 * abs(cs[i_pk])
    i_a = i_pk
    while i_a > 0 and cs[i_a - 1] >= thr:
        i_a -= 1
    i_b = i_pk
    while i_b < n_step and cs[i_b + 1] >= thr:
        i_b += 1
    tau_best = row["t_s"] - PRE_S + 0.5 * (i_a + i_b) * step
    fc_ = at(tau_best + (np.arange(n_bits) + 0.5) / R)
    cfo0 = float(np.mean(fc_[:32]))                        # 前导 1010… 平衡
    pos, neg = fc_[fc_ > cfo0], fc_[fc_ <= cfo0]
    cfo = 0.5 * (float(np.mean(pos)) + float(np.mean(neg))) if pos.size and neg.size else cfo0
    dev = fc_ - cfo
    bits = np.where(dev[:64] > 0, 1, -1)
    match = int(np.sum(bits == hv))
    i0 = int(math.floor((tau_best - 2.0 / R - t_f0) * fs_d))
    i1 = int(math.ceil((tau_best + (n_bits + 2.0) / R - t_f0) * fs_d))
    i0, i1 = max(i0, 0), min(i1, f.size)
    stride = max(1, -(-(i1 - i0) // TRACE_MAX))
    tr_i = np.arange(i0, i1, stride)
    trace = np.stack([(t_f0 + tr_i / fs_d - tau_best), f[tr_i] - cfo], axis=1)
    state = "valid" if match >= GFSK_HEADER_MIN else "invalid"
    reasons = [] if state == "valid" else [f"前导与同步字只对上 {match}/64"]
    return {"state": state, "reasons": reasons, "kind": "gfsk", "preset_id": raw["id"],
            "modulation": raw["modulation"], "bt": raw.get("bt"), "symbol_rate_Hz": R,
            "deviation_nominal_Hz": fdev, "deviation_Hz": float(np.mean(np.abs(dev))),
            "n_symbols": n_bits, "deviations": dev, "trace": trace, "cfo_Hz": cfo,
            "delay_s": tau_best - row["t_s"], "header_match": match, "fs_d": fs_d}


# ---------------------------------------------------------------- 入口

def load_docs() -> tuple[dict, dict]:
    with open(os.path.join(_ROOT, "models", "radiator", "gfsk-presets-v1.json"), "r", encoding="utf-8") as f:
        g = json.load(f)
    return ofdm_ref.load_presets(), g


def demod(iq: IqFile, row: dict, docs: tuple[dict, dict]) -> dict:
    wf = row.get("waveform")
    if wf in ("ofdm", "droneid"):
        return demod_ofdm(iq, row, docs[0])
    if wf == "gfsk":
        return demod_gfsk(iq, row, docs[1])
    return {"state": "not_applicable", "reasons": [f"波形 {wf} 无星座"]}


def truth_rows(run_dir: str) -> list:
    with open(os.path.join(run_dir, "truth.jsonl"), "r", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def overlaps(row: dict, rows: list, margin_s: float = 1e-4, margin_Hz: float = 1e5) -> list:
    lo, hi = row["center_Hz"] - row["bw_Hz"] / 2 - margin_Hz, row["center_Hz"] + row["bw_Hz"] / 2 + margin_Hz
    out = set()
    for r in rows:
        if r["emitter_id"] == row["emitter_id"] or r.get("site_id") != row.get("site_id"):
            continue
        if r["t_s"] > row["t_end_s"] + margin_s or r["t_end_s"] + margin_s < row["t_s"]:
            continue
        if r["center_Hz"] + r["bw_Hz"] / 2 < lo or r["center_Hz"] - r["bw_Hz"] / 2 > hi:
            continue
        out.add(r["emitter_id"])
    return sorted(out)


def _selftest() -> int:
    import resampler
    fails = 0

    def check(cond: bool, what: str) -> None:
        nonlocal fails
        print(("  ok   " if cond else "  FAIL ") + what)
        fails += 0 if cond else 1

    doc, _ = load_docs()
    tab = resampler.load_table()

    class Mem(IqFile):
        def __init__(self, x: np.ndarray, fs: float, fc: float):
            self.x, self.fs, self.fc, self.start, self.n = x, fs, fc, 0, x.size

        def read(self, a: int, b: int):
            return None if a < 0 or b > self.n else self.x[a:b]

    for pid, var, fs, M, cfo, delay_m, noise in (("dji-uplink-2m", 0, 80e6, 24, -45233.6625, 271, 0.0),
                                                 ("dji-video-20m-a", 0, 80e6, 48, 31234.5, 437, 0.0),
                                                 ("dji-droneid", 0, 80e6, 24, -12345.0, 123, 0.0),
                                                 ("dji-video-20m-a", 0, 80e6, 48, -45233.6625, 271, 0.1)):
        p = ofdm_ref.Preset(doc, pid)
        nat = ofdm_ref.burst(p, var, 1234)
        t_s = 0.0002
        n0 = int(round(t_s * p.fs))
        L = 125
        n_out = int(math.ceil((n0 + nat.size) * L / M)) + 400
        st = resampler.resample(nat, n0, M, 0, n_out, tab)
        x = np.zeros(n_out + 20000, dtype=np.complex128)
        x[delay_m:delay_m + st.size] = st
        m = np.arange(x.size)
        f_off = 22.5e6
        x *= np.exp(2j * np.pi * (f_off + cfo) * m / fs)
        if noise:
            rng = np.random.default_rng(7)
            x += noise * (rng.standard_normal(x.size) + 1j * rng.standard_normal(x.size)) / math.sqrt(2)
        bw = next(q for q in doc["presets"] if q["id"] == pid)["occupied_bw_Hz"]
        row = {"t_s": t_s, "t_end_s": (n0 + nat.size) / p.fs, "center_Hz": 2.44e9 + f_off, "bw_Hz": bw,
               "preset_id": pid, "waveform": "droneid" if pid == "dji-droneid" else "ofdm"}
        res = demod_ofdm(Mem(x, fs, 2.44e9), row, doc)
        if res["state"] != "valid":
            check(False, f"{pid}：{res['reasons']}")
            continue
        evm_db = 20 * math.log10(res["evm_rms"])
        line = -45.0 if not noise else -15.0
        check(evm_db <= line, f"{pid}（噪声 {noise}）：EVM {evm_db:.1f} dB（线 {line}）")
        check(abs(res["cfo_Hz"] - cfo) < 1.0, f"{pid}：频偏 {res['cfo_Hz']:.2f} Hz（设 {cfo}）")
        check(abs(res["delay_s"] - delay_m / fs) < 0.05e-6,
              f"{pid}：时延 {res['delay_s'] * 1e6:.4f} µs（设 {delay_m / fs * 1e6:.4f}）")
    print("自检", "通过" if fails == 0 else f"失败 {fails} 项")
    return 0 if fails == 0 else 1


def _summ(res: dict) -> str:
    if res["state"] not in ("valid", "degraded"):
        return f"{res['state']} {res['reasons']}"
    if res["kind"] == "ofdm":
        return (f"{res['state']} EVM {res['evm_rms'] * 100:.2f}% MER {res['mer_dB']:.2f} dB  CFO {res['cfo_Hz']:.1f} Hz "
                f"delay {res['delay_s'] * 1e6:.4f} µs  q {res['q']}  ratio {res['sync_ratio']:.1f}  "
                f"{res['n_symbols']}×{res['n_subcarriers']}")
    return (f"{res['state']} header {res['header_match']}/64  dev {res['deviation_Hz']:.0f} Hz  CFO {res['cfo_Hz']:.1f} Hz "
            f"delay {res['delay_s'] * 1e6:.3f} µs")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("run_dir", nargs="?")
    ap.add_argument("--op", default="s3")
    ap.add_argument("--emitter")
    ap.add_argument("--t", type=float)
    ap.add_argument("--scan")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--json")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    iq = IqFile(a.run_dir, a.op)
    rows = truth_rows(a.run_dir)
    docs = load_docs()
    if a.scan:
        sel = [r for r in rows if r["emitter_id"] == a.scan][: a.limit]
        for r in sel:
            res = demod(iq, r, docs)
            print(f"t={r['t_s']:.6f} f={r['center_Hz'] / 1e6:.3f} ov={overlaps(r, rows)} truth_cfo={r.get('cfo_Hz')}  "
                  + _summ(res))
        return 0
    r = min((r for r in rows if r["emitter_id"] == a.emitter), key=lambda r: abs(r["t_s"] - a.t))
    res = demod(iq, r, docs)
    print(_summ(res))
    if a.json:
        out = {k: v for k, v in res.items() if k not in ("points", "deviations", "trace", "ideal")}
        if "points" in res:
            out["points"] = [[float(z.real), float(z.imag)] for z in res["points"]]
        if "deviations" in res:
            out["deviations"] = [float(v) for v in res["deviations"]]
            out["trace"] = res["trace"].tolist()
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(out, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
