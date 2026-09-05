// 引擎自带的最小数字信号处理与特殊函数。
//
// 为什么不引第三方：这些函数必须与 algos/reference 的 Python 参考实现逐位对得上，
// 引入 FFTW 或 Boost 会带来实现差异与构建依赖，而这里只需要基 2 FFT 与一个不完全伽马函数。
// 算法与常数与参考实现一一对应，改动即为基准变化（铁律 10）。

#ifndef CUAV_DSP_H
#define CUAV_DSP_H

#include <complex>
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

}  // namespace dsp
}  // namespace cuav

#endif  // CUAV_DSP_H
