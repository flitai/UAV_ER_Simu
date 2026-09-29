#ifndef CUAV_FADING_H
#define CUAV_FADING_H

// 小尺度衰落的生成核（Q-4，D-091）：统计型正弦和（Jakes 谱）+ 指数时延谱的抽头延迟线。
//
// 纯函数，不碰块、帧与样点流：SceneBoundChannel 在绝对样点格点上调它求散射分量，格点之间线性插值；
// Python 参考 algos/reference/fading.py 逐式对应，黄金基准 engine/tests/golden/fading.json。
//
// 口径：
//   · 每个散射抽头 l 一组 N = 16 个正弦：g_l(Φ) = N^{-1/2}·Σ_n exp(j·(Φ·cos α_{l,n} + φ_{l,n}))，
//     α_{l,n} = 2π·(n + θ_l)/N。Φ 是多普勒相位积分 2π·∫f_D dt，由调用方按帧推进。E|g_l|² = 1。
//   · 固定 8 个抽头：τ_l = l·τ0/2、功率 p_l ∝ exp(−τ_l/τ0)、Σ p_l = 1。参数给的是这张离散时延谱的
//     **均方根时延扩展**本身，τ0 由精确比值 rms_ratio() 换算（≈ 0.8218）。首块知道采样率后按
//     floor(τ·fs + 0.5) 取整到样点、同一样点的抽头合并（权 sqrt(p_l) 相加，功率相加）。时延扩展为 0 即平坦：
//     8 个抽头全落在 0 号样点。
//   · 随机量个数只由这两个常数决定、与采样率和时长无关：按抽头 0…7 的顺序各取 θ_l 与 16 个 φ，
//     最后取视距分量的相位 θ0，全部来自调用方给的私有流（init() 里一次取完）。
//   · 视距与 K 不在这里：K 逐样点跟帧走，由调用方合成
//     h_0 = sqrt(K/(K+1))·e^{jθ0} + sqrt(1/(K+1))·D_0，h_d = sqrt(1/(K+1))·D_d（d > 0）。

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

#include "cuav/random.h"

namespace cuav {
namespace fading {

const int kTaps = 8;
const int kSinusoids = 16;

struct Draws {
    double theta[kTaps];                   // α 的随机偏移，[0, 1)
    double phi[kTaps][kSinusoids];         // 各正弦的初相，[0, 2π)
    double cos_alpha[kTaps][kSinusoids];   // cos(2π·(n + θ_l)/N)，由 theta 算出
    double los_phase;                      // 视距分量相位 θ0，[0, 2π)
};

// 按固定顺序取满全部随机量（抽头 0…7 的 θ 与 φ，最后 θ0）。
void draw(IRandom& rng, Draws& out);

// 第 l 个散射抽头在多普勒相位积分 Φ 处的复增益（单位平均功率）。
std::complex<double> diffuse(const Draws& d, int l, double Phi);

// 8 抽头离散时延谱在 τ0 = 1 时的均方根时延扩展（精确值，≈ 0.8218）与各抽头功率（和为 1）。
double rms_ratio();
double tap_power(int l);

// 首块知道采样率后定下的抽头布局：各不相同的样点时延（升序）与合并后的权。
struct Layout {
    std::vector<std::uint64_t> delay;             // 样点
    std::vector<std::vector<int> > members;       // 每个时延上合并了哪几个抽头
    std::vector<double> power;                    // 合并后的平均功率（和为 1）
    double rms_delay_spread_s = 0.0;              // 合并后的实际均方根时延扩展
};
// delay_spread_s 为 0 即平坦（一个时延、8 个抽头全合并）。
bool layout(double delay_spread_s, double fs_Hz, Layout& out, std::string& err);

// 各时延上的散射复增益 D_d(Φ) = Σ_{l∈d} sqrt(p_l)·g_l(Φ)，按 layout 的顺序写进 out。
void diffuse_at(const Draws& d, const Layout& lay, double Phi, std::vector<std::complex<double> >& out);

}  // namespace fading
}  // namespace cuav

#endif  // CUAV_FADING_H
