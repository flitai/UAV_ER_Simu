// GFSK 族波形的帧排布（Q-3，决策 D-089）。契约见 cuav_geo/gfsk_frame.h。

#include "cuav_geo/gfsk_frame.h"

namespace cuav {
namespace geo {

namespace {
// 乘积先落成 double 再参与加法：不让编译器把 offset + k·period 融合成一条 FMA。融合与否差一个末位，
// 而「与 Python 复刻逐位相同」是契约——实测 Apple clang 在 arm64 上缺省就在一个表达式内融合
// （-ffp-contract=on），单拆语句又管不住 GCC 的 -ffp-contract=fast，volatile 在三家编译器上都成立。
double product(double a, double b) {
    volatile double r = a * b;
    return r;
}
}  // namespace

double gfsk_burst_t0(const GfskPreset& p, double frame_offset_s, std::int64_t frame, int packet) {
    const double base = frame_offset_s + product(static_cast<double>(frame), p.period_s);
    return base + p.packets[packet].offset_s;
}

double gfsk_burst_t1(const GfskPreset& p, double t0_s, int packet) {
    return t0_s + static_cast<double>(p.packets[packet].n_bits) / p.symbol_rate_Hz;
}

GfskSchedule::GfskSchedule() {}

void GfskSchedule::build(const GfskPreset& p, double frame_offset_s, double end_s) {
    bursts_.clear();
    for (std::int64_t k = 0;; ++k) {
        if (frame_offset_s + product(static_cast<double>(k), p.period_s) >= end_s) break;
        for (int q = 0; q < p.n_packets; ++q) {
            GfskBurst b;
            b.frame = k;
            b.packet = q;
            b.index = k * p.n_packets + q;
            b.t0_s = gfsk_burst_t0(p, frame_offset_s, k, q);
            if (b.t0_s >= end_s) break;              // 包按偏移升序：后面的更晚
            b.t1_s = gfsk_burst_t1(p, b.t0_s, q);
            b.n_bits = p.packets[q].n_bits;
            bursts_.push_back(b);
        }
    }
}

}  // namespace geo
}  // namespace cuav
