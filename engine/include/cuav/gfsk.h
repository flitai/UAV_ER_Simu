// GFSK / 2-FSK 调制核：按任意时刻闭式求相位（Q-3，14 号报告 §3.2，决策 D-089）。
//
// 做什么：给定一个 GFSK 族预设（geo/include/cuav_geo/gfsk_presets.h）与一个包的比特，按包内任意时刻 τ
// **闭式**给出调制相位（以圈计）与瞬时频率。不经过任何过采样或数值积分，于是符号率不整除采样率
// （77 kbaud @ 80 MS/s = 1039.4 样点 / 符号）也照样精确，且结果只是 τ 的函数、与块长无关（铁律 9）。
// 载波搬移、开关与逐包频点不在这里（engine/src/scenario.cpp 的 SceneEmitterSource）。
//
// 这是**波形生成**，手写 C++（D-036 的「算术简单件」口径，同 D-069 ⑤ 的带限噪声与 D-088 的 OFDM 调制），
// 不是被测的 DSP 件。参考实现：algos/reference/gfsk_ref.py（同式 float64 一份 + mpmath 不截断全和一份）、
// MATLAB（基础 erf 的闭式 + comm.CPFSKModulator，matlab/golden/gen_gfsk_golden.m），判据 1e-9（算法核尺度）。
//
// 五条写法当作契约，Python 参考逐字同序（铁律 10）：
//   ① 比特：前导 preamble_bits 个 1010…（起于 1）→ 同步字 sync_bits 位（高位先发）→ 载荷：
//      Xoshiro256pp(种子)，每 64 个载荷比特取一个 next_u64、高位先用；比特 b → a = 2b − 1，
//      '1' → +f_dev（CC2500 表 23）。包外 a_k = 0（频率回到载波）。
//   ② 归一化时间 s = τ·R（以符号计），j = floor(s)，前缀和 S_m = Σ_{k<m} a_k（S_0 = 0，整数）。
//   ③ GFSK（BT = b）：σ̃ = √ln2 / (2π·b)（以符号计），窗口 K = 1 + ceil(8.5·σ̃)
//      （窗口外的尾巴 < erfc(6) ≈ 2e−17，比双精度的末位还小）；
//      Ĩ(x) = x·erf(x / (√2·σ̃)) + σ̃·√(2/π)·exp(−x² / (2σ̃²))，
//      lo = clamp(j − K, 0, N)、hi = clamp(j + K, −1, N − 1)；
//      acc = a_lo·Ĩ(s − lo) + Σ_{m = lo+1}^{hi} (a_m − a_{m−1})·Ĩ(s − m) − a_hi·Ĩ(s − hi − 1)
//      （按 m 升序累加，差为零的项跳过；lo > hi 时 acc = 0），
//      Φ = (S_lo + S_{hi+1}) / 2 + acc / 2。
//      这是「窗口内各符号 a_k·P(s − k)、窗口前的符号取满 1、窗口后的取 0」的裂项写法，
//      P 是 [0, 1) 矩形与高斯核卷积后的积分：P(x) = [Ĩ(x) − Ĩ(x − 1)] / 2 + 1/2。
//   ④ 2-FSK：Φ = S_j + a_j·(s − j)（0 ≤ j < N）；s < 0 取 0，s ≥ N 取 S_N。
//   ⑤ 相位 ψ = (f_dev / R)·Φ 圈（f_dev / R = h/2）；瞬时频率 f = f_dev·Σ_{k=lo}^{hi} a_k·g̃(s − k)，
//      g̃(x) = [erf(x / (√2σ̃)) − erf((x − 1) / (√2σ̃))] / 2（2-FSK 时 g̃ 是 [0, 1) 上的 1）。

#ifndef CUAV_GFSK_H
#define CUAV_GFSK_H

#include <cstdint>
#include <string>
#include <vector>

#include "cuav_geo/gfsk_presets.h"

namespace cuav {
namespace gfsk {

// 一个包的比特（①），长度 n_bits，取值 ±1。out 先清空再写。
void packet_bits(const geo::GfskPreset& p, int n_bits, std::uint64_t seed, std::vector<signed char>& out);

// 一个包：比特与前缀和。
struct Packet {
    std::vector<signed char> a;
    std::vector<std::int32_t> prefix;   // prefix[m] = S_m，长度 N + 1
};

class Modulator {
public:
    Modulator();

    // 绑定调制参数。gaussian = 1 时 bt 须为正；符号率与频偏须为正。否则写 err 返回 false。
    bool init(int gaussian, double bt, double symbol_rate_Hz, double deviation_Hz, std::string& err);
    bool init(const geo::GfskPreset& p, std::string& err);

    // 填好前缀和（②）。
    static void prepare(const std::vector<signed char>& a, Packet& out);

    // 包内时刻 τ（秒，相对包起点）的调制相位，以圈计（③④⑤）。
    double phase_cycles(const Packet& pk, double tau_s) const;
    // 同一时刻的瞬时频率（Hz，相对载波）。
    double inst_freq_Hz(const Packet& pk, double tau_s) const;

    int window() const { return K_; }
    double sigma_symbols() const { return sigma_; }
    double symbol_rate_Hz() const { return R_; }
    double deviation_Hz() const { return fdev_; }

private:
    int gaussian_;
    double R_;
    double fdev_;
    double sigma_;       // σ̃（以符号计）
    double inv_s2_;      // 1 / (√2·σ̃)
    double c_exp_;       // σ̃·√(2/π)
    double inv_2s2_;     // 1 / (2σ̃²)
    int K_;

    double I(double x) const;
};

}  // namespace gfsk
}  // namespace cuav

#endif
