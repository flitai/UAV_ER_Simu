// GFSK 族波形的帧排布：每个帧周期里哪几个包、各自的起止时刻（Q-3，14 号报告 §3，决策 D-089）。
//
// 与 OFDM 族的 FrameSchedule（ofdm_frame.h）不同：遥控链路的包是**确定**的——FrSky 每 7 ms 一包、
// S-FHSS 每 6.8 ms 同一频点两包（MPM 的发送状态机），不抽签、不丢包，也就不需要场景 seed。
// 也没有「原生采样率」：时刻以秒为单位，按
//     t0 = frame_offset_s + k·period_s + packets[q].offset_s     （先加前两项再加第三项）
//     t1 = t0 + n_bits / R
// 求值，且 k·period_s 先舍入成 double 再相加（**不许融合成 FMA**：实测 Apple clang 缺省就会融合，
// 差一个末位，整张包表的指纹当场对不上 Python）。这个次序是契约：评价器与 Python 复刻
// （algos/reference/gfsk_ref.py 的 frame_bursts()）逐字同式，于是真值行的起止时刻与源发射的逐位相同。
// 站点样点边界由调用方一律经 geo::sample_at 取整。
//
// 突发的全局序号 index = k·n_packets + q，是载荷种子与评价记录的键。
//
// **硬不变量**：build() 之后全部查询是 const 纯函数（同 ActivitySchedule、FrameSchedule）。

#ifndef CUAV_GEO_GFSK_FRAME_H
#define CUAV_GEO_GFSK_FRAME_H

#include <cstdint>
#include <vector>

#include "cuav_geo/gfsk_presets.h"

namespace cuav {
namespace geo {

struct GfskBurst {
    std::int64_t frame;          // 帧序号 k（≥ 0）
    int packet;                  // 帧内第 q 个包
    std::int64_t index;          // 全局序号 k·n_packets + q
    double t0_s;                 // 起点（秒）
    double t1_s;                 // 终点（秒）= t0 + n_bits / R
    int n_bits;
};

class GfskSchedule {
public:
    GfskSchedule();

    // 铺出起点 < end_s 的全部包。frame_offset_s ≥ 0。
    void build(const GfskPreset& p, double frame_offset_s, double end_s);

    const std::vector<GfskBurst>& bursts() const { return bursts_; }

private:
    std::vector<GfskBurst> bursts_;
};

// 一个包的起点与终点（按上面的契约求值）；源、评价器与复刻共用这一处写法。
double gfsk_burst_t0(const GfskPreset& p, double frame_offset_s, std::int64_t frame, int packet);
double gfsk_burst_t1(const GfskPreset& p, double t0_s, int packet);

}  // namespace geo
}  // namespace cuav

#endif
