// 频谱分析组件（06 备忘录 §9 P1-4a）：IQ 流 → Welch 功率谱帧，SpectrumFrame 的第一个生产者。
//
// 口径（与 algos/reference/gen_spectrum_golden.py、matlab/ref/cuav_welch_power.m 三方互证）：
//   每段 nfft 点加周期窗 → DFT → |X|² → 若干段平均 → 除以 (Σw)² → fftshift → 10·log10。
//   复单音的峰值等于其功率 A²，满量程单音读 0 dBFS。未标定一律 dBFS（D-020）。
// 计算在 double 里做（dsp::fft_inplace 的 double 版本），输入 float32 样点只是被读取。
// 组件不假设块长：跨块拼接，一次 process 把当前能切出的帧全部交出——调度器只在有新输入时
// 调用 process，不会为内部余量单独再调（graph.cpp）。

#ifndef CUAV_COMPONENTS_SPECTRUM_H
#define CUAV_COMPONENTS_SPECTRUM_H

#include <complex>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "cuav/component.h"

namespace cuav {

// Welch 累加器：切段、加窗、变换、累加、成帧。供 SpectrumAnalyzer 与观测点组件（B-3）共用。
class WelchAccumulator {
public:
    // window ∈ {hann, hamming, blackman, rect}，均为周期形式；overlap ∈ [0, 1) 且 nfft·(1−overlap) 须为正整数。
    bool configure(std::size_t nfft, double overlap, const std::string& window,
                   std::size_t segments_per_frame, std::string& err);

    // 成帧回调：线性功率（已 fftshift）、本帧第一段的首样点序号、本帧段数。
    using Emit = std::function<void(const std::vector<double>& power, std::uint64_t first_sample, std::size_t segments)>;

    // 喂一块样点；first_sample 是该块首样点在整条流中的序号。
    void push(const Complex* samples, std::size_t count, std::uint64_t first_sample, const Emit& emit);
    // 收尾：不满一帧的段平均后交出（segments < segments_per_frame）；返回是否有产出。
    bool flush(const Emit& emit);

    std::size_t nfft() const { return nfft_; }
    std::size_t hop() const { return hop_; }
    std::size_t segments_per_frame() const { return segments_per_frame_; }
    const std::string& window_name() const { return window_name_; }
    std::size_t dropped_tail_samples() const { return dropped_tail_; }
    void reset();

private:
    std::size_t nfft_ = 0, hop_ = 0, segments_per_frame_ = 1;
    std::string window_name_;
    std::vector<double> window_;
    double window_sum_sq_ = 0.0;     // (Σw)²

    std::vector<Complex> buf_;
    std::size_t head_ = 0;           // buf_ 里第一个未消费样点的下标
    std::uint64_t head_sample_ = 0;  // 它在整条流中的序号
    bool head_known_ = false;
    std::uint64_t covered_end_ = 0;  // 已被某一段覆盖到的样点序号上界（有重叠时 head 之后的样点可能已被覆盖）

    std::vector<double> acc_;
    std::size_t seg_count_ = 0;
    std::uint64_t frame_first_sample_ = 0;
    std::size_t dropped_tail_ = 0;

    void consume_segment();
    void emit_frame(const Emit& emit);
};

class SpectrumAnalyzer : public IComponent {
public:
    std::string type_name() const override { return "SpectrumAnalyzer"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::IQStream}}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::SpectrumFrame}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    std::size_t nfft_ = 1024;
    double overlap_ = 0.0;
    std::string window_ = "hann";
    std::size_t segments_per_frame_ = 1;

    WelchAccumulator acc_;
    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;
    BlockMeta last_meta_;
    bool seen_block_ = false;
    ComponentStatus status_;

    SpectrumFrame make_frame(const std::vector<double>& power, std::uint64_t first_sample,
                             std::size_t segments, bool partial) const;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_SPECTRUM_H
