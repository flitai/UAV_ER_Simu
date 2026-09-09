// 施加类信道组件（06 备忘录 §9C G-3；决策 D-013）。
//
// 慢变参数只能经"施加"类组件作用到 IQ 上——参数流与 IQ 流不得直连，这是 D-013 的执行点。
//
//   SceneBoundChannel  入 in(IQStream) + scene(SceneParamFrame)，出 out(IQStream)。
//                      施加链路预算增益、整数样点时延、多普勒相位斜坡；帧内零阶保持。
//   FreeSpaceChannel   定参自由空间信道（原 P1-3 欠项），不吃 scene 口，供无场景的算例与对拍用。
//
// 三条不变量：
//   ① **不改变流长度**。输出块的 start_sample 与样点数与输入块严格相同，时延靠历史缓冲实现，
//      全流最前面的 D 个样点为精确零。观测点的行索引、频谱的帧对齐、B-7 的偏移读法都建立在这上面。
//   ② 多普勒相位累加器**跨块连续**并逐样点回卷：按块回卷会让结果依赖块边界的位置。
//   ③ 增益按帧零阶保持，帧内不插值。1 km 距离、15 m/s、10 ms 一帧时台阶只有 0.0013 dB，
//      而"帧是真值的单位"这条语义比这点台阶重要得多。

#ifndef CUAV_COMPONENTS_CHANNEL_H
#define CUAV_COMPONENTS_CHANNEL_H

#include <cstdint>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav_geo/scenario.h"

namespace cuav {

class SceneBoundChannel : public IComponent {
public:
    SceneBoundChannel();

    std::string type_name() const override { return "SceneBoundChannel"; }
    std::vector<PortSpec> inputs() const override {
        return {PortSpec{"in", PortType::IQStream}, PortSpec{"scene", PortType::SceneParamFrame}};
    }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 供单测查看：链路预算里的常量部分 tx_power + G_t + G_r。
    double constant_gain_dB() const { return tx_power_dBm_ + tx_gain_dBi_ + rx_gain_dBi_; }

private:
    const SceneParamFrame* frame_for(double t_s);

    std::string scenario_path_, scenario_id_, entity_id_, site_id_;
    double tx_power_dBm_ = 0.0, tx_gain_dBi_ = 0.0, rx_gain_dBi_ = 0.0;
    bool apply_gain_ = true, apply_doppler_ = true;
    // 增益口径（D-051）：link_budget 保持原有的 tx_power + G_t + G_r − 路损（既有基准照旧）；
    // path_loss_only 只施加 −路损，发射功率与两端天线增益由各自的组件负责。
    std::string gain_mode_ = "link_budget";
    std::string delay_mode_ = "tracking";
    std::size_t max_delay_samples_ = 65536;

    double fs_ = 0.0;
    bool have_fs_ = false;
    std::uint64_t expect_start_ = 0;
    bool have_expect_ = false;
    double phase_ = 0.0;
    std::vector<Complex> tail_;          // 上一块末尾的样点，供整数时延回看
    std::vector<SceneParamFrame> pend_;  // 参数帧队列，游标只前进
    std::size_t cursor_ = 0;
    std::uint64_t fixed_delay_ = 0;
    bool fixed_delay_set_ = false;
    std::uint64_t delay_steps_ = 0;
    std::uint64_t last_delay_ = 0;
    bool have_last_delay_ = false;
    bool held_note_done_ = false;
    ComponentStatus status_;
};

class FreeSpaceChannel : public IComponent {
public:
    std::string type_name() const override { return "FreeSpaceChannel"; }
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

    double path_loss_dB() const { return path_loss_dB_; }

private:
    double distance_m_ = 0.0, frequency_Hz_ = 0.0;
    double tx_power_dBm_ = 0.0, tx_gain_dBi_ = 0.0, rx_gain_dBi_ = 0.0;
    double path_loss_dB_ = 0.0, amplitude_ = 1.0;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_CHANNEL_H
