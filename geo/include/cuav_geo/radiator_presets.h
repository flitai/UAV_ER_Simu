// 机型预设表 v1（Q-2；14 号报告 §2；决策 D-088）。
//
// 真理源是 models/radiator/presets-v1.json：每一项参数带 V / P / S / A / D / M 出处档与引文，
// 本头文件只声明生成与评价**要用到**的那几项。实现 geo/src/radiator_presets.cpp 由
// scripts/gen_radiator_presets.py 生成，不要手改；两者是否同步由 engine/tests/test_ofdm.cpp
// 逐项核对并比对表文件的 sha256（同 FIR 系数表的做法，铁律 10）。
//
// 为什么放在 geo/：场景载入时的校验（Scenario::cross_check —— 带宽是否等于占用带宽、
// 采样率够不够）与帧排布（geo/src/ofdm_frame.cpp）都要它，而那两处都在 geo/。
// 生成的是纯数据的 C++，geo/ 仍不碰 JSON、仍无第三方依赖。
//
// 运行时不读 JSON：系数与结构是常量，读文件会让场景校验依赖部署目录布局。
// 要改预设就出 v2，v1 原样留着守既有基准（同识别库 library-v1 的规矩）。

#ifndef CUAV_GEO_RADIATOR_PRESETS_H
#define CUAV_GEO_RADIATOR_PRESETS_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace cuav {
namespace geo {

// 一种突发：n_symbols 个 OFDM 符号，逐符号的 CP 长度与内容。
struct RadiatorBurst {
    int n_symbols;
    const int* cp;               // 每符号 CP 长度（原生样点），n_symbols 项
    const int* zc_root;          // 每符号：0 = 载数据；> 0 = 放该根的 ZC 同步序列
    std::int64_t length_n;       // 突发总长（原生样点）= Σ(fft_size + cp[i])
};

struct RadiatorPreset {
    const char* id;              // 如 "dji-video-20m-a"
    const char* type;            // 场景 waveform.type："ofdm" / "droneid"
    const char* role;            // 真值标签：video_link / rc_hopping / droneid
    const char* credibility;     // V1 / V2（A 档主导的写 V1，14 §9）

    int fft_size;
    double fs_native_Hz;         // = fft_size × subcarrier_spacing_Hz
    double subcarrier_spacing_Hz;
    int half_subcarriers;        // K：子载波 k = −K…−1, +1…+K，直流空
    double occupied_bw_Hz;       // (2K+1)·Δf；场景 emission.bw_Hz 必须等于它

    int bits_per_axis;           // 1 = QPSK，2 = 16QAM，3 = 64QAM

    int n_bursts;
    const RadiatorBurst* bursts;

    std::int64_t slot_n;         // 时隙长（原生样点，整数由生成脚本断言）
    int cycle_len;               // 时隙循环长度
    const double* cycle;         // cycle_len × (n_bursts + 1)，行主序：[P(空), P(突发 0), …]
};

// 按 id 查；查不到返回 0，由调用方报错并列出可取值（铁律 15，不取最近一项）。
const RadiatorPreset* radiator_preset_v1(const std::string& id);
std::size_t radiator_preset_v1_count();
const RadiatorPreset& radiator_preset_v1_at(std::size_t i);

// 生成时读到的表文件 sha256，供单测比对「改了 JSON 忘了重生成」。
const char* radiator_presets_v1_sha256();

// 相邻两个突发之间至少留这么多原生样点（一个突发没结束加上它之前开始的时隙一律空）。
// 取 64：重采样滤波器的半支撑是 T/2 个原生样点（T ≈ 20），两个突发的输出支撑因此
// 永不重叠，每个输出样点至多属于一个突发 —— 按突发定频点（D-088 ⑦）的前提。
// engine/tests/test_ofdm.cpp 断言重采样表的 T + 2 ≤ 它。
const std::int64_t kBurstMinGapNative = 64;

}  // namespace geo
}  // namespace cuav

#endif
