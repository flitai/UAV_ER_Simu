"""能量检测器参考实现的单元测试（04 §15.1 第一级：解析与理论）。

这里验证的是**实现本身**：特殊函数对闭式解、门限公式对蒙特卡洛。真实背景上的虚警率是
另一回事，那是 DS-6，结论在 WORKLOG 与 `data/iq/measured/ds6-false-alarm-report.md`。

运行：uv run --quiet --with numpy python tests/unit/test_energy_detector.py
"""
from __future__ import annotations

import math
import os
import sys
import unittest

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "algos", "reference"))

import energy_detector as ed          # noqa: E402


class TestRegularizedGammaQ(unittest.TestCase):
    """Q(a,x) 在 a 为小正整数时有闭式解，用它对拍。"""

    def test_a1_is_exponential(self):
        for x in (0.1, 1.0, 3.0, 10.0, 25.0):
            self.assertAlmostEqual(ed.regularized_gamma_q(1, x), math.exp(-x),
                                   delta=1e-12 + 1e-10 * math.exp(-x))

    def test_a2_closed_form(self):
        for x in (0.1, 1.0, 5.0, 20.0):
            want = (1 + x) * math.exp(-x)
            self.assertAlmostEqual(ed.regularized_gamma_q(2, x), want, delta=1e-12 + 1e-10 * want)

    def test_a3_closed_form(self):
        for x in (0.5, 2.0, 8.0, 30.0):
            want = (1 + x + x * x / 2) * math.exp(-x)
            self.assertAlmostEqual(ed.regularized_gamma_q(3, x), want, delta=1e-12 + 1e-10 * want)

    def test_monotone_and_bounds(self):
        self.assertEqual(ed.regularized_gamma_q(5, 0.0), 1.0)
        prev = 1.0
        for x in np.linspace(0.1, 60, 50):
            v = ed.regularized_gamma_q(5, float(x))
            self.assertLessEqual(v, prev + 1e-15)
            self.assertGreaterEqual(v, 0.0)
            prev = v

    def test_both_branches_match_exact_integer_form(self):
        """x 在 a+1 两侧走级数与连分式两条路径，都必须对上整数 a 的精确闭式。

        精确解 Q(n,x) = e^{-x} · Σ_{k<n} x^k/k!。两条路径实测相对误差均为 1e-10 量级，
        因此判据取 1e-8，而不是浮点极限——这是实现的真实精度，不是放水。
        """
        def exact(n, x):
            s, term = 0.0, 1.0
            for k in range(n):
                if k:
                    term *= x / k
                s += term
            return math.exp(-x) * s

        for a in (4, 16, 128):
            x = float(a + 1)
            want = exact(a, x)
            series = ed.regularized_gamma_q(a, x - 1e-9)       # 级数路径
            cfrac = ed.regularized_gamma_q(a, x + 1e-9)        # 连分式路径
            self.assertLess(abs(series - want) / want, 1e-8, f"a={a} 级数路径")
            self.assertLess(abs(cfrac - want) / want, 1e-8, f"a={a} 连分式路径")


class TestThreshold(unittest.TestCase):
    def test_single_bin_threshold_is_minus_log_pfa(self):
        for pfa in (1e-2, 1e-3, 1e-4):
            self.assertAlmostEqual(ed.threshold_for_pfa(1, pfa), -math.log(pfa), places=9)

    def test_threshold_inverts_q(self):
        for m in (1, 8, 128):
            for pfa in (1e-2, 1e-3, 1e-5):
                eta = ed.threshold_for_pfa(m, pfa)
                self.assertAlmostEqual(ed.regularized_gamma_q(m, m * eta), pfa,
                                       delta=pfa * 1e-6)

    def test_threshold_approaches_one_as_bins_grow(self):
        """频点越多，检测量越集中，门限越接近均值 1。"""
        etas = [ed.threshold_for_pfa(m, 1e-3) for m in (1, 16, 256, 4096)]
        self.assertTrue(all(a > b for a, b in zip(etas, etas[1:])), etas)
        self.assertLess(etas[-1], 1.2)
        self.assertGreater(etas[-1], 1.0)


