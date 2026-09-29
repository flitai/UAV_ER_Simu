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
#include "cuav/dsp.h"
#include "cuav/gfsk.h"
#include "cuav/ofdm.h"
#include "cuav/resampler.h"
#include "cuav_geo/activity.h"
#include "cuav_geo/map.h"
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

    // E3 档下的建筑几何与它所在的平面工作帧。E1 / E2 恒为 nullptr——建筑是**懒加载**的
    // （D3-4，07 报告 §7.4）；自 D3-5 起它已接进链路预算（line_of_sight 与 extra_loss_dB）。
    const geo::IMapQuery* scene_map() const { return map_; }
    const geo::SceneFrame& scene_frame() const { return frame_; }
    // 装载器注入的观测区域数据包根目录。公开出来是为了让单测钉住注入这一环：
    // 两处（describe 的参数名、configure 的取值键）拼错任何一处都会静默失效。
    const std::string& scene_root() const { return scene_root_; }

private:
    // 建筑几何的懒加载。只在 init() 里、只在 prop_.level == E3 时调。
    bool load_scene_map(std::string& err);
    // 把地图与平面帧发给各条链路。链路是在 configure() 里搭的（那时还没读建筑），
    // 所以这一步必须在 load_scene_map() 之后、产帧之前。
    bool attach_scene_map(std::string& err);

    // 内部参数（装载器注入）
    std::string scenario_path_, scenario_id_, site_id_, scene_root_;
    // 用户参数
    double sample_rate_Hz_ = 0.0;
    double update_rate_Hz_ = 20.0;
    double report_rate_Hz_ = 10.0;
    bool report_entities_ = true;
    std::uint64_t total_samples_ = 0;
    std::size_t block_samples_ = 65536;

    // 传播效应配置（D-058）。参数声明在本组件上（它是帧生产端、真正用到它们的地方），
    // 界面上显示在「传播信道」卡片的右栏——靠槽位表的代理机制（12 §5.3），不是第二份状态。
    geo::PropagationConfig prop_;

    geo::Scenario scene_;
    std::vector<geo::LinkFrameSource> links_;   // 与 ports_ 严格同序
    std::vector<PortSpec> ports_;
    std::vector<geo::EmitterRuntime> entities_;

    // 进程内共享的建筑桶网格（K 个站共用一份），不属本组件所有、不释放。
    // frame_ 是建筑投到平面米时用的那个帧，**必须与地图同源**（由 shared_scene_map 一并给出）。
    const geo::IMapQuery* map_ = nullptr;
    geo::SceneFrame frame_;

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
    // 样点域的活动时间线（G-6，D-069）：波形按它逐子段推进，粒度是样点不是块。
    // 评价器用同一个类算真值，于是「源怎么发的」与「真值怎么记的」逐位同源。
    geo::ActivitySchedule sched_;
    geo::Waveform waveform_;
    double emitter_center_Hz_ = 0.0;
    double bw_Hz_ = 0.0;
    std::uint64_t burst_period_n_ = 0, burst_on_n_ = 0;

    // noise 波形的带限（C-8 / G-6，D-069）：4 阶巴特沃斯低通，截止 emission.bw_Hz / 2，
    // 状态跨块保持（于是与块长无关）。不带任何用户参数，一切从场景的 bw_Hz 派生。
    bool band_limit_ = false;
    dsp::Biquad lp_[2];
    std::complex<double> lp_state_[4];
    double lp_gain_norm_ = 1.0;           // 1/sqrt(Σ|h|²)，把带限后的功率归回单位功率
    std::size_t lp_settle_ = 0;           // 冲激响应稳定所需样点数，init() 里先推这么多丢掉
    // 绕折功率占比：把中心搬到 ±Δf 之后，离中心比 Fs/2 更远的那半边裙边会绕到带的另一头。
    // 量的是**积分功率占比**而不是带边那一点的衰减 —— 后者会把物理上没问题的配置误判成降级
    // （实测：带边 39 dB 抑制对应的绕折功率只有 2.4e-5）。超过 1e-3 才标降级。
    double alias_frac_ = 0.0;

    // OFDM 族（Q-2，D-088）：ofdm / droneid。结构全来自机型预设表，帧排布来自 geo::FrameSchedule，
    // 原生率逐符号调制（ofdm.cpp）→ 有理重采样（Coder 核，resampler.cpp）→ 整突发开关 → 相位搬移。
    // 每个突发在 configure() 里展开成一行：起止（原生样点）、开没开、频偏、站点样点支撑 [m_lo, m_hi)。
    // 相邻突发至少隔 geo::kBurstMinGapNative 个原生样点，支撑互不重叠，于是每个站点样点至多属于一个突发。
    struct OfdmBurst {
        std::int64_t start_n = 0;
        std::int64_t length_n = 0;
        std::int64_t slot = 0;
        int variant = 0;
        bool on = true;             // 突发起点（连续时间）发射机开着就整突发发完（D-088 ⑥）
        double dphi = 0.0;          // 突发中点时刻的中心频率 + offset_Hz − 观测中心，折成弧度 / 样点（⑦）
        std::int64_t m_lo = 0, m_hi = 0;
    };
    bool configure_ofdm(std::string& err);
    std::complex<double> ofdm_sample(std::int64_t m, std::size_t burst);
    const std::vector<std::complex<double>>& ofdm_native(std::size_t burst);

    const geo::RadiatorPreset* preset_ = nullptr;
    ofdm::Modulator mod_;
    RationalResampler rsmp_;
    std::vector<OfdmBurst> ofdm_bursts_;
    double ofdm_c_ = 1.0;               // 滤波器在各子载波频点的 |H/L|² 均值
    double ofdm_gain_ = 1.0;            // 1/√c：把「发射期间 1 mW」补回精确（量级 < 0.01 dB）
    std::uint64_t payload_key_ = 0;     // init() 从私有子流取一次，突发载荷种子 = mix64(key ^ mix64(时隙))
    std::size_t ofdm_cursor_ = 0;
    std::int64_t native_idx_[2] = {-1, -1};                  // 最近用到的两个突发的原生样点缓存
    std::vector<std::complex<double>> native_[2];
    std::int64_t cycle_idx_ = -1;                            // 最近一拍（站点样点 125c … 125c+124）
    bool cycle_valid_ = false;
    std::vector<std::complex<double>> cycle_out_, win_;
    bool ofdm_note_done_ = false;

    // GFSK 族（Q-3，D-089）：gfsk。调制与帧来自 GFSK 族预设表，帧排布来自 geo::GfskSchedule（确定、不抽签），
    // 相位按任意时刻闭式求值（gfsk.cpp，不经重采样）→ 整包开关 → 相位搬移。每个包在 configure() 里展开成一行：
    // 起止（秒）、开没开、频偏、站点样点支撑 [m_lo, m_hi)（两端经 geo::sample_at，与评价器同一取整口径）。
    struct GfskBurstRt {
        std::int64_t index = 0;     // 全局包序号：载荷种子 = mix64(payload_key_ ^ mix64(index))
        double t0_s = 0.0;
        int n_bits = 0;
        bool on = true;             // 包起点时刻发射机开着就整包发完（同 D-088 ⑥）
        double dphi = 0.0;          // 包中点时刻的中心频率 + offset_Hz − 观测中心，折成弧度 / 样点（同 ⑦）
        std::int64_t m_lo = 0, m_hi = 0;
    };
    bool configure_gfsk(std::string& err);
    const geo::GfskPreset* gpreset_ = nullptr;
    gfsk::Modulator gmod_;
    std::vector<GfskBurstRt> gfsk_bursts_;
    std::size_t gfsk_cursor_ = 0;
    std::int64_t gfsk_cached_ = -1;                          // gfsk_pk_ 是哪个包的比特
    gfsk::Packet gfsk_pk_;
    std::vector<signed char> gfsk_bits_;
    bool gfsk_note_done_ = false;

    Xoshiro256pp sub_rng_{0};             // 私有随机子流，见 .cpp 里的理由
    bool sub_ready_ = false;
    double phase_ = 0.0;                  // 载波相位累加器，跨块连续
    std::uint64_t produced_ = 0;
    bool band_note_done_ = false;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_SCENARIO_H
