#include "cuav/ofdm.h"

#include <cmath>

namespace cuav {
namespace ofdm {

std::complex<double> zc_value(int root, int n_zc, int n) {
    // ③：u·n(n+1) 先对 2N 取模。N ≤ 4095、u < N，乘积 < 2^45，int64 装得下。
    const std::int64_t two_n = 2 * static_cast<std::int64_t>(n_zc);
    const std::int64_t nn = static_cast<std::int64_t>(n);
    const std::int64_t m = (static_cast<std::int64_t>(root) * ((nn * (nn + 1)) % two_n)) % two_n;
    const double ang = -3.14159265358979323846 * static_cast<double>(m) / static_cast<double>(n_zc);
    return std::complex<double>(std::cos(ang), std::sin(ang));
}

Modulator::Modulator() : p_(0), gain_(0.0) {}

bool Modulator::init(const geo::RadiatorPreset& p, std::string& err) {
    if (p.bits_per_axis < 1 || p.bits_per_axis > 3) {
        err = std::string("预设 ") + p.id + " 的星座位数不在 1…3";
        return false;
    }
    if (p.half_subcarriers < 1 || 2 * p.half_subcarriers + 1 >= p.fft_size) {
        err = std::string("预设 ") + p.id + " 的子载波数与 FFT 点数不相容";
        return false;
    }
    try {
        plan_ = dsp::FftPlan(static_cast<std::size_t>(p.fft_size));
    } catch (const std::exception& e) {
        err = std::string("预设 ") + p.id + "：" + e.what();
        return false;
    }
    p_ = &p;
    gain_ = 1.0 / std::sqrt(static_cast<double>(2 * p.half_subcarriers));
    const int L = 1 << p.bits_per_axis;
    const double norm = std::sqrt(2.0 * (static_cast<double>(L) * L - 1.0) / 3.0);
    levels_.assign(static_cast<std::size_t>(L), 0.0);
    for (int i = 0; i < L; ++i) levels_[static_cast<std::size_t>(i)] = (2.0 * i - (L - 1)) / norm;

    zc_roots_.clear();
    zc_cache_.clear();
    const int nzc = 2 * p.half_subcarriers + 1;
    for (int b = 0; b < p.n_bursts; ++b) {
        for (int s = 0; s < p.bursts[b].n_symbols; ++s) {
            const int u = p.bursts[b].zc_root[s];
            if (u == 0) continue;
            bool have = false;
            for (std::size_t r = 0; r < zc_roots_.size(); ++r) have = have || zc_roots_[r] == u;
            if (have) continue;
            std::vector<std::complex<double>> z;
            z.reserve(static_cast<std::size_t>(nzc - 1));
            for (int n = 0; n < nzc; ++n) {
                if (n == p.half_subcarriers) continue;      // 删去中间一项（直流）
                z.push_back(zc_value(u, nzc, n));
            }
            zc_roots_.push_back(u);
            zc_cache_.push_back(z);
        }
    }
    return true;
}

int Modulator::carrier_index(int i) const {
    const int K = p_->half_subcarriers;
    return i < K ? i - K : i - K + 1;
}

const std::vector<std::complex<double>>& Modulator::zc_carriers(int root) const {
    for (std::size_t r = 0; r < zc_roots_.size(); ++r)
        if (zc_roots_[r] == root) return zc_cache_[r];
    return zc_cache_.front();   // init() 已把全部根收齐，走不到这里
}

void Modulator::symbol_carriers(int variant, int symbol, Xoshiro256pp& rng,
                                std::vector<std::complex<double>>& carriers) const {
    const int n = n_carriers();
    carriers.resize(static_cast<std::size_t>(n));
    const int root = p_->bursts[variant].zc_root[symbol];
    if (root != 0) {
        carriers = zc_carriers(root);
        return;
    }
    const int b = p_->bits_per_axis;
    const std::uint64_t mask = (static_cast<std::uint64_t>(1) << b) - 1;
    for (int i = 0; i < n; ++i) {
        const std::uint64_t u = rng.next_u64();
        const double re = levels_[static_cast<std::size_t>(u & mask)];
        const double im = levels_[static_cast<std::size_t>((u >> b) & mask)];
        carriers[static_cast<std::size_t>(i)] = std::complex<double>(re, im);
    }
}

void Modulator::burst(int variant, std::uint64_t seed, std::vector<std::complex<double>>& out) const {
    const geo::RadiatorBurst& bd = p_->bursts[variant];
    const std::size_t N = static_cast<std::size_t>(p_->fft_size);
    out.clear();
    out.reserve(static_cast<std::size_t>(bd.length_n));
    Xoshiro256pp rng(seed);
    std::vector<std::complex<double>> carriers;
    std::vector<std::complex<double>> bins(N);
    for (int s = 0; s < bd.n_symbols; ++s) {
        symbol_carriers(variant, s, rng, carriers);
        // ④：x[n] = g·Σ X_k·e^{+j2πkn/N} = g·conj(FFT(conj X))[n]
        for (std::size_t i = 0; i < N; ++i) bins[i] = std::complex<double>(0.0, 0.0);
        for (int i = 0; i < n_carriers(); ++i) {
            const int k = carrier_index(i);
            const std::size_t idx = k < 0 ? N - static_cast<std::size_t>(-k) : static_cast<std::size_t>(k);
            bins[idx] = std::conj(carriers[static_cast<std::size_t>(i)]);
        }
        plan_.forward(bins);
        for (std::size_t i = 0; i < N; ++i) bins[i] = std::conj(bins[i]) * gain_;
        const std::size_t cp = static_cast<std::size_t>(bd.cp[s]);
        for (std::size_t i = N - cp; i < N; ++i) out.push_back(bins[i]);
        for (std::size_t i = 0; i < N; ++i) out.push_back(bins[i]);
    }
}

}  // namespace ofdm
}  // namespace cuav
