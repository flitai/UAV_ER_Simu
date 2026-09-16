// RxFilter：接收滤波（04 §7.5 与附录 A 的「滤波」；06 备忘录 §9D M-3；D-071）。
//
// 建模对象是接收机的**模拟预选 / 中频滤波**：只做幅频响应与群时延，不抽取，
// 输出采样率与中心频率都不变。04 §15.2 的标准算例第 5 项「接收滤波和群时延」由它兑现。
//
// **算法核是 MATLAB Coder 产物**（08 报告 §13 的首个使用者之一，D-036 / D-070 ②）：
// models/receiver/coder/cuav_rx_fir.c，来源 matlab/ref/cuav_rx_fir.m（一句 filter(h,1,x,zi)）。
// 本文件是 §13 规定的封装层，五项职责全在这里：参数校验、样点序号换算与群时延扣除、
// 状态持有与 reset()、溯源填充（implementation = coder、source_ref 必填）、四态传播。
//
// **它在链上排在 ReceiverFrontEnd 之前**（10 报告 §2.1 第 5 行、§3.5）。这个次序不是随意的：
// 前端注入的等效热噪声因此**不被本滤波器整形**，于是 S2 的底噪仍然是 −174 + nf + 10·log10(fs)。
// 那条式子有三处在用（前端频率计划的 adc_floor 检查、切片 ④a 的验收条款、
// models/receiver/README.md §2），把滤波器挪到前端之后会让实测底噪低 10·log10(fs/bw)。

#ifndef CUAV_COMPONENTS_RX_FILTER_H
#define CUAV_COMPONENTS_RX_FILTER_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/dsp.h"

extern "C" {
#include "cuav_rx_fir.h"
}

namespace cuav {

class RxFilter : public IComponent {
public:
    std::string type_name() const override { return "RxFilter"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::IQStream}}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 测试用读数
    int ntaps() const { return ntaps_; }
    int group_delay() const { return group_delay_; }
    double bw_rel() const { return bw_rel_; }
    std::uint64_t out_count() const { return out_count_; }

    // Coder 内核的定长块。封装层自己攒满再调：框图里的块长是任意的，而生成的 C 是定长接口。
    static const int kBlock = 1024;

private:
    // 攒满 kBlock 就调一次内核；ok 为假时 err 已填
    bool crunch(std::size_t n_real, std::vector<Complex>& sink);

    double bw_Hz_ = 0.0;
    double bw_rel_ = 0.0;
    std::string fir_version_ = "rx_v1";
    int ntaps_ = 0;
    int group_delay_ = 0;

    std::vector<double> taps_;      // 零填充到表内最大抽头数：内核接口是定长的
    std::vector<creal_T> xbuf_;     // 攒输入的缓冲，同时就是内核的入参数组
    std::vector<creal_T> ybuf_;     // 内核出参
    std::vector<creal_T> zi_;       // filter 的状态，跨块保持
    std::vector<creal_T> zf_;
    std::size_t fill_ = 0;          // xbuf_ 里已攒了多少
    std::uint64_t skip_ = 0;        // 还要丢掉多少个因果输出（群时延，08 §8 口径二）

    std::vector<Complex> outbuf_;

    double fs_in_ = 0.0;
    bool have_fs_ = false;
    std::uint64_t expect_in_ = 0;
    bool have_expect_ = false;
    std::uint64_t out_count_ = 0, samples_in_ = 0, pend_clip_ = 0;
    double center_Hz_ = 0.0;
    BlockMeta last_meta_;
    bool have_meta_ = false;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_RX_FILTER_H
