// 处理类组件：加法混合、能量检测。
//
// 能量检测的口径与 algos/reference/energy_detector.py 严格一致，
// 因为引擎侧的结果要与参考实现对拍（跨层一致性算例 ① 的引擎侧，决策 D-026）：
//   切帧不加窗不重叠 → 每帧 DFT → 频段内取能量 → 除以噪声估计 → 与门限比较。
// 不加窗是刻意的：加窗会让相邻频点相关，H0 的卡方自由度不再是 2M，解析虚警率失效。
// 噪声估计取逐频点的帧维中位数除以 ln2；判据里的常数改动即为基准变化（铁律 10）。

#ifndef CUAV_COMPONENTS_PROCESSING_H
#define CUAV_COMPONENTS_PROCESSING_H

#include <deque>
#include <string>
#include <vector>

#include "cuav/component.h"

namespace cuav {

// 两路 IQ 相加。用于「真实背景 + 合成目标」这类混合（04 §15.2 标准算例第 10 项）。
// 两路的采样率与中心频率必须一致，否则报错而不是静默按样点对齐。
class AddMixer : public IComponent {
public:
    std::string type_name() const override { return "AddMixer"; }
    std::vector<PortSpec> inputs() const override {
        return {PortSpec{"a", PortType::IQStream}, PortSpec{"b", PortType::IQStream}};
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::IQStream}};
    }
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    double gain_a_ = 1.0;
    double gain_b_ = 1.0;
    ComponentStatus status_;
};

// 能量检测器。参数与参考实现同名同义。
class EnergyDetector : public IComponent {
public:
    std::string type_name() const override { return "EnergyDetector"; }
    std::vector<PortSpec> inputs() const override {
        return {PortSpec{"in", PortType::IQStream}};
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::DetectionList}};
    }
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 供测试与上层查询
    double threshold() const { return eta_; }
    int band_bins() const { return m_bins_; }
    std::uint64_t hits() const { return hits_; }
    std::uint64_t frames() const { return frames_; }

private:
    std::size_t nfft_ = 1024;
    double band_lo_Hz_ = 0.0;
    double band_hi_Hz_ = 0.0;
    double pfa_ = 1e-3;
    std::size_t noise_frames_ = 8192;   // 估噪声用的探针帧数

    // 状态
    std::vector<Complex> carry_;                 // 不满一帧的余量
    std::vector<std::vector<double>> probe_;     // 探针帧的逐频点功率
    std::vector<double> noise_per_bin_;
    std::vector<bool> band_mask_;
    std::vector<Detection> pending_;
    double noise_band_ = 0.0;
    double eta_ = 0.0;
    int m_bins_ = 0;
    bool noise_ready_ = false;
    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;
    std::uint64_t frames_ = 0;
    std::uint64_t hits_ = 0;
    std::uint64_t next_frame_start_ = 0;
    ComponentStatus status_;

    void build_mask();
    void finalise_noise();
    void consume_frame(const std::vector<Complex>& frame, std::uint64_t start_sample);
};

// 检测结果汇聚。首期只做计数与极值摘要，够上层取用；
// 完整的候选片段清单（时间、频率、带宽、功率、门限、质量、追溯）留给 EM-S-02 的完整实现。
class DetectionSink : public IComponent {
public:
    std::string type_name() const override { return "DetectionSink"; }
    std::vector<PortSpec> inputs() const override {
        return {PortSpec{"in", PortType::DetectionList}};
    }
    std::vector<PortSpec> outputs() const override { return {}; }
    bool configure(const std::map<std::string, double>&,
                   const std::map<std::string, std::string>&, std::string&) override {
        return true;
    }
    bool init(IRandom&, std::string&) override {
        frames_ = 0; hits_ = 0; max_stat_ = 0.0; threshold_ = 0.0;
        status_ = ComponentStatus();
        return true;
    }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override { frames_ = 0; hits_ = 0; max_stat_ = 0.0; }
    ComponentStatus status() const override { return status_; }

    std::uint64_t frames() const { return frames_; }
    std::uint64_t hits() const { return hits_; }
    double hit_rate() const { return frames_ ? static_cast<double>(hits_) / frames_ : 0.0; }
    double max_statistic() const { return max_stat_; }
    double threshold() const { return threshold_; }

private:
    std::uint64_t frames_ = 0;
    std::uint64_t hits_ = 0;
    double max_stat_ = 0.0;
    double threshold_ = 0.0;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_PROCESSING_H
