#include "cuav/dsp.h"

#include <cmath>
#include <stdexcept>

namespace cuav {
namespace dsp {

void fft_inplace(std::vector<Complex>& x) {
    const std::size_t n = x.size();
    if (n == 0) return;
    if ((n & (n - 1)) != 0) throw std::invalid_argument("FFT 长度必须是 2 的幂");
    // 位反转置换
    for (std::size_t i = 1, j = 0; i < n; ++i) {
        std::size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(x[i], x[j]);
    }
    for (std::size_t len = 2; len <= n; len <<= 1) {
        const double ang = -2.0 * 3.14159265358979323846 / static_cast<double>(len);
        const Complex wl(static_cast<float>(std::cos(ang)), static_cast<float>(std::sin(ang)));
        for (std::size_t i = 0; i < n; i += len) {
            Complex w(1.0f, 0.0f);
            for (std::size_t k = 0; k < len / 2; ++k) {
                Complex u = x[i + k];
                Complex v = x[i + k + len / 2] * w;
                x[i + k] = u + v;
                x[i + k + len / 2] = u - v;
                w *= wl;
            }
        }
    }
}

void fftshift(std::vector<Complex>& x) {
    const std::size_t n = x.size();
    if (n < 2) return;
    std::rotate(x.begin(), x.begin() + static_cast<long>((n + 1) / 2), x.end());
}

void fft_inplace(std::vector<std::complex<double>>& x) {
    const std::size_t n = x.size();
    if (n == 0) return;
    if ((n & (n - 1)) != 0) throw std::invalid_argument("FFT 长度必须是 2 的幂");
    for (std::size_t i = 1, j = 0; i < n; ++i) {
        std::size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(x[i], x[j]);
    }
    const double kTwoPi = 6.28318530717958647692;
    for (std::size_t len = 2; len <= n; len <<= 1) {
        const std::size_t half = len / 2;
        // 旋转因子逐点直接求值：递推乘法在 double 里也会积累 1e-13 量级的误差
        std::vector<std::complex<double>> tw(half);
        for (std::size_t k = 0; k < half; ++k) {
            const double ang = -kTwoPi * static_cast<double>(k) / static_cast<double>(len);
            tw[k] = std::complex<double>(std::cos(ang), std::sin(ang));
        }
        for (std::size_t i = 0; i < n; i += len) {
            for (std::size_t k = 0; k < half; ++k) {
                const std::complex<double> u = x[i + k];
                const std::complex<double> v = x[i + k + half] * tw[k];
                x[i + k] = u + v;
                x[i + k + half] = u - v;
            }
        }
    }
}

void fftshift(std::vector<std::complex<double>>& x) {
    const std::size_t n = x.size();
    if (n < 2) return;
    std::rotate(x.begin(), x.begin() + static_cast<long>((n + 1) / 2), x.end());
}

void fftshift(std::vector<double>& x) {
    const std::size_t n = x.size();
    if (n < 2) return;
    std::rotate(x.begin(), x.begin() + static_cast<long>((n + 1) / 2), x.end());
}

double regularized_gamma_q(double a, double x) {
    if (x < 0 || a <= 0) throw std::invalid_argument("参数越界");
    if (x == 0) return 1.0;
    if (x < a + 1.0) {
        double ap = a;
        double total = 1.0 / a;
        double term = total;
        for (int i = 0; i < 10000; ++i) {
            ap += 1.0;
            term *= x / ap;
            total += term;
            if (std::fabs(term) < std::fabs(total) * 1e-16) break;
        }
        return 1.0 - total * std::exp(-x + a * std::log(x) - std::lgamma(a));
    }
    const double tiny = 1e-300;
    double b = x + 1.0 - a;
    double c = 1.0 / tiny;
    double d = 1.0 / b;
    double h = d;
    for (int i = 1; i < 10000; ++i) {
        const double an = -static_cast<double>(i) * (static_cast<double>(i) - a);
        b += 2.0;
        d = an * d + b;
        if (std::fabs(d) < tiny) d = tiny;
        c = b + an / c;
        if (std::fabs(c) < tiny) c = tiny;
        d = 1.0 / d;
        const double delta = d * c;
        h *= delta;
        if (std::fabs(delta - 1.0) < 1e-16) break;
    }
    return std::exp(-x + a * std::log(x) - std::lgamma(a)) * h;
}

double threshold_for_pfa(int m_bins, double pfa) {
    if (!(pfa > 0.0 && pfa < 1.0)) throw std::invalid_argument("目标虚警率必须在 (0,1)");
    double lo = 1e-6, hi = 1.0;
    const double m = static_cast<double>(m_bins);
    while (regularized_gamma_q(m, m * hi) > pfa) {
        hi *= 2.0;
        if (hi > 1e6) throw std::runtime_error("门限求解发散");
    }
    for (int i = 0; i < 200; ++i) {
        const double mid = 0.5 * (lo + hi);
        if (regularized_gamma_q(m, m * mid) > pfa) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

}  // namespace dsp
}  // namespace cuav
