// 首批数据源组件：单音源、复高斯噪声源、文件回放源。
//
// 依据：06 备忘录 §9 P1-3「models 首批」；04 §15.2 标准算例第 1、2、9 项。
// 口径与 algos/reference 保持一致，因为引擎侧的结果要与参考实现对拍。

#ifndef CUAV_COMPONENTS_SOURCES_H
#define CUAV_COMPONENTS_SOURCES_H

#include <string>

#include "cuav/component.h"

namespace cuav {

// 单音源：x[n] = A·exp(j·2π·f·n/Fs + jφ)。确定型信号，用于标准算例第 1 项。
class ToneSource : public IComponent {
public:
    std::string type_name() const override { return "ToneSource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::IQStream}};
    }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;
    double offset_Hz_ = 0.0;       // 相对中心频率的频偏
    double amplitude_ = 1.0;
    double phase_rad_ = 0.0;
    std::uint64_t total_samples_ = 0;
    // 起止样点：区间之外输出零。用于突发开关与占空比算例，也让下游的噪声估计
    // 有一段无信号的窗口可用——这不是可选功能，没有它就没法在有信号时估底噪。
    std::uint64_t start_sample_ = 0;
    std::uint64_t stop_sample_ = 0;      // 0 表示直到结束
    std::size_t block_samples_ = 65536;

    std::uint64_t produced_ = 0;
    ComponentStatus status_;
};

// 复高斯白噪声源。方差按每样点功率给定（线性，不是分贝）。
class NoiseSource : public IComponent {
public:
    std::string type_name() const override { return "NoiseSource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::IQStream}};
    }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;
    double power_ = 1.0;           // 每样点平均功率 E|x|^2
    std::uint64_t total_samples_ = 0;
    std::size_t block_samples_ = 65536;

    IRandom* rng_ = nullptr;       // 随机性显式注入（铁律 9），组件不持有随机源
    std::uint64_t produced_ = 0;
    ComponentStatus status_;
};

// 文件回放源：读本项目格式的 .iq（复 int16 交织、小端、无文件头）与旁挂清单。
// 规范见 docs/iq-format.md 第 3、4 节。
class FileReplaySource : public IComponent {
public:
    std::string type_name() const override { return "FileReplaySource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::IQStream}};
    }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    std::string path_;             // .iq 路径；分段文件按清单顺序读
    std::string manifest_path_;    // 由装载器按 data_id 解析注入（internal 参数）
    std::string data_id_;          // 数据索引里的标识，进溯源
    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;
    double full_scale_ = 32768.0;
    std::size_t block_samples_ = 65536;
    std::uint64_t max_samples_ = 0;      // 0 表示读到文件末尾

    std::vector<std::string> segment_paths_;
    std::size_t segment_index_ = 0;
    std::uint64_t offset_in_segment_ = 0;
    std::uint64_t produced_ = 0;
    State file_state_ = State::Valid;
    std::vector<std::string> file_reasons_;
    ComponentStatus status_;

    bool load_manifest(std::string& err);
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_SOURCES_H
