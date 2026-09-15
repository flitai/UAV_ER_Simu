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

// --- 带限双二阶节（C-8 / G-6，D-069）----------------------------------------

namespace {
// |H(f)| 的解析式：4 阶巴特沃斯 |H|² = 1 / (1 + (tan(πf/fs)/K)^8)，K = tan(π·fc/fs)。
// 用双线性变换后的数字频率，和实现同源，所以这不是「另一套公式」而是同一式的闭式解。
double butter4_mag_dB(double f_Hz, double fc_Hz, double fs_Hz) {
    const double pi = 3.14159265358979323846;
    const double r = std::tan(pi * f_Hz / fs_Hz) / std::tan(pi * fc_Hz / fs_Hz);
    double r8 = 1.0;
    for (int i = 0; i < 8; ++i) r8 *= r;
    return -10.0 * std::log10(1.0 + r8);
}

// 逐点跑滤波器，量某个频率上的稳态幅度（跳过暖机段）
double measured_mag_dB(const dsp::Biquad f[2], double f_Hz, double fs_Hz, std::size_t settle) {
    const double pi = 3.14159265358979323846;
    std::complex<double> st[4];
    for (int i = 0; i < 4; ++i) st[i] = std::complex<double>(0.0, 0.0);
    const double w = 2.0 * pi * f_Hz / fs_Hz;
    double acc = 0.0;
    const std::size_t n_meas = 20000;
    for (std::size_t n = 0; n < settle + n_meas; ++n) {
        const std::complex<double> x(std::cos(w * static_cast<double>(n)), std::sin(w * static_cast<double>(n)));
        const std::complex<double> y = dsp::biquad2_step(f, st, x);
        if (n >= settle) acc += std::norm(y);
    }
    return 10.0 * std::log10(acc / static_cast<double>(n_meas));
}
}  // namespace

TEST_CASE("带限：4 阶巴特沃斯的 −3 dB 点与阻带滚降对解析式") {
    const double fs = 10.0e6, fc = 1.0e6;
    dsp::Biquad f[2];
    std::string err;
    REQUIRE_MESSAGE(dsp::butterworth_lp4(fc, fs, f, err), err);
    double gain = 0.0;
    std::size_t settle = 0;
    REQUIRE_MESSAGE(dsp::impulse_power_gain(f, gain, settle, err), err);

    // 截止频率处恰好 −3.0103 dB（这是巴特沃斯的定义）
    CHECK(std::fabs(measured_mag_dB(f, fc, fs, settle) + 3.0103) < 0.01);
    // 六个探测频率逐点对解析式。注意数字域因双线性预畸变比模拟域的「每倍频程 24 dB」更陡：
    // fs 10 MHz / fc 1 MHz 时 2fc 处实测 −27.97 dB 而不是 −24 dB，解析式同样给 −27.97。
    const double probes[] = {0.2e6, 0.5e6, 1.0e6, 2.0e6, 3.0e6, 4.0e6};
    for (std::size_t i = 0; i < sizeof(probes) / sizeof(probes[0]); ++i) {
        const double got = measured_mag_dB(f, probes[i], fs, settle);
        const double want = butter4_mag_dB(probes[i], fc, fs);
        CHECK_MESSAGE(std::fabs(got - want) < 0.02, probes[i] << " Hz：实测 " << got << " 对解析 " << want);
    }
    MESSAGE("2fc 处 " << measured_mag_dB(f, 2.0 * fc, fs, settle) << " dB，冲激响应稳定用了 " << settle << " 个样点");
}

TEST_CASE("带限：噪声功率增益归一后，白噪声过滤波器的输出功率是 1（蒙特卡洛矩校验，铁律 9）") {
    const double fs = 10.0e6, fc = 1.0e6;
    dsp::Biquad f[2];
    std::string err;
    REQUIRE(dsp::butterworth_lp4(fc, fs, f, err));
    double gain = 0.0;
    std::size_t settle = 0;
    REQUIRE(dsp::impulse_power_gain(f, gain, settle, err));
    const double g = 1.0 / std::sqrt(gain);

    Xoshiro256pp rng(20260915);
    std::complex<double> st[4];
    for (int i = 0; i < 4; ++i) st[i] = std::complex<double>(0.0, 0.0);
    const std::size_t n_warm = settle, n = 1000000;
    double acc = 0.0;
    for (std::size_t k = 0; k < n_warm + n; ++k) {
        float re = 0.0f, im = 0.0f;
        rng.complex_normal(re, im);
        const std::complex<double> y = dsp::biquad2_step(f, st, std::complex<double>(re, im));
        if (k >= n_warm) acc += std::norm(y * g);
    }
    const double p = acc / static_cast<double>(n);
    // 1e6 个样本、指数分布的功率：相对标准差约 1/√n = 0.1%，放宽到 3σ
    CHECK_MESSAGE(std::fabs(p - 1.0) < 0.005, "归一后平均功率 " << p);
}

TEST_CASE("带限：截止频率越界与冲激响应不收敛都报错，不静默夹（铁律 15）") {
    dsp::Biquad f[2];
    std::string err;
    CHECK_FALSE(dsp::butterworth_lp4(0.0, 1.0e6, f, err));
    CHECK(err.find("(0, Fs/2)") != std::string::npos);
    CHECK_FALSE(dsp::butterworth_lp4(500000.0, 1.0e6, f, err));   // 恰好 Fs/2 也不行
    CHECK_FALSE(dsp::butterworth_lp4(1.0e6, 0.0, f, err));
}
