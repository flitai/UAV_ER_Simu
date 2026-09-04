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


if __name__ == "__main__":
    unittest.main()