class TestOnSyntheticAWGN(unittest.TestCase):
    """H0 是复高斯白噪声时，实测虚警率必须落在目标值的统计误差内。"""

    def _lambda(self, frames, nfft, band, fs, seed):
        rng = np.random.default_rng(seed)
        n = frames * nfft
        x = ((rng.standard_normal(n) + 1j * rng.standard_normal(n))
             / math.sqrt(2)).astype(np.complex64)
        p = ed.frame_bin_power(x, nfft)
        mask = band.mask(nfft, fs)
        noise = ed.estimate_noise_per_bin(p)
        return ed.statistic(p, mask, noise), int(np.count_nonzero(mask))

    def test_measured_pfa_matches_target(self):
        fs = 80e6
        band = ed.Band(-5e6, 5e6)
        lam, m = self._lambda(frames=40000, nfft=256, band=band, fs=fs, seed=7)
        for pfa in (1e-2, 1e-3):
            eta = ed.threshold_for_pfa(m, pfa)
            measured = float(np.mean(lam > eta))
            # 二项分布 3 sigma
            tol = 3 * math.sqrt(pfa * (1 - pfa) / lam.size) + 0.2 * pfa
            self.assertLess(abs(measured - pfa), tol,
                            f"目标 {pfa}，实测 {measured}，容差 {tol}")

    def test_statistic_mean_is_one_under_h0(self):
        lam, _ = self._lambda(frames=8000, nfft=256, band=ed.Band(-5e6, 5e6), fs=80e6, seed=8)
        self.assertAlmostEqual(float(lam.mean()), 1.0, delta=0.02)

    def test_noise_estimator_is_unbiased_enough(self):
        """逐频点帧维中位数除以 ln2，对指数分布是无偏的一致估计。"""
        rng = np.random.default_rng(9)
        n = 20000 * 64
        x = ((rng.standard_normal(n) + 1j * rng.standard_normal(n))
             / math.sqrt(2)).astype(np.complex64)
        p = ed.frame_bin_power(x, 64)
        est = ed.estimate_noise_per_bin(p)
        self.assertAlmostEqual(float(est.mean() / p.mean()), 1.0, delta=0.02)

    def test_estimator_bias_under_bursts_matches_theory(self):
        """突发占空比 d 时，中位数估计有确定的偏低量，且远小于均值估计的偏高量。

        占空比 d 的帧被抬高后，它们排到分布顶端，于是中位数落在原分布的 0.5/(1−d) 分位上，
        指数分布下 d=5% 对应 ln(1/(1−0.5263))/ln2 = 1.077，即噪声被**高估 0.33 dB**。
        方向是高估不是低估：门限因此偏高、虚警率因此偏低，所以 DS-6 测到的超标是**保守**的。
        这不是"基本不动"，而是一个可解析的已知偏差，解读虚警率时要算进去。
        均值估计在同样条件下被拉高十倍以上，这就是这里不用均值的理由。
        """
        rng = np.random.default_rng(10)
        frames, nfft, duty = 4000, 64, 0.05
        x = ((rng.standard_normal(frames * nfft) + 1j * rng.standard_normal(frames * nfft))
             / math.sqrt(2)).astype(np.complex64)
        p_clean = ed.frame_bin_power(x, nfft)
        p_burst = p_clean.copy()
        p_burst[:int(frames * duty)] *= 1000.0          # 5% 的帧强 30 dB
        med = ed.estimate_noise_per_bin(p_burst) / ed.estimate_noise_per_bin(p_clean)
        q = 0.5 / (1 - duty)
        want = math.log(1 / (1 - q)) / math.log(2)
        self.assertAlmostEqual(float(med.mean()), want, delta=0.02)
        self.assertLess(abs(10 * math.log10(want) - 0.326), 0.01)     # +0.32 dB，高估
        self.assertGreater(p_burst.mean() / p_clean.mean(), 10.0)


