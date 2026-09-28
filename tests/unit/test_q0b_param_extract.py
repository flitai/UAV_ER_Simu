"""Q-0b 实测参数提取的合成夹具单测（06 §9K 验收：合成夹具上提取误差 ≤ 5%）。

每个夹具都按**已知参数**造信号、加复高斯噪声，再让提取器去量，对比设定值：
- 图传：18 MHz 类 OFDM 突发串（921 个子载波），带内夹两个 25 dB 的 2 MHz 强跳频点——
  这正是按带内能量求和会偏长 20% 的情形，中位数做法要把它挡住；
- 遥控上行：2 MHz 带限噪声跳频，0.5 ms、间隔 4 / 6 ms 交替（DroneRFb 实测的形状）；
- 第三方遥控：GFSK（70 kbaud、频偏 57 kHz、BT 0.5），47 个频点、3.0 ms / 9 ms（14 报告 §3.1 的 ACCST 参数）；
- 纯噪声：量虚警与等效门限；
- 块边界：间隔不跨块；验收集剔除；DroneRFb 机型数核实。

不读任何数据集。运行：
    uv run --quiet --with numpy --with scipy python tests/unit/test_q0b_param_extract.py
"""
from __future__ import annotations

import math
import os
import sys
import unittest

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "algos", "reference"))

import q0b_param_extract as q   # noqa: E402

TOL = 0.05   # 06 §9K：提取误差 ≤ 5%


def cnoise(rng: np.random.Generator, n: int, power: float = 1.0) -> np.ndarray:
    return (rng.standard_normal(n) + 1j * rng.standard_normal(n)) * math.sqrt(power / 2)


