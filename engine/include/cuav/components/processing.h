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
    ComponentInfo describe() const override;
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

// 多路叠加（D-053，11 报告 §3.1）。N 个辐射源各走一条前四环节的支路，在**接收天线之后、
// 接收机前端之前**汇成一路——物理上电磁场在天线口面叠加，接收机只有一条通道。
//
// 为什么不把 AddMixer 改成八口：AddMixer 已进目录黄金基准并被混合增强模式使用，
// 改端口表属于铁律 10 意义上的基准变更，而收益只是省一个类。
//
// 八个输入口全部 optional，因此「一个都没连」在 Graph::validate 眼里合法——
// 真正的下限由 check_wiring() 按 min_inputs 声明（D-053 启用的 port_optional）。
class Superposition : public IComponent {
public:
    std::string type_name() const override { return "Superposition"; }
    std::vector<PortSpec> inputs() const override {
        std::vector<PortSpec> v;
        for (int k = 1; k <= 8; ++k) {
            PortSpec p;
            p.name = std::string("in") + static_cast<char>('0' + k);
            p.type = PortType::IQStream;
            p.optional = true;
            v.push_back(p);
        }
        return v;
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::IQStream}};
    }
    ComponentInfo describe() const override;
    bool check_wiring(const std::vector<std::string>& wired, std::string& err) const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    std::size_t min_inputs_ = 2;
    ComponentStatus status_;
};

// 能量检测器。参数与参考实现同名同义。
//
// 两种噪声估计（C-3，D-063）：
//   probe   —— 前 noise_frames 帧估一次逐频点中位数后固定。既有算法，黄金基准
//              engine/tests/golden/energy_detector.json 守着它，一字不改（铁律 10）。
//   sliding —— 带删截的滑动中位数：只把**未命中**的帧纳入最近 W 帧的环，环变了才重算噪声；
//              背景漂移时门限跟着走，删截避免信号自身抬高噪声估计——D-026「交付形态不得是
//              静态门限」的兑现（固定门限在一半背景上标定、换到另一半虚警率超目标 7 倍）。
// 两种模式都按 merge_gap_frames 把命中帧并成突发（segment_id）；每帧经观察者 on_detection
// 上报一行，flush 时 on_detection_summary 一次。算法逐帧顺序与 algos/reference/energy_detector.py
// 的 sliding_from_power 严格一致，黄金基准 energy_detector_sliding.json 逐帧对拍。
class EnergyDetector : public IComponent {
public:
    std::string type_name() const override { return "EnergyDetector"; }
    std::vector<PortSpec> inputs() const override {
        return {PortSpec{"in", PortType::IQStream}};
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::DetectionList}};
    }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    void set_node_name(const std::string& name) override { node_name_ = name; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 供测试与上层查询
    double threshold() const { return eta_; }
    int band_bins() const { return m_bins_; }
    std::uint64_t hits() const { return hits_; }
    std::uint64_t frames() const { return frames_; }
    std::uint64_t segments() const { return segments_; }
    std::uint64_t noise_stale_frames() const { return noise_stale_; }

private:
    std::size_t nfft_ = 1024;
    double band_lo_Hz_ = 0.0;
    double band_hi_Hz_ = 0.0;
    double pfa_ = 1e-3;
    std::size_t noise_frames_ = 8192;   // probe：估噪声用的探针帧数
    std::string noise_mode_ = "probe";
    std::size_t window_frames_ = 256;   // sliding：环长 W
    std::uint64_t merge_gap_ = 2;       // 突发合并允许的空隙帧数
    bool want_dBm_ = true;
    std::string site_id_;               // 装载器按 scene_binding 注入；只作行身份，不影响算法
    std::string node_name_;
    IRunObserver* obs_ = nullptr;

    // 状态
    std::vector<Complex> carry_;                 // 不满一帧的余量
    std::vector<std::vector<double>> probe_;     // 探针帧的逐频点功率（probe）
    std::vector<bool> probe_overload_;           // 与 probe_ 同长：该探针帧是否含削波块
    std::vector<double> noise_per_bin_;
    std::vector<bool> band_mask_;
    std::vector<std::size_t> band_bins_;         // 频段内 bin 的 k 值，升序
    std::vector<Detection> pending_;
    double noise_band_ = 0.0;
    double eta_ = 0.0;
    int m_bins_ = 0;
    bool noise_ready_ = false;
    std::size_t probe_used_ = 0;                 // probe 实际用了几帧
    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;
    std::uint64_t frames_ = 0;
    std::uint64_t hits_ = 0;
    std::uint64_t next_frame_start_ = 0;
    // sliding 的环：ring_ 按帧序存整帧功率（弹出最旧帧时要知道删哪个值），
    // sorted_ 按频段内 bin 各存一份有序副本——中位数 O(1)，插删 O(W) 的 memmove。
    // 逐帧对 M 个 bin 重排序（M·W·logW）在 921 bin × 256 帧 × 488 帧/s 下是每秒十亿次比较，不可取。
    std::deque<std::vector<double>> ring_;
    std::vector<std::vector<double>> sorted_;
    bool ring_dirty_ = false;
    bool ring_ever_full_ = false;
    std::uint64_t frames_since_admit_ = 0;
    std::uint64_t noise_stale_ = 0;
    // 分段与逐帧标记
    std::int64_t last_hit_frame_ = -1;
    std::int64_t segment_counter_ = -1;
    std::uint64_t segments_ = 0;
    std::uint64_t overload_frames_ = 0;
    bool frame_overload_ = false;                // 正在拼的这一帧是否含削波块
    bool frame_calibrated_ = false;              // 最近一块是否已标定（决定 has_dBm）
    bool summary_sent_ = false;
    ComponentStatus status_;

    void clear_state();
    void build_mask();
    void finalise_noise();
    void consume_frame(const std::vector<Complex>& frame, std::uint64_t start_sample);
    void judge_sliding(const std::vector<double>& power, std::uint64_t start_sample);
    void ring_push(const std::vector<double>& power);
    void recompute_noise_from_ring();
    Detection make_detection(double band_energy, std::uint64_t frame_index,
                             std::uint64_t start_sample, bool overload);
    void report(const Detection& d);
    void emit_summary();
    ModelTrace trace() const;
};

