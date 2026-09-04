// 数字信号处理与随机源的单元测试（04 §15.1 第一级：解析与理论）。
#include "doctest/doctest.h"

#include <cmath>
#include <vector>

#include "cuav/dsp.h"
#include "cuav/random.h"

using namespace cuav;

TEST_CASE("FFT：冲激的谱是平的") {
    std::vector<Complex> x(64, Complex(0.0f, 0.0f));
    x[0] = Complex(1.0f, 0.0f);
    dsp::fft_inplace(x);
    for (std::size_t k = 0; k < x.size(); ++k) {
        CHECK(std::abs(x[k] - Complex(1.0f, 0.0f)) < 1e-5f);
    }
}

TEST_CASE("FFT：单音只落在一个频点上") {
    const std::size_t n = 256;
    const std::size_t bin = 7;
    std::vector<Complex> x(n);
    for (std::size_t i = 0; i < n; ++i) {
        const double ph = 2.0 * 3.14159265358979323846 * static_cast<double>(bin * i) / n;
        x[i] = Complex(static_cast<float>(std::cos(ph)), static_cast<float>(std::sin(ph)));
    }
    dsp::fft_inplace(x);
    double peak = 0.0;
    std::size_t peak_k = 0;
    double others = 0.0;
    for (std::size_t k = 0; k < n; ++k) {
        const double m = std::abs(x[k]);
        if (m > peak) { peak = m; peak_k = k; }
    }
    for (std::size_t k = 0; k < n; ++k) if (k != peak_k) others += std::abs(x[k]);
    CHECK(peak_k == bin);
    CHECK(peak == doctest::Approx(static_cast<double>(n)).epsilon(1e-4));
    CHECK(others < 1e-2 * peak);
}

TEST_CASE("fftshift 把零频移到中间") {
    std::vector<Complex> x(8);
    for (std::size_t i = 0; i < 8; ++i) x[i] = Complex(static_cast<float>(i), 0.0f);
    dsp::fftshift(x);
    // numpy.fft.fftshift([0..7]) == [4,5,6,7,0,1,2,3]
    CHECK(x[0].real() == doctest::Approx(4.0f));
    CHECK(x[4].real() == doctest::Approx(0.0f));
}

TEST_CASE("不完全伽马函数对整数阶的精确闭式") {
    // Q(1,x)=e^-x, Q(2,x)=(1+x)e^-x, Q(3,x)=(1+x+x^2/2)e^-x
    for (double x : {0.1, 1.0, 5.0, 20.0}) {
        CHECK(dsp::regularized_gamma_q(1, x) == doctest::Approx(std::exp(-x)).epsilon(1e-10));
        CHECK(dsp::regularized_gamma_q(2, x) ==
              doctest::Approx((1 + x) * std::exp(-x)).epsilon(1e-10));
        CHECK(dsp::regularized_gamma_q(3, x) ==
              doctest::Approx((1 + x + x * x / 2) * std::exp(-x)).epsilon(1e-10));
    }
}

TEST_CASE("门限公式与虚警率互为反函数") {
    for (int m : {1, 8, 128}) {
        for (double pfa : {1e-2, 1e-3, 1e-5}) {
            const double eta = dsp::threshold_for_pfa(m, pfa);
            CHECK(dsp::regularized_gamma_q(m, m * eta) == doctest::Approx(pfa).epsilon(1e-6));
        }
    }
    // M=1 时门限有闭式 -ln(pfa)
    CHECK(dsp::threshold_for_pfa(1, 1e-3) == doctest::Approx(-std::log(1e-3)).epsilon(1e-9));
}

TEST_CASE("随机源：同种子逐位复现，不同种子不同") {
    Xoshiro256pp a(12345), b(12345), c(12346);
    for (int i = 0; i < 100; ++i) {
        const std::uint64_t x = a.next_u64();
        CHECK(x == b.next_u64());
        if (i == 0) CHECK(x != c.next_u64());
    }
}

TEST_CASE("随机源：复正态的功率为 1，实虚部不相关") {
    Xoshiro256pp r(7);
    const int n = 200000;
    double p = 0.0, sre = 0.0, sim = 0.0, cross = 0.0;
    for (int i = 0; i < n; ++i) {
        float re, im;
        r.complex_normal(re, im);
        p += static_cast<double>(re) * re + static_cast<double>(im) * im;
        sre += re; sim += im; cross += static_cast<double>(re) * im;
    }
    CHECK(p / n == doctest::Approx(1.0).epsilon(0.02));
    CHECK(std::fabs(sre / n) < 0.01);
    CHECK(std::fabs(sim / n) < 0.01);
    CHECK(std::fabs(cross / n) < 0.01);
}
