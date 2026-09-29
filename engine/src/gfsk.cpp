// GFSK / 2-FSK 调制核（Q-3，决策 D-089）。契约见 cuav/gfsk.h 的五条，Python 参考逐字同序。

#include "cuav/gfsk.h"

#include <algorithm>
#include <cmath>

#include "cuav/random.h"

namespace cuav {
namespace gfsk {

namespace {
const double kPi = 3.14159265358979323846;
}

void packet_bits(const geo::GfskPreset& p, int n_bits, std::uint64_t seed, std::vector<signed char>& out) {
    out.assign(static_cast<std::size_t>(n_bits < 0 ? 0 : n_bits), 0);
    int i = 0;
    for (int k = 0; k < p.preamble_bits && i < n_bits; ++k, ++i)
        out[static_cast<std::size_t>(i)] = (k % 2 == 0) ? 1 : -1;       // 1010…
    for (int k = p.sync_bits - 1; k >= 0 && i < n_bits; --k, ++i)
        out[static_cast<std::size_t>(i)] = ((p.sync_word >> k) & 1u) ? 1 : -1;
    Xoshiro256pp rng(seed);
    std::uint64_t word = 0;
    int left = 0;
    for (; i < n_bits; ++i) {
        if (left == 0) {
            word = rng.next_u64();
            left = 64;
        }
        --left;
        out[static_cast<std::size_t>(i)] = ((word >> left) & 1u) ? 1 : -1;   // 高位先用
    }
}

Modulator::Modulator()
    : gaussian_(0), R_(0.0), fdev_(0.0), sigma_(0.0), inv_s2_(0.0), c_exp_(0.0), inv_2s2_(0.0), K_(0) {}

bool Modulator::init(int gaussian, double bt, double symbol_rate_Hz, double deviation_Hz, std::string& err) {
    if (!(symbol_rate_Hz > 0.0) || !(deviation_Hz > 0.0)) {
        err = "GFSK 调制：符号率与频偏须为正";
        return false;
    }
    gaussian_ = gaussian ? 1 : 0;
    R_ = symbol_rate_Hz;
    fdev_ = deviation_Hz;
    if (gaussian_) {
        if (!(bt > 0.0)) {
            err = "GFSK 调制：高斯滤波的 BT 须为正";
            return false;
        }
        sigma_ = std::sqrt(std::log(2.0)) / (2.0 * kPi * bt);
        inv_s2_ = 1.0 / (std::sqrt(2.0) * sigma_);
        c_exp_ = sigma_ * std::sqrt(2.0 / kPi);
        inv_2s2_ = 1.0 / (2.0 * sigma_ * sigma_);
        K_ = 1 + static_cast<int>(std::ceil(8.5 * sigma_));
    } else {
        sigma_ = inv_s2_ = c_exp_ = inv_2s2_ = 0.0;
        K_ = 0;
    }
    return true;
}

bool Modulator::init(const geo::GfskPreset& p, std::string& err) {
    return init(p.gaussian, p.bt, p.symbol_rate_Hz, p.deviation_Hz, err);
}

void Modulator::prepare(const std::vector<signed char>& a, Packet& out) {
    out.a = a;
    out.prefix.assign(a.size() + 1, 0);
    for (std::size_t k = 0; k < a.size(); ++k) out.prefix[k + 1] = out.prefix[k] + a[k];
}

double Modulator::I(double x) const {
    return x * std::erf(x * inv_s2_) + c_exp_ * std::exp(-x * x * inv_2s2_);
}

double Modulator::phase_cycles(const Packet& pk, double tau_s) const {
    const std::int64_t N = static_cast<std::int64_t>(pk.a.size());
    const double s = tau_s * R_;
    const double jf = std::floor(s);
    double phi = 0.0;
    if (!gaussian_) {
        // ④ 2-FSK：矩形频率脉冲
        if (s < 0.0) {
            phi = 0.0;
        } else if (jf >= static_cast<double>(N)) {
            phi = static_cast<double>(pk.prefix[static_cast<std::size_t>(N)]);
        } else {
            const std::int64_t j = static_cast<std::int64_t>(jf);
            phi = static_cast<double>(pk.prefix[static_cast<std::size_t>(j)]) +
                  static_cast<double>(pk.a[static_cast<std::size_t>(j)]) * (s - jf);
        }
        return (fdev_ / R_) * phi;
    }
    // ③ GFSK：窗口内裂项
    const double jc = std::max(-1.0e12, std::min(1.0e12, jf));   // 远在包外的 τ 也别溢出
    const std::int64_t j = static_cast<std::int64_t>(jc);
    const std::int64_t lo = std::max<std::int64_t>(0, std::min<std::int64_t>(N, j - K_));
    const std::int64_t hi = std::max<std::int64_t>(-1, std::min<std::int64_t>(N - 1, j + K_));
    double acc = 0.0;
    if (lo <= hi) {
        acc += static_cast<double>(pk.a[static_cast<std::size_t>(lo)]) * I(s - static_cast<double>(lo));
        for (std::int64_t m = lo + 1; m <= hi; ++m) {
            const int d = pk.a[static_cast<std::size_t>(m)] - pk.a[static_cast<std::size_t>(m - 1)];
            if (d != 0) acc += static_cast<double>(d) * I(s - static_cast<double>(m));
        }
        acc -= static_cast<double>(pk.a[static_cast<std::size_t>(hi)]) * I(s - static_cast<double>(hi + 1));
    }
    phi = 0.5 * static_cast<double>(pk.prefix[static_cast<std::size_t>(lo)] +
                                    pk.prefix[static_cast<std::size_t>(hi + 1)]) + 0.5 * acc;
    return (fdev_ / R_) * phi;
}

double Modulator::inst_freq_Hz(const Packet& pk, double tau_s) const {
    const std::int64_t N = static_cast<std::int64_t>(pk.a.size());
    const double s = tau_s * R_;
    const double jf = std::floor(s);
    if (!gaussian_) {
        if (s < 0.0 || jf >= static_cast<double>(N)) return 0.0;
        return fdev_ * static_cast<double>(pk.a[static_cast<std::size_t>(static_cast<std::int64_t>(jf))]);
    }
    const double jc = std::max(-1.0e12, std::min(1.0e12, jf));
    const std::int64_t j = static_cast<std::int64_t>(jc);
    const std::int64_t lo = std::max<std::int64_t>(0, j - K_);
    const std::int64_t hi = std::min<std::int64_t>(N - 1, j + K_);
    double acc = 0.0;
    for (std::int64_t k = lo; k <= hi; ++k) {
        const double x = s - static_cast<double>(k);
        acc += static_cast<double>(pk.a[static_cast<std::size_t>(k)]) *
               0.5 * (std::erf(x * inv_s2_) - std::erf((x - 1.0) * inv_s2_));
    }
    return fdev_ * acc;
}

}  // namespace gfsk
}  // namespace cuav
