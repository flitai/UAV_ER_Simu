// 测向与定位组件（06 备忘录 §9H L-3 至 L-5；决策 D-053，11 报告 §3）。
//
//   DirectionFinder   入 scene1..scene8（SceneParamFrame，全可选）+ det（DetectionList，可选）
//                     出 out(BearingReport)。EM-S-05 的 E2 档效应模型。
//
// **它是「测向算法的统计模型」，不是被测的测向算法**（11 报告 §1.3）。它从链路参数帧取真值
// 方位与电平，按噪声系数算信噪比，按七分量误差预算得 σ_θ，抽一个高斯样本作为量测方位。
// 取真值合法的依据是 01 §6.2（模型的输入可以是真值）；04 §5.2「真值只进评价器」约束的是
// 被测的 M3 算法（检测器、识别器），本组件不在其列。代价是必须声明三件事：
//   ① model_layer = M2、credibility = V2；② 每行 truth_consumed = true；
//   ③ 模型卡写明「散布来自建模的误差预算，不代表任何真实测向设备的实测性能」。
// 05 P1 的阵列估计器（MUSIC / 相位干涉）将来从 ArrayIQStream 出发算方位，输出**同一个端口**
// 替换它，框图形状与下游一件不改，那时 truth_consumed 才变成 false。
//
// 八个 scene 口全部可选，真正的下限由 check_wiring() 声明（至少一路），
// 失败映射到装载器错误码 port_optional。

#ifndef CUAV_COMPONENTS_LOCATE_H
#define CUAV_COMPONENTS_LOCATE_H

#include <map>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/random.h"
#include "cuav_geo/df_error.h"
#include "cuav_geo/scenario.h"

namespace cuav {

// 固定可选口的名字：in1..in8 / scene1..scene8 / b1..b8 / t1..t8（D-053 §6.4）。
// 动态端口只有 ScenarioSource 一个使用者，为四个新组件再开一套动态端口不划算，
// 而 N、K ≤ 8 对演示够用；身份靠帧与报告自带的 site_id / emitter_id / link_id，不靠端口序号。
std::vector<PortSpec> optional_ports(const char* prefix, PortType type, int count = 8);

class DirectionFinder : public IComponent {
public:
    std::string type_name() const override { return "DirectionFinder"; }
    std::vector<PortSpec> inputs() const override {
        std::vector<PortSpec> v = optional_ports("scene", PortType::SceneParamFrame);
        PortSpec det{"det", PortType::DetectionList};
        det.optional = true;
        v.push_back(det);
        return v;
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::BearingReport}};
    }
    ComponentInfo describe() const override;
    bool check_wiring(const std::vector<std::string>& wired, std::string& err) const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 供单测：本站对某条链路在给定信噪比下的预算（不抽样，确定性）
    const geo::DfErrorBudget& budget() const { return budget_; }

private:
    // 一条链路的上一帧读数，用于同频混叠判定与逐帧节流
    struct LinkState {
        std::string link_id, site_id, emitter_id;
        double last_report_t_s;
        bool has_reported;
        LinkState() : last_report_t_s(0.0), has_reported(false) {}
    };

    geo::DfErrorBudget budget_;
    std::vector<double> q_thresholds_;
    double min_snr_dB_ = 3.0;
    double mixture_separation_dB_ = 10.0;
    double report_rate_Hz_ = 10.0;
    std::string method_ = "amplitude_compare";
    // 场景派生量：站的采样率与噪声系数、各源的发射功率与天线增益
    std::string scenario_path_, scenario_id_, site_id_;
    double bandwidth_Hz_ = 0.0;
    double rx_center_Hz_ = 0.0;
    double rx_gain_dBi_ = 0.0;
    double site_lon_ = 0.0, site_lat_ = 0.0, site_alt_m_ = 0.0;
    std::map<std::string, double> tx_power_dBm_;   // emitter_id → 发射功率
    std::map<std::string, double> tx_gain_dBi_;
    std::map<std::string, double> tx_bw_Hz_;       // 判占用带是否重叠要用

    Xoshiro256pp sub_rng_{0};      // 私有随机子流，与 SceneEmitterSource 同法（铁律 9）
    IRunObserver* obs_ = nullptr;
    ComponentStatus status_;
    std::map<std::string, LinkState> links_;
};

