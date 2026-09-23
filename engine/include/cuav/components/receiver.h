// 接收机组件（06 备忘录 §9G C-2；决策 D-051、D-050 问题 ②③）。
//
//   ReceiverFrontEnd  入 in(IQStream)，出 out(IQStream)。噪声系数生热噪声、增益、本振频偏、
//                     IQ 幅相不平衡、直流偏置。产出 S2 观测点。
//   AdcQuantizer      入 in(IQStream)，出 out(IQStream)。均匀量化与削波。产出 S3 观测点。
//
// 两条拍板结论（D-050）：
//
// ② **典型链路里接收机噪声由噪声系数生成，取代手兑噪声**。此前噪声是独立 NoiseSource 加
//    AddMixer 按用户给的绝对电平兑出来的，「噪声系数」这个演示时必讲的参数没有落点。
//    改法不动任何既有基准：本组件是新增件，既有示例框图一个字没改，仍然手兑。
//    热噪声底与 geo/link_budget.cpp 的 thermal_noise_dBm_per_Hz 共用同一个 −174 dBm/Hz 工程常数
//    （290 K 的 kT 实为 −173.975，工程惯例四舍五入），因此参数帧里的链路读数与这里实际注入的
//    噪声**逐项一致**。温度偏离 290 K 时按 10·log10(T/290) 修正。
//
// ③ **ADC 削波是数据标记不是降级**。逐块把削波样点数记进 BlockMeta.clip_count 与 state_reasons，
//    四态不变；只有全程削波比例超过 degrade_clip_ratio 才在收尾时把组件状态标降级。
//    理由同 08 报告 §9.5 对整数样点时延跳变的处置：被显式建模的效应标成降级会淹没真正的降级信号。
//
// 两者都**不改变流长度**，逐样点处理，start_sample 与样点数与输入块严格相同。

#ifndef CUAV_COMPONENTS_RECEIVER_H
#define CUAV_COMPONENTS_RECEIVER_H

#include <cstdint>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/random.h"

namespace cuav {

class ReceiverFrontEnd : public IComponent {
public:
    std::string type_name() const override { return "ReceiverFrontEnd"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::IQStream}}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 供单测与解析锚点：等效输入噪声功率谱密度（dBm/Hz），以及给定采样率下的总噪声功率（dBm）。
    double noise_psd_dBm_per_Hz() const;
    double noise_power_dBm(double fs_Hz) const;

private:
    std::string noise_mode_ = "thermal";
    double nf_dB_ = 0.0;
    double reference_temperature_K_ = 290.0;
    double gain_dB_ = 0.0;
    double lo_offset_Hz_ = 0.0;
    double iq_gain_imbalance_dB_ = 0.0;
    double iq_phase_imbalance_deg_ = 0.0;
    double dc_offset_mW_ = 0.0;

    Xoshiro256pp sub_rng_{0};    // 私有随机子流，与 SceneEmitterSource 同法（08 §11.1）
    bool sub_ready_ = false;
    double phase_ = 0.0;         // 本振相位累加器，跨块连续
    double fs_ = 0.0;
    bool have_fs_ = false;
    ComponentStatus status_;
};

class AdcQuantizer : public IComponent {
public:
    std::string type_name() const override { return "AdcQuantizer"; }
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

    double full_scale_amplitude() const { return full_scale_amp_; }
    double lsb() const { return lsb_; }
    std::uint64_t clipped() const { return clipped_; }
    std::uint64_t seen() const { return seen_; }

private:
    int bits_ = 14;
    double full_scale_dBm_ = 0.0;
    std::string rounding_ = "nearest";
    double degrade_clip_ratio_ = 0.01;

    double full_scale_amp_ = 1.0;
    double lsb_ = 1.0;
    double code_max_ = 0.0, code_min_ = 0.0;
    std::uint64_t clipped_ = 0, seen_ = 0;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_RECEIVER_H
