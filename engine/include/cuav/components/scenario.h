// 场景运行时组件（06 备忘录 §9C G-2；决策 D-033）。
//
//   ScenarioSource      站点视角的参数帧源：每条链路一个 SceneParamFrame 输出口 link:<emitter_id>，
//                       按样点序号出帧；实体状态与链路读数经观察者回调上报，不做端口类型。
//   SceneEmitterSource  场景绑定的辐射源：按 emission.waveform 生成 tone / noise / burst，
//                       归一化到**发射期间**单位功率（0 dBm），绝对电平交给施加类信道。
//
// 两者的 scenario_path / scenario_id / site_id / entity_id 都是**内部参数**：画布上只见
// scene_binding，装载器把它解析成这些参数注入（与 data_id → manifest_path 同法，D-037）。
//
// 调度上的硬约束（08 报告 §9.3，来自 engine/src/graph.cpp:227-249 的实测）：
// 调度器每轮无条件把上游产出**覆盖**进下游缓冲，且 process 之后无条件清空输入缓冲。
// 所以 ScenarioSource **每一轮都必须产出**（哪怕只是重发上一帧），否则下游信道会因为
// scene 口没数据而跳过一轮，下一轮的 IQ 块就把没被消费的块静默覆盖掉——样点丢了还不报错。

#ifndef CUAV_COMPONENTS_SCENARIO_H
#define CUAV_COMPONENTS_SCENARIO_H

#include <cstdint>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/observer.h"
#include "cuav/random.h"
#include "cuav_geo/scenario.h"

namespace cuav {

class ScenarioSource : public IComponent {
public:
    ScenarioSource();

    std::string type_name() const override { return "ScenarioSource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    // configure() 之后按场景 emitters 的数组顺序给出 link:<emitter_id>；之前为空。
    // Graph::connect 在 configure 之后调用，所以连线查得到；describe() 在未 configure 的实例上
    // 调用，只能给 has_dynamic_ports 四字段——目录里的动态端口声明正是为此存在。
    std::vector<PortSpec> outputs() const override { return ports_; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    double update_rate_Hz() const { return update_rate_Hz_; }

private:
    // 内部参数（装载器注入）
    std::string scenario_path_, scenario_id_, site_id_;
    // 用户参数
    double sample_rate_Hz_ = 0.0;
    double update_rate_Hz_ = 20.0;
    double report_rate_Hz_ = 10.0;
    bool report_entities_ = true;
    std::uint64_t total_samples_ = 0;
    std::size_t block_samples_ = 65536;

    geo::Scenario scene_;
    std::vector<geo::LinkFrameSource> links_;   // 与 ports_ 严格同序
    std::vector<PortSpec> ports_;
    std::vector<geo::EmitterRuntime> entities_;

    std::uint64_t produced_ = 0;
    std::uint64_t report_every_ = 2;
    std::uint64_t reported_upto_ = 0;           // 已上报到的帧序号（开区间上界）
    IRunObserver* obs_ = nullptr;
    ComponentStatus status_;
};

class SceneEmitterSource : public IComponent {
public:
    SceneEmitterSource();

    std::string type_name() const override { return "SceneEmitterSource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    std::string scenario_path_, scenario_id_, entity_id_;
    double sample_rate_Hz_ = 0.0;
    double center_frequency_Hz_ = 0.0;    // 观测中心频率（站点接收机的），不是辐射源的
    std::uint64_t total_samples_ = 0;
    std::size_t block_samples_ = 65536;
    // 按发射功率标定输出电平（D-051）。假时保持原有的单位功率归一化，既有示例与基准因此不变。
    bool emit_at_tx_power_ = false;
    double tx_power_amp_ = 1.0;

    geo::Scenario scene_;
    geo::EmitterRuntime emitter_;
    geo::Waveform waveform_;
    double emitter_center_Hz_ = 0.0;
    double bw_Hz_ = 0.0;
    std::uint64_t burst_period_n_ = 0, burst_on_n_ = 0;

    Xoshiro256pp sub_rng_{0};             // 私有随机子流，见 .cpp 里的理由
    bool sub_ready_ = false;
    double phase_ = 0.0;                  // 载波相位累加器，跨块连续
    std::uint64_t produced_ = 0;
    bool band_note_done_ = false;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_SCENARIO_H