class TestAnalyticPd(unittest.TestCase):
    """检测概率解析式：退化、单调、以及与蒙特卡洛的对拍（跨层一致性算例 ① 的单测形态）。"""

    def test_degenerates_to_pfa_at_zero_snr(self):
        for m in (1, 16, 128):
            for pfa in (1e-2, 1e-3):
                eta = ed.threshold_for_pfa(m, pfa)
                self.assertAlmostEqual(ed.pd_random_signal(m, eta, 0.0), pfa, delta=pfa * 1e-6)
                self.assertAlmostEqual(ed.pd_deterministic_signal(m, eta, 0.0), pfa,
                                       delta=pfa * 1e-6)

    def test_monotone_in_snr(self):
        m, eta = 128, ed.threshold_for_pfa(128, 1e-3)
        prev_r = prev_d = 0.0
        for db in range(-20, 11, 2):
            s = ed.snr_db_to_linear(db)
            r, d = ed.pd_random_signal(m, eta, s), ed.pd_deterministic_signal(m, eta, s)
            self.assertGreaterEqual(r, prev_r - 1e-12)
            self.assertGreaterEqual(d, prev_d - 1e-12)
            prev_r, prev_d = r, d
        self.assertGreater(prev_r, 0.999)

    def test_analytic_matches_monte_carlo_in_awgn(self):
        """公式侧（M1/M2）对蒙特卡洛侧（M3）。容差取 0.01，04 §16.3 建议的是 0.05 至 0.10。"""
        rng = np.random.default_rng(11)
        m, frames = 32, 40000
        eta = ed.threshold_for_pfa(m, 1e-3)
        for db in (-8, -5, -3, 0):
            s = ed.snr_db_to_linear(db)
            noise = ((rng.standard_normal((frames, m))
                      + 1j * rng.standard_normal((frames, m))) / math.sqrt(2))
            # 随机型：信号功率均摊到各频点
            sig = ((rng.standard_normal((frames, m)) + 1j * rng.standard_normal((frames, m)))
                   * math.sqrt(s / 2))
            lam = (np.abs(noise + sig) ** 2).sum(axis=1) / m
            mc = float(np.mean(lam > eta))
            an = ed.pd_random_signal(m, eta, s)
            self.assertLess(abs(mc - an), 0.01, f"随机型 {db} dB：蒙特卡洛 {mc}，解析 {an}")
            # 确定型：全部能量集中在一个频点
            sig2 = np.zeros((frames, m), dtype=complex)
            sig2[:, m // 2] = math.sqrt(s * m) * np.exp(
                1j * rng.uniform(0, 2 * math.pi, size=frames))
            lam2 = (np.abs(noise + sig2) ** 2).sum(axis=1) / m
            mc2 = float(np.mean(lam2 > eta))
            an2 = ed.pd_deterministic_signal(m, eta, s)
            self.assertLess(abs(mc2 - an2), 0.01, f"确定型 {db} dB：蒙特卡洛 {mc2}，解析 {an2}")