def ofdm(rng: np.random.Generator, n: int, nfo: int = 4096, nused: int = 921, cp: int = 288) -> np.ndarray:
    """单位功率的类 OFDM：nfo 点 IFFT、nused 个 QPSK 子载波（含直流）、循环前缀 cp。"""
    out, tot = [], 0
    idx = np.arange(-(nused // 2), nused // 2 + 1)
    while tot < n:
        X = np.zeros(nfo, complex)
        X[idx % nfo] = (rng.choice([-1, 1], idx.size) + 1j * rng.choice([-1, 1], idx.size)) / math.sqrt(2)
        s = np.fft.ifft(X) * nfo / math.sqrt(nused)
        s = np.concatenate([s[-cp:], s])
        out.append(s)
        tot += s.size
    return np.concatenate(out)[:n]


def bl_noise(rng: np.random.Generator, n: int, fs: float, bw: float) -> np.ndarray:
    """单位功率、矩形谱、宽 bw 的带限噪声。"""
    X = np.fft.fft(cnoise(rng, n))
    X[np.abs(np.fft.fftfreq(n, 1 / fs)) > bw / 2] = 0
    y = np.fft.ifft(X)
    return y / math.sqrt(np.mean(np.abs(y) ** 2))


def gfsk(rng: np.random.Generator, n: int, fs: float, baud: float, dev: float, bt: float) -> np.ndarray:
    """恒包络 GFSK：高斯滤波后的 ±1 频率脉冲按 dev 积分成相位。"""
    sps = fs / baud
    nsym = int(math.ceil(n / sps)) + 8
    bits = rng.choice([-1.0, 1.0], nsym)
    t = np.arange(n) / fs
    sym = np.floor(t * baud).astype(int)
    f = bits[sym]
    # 高斯滤波（BT 以符号率归一）：σ_t = sqrt(ln2) / (2π·BT·baud)
    sig_t = math.sqrt(math.log(2)) / (2 * math.pi * bt * baud)
    k = np.arange(-int(4 * sig_t * fs), int(4 * sig_t * fs) + 1) / fs
    g = np.exp(-k ** 2 / (2 * sig_t ** 2))
    f = np.convolve(f, g / g.sum(), mode="same")
    return np.exp(1j * 2 * math.pi * dev * np.cumsum(f) / fs)


def ref_obw99(x: np.ndarray, fs: float, m: int) -> float:
    """干净信号的 99% 占用带宽（同样的汉宁均值谱），作为 GFSK 的「真值」。"""
    k = x.size // m
    w = np.hanning(m)
    X = np.fft.fftshift(np.fft.fft(x[:k * m].reshape(k, m) * w, axis=1), axes=1)
    p = np.mean(np.abs(X) ** 2, axis=0)
    c = np.cumsum(p) / p.sum()
    f = (np.arange(m) - m / 2) * fs / m
    return float(f[np.searchsorted(c, 0.995)] - f[np.searchsorted(c, 0.005)]) + fs / m


class TestVideoChannel(unittest.TestCase):
    """图传：覆盖率判开关 + 细时频图中位数能量等效时长。"""

    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(20260928)
        fs = cls.fs = 80e6
        n = int(20e-3 * fs)
        t = np.arange(n) / fs
        cls.bursts = [(0.5e-3, 1.2e-3), (2.3e-3, 0.8e-3), (4.2e-3, 2.0e-3), (7.1e-3, 1.5e-3),
                      (9.4e-3, 1.0e-3), (12.0e-3, 2.2e-3), (15.0e-3, 0.9e-3), (17.0e-3, 1.3e-3)]
        cls.occupied = 921 * fs / 4096          # 17.99 MHz
        cls.offset = 22e6
        gate = np.zeros(n)
        for a, d in cls.bursts:
            gate[int(round(a * fs)):int(round((a + d) * fs))] = 1
        snr = 10 ** (15 / 10) * cls.occupied / fs   # 带内信噪比 15 dB（噪声每样点功率 1）
        x = cnoise(rng, n) + math.sqrt(snr) * ofdm(rng, n) * np.exp(2j * math.pi * cls.offset * t) * gate
        # 两个 2 MHz、带内信噪比 25 dB 的跳频点：一个落在突发中间（4.2–6.2 ms 那个里面），一个落在间隙里
        for a, d, f0 in [(5.0e-3, 0.45e-3, 25e6), (11.0e-3, 0.45e-3, -10e6)]:
            i0, i1 = int(a * fs), int((a + d) * fs)
            x[i0:i1] += math.sqrt(10 ** 2.5 * 2e6 / fs) * bl_noise(rng, i1 - i0, fs, 2e6) \
                * np.exp(2j * math.pi * f0 * t[i0:i1])
        cls.x = x.astype(np.complex64)
        cls.tf = q.tf_map(cls.x, fs, 2440e6)
        cls.bl = q.blobs(cls.tf)
        cls.ch = q.find_channels(cls.tf, cls.bl, 10e6, 2450e6, 2480e6)
        cls.out, cls.info = q.channel_bursts(cls.x, cls.tf, *cls.ch[0]) if cls.ch else ([], {})

    def test_one_channel_with_right_edges(self):
        self.assertEqual(len(self.ch), 1)
        k0, k1 = self.ch[0]
        lo, hi = self.tf.bin_freq(k0) - 2440e6, self.tf.bin_freq(k1) - 2440e6
        self.assertLess(abs(lo - (self.offset - self.occupied / 2)), TOL * self.occupied)
        self.assertLess(abs(hi - (self.offset + self.occupied / 2)), TOL * self.occupied)

    def test_durations_within_5pct(self):
        self.assertEqual(len(self.out), len(self.bursts))
        for b, (a, d) in zip(self.out, self.bursts):
            self.assertLess(abs(b.dur_s / d - 1), TOL, f"{d * 1e3} ms 的突发量成 {b.dur_s * 1e3:.4f} ms")
            self.assertLess(abs(b.t0_s - a), TOL * d)

    def test_strong_inband_hop_does_not_stretch_burst(self):
        """4.2–6.2 ms 那个突发里夹着 25 dB 的跳频点：求和会偏长，中位数不会（比 5% 严一档）。"""
        b = next(z for z in self.out if abs(z.t0_s - 4.2e-3) < 0.1e-3)
        self.assertLess(abs(b.dur_s / 2.0e-3 - 1), 0.01)

    def test_intervals_within_5pct(self):
        got = np.diff([b.t0_s for b in self.out])
        want = np.diff([a for a, _ in self.bursts])
        for g, w in zip(got, want):
            self.assertLess(abs(g / w - 1), TOL)

    def test_bandwidth_within_5pct(self):
        for b in self.out:
            self.assertLess(abs(b.bw10_Hz / self.occupied - 1), TOL)
            self.assertLess(abs(b.obw99_Hz / self.occupied - 1), TOL)
            self.assertLess(abs(b.f_center_Hz - 2440e6 - self.offset), TOL * self.occupied)

    def test_snr_reads_the_set_value(self):
        med = float(np.median([b.snr_dB for b in self.out]))
        self.assertLess(abs(med - 15.0), 0.5)

    def test_gap_hop_is_found_and_video_fragments_are_not(self):
        runs = self.info["runs"]
        hops = q.hop_bursts(self.x, self.tf, self.bl, (0.8e6, 10e6),
                            exclude=[(*self.ch[0], runs)])
        # 落在图传频段外的那个（−10 MHz）一定找到；落在图传突发里的那个被当作图传碎片排除
        self.assertTrue(any(abs(h.f_center_Hz - 2440e6 + 10e6) < 0.2e6 and abs(h.dur_s / 0.45e-3 - 1) < TOL
                            for h in hops))
        self.assertFalse(any(abs(h.f_center_Hz - 2440e6 - 25e6) < 1e6 for h in hops))


class TestVideoPapr(unittest.TestCase):
    """峰均比：高信噪比下对干净信号的同口径值差 < 0.3 dB，且与复高斯的 CCDF 1e-3 点（8.39 dB）同量级。"""

    def test_papr(self):
        rng = np.random.default_rng(7)
        fs = 80e6
        n = int(12e-3 * fs)
        t = np.arange(n) / fs
        gate = np.zeros(n)
        gate[int(2e-3 * fs):int(8e-3 * fs)] = 1
        s = ofdm(rng, n) * np.exp(2j * math.pi * 20e6 * t)
        occ = 921 * fs / 4096
        x = (cnoise(rng, n) + math.sqrt(10 ** 3.0 * occ / fs) * s * gate).astype(np.complex64)
        tf = q.tf_map(x, fs, 2440e6)
        ch = q.find_channels(tf, q.blobs(tf), 10e6, 2440e6, 2480e6)
        out, _ = q.channel_bursts(x, tf, *ch[0])
        self.assertEqual(len(out), 1)
        core = np.abs(s[int(3.2e-3 * fs):int(6.8e-3 * fs)]) ** 2
        ref = 10 * math.log10(np.quantile(core, 1 - q.PAPR_CCDF) / np.mean(core))
        self.assertIsNotNone(out[0].papr_dB)
        self.assertLess(abs(out[0].papr_dB - ref), 0.3)
        self.assertLess(abs(ref - 10 * math.log10(-math.log(q.PAPR_CCDF))), 0.5)


class TestUplinkHops(unittest.TestCase):
    """遥控上行：带限噪声跳频，0.5 ms、间隔 4 / 6 ms 交替，9 个频点。"""

    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(11)
        fs = cls.fs = 80e6
        n = int(100e-3 * fs)
        t = np.arange(n) / fs
        cls.points = np.array([-35, -28, -21, -14, -7, 0, 7, 14, 21]) * 1e6
        cls.dur, cls.bw = 0.5e-3, 2e6
        x = cnoise(rng, n)
        starts, t0, k = [], 1.0e-3, 0
        while t0 + cls.dur < 99e-3:
            starts.append(t0)
            t0 += 4e-3 if k % 2 == 0 else 6e-3
            k += 1
        cls.starts = starts
        seq = [(4 * i) % 9 for i in range(len(starts))]   # 4 与 9 互素，九个点都走到
        amp = math.sqrt(10 ** 1.5 * cls.bw / fs)
        for a, j in zip(starts, seq):
            i0, i1 = int(round(a * fs)), int(round((a + cls.dur) * fs))
            x[i0:i1] += amp * bl_noise(rng, i1 - i0, fs, cls.bw) * np.exp(2j * math.pi * cls.points[j] * t[i0:i1])
        cls.x = x.astype(np.complex64)
        tf = q.tf_map(cls.x, fs, 2440e6)
        cls.hops = q.hop_bursts(cls.x, tf, q.blobs(tf), (0.5e6, 12e6))
        block = {"seconds": tf.mask.shape[0] * tf.cell_s, "channels": [], "hops": cls.hops}
        cls.summary = q.summarize_link([block], None, "uplink")

    def test_every_hop_found(self):
        self.assertEqual(len(self.hops), len(self.starts))

    def test_durations_and_bandwidth_within_5pct(self):
        for h in self.hops:
            self.assertLess(abs(h.dur_s / self.dur - 1), TOL)
            self.assertLess(abs(h.bw10_Hz / self.bw - 1), TOL)
            self.assertLess(abs(h.obw99_Hz / self.bw - 1), TOL)

    def test_mode_and_interval_peaks(self):
        m = self.summary["mode"]
        self.assertLess(abs(m["bw10_Hz"] / self.bw - 1), TOL)
        self.assertLess(abs(m["dur_s"] / self.dur - 1), TOL)
        peaks = sorted(p["center"] for p in self.summary["interval_peaks_ms"])
        self.assertEqual(len(peaks), 2)
        self.assertLess(abs(peaks[0] / 4.0 - 1), TOL)
        self.assertLess(abs(peaks[1] / 6.0 - 1), TOL)

    def test_frequency_set(self):
        fs_ = self.summary["freq_set"]
        self.assertEqual(fs_["n_points"], 9)
        got = np.array(fs_["points_Hz"]) - 2440e6
        self.assertLess(float(np.max(np.abs(got - self.points))), TOL * 7e6)


class TestGfskRc(unittest.TestCase):
    """第三方遥控：GFSK 70 kbaud、频偏 57 kHz、BT 0.5，3.0 ms / 9 ms，频点逐跳 +7 模 47（间距 1.5 MHz）。"""

    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(3)
        fs = cls.fs = 100e6
        n = int(95e-3 * fs)
        t = np.arange(n) / fs
        cls.dur, cls.period = 3.0e-3, 9.0e-3
        grid = (np.arange(47) * 1.5e6) - 35e6
        x = cnoise(rng, n)
        cls.clean = []
        cls.visits = []
        amp = math.sqrt(10 ** 1.5 * 0.2e6 / fs)
        for i in range(10):
            a = 1e-3 + i * cls.period
            ch = (7 * i) % 47
            cls.visits.append(grid[ch])
            i0, i1 = int(round(a * fs)), int(round((a + cls.dur) * fs))
            s = gfsk(rng, i1 - i0, fs, 70e3, 57e3, 0.5)
            cls.clean.append(s)
            x[i0:i1] += amp * s * np.exp(2j * math.pi * grid[ch] * t[i0:i1])
        cls.x = x.astype(np.complex64)
        tf = q.tf_map(cls.x, fs, 2440e6)
        cls.hops = q.hop_bursts(cls.x, tf, q.blobs(tf), (0.05e6, 3e6))
        block = {"seconds": tf.mask.shape[0] * tf.cell_s, "channels": [], "hops": cls.hops}
        cls.summary = q.summarize_link([block], None, "rc")

    def test_durations_within_5pct(self):
        self.assertEqual(len(self.hops), 10)
        for h in self.hops:
            self.assertLess(abs(h.dur_s / self.dur - 1), TOL)

    def test_interval_within_5pct(self):
        self.assertLess(abs(self.summary["interval_s"]["median"] / self.period - 1), TOL)

    def test_obw99_against_clean_reference(self):
        ref = float(np.median([ref_obw99(s, self.fs, 1 << 15) for s in self.clean]))
        got = float(np.median([h.obw99_Hz for h in self.hops]))
        self.assertLess(abs(got / ref - 1), TOL, f"99% 带宽 {got / 1e3:.1f} kHz，干净信号 {ref / 1e3:.1f} kHz")

    def test_visited_points(self):
        fs_ = self.summary["freq_set"]
        self.assertEqual(fs_["n_points"], len(set(np.round(self.visits, 3))))
        got = np.array(fs_["points_Hz"]) - 2440e6
        for v in self.visits:
            self.assertLess(float(np.min(np.abs(got - v))), TOL * 1.5e6)


class TestNoiseOnly(unittest.TestCase):
    """纯噪声：占用格的比例（虚警）与等效门限（相对噪声均值），也证明没有凭空的突发。"""

    def test_false_alarm_and_effective_threshold(self):
        rng = np.random.default_rng(5)
        fs = 80e6
        x = cnoise(rng, int(50e-3 * fs)).astype(np.complex64)
        tf = q.tf_map(x, fs, 2440e6)
        pfa = float(tf.mask.mean())
        self.assertLess(pfa, 1e-2)          # 实测约 0.4%（脚本头第 3 条）
        eff_dB = 10 * math.log10(float(np.median(tf.floor)) * 10 ** (q.THRESH_DB / 10) / float(np.median(tf.noise_mean)))
        self.assertGreater(eff_dB, 3.0)
        self.assertLess(eff_dB, 5.0)
        bl = q.blobs(tf)
        self.assertEqual(q.hop_bursts(x, tf, bl, (0.05e6, 20e6)), [])
        self.assertEqual(q.find_channels(tf, bl, 5e6, 2400e6, 2480e6), [])


def _burst(t0: float, dur: float, f: float) -> q.Burst:
    return q.Burst(t0, dur, f, 2e6, 2e6, 2e6, 0.9, 30.0, None, False, 2e6)


class TestBlockContinuity(unittest.TestCase):
    """DroneRFa 块间不连续：间隔只在块内算（铁律 3）。"""

    def test_no_interval_across_blocks(self):
        a = {"seconds": 0.1, "channels": [], "hops": [_burst(0.01 + 0.004 * i, 0.5e-3, 2440e6 + i * 1e6)
                                                        for i in range(5)]}
        b = {"seconds": 0.1, "channels": [], "hops": [_burst(0.002 + 0.004 * i, 0.5e-3, 2450e6 + i * 1e6)
                                                        for i in range(5)]}
        s = q.summarize_link([a, b], None, "uplink")
        self.assertEqual(s["interval_s"]["n"], 8)
        self.assertAlmostEqual(s["interval_s"]["max"], 0.004, places=9)


class TestHoldoutAndCensus(unittest.TestCase):

    def test_drop_holdout_by_id_and_hash(self):
        recs = [q.Rec("a", "", "dronerfb", {}, "CH0", "h1"), q.Rec("b", "", "dronerfb", {}, "CH0", "h2"),
                q.Rec("c", "", "dronerfb", {}, "CH0", "h3")]
        keep, dropped = q.drop_holdout(recs, {"a"}, {"h3"})
        self.assertEqual([r.data_id for r in keep], ["b"])
        self.assertEqual(sorted(dropped), ["a", "c"])

    def test_census_counts_background_letter_out(self):
        recs = []
        for letter in "ACDEFG":
            for ind in (1, 2, 3):
                recs.append(q.Rec(f"{letter}{ind}", "", "dronerfb",
                                  {"class_code": f"{letter}{ind}", "class_name": letter,
                                   "split": "test"}, "CH0", ""))
        recs.append(q.Rec("bg", "", "dronerfb", {"class_code": "B", "split": "test"}, "CH0", ""))
        c = q.dronerfb_census(recs)
        self.assertEqual(c["local"]["types"], 6)
        self.assertEqual(c["local"]["individuals_per_type"], [3])
        self.assertEqual(c["local"]["test_labels"], 19)


class TestEnergyDuration(unittest.TestCase):

    def test_rectangle_with_noise(self):
        rng = np.random.default_rng(1)
        e = rng.standard_normal(20000) * 0.05
        e[5000:13000] += 1.0
        dur, cen, plat = q._energy_duration(e, 5000, 13000, 1000, 10)
        self.assertLess(abs(dur / 8000 - 1), 0.01)
        self.assertLess(abs(cen - 9000), 40)


if __name__ == "__main__":
    unittest.main(verbosity=2)
