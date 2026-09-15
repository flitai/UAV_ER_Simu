// 引擎自带的最小数字信号处理与特殊函数。
//
// 为什么不引第三方：这些函数必须与 algos/reference 的 Python 参考实现逐位对得上，
// 引入 FFTW 或 Boost 会带来实现差异与构建依赖，而这里只需要基 2 FFT 与一个不完全伽马函数。
// 算法与常数与参考实现一一对应，改动即为基准变化（铁律 10）。

#ifndef CUAV_DSP_H
#define CUAV_DSP_H

#include <complex>
#include <string>
#include <cstddef>
#include <vector>

#include "cuav/types.h"

namespace cuav {
namespace dsp {

// 原地基 2 时域抽取 FFT。n 必须是 2 的幂。
void fft_inplace(std::vector<Complex>& x);

// 把零频移到中间，与 numpy.fft.fftshift 一致。
void fftshift(std::vector<Complex>& x);

// double 版本，供频谱分析（P1-4a）与观测点产品（B-3）使用：显示用的谱要与 MATLAB / numpy 的
// double 结果对到 1e-9，float 版本做不到。旋转因子按频点直接求值，不做递推累积。
// float 版本保持不变，能量检测的黄金基准依赖它（铁律 10）。
void fft_inplace(std::vector<std::complex<double>>& x);
void fftshift(std::vector<std::complex<double>>& x);
void fftshift(std::vector<double>& x);

// 正则化上不完全伽马函数 Q(a,x)=Γ(a,x)/Γ(a)。
// 与 algos/reference/energy_detector.py 的 regularized_gamma_q 同算法同分支条件。
double regularized_gamma_q(double a, double x);

// 解 Q(M, M·η) = pfa，返回归一化门限 η。二分法，与参考实现同收敛判据。
double threshold_for_pfa(int m_bins, double pfa);

// --- 带限用的双二阶节（C-8 / G-6，D-069）------------------------------------
//
// 用途只有一个：给 SceneEmitterSource 的 noise 波形做带限，让「2 MHz 图传落在 10 MS/s 的
// 观测带里」这件事在谱上成立。这是**波形生成**，不是 D-036 所指的被测 DSP 滤波件
// （接收滤波 / DDC / 信道化仍走 MATLAB Coder，M-2 / M-3）。
//
// 形式：4 阶巴特沃斯低通 = 两个双二阶节级联，双线性变换加频率预畸变，转置直接 II 型递推。
// 五行递推当作契约，C++ 与 Python 参考必须逐字同序（铁律 10）：
//     y  = b0*x + s1
//     s1 = b1*x - a1*y + s2
//     s2 = b2*x - a2*y
struct Biquad {
    double b0, b1, b2, a1, a2;
    Biquad() : b0(1.0), b1(0.0), b2(0.0), a1(0.0), a2(0.0) {}
};

// 4 阶巴特沃斯低通的两节系数。要求 0 < fc < fs/2，否则写 err 返回 false。
bool butterworth_lp4(double fc_Hz, double fs_Hz, Biquad out[2], std::string& err);

// 级联的噪声功率增益 Σ|h[n]|²（白输入单位功率时的输出功率）与稳定所需的样点数。
// 跑冲激响应累加，判据「连续 16 个样点 h² ≤ 1e-20·acc」，上限 2^22 到顶即报错（铁律 15）。
bool impulse_power_gain(const Biquad f[2], double& gain, std::size_t& n_settle, std::string& err);

// 单个复样点过两节级联；state 是 4 个复状态（每节 2 个），由调用方跨块持有。
std::complex<double> biquad2_step(const Biquad f[2], std::complex<double> state[4],
                                  std::complex<double> x);


}  // namespace dsp
}  // namespace cuav

#endif  // CUAV_DSP_H
