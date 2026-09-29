// OFDM 族波形的有理重采样封装（Q-2，14 号报告 §2.4，决策 D-088）。
//
// 三层分工（08 报告 §13）：
//   matlab/ref/cuav_rsmp_cycle.m + cuav_rsmp_m{24,48,96}.m   算法核来源（人工）
//   models/radiator/coder/*.{c,h}                               Coder 产物（入库，编进 cuav_coder）
//   本文件与 engine/src/resampler.cpp                           封装层（人工）
//
// 它不是组件：重采样是波形生成的一步，挂在 SceneEmitterSource 里（engine/src/scenario.cpp），
// 典型链路上没有它的槽位。组件目录里 SceneEmitterSource 的 implementation 因此是 coder、
// source_ref 指向本件的产物（08 §13 第 4 条）。
//
// 时间锚（08 报告 §8 口径二）：输出样点 m ↔ 原型序号 m·M + gd（gd = L·T/2），即站点样点 m 恰在
// 原生时刻 m·M/L 上。一拍 c 产出站点样点 125c … 125c+124，吃原生样点 c·M − T/2 … c·M + M + T/2 − 1
// 这 M+T 个（正序窗口）。窗口外的原生样点对本拍没有贡献，于是：
//   · 输出只是站点样点序号的函数，与分块无关、可随机访问；
//   · 窗口全零的一拍不必调核，输出定义为 +0（调核也只会得到 ±0）。

#ifndef CUAV_RESAMPLER_H
#define CUAV_RESAMPLER_H

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

namespace cuav {

class RationalResampler {
public:
    RationalResampler();

    // 抽取比 M 必须是冻结表支持的档（24 / 48 / 96），否则写 err 列出可取值并返回 false。
    bool init(int decim, std::string& err);

    int interp() const { return L_; }                  // 125
    int decim() const { return M_; }
    int taps_per_phase() const { return T_; }          // 20
    int window_len() const { return M_ + T_; }

    // 第 c 拍窗口的首个原生样点序号：c·M − T/2（可为负，负序号处的样点按 0 算由调用方给）。
    std::int64_t window_start(std::int64_t c) const { return c * M_ - T_ / 2; }

    // 站点样点 m 依赖的原生样点闭区间 [lo, hi]。调用方据此判断某个突发会不会影响它。
    void native_span(std::int64_t m, std::int64_t& lo, std::int64_t& hi) const;

    // 一拍：win 是 window_len() 个原生样点（正序），y 写 interp() 个站点样点。
    void cycle(const std::complex<double>* win, std::complex<double>* y) const;

private:
    int L_;
    int M_;
    int T_;
    int gd_;
    std::vector<double> hpad_;                          // L·(T+1)，展开后末尾补零
};

// 可取的抽取比（冻结表 spec.decim_M_supported），报错列可取值用。
const std::vector<int>& rsmp_supported_decim();

}  // namespace cuav

#endif