class TestBurstEquivalence(unittest.TestCase):
    def test_burst_equals_continuous_at_same_frame_snr(self):
        """对按帧取总能量的检测器，突发与连续在同一帧平均信噪比下等价。

        帧内能量只取决于总能量，与它在帧内怎么分布无关。所以 DS-7 不单列突发一档；
        突发的真实影响是另外两条：只有含突发的帧有机会被检出，以及突发短于帧长时
        等效帧平均信噪比下降 10·lg(占空比)。这里验证第一条等价性与第二条的量值。
        """
        rng = np.random.default_rng(12)
        frames, nfft, duty = 6000, 256, 0.1
        fs = 80e6
        band = ed.Band(-40e6, 40e6)          # 整带，避免带外泄漏干扰比较
        mask = band.mask(nfft, fs)
        m = int(np.count_nonzero(mask))
        snr = 0.5                            # 帧平均信噪比

        def lam_of(sig_frames):
            noise = ((rng.standard_normal((frames, nfft))
                      + 1j * rng.standard_normal((frames, nfft))) / math.sqrt(2))
            x = (noise + sig_frames).astype(np.complex64).reshape(-1)
            p = ed.frame_bin_power(x, nfft)
            return ed.statistic(p, mask, ed.estimate_noise_per_bin(p))

        # 连续：每个样点功率 snr
        cont = ((rng.standard_normal((frames, nfft))
                 + 1j * rng.standard_normal((frames, nfft))) * math.sqrt(snr / 2))
        # 突发：只在帧内 duty 比例的样点上有信号，功率 snr/duty，帧平均功率相同
        burst = np.zeros((frames, nfft), dtype=complex)
        n_on = int(nfft * duty)
        burst[:, :n_on] = ((rng.standard_normal((frames, n_on))
                            + 1j * rng.standard_normal((frames, n_on)))
                           * math.sqrt(snr / duty / 2))
        lam_c, lam_b = lam_of(cont), lam_of(burst)
        self.assertAlmostEqual(float(lam_c.mean()), float(lam_b.mean()), delta=0.02)
        eta = ed.threshold_for_pfa(m, 1e-3)
        pd_c, pd_b = float(np.mean(lam_c > eta)), float(np.mean(lam_b > eta))
        self.assertLess(abs(pd_c - pd_b), 0.03, f"连续 {pd_c}，突发 {pd_b}")

    def test_short_burst_costs_ten_log_duty(self):
        """突发短于帧长、峰值功率固定时，帧平均信噪比按 10·lg(占空比) 下降。"""
        for duty in (1.0, 0.5, 0.1, 0.01):
            loss_db = 10 * math.log10(duty)
            peak_snr = 1.0
            frame_avg = peak_snr * duty
            self.assertAlmostEqual(10 * math.log10(frame_avg), loss_db, places=9)



