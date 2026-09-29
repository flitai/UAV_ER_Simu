// 原生采样率上的 OFDM 调制（Q-2，14 号报告 §2.2–§2.5，决策 D-088）。
//
// 做什么：给定一个机型预设（geo/include/cuav_geo/radiator_presets.h）与一个突发的载荷种子，
// 逐符号在子载波上放数据（QPSK / 16QAM / 64QAM）或 ZC 同步序列，IFFT 后加 CP，
// 输出**原生采样率**（FFT 点数 × 15 kHz）上的复基带样点。重采样到站点采样率、开关与频率
// 搬移不在这里（engine/src/scenario.cpp 的 SceneEmitterSource）。
//
// 这是**波形生成**，手写 C++（D-036 的「算术简单件」口径，同 D-069 ⑤ 的带限噪声），
// 不是被测的 DSP 件。参考实现三方：algos/reference/ofdm_ref.py（numpy 的 ifft，独立实现）、
// MATLAB comm 工具箱 ofdmmod（matlab/golden/gen_ofdm_golden.m），判据 1e-9（算法核尺度）。
//
// 四条写法当作契约，Python 参考逐字同序（铁律 10）：
//   ① 子载波顺序：k = −K…−1, +1…+K（K = half_subcarriers），直流空；
//   ② 数据：每个突发一个 Xoshiro256pp(种子)，逐数据符号、逐子载波（按 ① 的顺序）取一个 next_u64，
//      低 b 位给 I、再往上 b 位给 Q（b = bits_per_axis），电平 (2i − (L−1)) / √(2(L²−1)/3)；
//      ZC 符号不耗随机数；
//   ③ ZC：x(n) = exp(−jπ·u·n(n+1)/N)，N = 2K+1，n = 0…2K，删去 n = K 后依次映射到 ① 的顺序；
//      相位下标 u·n(n+1) 先按整数对 2N 取模再换成角度（大角度下各家 cos/sin 会差出 1e-9 以上）；
//   ④ 时域：x[n] = g·Σ_k X_k·exp(+j2πkn/N_fft)，g = 1/√(2K)，于是数据符号在期望上、ZC 符号
//      逐位地，符号内平均功率恰为 1（Parseval）；先放 CP（取符号尾部 cp 个样点）再放符号本体。

#ifndef CUAV_OFDM_H
#define CUAV_OFDM_H

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

#include "cuav/dsp.h"
#include "cuav/random.h"
#include "cuav_geo/radiator_presets.h"

namespace cuav {
namespace ofdm {

// ZC 序列第 n 项（③）。n_zc 须为奇数、0 ≤ n < n_zc。
std::complex<double> zc_value(int root, int n_zc, int n);

class Modulator {
public:
    Modulator();

    // 绑定一个预设。星座位数不在 1…3、FFT 点数不是 2 的幂等即写 err 返回 false。
    bool init(const geo::RadiatorPreset& p, std::string& err);

    const geo::RadiatorPreset& preset() const { return *p_; }
    double gain() const { return gain_; }            // g = 1/√(2K)
    int n_carriers() const { return 2 * p_->half_subcarriers; }

    // 子载波下标 i（0…2K−1）对应的频率序号 k（①）。
    int carrier_index(int i) const;

    // 突发 variant 第 symbol 个符号的子载波值（2K 项，按 ① 的顺序）。数据符号从 rng 取数（②）。
    void symbol_carriers(int variant, int symbol, Xoshiro256pp& rng,
                         std::vector<std::complex<double>>& carriers) const;

    // 整个突发的原生样点，长度恰为 bursts[variant].length_n（④）。out 先清空再写。
    void burst(int variant, std::uint64_t seed, std::vector<std::complex<double>>& out) const;

private:
    const geo::RadiatorPreset* p_;
    dsp::FftPlan plan_;
    double gain_;
    std::vector<double> levels_;                     // 每轴 L 个电平
    std::vector<std::vector<std::complex<double>>> zc_cache_;   // 按 ZC 根缓存的 2K 项（③）
    std::vector<int> zc_roots_;

    const std::vector<std::complex<double>>& zc_carriers(int root) const;
};

}  // namespace ofdm
}  // namespace cuav

#endif