/**
 * 到达时间估计（algorithm / M2 / E2 / EM-S-07，D-053 §3.3）。
 *
 * **隐含节点**：用户不选、不配参数——时差定位的到达时间只应该有一种口径，
 * 暴露成槽位只会让人以为可以换。与 `DirectionFinder` 一样是 M2 效应模型：
 * 从帧取真值时延，按误差预算加噪，每行带 `truth_consumed`。
 *
 * **站钟全部来自场景**（`sites[].clock`）。缺 `clock` 即 configure 失败，**不默认完美时钟**——
 * 默认 0 ns 会让时差定位的结果好得不真实（铁律 15）。
 *
 * 与 emcore 的一处有意差别：σ_pick 的相关带宽取**站的实际采样率**，不是写死的 10 MHz。
 * 写死常数会给出与配置无关的假精度——500 kS/s 与 20 MS/s 的时差精度差 40 倍。
 */
class ToaEstimator : public IComponent {
public:
    std::string type_name() const override { return "ToaEstimator"; }
    std::vector<PortSpec> inputs() const override {
        return optional_ports("scene", PortType::SceneParamFrame);
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::ToaReport}};
    }
    ComponentInfo describe() const override;
    bool check_wiring(const std::vector<std::string>& wired, std::string& err) const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    double min_snr_dB_ = 3.0;
    double sigma_floor_ns_ = 0.3;
    double report_rate_Hz_ = 10.0;
    std::string scenario_path_, scenario_id_, site_id_;
    double bandwidth_Hz_ = 0.0;
    double rx_gain_dBi_ = 0.0;
    double site_lon_ = 0.0, site_lat_ = 0.0, site_alt_m_ = 0.0;
    // 站钟（场景里的建模值）
    double sync_sigma_ns_ = 0.0, bias_ns_ = 0.0, rx_delay_ns_ = 0.0, rx_delay_sigma_ns_ = 0.0;
    std::string sync_state_;
    std::map<std::string, double> tx_power_dBm_, tx_gain_dBi_;

    Xoshiro256pp sub_rng_{0};
    IRunObserver* obs_ = nullptr;
    ComponentStatus status_;
    std::map<std::string, double> last_report_t_s_;
};

/**
 * 多站定位（algorithm / M2 / E2 / EM-S-06 + EM-S-07，D-053 §3.4）。
 *
 * 一个组件一个下拉：`method ∈ {aoa, tdoa, aoa_tdoa}`，「关」= 槽位旁路。
 * 输入 `b1..b8`（测向报告）与 `t1..t8`（到达时间报告）全部可选，
 * 真正的下限由 `check_wiring()` 按 method 声明（aoa ≥ 2 路 b，tdoa ≥ 3 路 t）。
 *
 * **它是纯函数式的**：站址随报告走（BearingReport.site_lon/lat），不绑场景、不读场景文件。
 * 「绑一个站」对全图唯一的融合节点本来就没有语义。
 *
 * 站数不足或几何退化时输出一行 `state = invalid` 并写明原因，不是不输出（铁律 15）。
 */
class MultiSiteLocator : public IComponent {
public:
    std::string type_name() const override { return "MultiSiteLocator"; }
    std::vector<PortSpec> inputs() const override {
        std::vector<PortSpec> v = optional_ports("b", PortType::BearingReport);
        const std::vector<PortSpec> t = optional_ports("t", PortType::ToaReport);
        v.insert(v.end(), t.begin(), t.end());
        return v;
    }
    std::vector<PortSpec> outputs() const override {
        return {PortSpec{"out", PortType::PositionReport}};
    }
    ComponentInfo describe() const override;
    bool check_wiring(const std::vector<std::string>& wired, std::string& err) const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

private:
    void solve_group(double t_s, const std::string& emitter_id,
                     const std::vector<const BearingReport*>& bs,
                     const std::vector<const ToaReport*>& ts);
    void solve_tdoa(PositionReport& r, const std::vector<const ToaReport*>& ts,
                    const double* init_x, const double* init_y);

    std::string method_ = "aoa";
    double min_crossing_angle_deg_ = 10.0;
    double geometry_condition_threshold_ = 15.0;
    double max_tdoa_feasibility_margin_m_ = 50.0;
    double propagation_speed_mps_ = 299792458.0;
    std::string reference_station_rule_ = "best_snr";
    std::string weighting_ = "correlated_reference";
    int sync_quality_threshold_ = 3;
    double time_tolerance_s_ = 1e-6;
    std::string coord_version_ = "wgs84-2026-09";

    IRunObserver* obs_ = nullptr;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_LOCATE_H