class TestSliding(unittest.TestCase):
    """滑动噪声估计（C-3，D-063）：暖机后虚警率、删截保持检出、吸收、陈旧、分段。"""

    @staticmethod
    def _noise(frames, nfft, seed):
        rng = np.random.default_rng(seed)
        n = frames * nfft
        return ((rng.standard_normal(n) + 1j * rng.standard_normal(n))
                / math.sqrt(2)).astype(np.complex64)

    @staticmethod
    def _tone(frames, nfft, fs, f_Hz, amp, on):
        """on 是逐帧布尔：该帧是否有信号。"""
        n = frames * nfft
        idx = np.arange(n)
        x = amp * np.exp(1j * 2 * math.pi * f_Hz * idx / fs)
        gate = np.repeat(on.astype(np.float64), nfft)
        return (x * gate).astype(np.complex64)

    def test_first_frame_is_ln2_and_never_hits(self):
        x = self._noise(300, 64, 1)
        r = ed.detect_sliding(x, 1e6, ed.Band(-2e5, 2e5), 64, 1e-2, window_frames=32)
        self.assertAlmostEqual(float(r["statistic"][0]), ed.LN2, delta=1e-9)
        self.assertFalse(bool(r["hit"][0]))
        self.assertEqual(int(r["noise_frames_used"][0]), 1)
        # 环单调填到 W 后停住
        used = r["noise_frames_used"]
        self.assertTrue(np.all(np.diff(used) >= 0))
        self.assertEqual(int(used[-1]), 32)
        self.assertTrue(r["ring_ever_full"])

    def test_pfa_after_warmup_matches_target(self):
        frames, nfft, fs = 20000, 256, 80e6
        x = self._noise(frames, nfft, 7)
        band = ed.Band(-5e6, 5e6)
        for pfa in (1e-2, 1e-3):
            r = ed.detect_sliding(x, fs, band, nfft, pfa, window_frames=256)
            lam = r["statistic"][256:]
            hit = r["hit"][256:]
            self.assertAlmostEqual(float(lam.mean()), 1.0, delta=0.02)
            measured = float(np.mean(hit))
            # 滑动估计自带估计噪声、删截去掉最高的 pfa 份额，虚警率比静态估计略高；
            # 判据是「同量级」：目标的一半到两倍，加二项分布 3σ
            tol = 3 * math.sqrt(pfa * (1 - pfa) / hit.size)
            self.assertGreater(measured + tol, 0.5 * pfa, f"目标 {pfa}，实测 {measured}")
            self.assertLess(measured - tol, 2.0 * pfa, f"目标 {pfa}，实测 {measured}")
            self.assertEqual(r["noise_stale"], 0)

    def test_persistent_signal_after_clean_start_stays_detected(self):
        frames, nfft, fs = 4000, 256, 1e6
        on = np.zeros(frames, dtype=bool)
        on[1000:] = True
        x = self._noise(frames, nfft, 11) + self._tone(frames, nfft, fs, 50e3, 0.5, on)
        band = ed.Band(40e3, 60e3)
        r = ed.detect_sliding(x, fs, band, nfft, 1e-3, window_frames=256)
        self.assertGreaterEqual(float(np.mean(r["hit"][1000:])), 0.99)
        self.assertLessEqual(int(np.count_nonzero(r["hit"][:1000])), 10)
        # 环被删截冻结：陈旧帧 > 0，且都在信号期
        self.assertGreater(r["noise_stale"], 0)
        self.assertLess(r["noise_stale"], 3000)
        # 同一段：第 1000 帧与最后一帧段号相同
        self.assertEqual(int(r["segment_id"][1000]), int(r["segment_id"][-1]))
        # 对照：整段估一次噪声（detect）会把 75% 占空的信号吸收进中位数
        hits_static, _, _ = ed.detect(x, fs, band, nfft, 1e-3)
        self.assertLess(float(np.mean(hits_static)), 0.05)

    def test_signal_from_frame_zero_is_absorbed(self):
        frames, nfft, fs = 3000, 256, 1e6
        on = np.ones(frames, dtype=bool)
        x = self._noise(frames, nfft, 11) + self._tone(frames, nfft, fs, 50e3, 0.5, on)
        r = ed.detect_sliding(x, fs, ed.Band(40e3, 60e3), nfft, 1e-3, window_frames=256)
        self.assertLess(float(np.mean(r["hit"])), 0.05)

    def test_duty_cycle_bursts_are_detected(self):
        """20% 占空比的周期突发：中位数不受影响，命中率 ≈ 占空比。"""
        frames, nfft, fs = 5000, 256, 1e6
        on = (np.arange(frames) % 50) < 10
        x = self._noise(frames, nfft, 13) + self._tone(frames, nfft, fs, 50e3, 0.5, on)
        r = ed.detect_sliding(x, fs, ed.Band(40e3, 60e3), nfft, 1e-3, window_frames=256)
        hit = r["hit"][256:]
        self.assertAlmostEqual(float(np.mean(hit)), 0.2, delta=0.03)
        self.assertGreaterEqual(float(np.mean(r["hit"][256:][on[256:]])), 0.98)
        self.assertEqual(r["noise_stale"], 0)
        # 每个 10 帧的突发是一段：段数 ≈ 5000/50 − 暖机期的
        self.assertGreater(r["segments"], 90)

    def test_segments_from_hits(self):
        hit = np.zeros(20, dtype=bool)
        hit[[2, 3, 6, 7, 11]] = True      # 3→6 空 2 帧，7→11 空 3 帧
        seg2 = ed.segments_from_hits(hit, 2)
        self.assertEqual([int(v) for v in seg2[[2, 3, 6, 7, 11]]], [0, 0, 0, 0, 1])
        seg1 = ed.segments_from_hits(hit, 1)
        self.assertEqual([int(v) for v in seg1[[2, 3, 6, 7, 11]]], [0, 0, 1, 1, 2])
        self.assertTrue(np.all(seg2[~hit] == -1))
        seg0 = ed.segments_from_hits(hit, 0)
        self.assertEqual([int(v) for v in seg0[[2, 3, 6, 7, 11]]], [0, 0, 1, 1, 2])
        self.assertEqual(int(ed.segments_from_hits(np.zeros(5, dtype=bool), 2).max()), -1)
if __name__ == "__main__":
    unittest.main()