// 突发特征提取（C-4，10 报告 §4.3；EM-S-03 §10.5–§10.10）。M3 观测量提取件：吃 IQ 与检测行，
// 按检测器给的 segment_id 在段收口时出一行特征，算法与 algos/reference/features.py 严格同序
// （黄金基准 engine/tests/golden/features.json 逐段对拍）。
//
// 与检测器的对齐是硬契约：同样从收到的第一个样点起切帧、不加窗、不重叠、nfft 相同，于是本组件的
// 第 k 帧就是检测行 frame_index = k 那一帧。装载器核对两边的 nfft / merge_gap_frames / noise_mode，
// 运行时再按 frame_index 与 start_sample 逐帧核对——对不上即报错，不猜。
//
// 两条调度约定（C-4 落地时核实到的两处风险）：
//   ① IQ 块必须连续（start_sample 首尾相接），断档即 Step::Error。调度器的缓冲深度为 1、按赋值覆盖，
//      上游若有一轮没产出，本节点那一轮被跳过、块被下一轮覆盖——静默丢块是铁律 15 不允许的。
//      为此 EnergyDetector 自 C-4 起「消费了块就产出」（没有完成帧时给空列表）。
//   ② 本组件同样「消费了输入的轮次必产出」（哪怕是空的 FeatureVector）：C-5 的评价器是双输入节点，
//      靠这条约定才不会被跳过。
//
// 段的收口时机：出现新的 segment_id、或连续未命中帧数超过 merge_gap_frames（检测器的合并判据，
// 超过它就不可能再并进来）、或 flush()。谱统计只用命中帧：合并空隙里的非命中帧不计。
// 两套谱：**电量**（带内功率、信噪比、噪声）用不加窗的帧——与检测器逐位同源，噪声由检测行的 Λ 反推
// （noise = e / Λ）；**形状**（质心、带宽、平坦度、峰值）用同一帧加周期 Hann 窗的 PSD——不加窗的
// 矩形帧对不在 bin 上的单音漏出 sinc² 旁瓣，99% 占用带宽会量到几十个 bin，cw 这一类永远配不上；
// 加窗后噪声每 bin 功率按 Σw²/nfft 缩放，去噪与过闸都在加窗域做。
// 去噪：段均 PSD 减去带内白噪声估计，再过一道闸 noise_gate · n_bin / √F（F 帧平均后噪声 bin 的散布
// 按 1/√F 收窄）——不去噪的话，单音在 10 dB 带内信噪比下的占用带宽会吞进大半个噪声频段。
class FeatureExtractor : public IComponent {
public:
    std::string type_name() const override { return "FeatureExtractor"; }
    std::vector<PortSpec> inputs() const override {
        return {PortSpec{"iq", PortType::IQStream}, PortSpec{"det", PortType::DetectionList}};
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::FeatureVector}};
    }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    void set_node_name(const std::string& name) override { node_name_ = name; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    std::uint64_t frames() const { return frames_; }
    std::uint64_t segments() const { return segments_; }

private:
    struct Frame {
        std::uint64_t index = 0;
        std::vector<double> power;    // fftshift 后逐 bin |X_k|²（未归一化 DFT，与检测器同算）
        std::vector<double> power_w;  // 同一帧加周期 Hann 窗后的 |X_k|²，只供形状量
        double sum_abs2 = 0.0;        // 时域 Σ|x|²（double 累加）
        double max_abs2 = 0.0;
        bool calibrated = false;
    };
    struct Segment {
        std::int64_t id = -1;
        std::uint64_t first_frame = 0, last_frame = 0, frames = 0;
        std::vector<double> psd_sum;
        std::vector<double> psd_w_sum;
        double e_sum = 0.0, noise_sum = 0.0, sum_abs2 = 0.0, max_abs2 = 0.0;
        bool overload = false, calibrated = true;
        double duty = 0.0;
    };

    std::size_t nfft_ = 1024;
    std::string bandwidth_method_ = "occupied_99";
    std::uint64_t min_frames_ = 2;
    std::size_t window_frames_ = 64;
    std::uint64_t merge_gap_ = 2;
    double noise_gate_ = 4.0;
    std::string site_id_;
    std::string node_name_;
    IRunObserver* obs_ = nullptr;
    std::vector<float> window_;       // 周期 Hann，configure 时按 nfft 建
    double wsum_ = 0.0, wsq_ = 0.0;   // Σw、Σw²（按 float32 的窗值用 double 累加）

    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;
    bool has_expected_ = false;
    std::uint64_t expected_start_ = 0;
    std::vector<Complex> carry_;
    std::uint64_t next_frame_index_ = 0;
    bool frame_calibrated_ = false;
    std::deque<Frame> pending_frames_;           // 已切出、还没等到检测行的帧
    bool band_ready_ = false;
    double band_lo_Hz_ = 0.0, band_hi_Hz_ = 0.0;  // 相对中心频率，取自检测行
    std::vector<std::size_t> band_bins_;
    bool open_ = false;
    Segment cur_;
    std::uint64_t gap_ = 0;
    std::deque<bool> hit_window_;
    bool has_prev_ = false;
    double prev_t_end_s_ = 0.0, prev_center_Hz_ = 0.0;
    std::vector<FeatureRow> pending_rows_;
    std::uint64_t frames_ = 0;
    std::uint64_t segments_ = 0;
    ComponentStatus status_;

    void clear_state();
    void build_band(double f_lo_abs, double f_hi_abs);
    void push_frame(const std::vector<Complex>& frame);
    void apply(const Detection& d, const Frame& f);
    void close_segment();
    FeatureRow compute_row(const Segment& s) const;
    void report(const FeatureRow& r);
    ModelTrace trace() const;
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
    ComponentInfo describe() const override;
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
