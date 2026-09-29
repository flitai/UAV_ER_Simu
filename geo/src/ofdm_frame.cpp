#include "cuav_geo/ofdm_frame.h"

#include <algorithm>

namespace cuav {
namespace geo {

std::uint64_t mix64(std::uint64_t z) {
    z += 0x9E3779B97F4A7C15ULL;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

std::uint64_t fnv1a64(const std::string& s) {
    std::uint64_t h = 0xcbf29ce484222325ULL;
    for (std::size_t i = 0; i < s.size(); ++i) {
        h ^= static_cast<std::uint64_t>(static_cast<unsigned char>(s[i]));
        h *= 0x100000001b3ULL;
    }
    return h;
}

FrameSchedule::FrameSchedule() : p_(0), key_(0) {}

int FrameSchedule::draw(std::int64_t k) const {
    const std::uint64_t z = mix64(key_ ^ mix64(static_cast<std::uint64_t>(k)));
    const double u = static_cast<double>(z >> 11) * (1.0 / 9007199254740992.0);
    const int cols = p_->n_bursts + 1;
    const double* row = p_->cycle + static_cast<std::ptrdiff_t>(k % p_->cycle_len) * cols;
    double acc = 0.0;
    int last = 0;
    for (int c = 0; c < cols; ++c) {
        if (row[c] > 0.0) last = c;
        acc += row[c];
        if (u < acc) return c - 1;
    }
    return last - 1;   // 行和因舍入略小于 1、u 恰落在缝里：取最后一个概率非零的类别
}

void FrameSchedule::build(const RadiatorPreset& p, std::uint64_t scenario_seed, const std::string& emitter_id,
                          std::int64_t offset_n, std::int64_t end_n) {
    p_ = &p;
    key_ = mix64(scenario_seed ^ mix64(fnv1a64(emitter_id)));
    bursts_.clear();
    std::int64_t free_from = offset_n;             // 上一个突发结束 + 最小间隔
    for (std::int64_t k = 0;; ++k) {
        const std::int64_t s = offset_n + k * p.slot_n;
        if (s >= end_n) break;
        if (s < free_from) continue;               // 被上一个突发封住
        const int v = draw(k);
        if (v < 0) continue;
        FrameBurst b;
        b.slot = k;
        b.start_n = s;
        b.length_n = p.bursts[v].length_n;
        b.variant = v;
        bursts_.push_back(b);
        free_from = s + b.length_n + kBurstMinGapNative;
    }
}

void FrameSchedule::bursts_in(std::int64_t n_lo, std::int64_t n_hi, std::vector<FrameBurst>& out) const {
    // 突发按起点升序且互不重叠，于是「结束 > n_lo」的第一个就是起点：二分找它
    std::size_t lo = 0, hi = bursts_.size();
    while (lo < hi) {
        const std::size_t mid = (lo + hi) / 2;
        if (bursts_[mid].start_n + bursts_[mid].length_n <= n_lo) lo = mid + 1;
        else hi = mid;
    }
    for (std::size_t i = lo; i < bursts_.size() && bursts_[i].start_n < n_hi; ++i) out.push_back(bursts_[i]);
}

}  // namespace geo
}  // namespace cuav
