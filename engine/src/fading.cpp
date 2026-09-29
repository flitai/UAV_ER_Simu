#include "cuav/fading.h"

#include <algorithm>
#include <cmath>

namespace cuav {
namespace fading {
namespace {
const double kTwoPi = 6.283185307179586476925286766559;
}

void draw(IRandom& rng, Draws& out) {
    for (int l = 0; l < kTaps; ++l) {
        out.theta[l] = rng.uniform();
        for (int n = 0; n < kSinusoids; ++n) out.phi[l][n] = kTwoPi * rng.uniform();
        for (int n = 0; n < kSinusoids; ++n)
            out.cos_alpha[l][n] = std::cos(kTwoPi * (static_cast<double>(n) + out.theta[l]) / kSinusoids);
    }
    out.los_phase = kTwoPi * rng.uniform();
}

std::complex<double> diffuse(const Draws& d, int l, double Phi) {
    double re = 0.0, im = 0.0;
    for (int n = 0; n < kSinusoids; ++n) {
        const double a = Phi * d.cos_alpha[l][n] + d.phi[l][n];
        re += std::cos(a);
        im += std::sin(a);
    }
    const double s = 1.0 / std::sqrt(static_cast<double>(kSinusoids));
    return std::complex<double>(re * s, im * s);
}

double tap_power(int l) {
    double sum = 0.0;
    for (int k = 0; k < kTaps; ++k) sum += std::exp(-0.5 * k);
    return std::exp(-0.5 * l) / sum;
}

double rms_ratio() {
    double m = 0.0, m2 = 0.0;
    for (int l = 0; l < kTaps; ++l) {
        const double t = 0.5 * l, p = tap_power(l);
        m += p * t;
        m2 += p * t * t;
    }
    return std::sqrt(m2 - m * m);
}

bool layout(double delay_spread_s, double fs_Hz, Layout& out, std::string& err) {
    out = Layout();
    if (!(fs_Hz > 0.0)) { err = "衰落抽头布局需要正的采样率"; return false; }
    if (!(delay_spread_s >= 0.0)) { err = "均方根时延扩展不得为负"; return false; }
    const double tau0 = delay_spread_s / rms_ratio();
    for (int l = 0; l < kTaps; ++l) {
        const std::uint64_t dl = static_cast<std::uint64_t>(std::floor(0.5 * l * tau0 * fs_Hz + 0.5));
        std::size_t k = 0;
        while (k < out.delay.size() && out.delay[k] != dl) ++k;
        if (k == out.delay.size()) {
            out.delay.push_back(dl);
            out.members.push_back(std::vector<int>());
            out.power.push_back(0.0);
        }
        out.members[k].push_back(l);
        out.power[k] += tap_power(l);
    }
    // τ_l 单调，delay 已是升序
    double m = 0.0, m2 = 0.0;
    for (std::size_t k = 0; k < out.delay.size(); ++k) {
        const double t = static_cast<double>(out.delay[k]) / fs_Hz;
        m += out.power[k] * t;
        m2 += out.power[k] * t * t;
    }
    out.rms_delay_spread_s = std::sqrt(std::max(0.0, m2 - m * m));
    return true;
}

void diffuse_at(const Draws& d, const Layout& lay, double Phi, std::vector<std::complex<double> >& out) {
    out.assign(lay.delay.size(), std::complex<double>(0.0, 0.0));
    for (std::size_t k = 0; k < lay.delay.size(); ++k) {
        for (std::size_t j = 0; j < lay.members[k].size(); ++j) {
            const int l = lay.members[k][j];
            out[k] += std::sqrt(tap_power(l)) * diffuse(d, l, Phi);
        }
    }
}

}  // namespace fading
}  // namespace cuav
