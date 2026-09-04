#include "cuav/random.h"

#include <cmath>

namespace cuav {
namespace {

inline std::uint64_t rotl(std::uint64_t x, int k) {
    return (x << k) | (x >> (64 - k));
}

// splitmix64：用一个种子铺开成四个状态字，避免全零状态。
inline std::uint64_t splitmix64(std::uint64_t& x) {
    std::uint64_t z = (x += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

}  // namespace

Xoshiro256pp::Xoshiro256pp(std::uint64_t seed) {
    std::uint64_t x = seed;
    for (int i = 0; i < 4; ++i) s_[i] = splitmix64(x);
}

std::uint64_t Xoshiro256pp::next_u64() {
    const std::uint64_t result = rotl(s_[0] + s_[3], 23) + s_[0];
    const std::uint64_t t = s_[1] << 17;
    s_[2] ^= s_[0];
    s_[3] ^= s_[1];
    s_[1] ^= s_[2];
    s_[0] ^= s_[3];
    s_[2] ^= t;
    s_[3] = rotl(s_[3], 45);
    return result;
}

double Xoshiro256pp::uniform() {
    // 取高 53 位，落在 [0,1)
    return static_cast<double>(next_u64() >> 11) * (1.0 / 9007199254740992.0);
}

double Xoshiro256pp::normal() {
    if (has_spare_) {
        has_spare_ = false;
        return spare_;
    }
    // Box-Muller。u1 取 (0,1] 避免 log(0)
    double u1 = 1.0 - uniform();
    double u2 = uniform();
    double r = std::sqrt(-2.0 * std::log(u1));
    double theta = 6.283185307179586476925286766559 * u2;
    spare_ = r * std::sin(theta);
    has_spare_ = true;
    return r * std::cos(theta);
}

void Xoshiro256pp::complex_normal(float& re, float& im) {
    // 实虚部各方差 1/2，使 E|z|^2 = 1，与 algos/reference 的口径一致
    const double k = 0.7071067811865475244;
    re = static_cast<float>(normal() * k);
    im = static_cast<float>(normal() * k);
}

}  // namespace cuav
