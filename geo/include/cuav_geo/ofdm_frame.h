// OFDM 族波形的帧排布：哪个时隙发哪种突发（Q-2，14 号报告 §2.2–§2.5，决策 D-088 ⑤）。
//
// 一切落在**整数原生样点**上：时隙长 slot_n（生成脚本断言 2 / 4 / 640 ms 在三种原生率下都是
// 整数），突发起点 = offset_n + k·slot_n，长度 = 预设里该种突发的 length_n。原生样点换成秒是
// 精确的有理数 n / fs_n，与站点采样率无关——于是 DDC 前后、不同站点采样率下，同一个突发的
// 起止时刻逐位相同，评价器按突发记真值时不存在「按哪个采样率取整」的问题。
//
// 每个时隙的抽签用计数器哈希，不耗任何随机流：
//     key  = mix64(scenario_seed ^ mix64(fnv1a64(emitter_id)))
//     u(k) = (mix64(key ^ mix64(k)) >> 11) · 2^−53
// 按时隙循环 cycle 的第 (k mod cycle_len) 行 [P(空), P(突发 0), …] 累加定类别。源与评价器各自
// 调本类、各算一遍同一张表，评价器仍然不从随机流取数（D-067）。场景 seed 由此第一次有消费者。
//
// 封住规则：上一个实际发出的突发结束后再过 kBurstMinGapNative 个原生样点之前开始的时隙一律空
// （长突发超出时隙即封住下一时隙）。这条规则也保证两个突发的重采样输出支撑永不重叠。
//
// **硬不变量**：build() 之后全部查询是 const 纯函数（同 ActivitySchedule）。build() 按时间顺序
// 铺到给定终点，查询二分取值——源是顺序访问、评价器是乱序访问，结果逐位相同。
//
// Python 复刻：algos/reference/ofdm_ref.py 的 frame_bursts()，逐字同式（黄金基准 engine/tests/golden/ofdm_frame.json）。

#ifndef CUAV_GEO_OFDM_FRAME_H
#define CUAV_GEO_OFDM_FRAME_H

#include <cstdint>
#include <string>
#include <vector>

#include "cuav_geo/radiator_presets.h"

namespace cuav {
namespace geo {

// 有理重采样的档位（与 models/radiator/fir_rsmp_v1.json 的 interp_L / decim_M_supported 相同；
// engine/tests/test_ofdm.cpp 核对）。场景载入时就要判「这个站的采样率生成得了这个预设吗」，
// 而 geo/ 看不见引擎里的系数表，于是把这两件事实在这里声明一次。
const int kRsmpInterp = 125;
// 预设在站点采样率 fs 下对应的抽取比 M（fs = fs_n·L/M 且 fs ≥ fs_n）；不在档返回 0。
int rsmp_decim_for(const RadiatorPreset& p, double fs_Hz);
// 该预设可取的站点采样率，报错用，如 "20000000 / 40000000 / 80000000 Hz"。
std::string rsmp_allowed_fs_text(const RadiatorPreset& p);

// splitmix64 的一步（先加黄金比例常数再混合），与 engine/src/random.cpp 的种子铺开同式。
std::uint64_t mix64(std::uint64_t z);
// FNV-1a 64 位，按 UTF-8 字节。
std::uint64_t fnv1a64(const std::string& s);

struct FrameBurst {
    std::int64_t slot;           // 时隙序号 k（≥ 0）
    std::int64_t start_n;        // 原生样点起点
    std::int64_t length_n;       // 原生样点长度
    int variant;                 // 预设里的突发下标
};

class FrameSchedule {
public:
    FrameSchedule();

    // 铺出起点 < end_n 的全部突发。offset_n ≥ 0（场景 waveform.frame_offset_s 折成原生样点）。
    void build(const RadiatorPreset& p, std::uint64_t scenario_seed, const std::string& emitter_id,
               std::int64_t offset_n, std::int64_t end_n);

    const std::vector<FrameBurst>& bursts() const { return bursts_; }

    // 与原生区间 [n_lo, n_hi) 相交的突发（按起点升序）追加到 out。
    void bursts_in(std::int64_t n_lo, std::int64_t n_hi, std::vector<FrameBurst>& out) const;

    // 第 k 个时隙的抽签（不看封住规则）：−1 = 空，否则突发下标。测试与复刻对拍用。
    int draw(std::int64_t k) const;

private:
    const RadiatorPreset* p_;
    std::uint64_t key_;
    std::vector<FrameBurst> bursts_;
};

}  // namespace geo
}  // namespace cuav

#endif
