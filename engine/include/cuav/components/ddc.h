// DDC：数字下变频（04 §7.7；06 备忘录 §9D M-2；D-070）。
//
// 本组件是首期唯一改变采样率的件，08 报告 §8 的四条多速率口径由它兑现：
//   口径一 样点序号是唯一需要换算的量；口径二 群时延在这一层扣除；
//   口径三 铁律 4 的检查在这一层（引擎能判定的那一半）；口径四 变速率要留溯源。
//
// 手写 C++ 而不是 MATLAB Coder 产物，是**工程取舍不是许可所迫**（D-070 改写后的定论）：
// 算法核「数控振荡 + 抽取型 FIR」约 60 行，而封装层按 08 §13 本来就得手写，Coder 省不下多少；
// 手写版又已与独立的 Python 参考逐位相同，回退无收益只有风险。Coder 路线的首个使用者是 M-3
// （信道化与接收滤波，见 components/channelizer.h、components/rx_filter.h）。
// 算法核在 dsp.h 的 ddc_* 三件，系数表在 models/adc-ddc/fir_lp_v1.json。

#ifndef CUAV_COMPONENTS_DDC_H
#define CUAV_COMPONENTS_DDC_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/dsp.h"

namespace cuav {

class DDC : public IComponent {
public:
    std::string type_name() const override { return "DDC"; }
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

    int decim() const { return decim_; }
    int ntaps() const { return st_.ntaps; }
    int group_delay() const { return st_.group_delay; }
    double sample_rate_out_Hz() const { return fs_out_; }
    std::uint64_t out_count() const { return out_count_; }

private:
    double f_shift_Hz_ = 0.0;
    int decim_ = 1;
    std::string fir_version_ = "lp_v1";

    dsp::DdcState st_;
    std::vector<Complex> outbuf_;

    double fs_in_ = 0.0, fs_out_ = 0.0;
    bool have_fs_ = false;
    std::uint64_t expect_in_ = 0;
    bool have_expect_ = false;
    std::uint64_t out_count_ = 0, samples_in_ = 0, pend_clip_ = 0;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_DDC_H
