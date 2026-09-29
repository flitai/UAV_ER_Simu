// GFSK 族机型预设表 v1（Q-3；14 号报告 §3；决策 D-089）。
//
// 真理源是 models/radiator/gfsk-presets-v1.json：每一项参数带 V / P / S / A / D / M 出处档与引文，
// S 档的数都能由开源实现里的 CC2500 寄存器按数据手册公式复算（生成脚本逐位核对）。本头文件只声明
// 生成与评价**要用到**的那几项。实现 geo/src/gfsk_presets.cpp 由 scripts/gen_gfsk_presets.py 生成，
// 不要手改；两者是否同步由 engine/tests/test_gfsk.cpp 逐项核对并比对表文件的 sha256（铁律 10）。
//
// 与 OFDM 族那张表（radiator_presets.h）分开：那张表的 sha256 钉在 OFDM 的两份黄金基准里，
// 它的结构也套不上 GFSK。跳频频点表不进 C++：频点写在场景的 hop 活动里（同 D-088 的上行）。
//
// 运行时不读 JSON；要改预设就出 v2，v1 原样留着守既有基准。

#ifndef CUAV_GEO_GFSK_PRESETS_H
#define CUAV_GEO_GFSK_PRESETS_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace cuav {
namespace geo {

// 一帧里的一个包：起点相对帧起点的偏移与比特数（含前导与同步）。
struct GfskPacket {
    double offset_s;
    int n_bits;
};

struct GfskPreset {
    const char* id;              // 如 "frsky-d16v2-fcc"
    const char* type;            // 场景 waveform.type："gfsk"
    const char* role;            // 真值标签：rc_hopping
    const char* credibility;     // V1 / V2

    int gaussian;                // 1 = GFSK（高斯频率脉冲），0 = 2-FSK（矩形）
    double bt;                   // 高斯滤波的带宽时间积（仅 gaussian）
    double symbol_rate_Hz;       // R
    double deviation_Hz;         // f_dev：比特 '1' → +f_dev，'0' → −f_dev（CC2500 表 23）
    double occupied_bw_Hz;       // Carson 带宽 2·(f_dev + R/2)；场景 emission.bw_Hz 必须等于它

    int preamble_bits;           // 前导 1010…（起于 1）
    std::uint32_t sync_word;     // 同步字，高位先发
    int sync_bits;               // 32（16 位同步字重复一次）或 16

    double period_s;             // 帧周期
    int n_packets;
    const GfskPacket* packets;   // 按偏移升序，互不重叠

    double hop_dwell_s;          // 跳频停留（= 帧周期）；场景 hop 活动的 dwell_s 取它
};

// 按 id 查；查不到返回 0，由调用方报错并列出可取值（铁律 15，不取最近一项）。
const GfskPreset* gfsk_preset_v1(const std::string& id);
std::size_t gfsk_preset_v1_count();
const GfskPreset& gfsk_preset_v1_at(std::size_t i);

// 生成时读到的表文件 sha256，供单测比对「改了 JSON 忘了重生成」。
const char* gfsk_presets_v1_sha256();

}  // namespace geo
}  // namespace cuav

#endif
