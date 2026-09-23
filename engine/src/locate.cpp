#include "cuav/numstr.h"
#include "cuav/components/locate.h"

#include <algorithm>
#include <cmath>

#include "cuav/observer.h"
#include "cuav/scenario_json.h"
#include "cuav_geo/geodesy.h"
#include "cuav_geo/link_budget.h"
#include "cuav_geo/locate_aoa.h"
#include "cuav_geo/locate_tdoa.h"

namespace cuav {
namespace {

double get_num(const std::map<std::string, double>& p, const char* key, double def) {
    std::map<std::string, double>::const_iterator it = p.find(key);
    return it == p.end() ? def : it->second;
}

bool get_text(const std::map<std::string, std::string>& t, const char* key, std::string& out) {
    std::map<std::string, std::string>::const_iterator it = t.find(key);
    if (it == t.end()) return false;
    out = it->second;
    return true;
}

ModelTrace df_trace(const std::string& trace_id) {
    ModelTrace t;
    t.model_id = "EM-S-05";
    t.model_version = "0.1.0";
    t.model_level = "E2";
    // M2：效应级模型，不是 M3 的样点处理。credibility 封顶 V2——有解析锚点与蒙特卡洛自洽，
    // 但没有任何实测测向数据校准过（11 报告 §1.3 的第三条声明）。
    t.model_layer = "M2";
    t.credibility = "V2";
    t.parameter_version = "df-effect-v1";
    t.trace_id = trace_id;
    return t;
}

double wrap360(double a) {
    a = std::fmod(a, 360.0);
    if (a < 0.0) a += 360.0;
    return a;
}

}  // namespace

std::vector<PortSpec> optional_ports(const char* prefix, PortType type, int count) {
    std::vector<PortSpec> v;
    for (int k = 1; k <= count; ++k) {
        PortSpec p;
        p.name = std::string(prefix) + static_cast<char>('0' + k);
        p.type = type;
        p.optional = true;
        v.push_back(p);
    }
    return v;
}

// ------------------------------------------------------------- DirectionFinder

ComponentInfo DirectionFinder::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "单站测向";
    i.description =
        "按误差预算给出本站对每条链路的方位量测（EM-S-05 的 E2 档效应模型，D-053）。"
        "从链路参数帧取真值方位与电平，按站点噪声系数算信噪比，七个分量合成 1σ 后抽一个高斯样本。"
        "**它是测向算法的统计模型，不是被测的测向算法**：每一行带 truth_consumed = true，"
        "溯源 model_layer = M2、credibility = V2，指标只能当作模型自洽性检查，不得当作设备定位精度。"
        "后置能力包 P1 的阵列估计器（MUSIC / 相位干涉）将来从 ArrayIQStream 出发算方位，"
        "输出同一个端口替换本组件，框图形状不变。"
        "同站同频多源时给较弱的那个源加混叠项并标 use_policy = low_weight——"
        "比幅与干涉测向在两个同频信号功率接近时会指向能量质心。"
        "发射不在（tx_on 为假）或信噪比低于 min_snr_dB 时仍出一行，"
        "只是 df_result_state = invalid 并写明原因，不是不输出（铁律 15）。";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "EM-S-05";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = true;
    i.stateful = true;
    i.params = {
        ParamSpec::choice("method", {"amplitude_compare", "interferometer"},
                          "测向体制。本档只影响报告里的标注与 sigma_method_deg 的取值口径，"
                          "不改变算法——两种体制的样点级差异要等 P1 的阵列估计器")
            .def_text("amplitude_compare"),
        ParamSpec::number("sigma_method_deg", "deg", "体制固有分辨力（通道一致性、基线量化）")
            .def(1.5).at_least(0.0),
        ParamSpec::number("sigma_snr_ref_deg", "deg", "参考信噪比处的信噪比项；"
                          "σ_snr = 本值 · √(SNR_ref / max(SNR, 1))")
            .def(2.0).at_least(0.0),
        ParamSpec::number("snr_ref_dB", "dB", "上一项的参考信噪比").def(10.0),
        ParamSpec::number("sigma_cal_deg", "deg", "标校残差").def(0.5).at_least(0.0),
        ParamSpec::number("sigma_att_deg", "deg", "平台姿态与方位基准误差").def(0.3).at_least(0.0),
        ParamSpec::number("sigma_mp_los_deg", "deg", "视距下的多径项").def(0.5).at_least(0.0),
        ParamSpec::number("sigma_mp_nlos_deg", "deg",
                          "非视距下的多径项。D3 的遮挡接入之前帧里的视距恒为真，本项实际不生效")
            .def(5.0).at_least(0.0),
        ParamSpec::number("sigma_mix_deg", "deg", "同站同频多源混叠项，只加在被压住的那个源上")
            .def(8.0).at_least(0.0),
        ParamSpec::number("bias_deg", "deg", "系统偏差。不进方差，直接加在方位上；"
                          "模型卡说明它模拟未标校的固定指向偏差")
            .def(0.0),
        ParamSpec::number("min_snr_dB", "dB", "低于此信噪比即判 invalid，不出方位").def(3.0),
        ParamSpec::number("mixture_separation_dB", "dB",
                          "同频两源的电平差小于它才判混叠；差得多时弱信号被强信号压住，不算混叠")
            .def(10.0).at_least(0.0),
        ParamSpec::number("q_thr1_deg", "deg", "DF-Q1 的 σ 上限").def(2.0).at_least(0.0),
        ParamSpec::number("q_thr2_deg", "deg", "DF-Q2 的 σ 上限").def(5.0).at_least(0.0),
        ParamSpec::number("q_thr3_deg", "deg", "DF-Q3 的 σ 上限").def(15.0).at_least(0.0),
        ParamSpec::number("q_thr4_deg", "deg", "DF-Q4 的 σ 上限；超出即 invalid").def(45.0).at_least(0.0),
        ParamSpec::number("report_rate_Hz", "Hz", "出报告的速率。按样点序号推进，不按墙钟（D-049 ③）")
            .def(10.0).at_least(0.0, true),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("site_id", "本测向站的标识，由装载器按 scene_binding 注入").internal_only(),
    };
    return i;
}

bool DirectionFinder::check_wiring(const std::vector<std::string>& wired, std::string& err) const {
    for (std::size_t i = 0; i < wired.size(); ++i) {
        if (wired[i].compare(0, 5, "scene") == 0) return true;
    }
    err = "单站测向至少要接一路场景参数帧（scene1..scene8），否则没有链路可测";
    return false;
}

bool DirectionFinder::configure(const std::map<std::string, double>& params,
                                const std::map<std::string, std::string>& text_params,
                                std::string& err) {
    get_text(text_params, "method", method_);
    if (method_.empty()) method_ = "amplitude_compare";
    if (method_ != "amplitude_compare" && method_ != "interferometer") {
        err = "method 必须是 amplitude_compare / interferometer 之一";
        return false;
    }
    budget_.sigma_method_deg = get_num(params, "sigma_method_deg", 1.5);
    budget_.sigma_snr_ref_deg = get_num(params, "sigma_snr_ref_deg", 2.0);
    budget_.snr_ref_dB = get_num(params, "snr_ref_dB", 10.0);
    budget_.sigma_cal_deg = get_num(params, "sigma_cal_deg", 0.5);
    budget_.sigma_att_deg = get_num(params, "sigma_att_deg", 0.3);
    budget_.sigma_mp_los_deg = get_num(params, "sigma_mp_los_deg", 0.5);
    budget_.sigma_mp_nlos_deg = get_num(params, "sigma_mp_nlos_deg", 5.0);
    budget_.sigma_mix_deg = get_num(params, "sigma_mix_deg", 8.0);
    budget_.bias_deg = get_num(params, "bias_deg", 0.0);
    min_snr_dB_ = get_num(params, "min_snr_dB", 3.0);
    mixture_separation_dB_ = get_num(params, "mixture_separation_dB", 10.0);
    report_rate_Hz_ = get_num(params, "report_rate_Hz", 10.0);
    if (!(report_rate_Hz_ > 0.0)) { err = "report_rate_Hz 必须为正"; return false; }

    q_thresholds_.clear();
    q_thresholds_.push_back(get_num(params, "q_thr1_deg", 2.0));
    q_thresholds_.push_back(get_num(params, "q_thr2_deg", 5.0));
    q_thresholds_.push_back(get_num(params, "q_thr3_deg", 15.0));
    q_thresholds_.push_back(get_num(params, "q_thr4_deg", 45.0));
    for (std::size_t i = 1; i < q_thresholds_.size(); ++i) {
        if (q_thresholds_[i] < q_thresholds_[i - 1]) {
            err = "DF-Q 的四个门限必须非降";
            return false;
        }
    }

    get_text(text_params, "scenario_path", scenario_path_);
    get_text(text_params, "scenario_id", scenario_id_);
    get_text(text_params, "site_id", site_id_);
    if (scenario_path_.empty()) {
        err = "DirectionFinder 缺内部参数 scenario_path。它由装载器按节点的 scene_binding 解析注入"
              "（框图里只写 scene_binding，D-037）；单机运行请给 cuav_run --scenario <场景文件>";
        return false;
    }
    LoadedScenario ls;
    if (!load_scenario_file(scenario_path_, ls, err)) return false;
    if (!scenario_id_.empty() && ls.scenario.scenario_id != scenario_id_) {
        err = "DirectionFinder 绑定的场景标识是 " + scenario_id_ + "，但文件里的是 " + ls.scenario.scenario_id;
        return false;
    }
    // 站：没绑就取唯一站（与 SceneBoundChannel 同一口径，D-053 §6.3）
    const geo::Site* site = 0;
    if (site_id_.empty()) {
        if (ls.scenario.sites.size() != 1) {
            err = "多站场景（" + numstr(ls.scenario.sites.size()) +
                  " 个站点）的测向组件必须在 scene_binding 里绑定 site_id";
            return false;
        }
        site = &ls.scenario.sites[0];
        site_id_ = site->id;
    } else {
        site = ls.scenario.find_site(site_id_);
        if (site == 0) { err = "场景 " + ls.scenario.scenario_id + " 里没有站点 " + site_id_; return false; }
    }
    // 信噪比要用的三件都从场景派生，不再开用户参数：它们已经在场景里声明过一次，
    // 让用户在测向卡片上再填一遍必然会与场景脱节。
    bandwidth_Hz_ = site->receiver.fs_Hz;
    rx_center_Hz_ = site->receiver.center_Hz;
    rx_gain_dBi_ = site->antenna.gain_dBi;
    site_lon_ = site->position.lon_deg;
    site_lat_ = site->position.lat_deg;
    site_alt_m_ = site->position.alt_m;
    tx_power_dBm_.clear();
    tx_gain_dBi_.clear();
    tx_bw_Hz_.clear();
    for (std::size_t i = 0; i < ls.scenario.emitters.size(); ++i) {
        const geo::Emitter& e = ls.scenario.emitters[i];
        tx_power_dBm_[e.id] = e.emission.tx_power_dBm;
        tx_gain_dBi_[e.id] = e.emission.antenna_gain_dBi;
        tx_bw_Hz_[e.id] = e.emission.bw_Hz;
    }
    return true;
}

bool DirectionFinder::init(IRandom& rng, std::string& err) {
    (void)err;
    // 私有子流：本组件抽多少个样都不影响其它组件的随机序列（铁律 9）
    sub_rng_ = Xoshiro256pp(rng.next_u64());
    status_ = ComponentStatus();
    links_.clear();
    return true;
}

Step DirectionFinder::process(PortMap& in, PortMap& out, std::string& err) {
    (void)err;
    // 两条路径各有各的用处，都要走：
    //   端口 → 下游的融合节点（MultiSiteLocator）按数据流拿到本轮的报告；
    //   观察者 → 运行器落 bearings.jsonl 并发事件（与 EntityState / LinkFrame 同法，D-033）。
    // 起初只写了观察者，结果多站定位一行也出不来——端口上是空的。
    PortData outd;
    outd.type = PortType::BearingReport;

    // 收本轮到手的全部帧，按时刻分组：同一时刻的各链路要一起判混叠
    struct Item {
        const SceneParamFrame* f;
        double prx_dBm;
        double snr_dB;
    };
    std::vector<Item> items;
    for (int k = 1; k <= 8; ++k) {
        const std::string name = std::string("scene") + static_cast<char>('0' + k);
        PortMap::iterator it = in.find(name);
        if (it == in.end() || !it->second.has_data) continue;
        for (std::size_t i = 0; i < it->second.scenes.size(); ++i) {
            const SceneParamFrame& f = it->second.scenes[i];
            Item x;
            x.f = &f;
            std::map<std::string, double>::const_iterator tp = tx_power_dBm_.find(f.emitter_id);
            std::map<std::string, double>::const_iterator tg = tx_gain_dBi_.find(f.emitter_id);
            const double txp = tp == tx_power_dBm_.end() ? 0.0 : tp->second;
            const double txg = tg == tx_gain_dBi_.end() ? 0.0 : tg->second;
            x.prx_dBm = txp + txg + rx_gain_dBi_ - f.path_loss_dB;
            const double n_dBm = f.noise_floor_dBm_per_Hz + 10.0 * std::log10(bandwidth_Hz_);
            x.snr_dB = x.prx_dBm - n_dBm;
            items.push_back(x);
        }
    }
    if (items.empty()) return Step::Idle;

    const double period_s = 1.0 / report_rate_Hz_;
    std::size_t produced = 0;
    for (std::size_t i = 0; i < items.size(); ++i) {
        const SceneParamFrame& f = *items[i].f;
        const std::string key = f.link_id.empty() ? (f.site_id + "-" + f.emitter_id) : f.link_id;
        LinkState& st = links_[key];
        if (!st.has_reported) {
            st.link_id = key;
            st.site_id = f.site_id;
            st.emitter_id = f.emitter_id;
        }
        // 按样点序号推进的帧时间做节流：帧会跨轮重发，同一帧只报一次
        const double t = f.valid_from_s;
        if (st.has_reported && t < st.last_report_t_s + period_s - 1e-12) continue;
        st.last_report_t_s = t;
        st.has_reported = true;

        // 同站同频多源的混叠判定。三个条件缺一不可：
        //   ① 两个源的**占用带**重叠（|Δf| < (B_i + B_j)/2），且都落在本站的接收带内——
        //      带不重叠的两个源，比幅测向本来就分得开；
        //   ② 对方更强（较强的那个不受影响，被压住的是较弱的那个）；
        //   ③ 两者电平差小于 mixture_separation_dB——功率接近时测向才会指向能量质心，
        //      差得远时弱信号只是被淹没，不是"指偏"。
        // 第 ③ 条第一版写成了「对方 ≥ 本方 − separation 且 对方 ≥ 本方」，
        // 化简后就是「对方更强」，那道闸等于没有：golden-03 上 1800 行里报了 1200 行混叠，
        // 连相差 15 dB 的突发源都算了进去。
        const double bw_i = tx_bw_Hz_.count(f.emitter_id) ? tx_bw_Hz_[f.emitter_id] : 0.0;
        const bool in_rx_i = std::fabs(f.tx_center_Hz - rx_center_Hz_) < bandwidth_Hz_ / 2.0;
        bool mixture = false;
        for (std::size_t j = 0; in_rx_i && j < items.size(); ++j) {
            if (j == i) continue;
            const SceneParamFrame& g = *items[j].f;
            if (g.emitter_id == f.emitter_id) continue;
            if (std::fabs(g.valid_from_s - f.valid_from_s) > 1e-9) continue;
            if (!g.tx_on) continue;
            if (std::fabs(g.tx_center_Hz - rx_center_Hz_) >= bandwidth_Hz_ / 2.0) continue;
            const double bw_j = tx_bw_Hz_.count(g.emitter_id) ? tx_bw_Hz_[g.emitter_id] : 0.0;
            if (std::fabs(g.tx_center_Hz - f.tx_center_Hz) >= (bw_i + bw_j) / 2.0) continue;
            const double d = items[j].prx_dBm - items[i].prx_dBm;
            if (d >= 0.0 && d < mixture_separation_dB_) { mixture = true; break; }
        }

        BearingReport r;
        r.t_s = t;
        r.site_id = f.site_id.empty() ? site_id_ : f.site_id;
        r.site_lon = site_lon_;
        r.site_lat = site_lat_;
        r.site_alt_m = site_alt_m_;
        r.emitter_id = f.emitter_id;
        r.link_id = key;
        r.elevation_deg = f.aoa_el_deg;
        r.snr_dB = items[i].snr_dB;
        r.level_dBm = items[i].prx_dBm;
        r.method = method_;
        r.bias_deg = budget_.bias_deg;
        r.line_of_sight = f.line_of_sight;
        r.mixture = mixture;
        r.truth_consumed = true;
        r.state = f.state;
        r.trace = df_trace(scenario_id_ + ":" + key);

        const geo::DfSigmaParts p = geo::df_sigma_total(budget_, r.snr_dB, f.line_of_sight, mixture);
        r.sigma.method_deg = p.method_deg;
        r.sigma.snr_deg = p.snr_deg;
        r.sigma.cal_deg = p.cal_deg;
        r.sigma.att_deg = p.att_deg;
        r.sigma.multipath_deg = p.multipath_deg;
        r.sigma.mixture_deg = p.mixture_deg;
        r.bearing_std_deg = p.total_deg;

        if (!f.tx_on) {
            r.df_result_state = State::Invalid;
            r.df_quality = "invalid";
            r.use_policy = "exclude";
            r.reasons.push_back("tx_off");
            r.bearing_deg = 0.0;
        } else if (r.snr_dB < min_snr_dB_) {
            r.df_result_state = State::Invalid;
            r.df_quality = "invalid";
            r.use_policy = "exclude";
            r.reasons.push_back("snr_below_min");
            r.bearing_deg = 0.0;
        } else {
            // 抽样。真值方位来自帧的 aoa_az_deg（站点看辐射源的方向，严格 ENU 算出）
            r.bearing_deg = wrap360(f.aoa_az_deg + budget_.bias_deg + p.total_deg * sub_rng_.normal());
            r.df_quality = geo::df_quality_grade(p.total_deg, q_thresholds_);
            if (r.df_quality == "invalid") {
                r.df_result_state = State::Invalid;
                r.use_policy = "exclude";
                r.reasons.push_back("sigma_beyond_grades");
            } else if (mixture) {
                r.df_result_state = State::Degraded;
                r.use_policy = "low_weight";
                r.reasons.push_back("mixture");
            } else {
                r.df_result_state = State::Valid;
                r.use_policy = "normal";
            }
        }

        if (obs_ != 0) obs_->on_bearing(r);
        outd.bearings.push_back(r);
        ++produced;
    }

    if (produced) {
        outd.has_data = true;
        out["out"] = outd;
    }
    status_.blocks_in++;
    status_.blocks_out += produced;
    return produced ? Step::Produced : Step::Idle;
}

void DirectionFinder::reset() {
    status_ = ComponentStatus();
    links_.clear();
}

// --------------------------------------------------------------- ToaEstimator

namespace {

ModelTrace toa_trace(const std::string& trace_id) {
    ModelTrace t;
    t.model_id = "EM-S-07";
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M2";
    t.credibility = "V2";
    t.parameter_version = "toa-effect-v1";
    t.trace_id = trace_id;
    return t;
}

}  // namespace

ComponentInfo ToaEstimator::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "到达时间估计";
    i.description =
        "给出本站对每条链路的到达时刻量测（EM-S-07 的 E2 档效应模型，D-053）。"
        "从链路参数帧取真值时延，按 σ_pick ⊕ σ_floor ⊕ σ_sync ⊕ σ_rxdelay 的预算加噪，"
        "并加上站钟的固定偏差与接收通道群时延。"
        "**σ_pick 的相关带宽取本站的实际采样率**，不是写死的标称值——写死会给出与配置无关的假精度。"
        "站钟全部来自场景的 sites[].clock；**缺 clock 即拒绝运行，不默认一个完美时钟**（铁律 15）。"
        "与测向同为 M2 效应模型：每行带 truth_consumed，指标不得当作设备时统性能。"
        "典型链路视图把它作为隐含节点自动接上，用户不单独配置——"
        "时差定位的到达时间只应该有一种口径。";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "EM-S-07";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = true;
    i.stateful = true;
    i.params = {
        ParamSpec::number("min_snr_dB", "dB", "低于此信噪比即判 invalid，不出到达时刻").def(3.0),
        ParamSpec::number("sigma_floor_ns", "ns", "不可消减的时戳底噪（量化与群时延残差）")
            .def(0.3).at_least(0.0),
        ParamSpec::number("report_rate_Hz", "Hz", "出报告的速率，按样点序号推进")
            .def(10.0).at_least(0.0, true),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("site_id", "本站标识，由装载器按 scene_binding 注入").internal_only(),
    };
    return i;
}

bool ToaEstimator::check_wiring(const std::vector<std::string>& wired, std::string& err) const {
    for (std::size_t i = 0; i < wired.size(); ++i) {
        if (wired[i].compare(0, 5, "scene") == 0) return true;
    }
    err = "到达时间估计至少要接一路场景参数帧（scene1..scene8）";
    return false;
}

bool ToaEstimator::configure(const std::map<std::string, double>& params,
                             const std::map<std::string, std::string>& text_params,
                             std::string& err) {
    min_snr_dB_ = get_num(params, "min_snr_dB", 3.0);
    sigma_floor_ns_ = get_num(params, "sigma_floor_ns", 0.3);
    report_rate_Hz_ = get_num(params, "report_rate_Hz", 10.0);
    if (!(report_rate_Hz_ > 0.0)) { err = "report_rate_Hz 必须为正"; return false; }

    get_text(text_params, "scenario_path", scenario_path_);
    get_text(text_params, "scenario_id", scenario_id_);
    get_text(text_params, "site_id", site_id_);
    if (scenario_path_.empty()) {
        err = "ToaEstimator 缺内部参数 scenario_path。它由装载器按节点的 scene_binding 解析注入";
        return false;
    }
    LoadedScenario ls;
    if (!load_scenario_file(scenario_path_, ls, err)) return false;
    const geo::Site* site = 0;
    if (site_id_.empty()) {
        if (ls.scenario.sites.size() != 1) {
            err = "多站场景的到达时间估计必须在 scene_binding 里绑定 site_id";
            return false;
        }
        site = &ls.scenario.sites[0];
        site_id_ = site->id;
    } else {
        site = ls.scenario.find_site(site_id_);
        if (site == 0) { err = "场景 " + ls.scenario.scenario_id + " 里没有站点 " + site_id_; return false; }
    }
    // 站钟：缺席即拒绝。默认一个完美时钟会让时差定位好得不真实（铁律 15、D-053 §6.5）
    if (!site->clock.has_clock) {
        err = "站点 " + site_id_ + " 没有 clock（站钟与时统）字段，时差定位无从谈起。"
              "请在场景里给它一个 clock：{sync_sigma_ns, bias_ns, rx_delay_ns, rx_delay_sigma_ns, sync_state}；"
              "这些是 LogicalSim 下**建模的**同步误差，不是真实设备指标（11 报告 §6.5）";
        return false;
    }
    sync_sigma_ns_ = site->clock.sync_sigma_ns;
    bias_ns_ = site->clock.bias_ns;
    rx_delay_ns_ = site->clock.rx_delay_ns;
    rx_delay_sigma_ns_ = site->clock.rx_delay_sigma_ns;
    sync_state_ = geo::to_string(site->clock.sync_state);

    bandwidth_Hz_ = site->receiver.fs_Hz;
    rx_gain_dBi_ = site->antenna.gain_dBi;
    site_lon_ = site->position.lon_deg;
    site_lat_ = site->position.lat_deg;
    site_alt_m_ = site->position.alt_m;
    tx_power_dBm_.clear();
    tx_gain_dBi_.clear();
    for (std::size_t i = 0; i < ls.scenario.emitters.size(); ++i) {
        const geo::Emitter& e = ls.scenario.emitters[i];
        tx_power_dBm_[e.id] = e.emission.tx_power_dBm;
        tx_gain_dBi_[e.id] = e.emission.antenna_gain_dBi;
    }
    return true;
}

bool ToaEstimator::init(IRandom& rng, std::string&) {
    sub_rng_ = Xoshiro256pp(rng.next_u64());
    status_ = ComponentStatus();
    last_report_t_s_.clear();
    return true;
}

Step ToaEstimator::process(PortMap& in, PortMap& out, std::string& err) {
    (void)err;
    PortData outd;
    outd.type = PortType::ToaReport;
    const double period_s = 1.0 / report_rate_Hz_;
    std::size_t produced = 0;

    for (int k = 1; k <= 8; ++k) {
        const std::string name = std::string("scene") + static_cast<char>('0' + k);
        PortMap::iterator it = in.find(name);
        if (it == in.end() || !it->second.has_data) continue;
        for (std::size_t i = 0; i < it->second.scenes.size(); ++i) {
            const SceneParamFrame& f = it->second.scenes[i];
            const std::string key = f.link_id.empty() ? (f.site_id + "-" + f.emitter_id) : f.link_id;
            const double t = f.valid_from_s;
            std::map<std::string, double>::iterator prev = last_report_t_s_.find(key);
            if (prev != last_report_t_s_.end() && t < prev->second + period_s - 1e-12) continue;
            last_report_t_s_[key] = t;

            std::map<std::string, double>::const_iterator tp = tx_power_dBm_.find(f.emitter_id);
            std::map<std::string, double>::const_iterator tg = tx_gain_dBi_.find(f.emitter_id);
            const double prx = (tp == tx_power_dBm_.end() ? 0.0 : tp->second)
                             + (tg == tx_gain_dBi_.end() ? 0.0 : tg->second)
                             + rx_gain_dBi_ - f.path_loss_dB;
            const double snr = prx - (f.noise_floor_dBm_per_Hz + 10.0 * std::log10(bandwidth_Hz_));

            ToaReport r;
            r.t_s = t;
            r.site_id = f.site_id.empty() ? site_id_ : f.site_id;
            r.emitter_id = f.emitter_id;
            r.link_id = key;
            r.site_lon = site_lon_;
            r.site_lat = site_lat_;
            r.site_alt_m = site_alt_m_;
            r.snr_dB = snr;
            r.sync_state = sync_state_;
            r.truth_consumed = true;
            r.state = f.state;
            r.trace = toa_trace(scenario_id_ + ":" + key);

            // σ_pick = 1/(2π·B·√SNR)，B 取本站的实际采样率
            const double lin = std::pow(10.0, snr / 10.0);
            const double b = bandwidth_Hz_ > 0.0 ? bandwidth_Hz_ : 1.0;
            r.sigma.pick_s = 1.0 / (2.0 * 3.14159265358979323846 * b * std::sqrt(lin > 1.0 ? lin : 1.0));
            r.sigma.floor_s = sigma_floor_ns_ * 1e-9;
            r.sigma.sync_s = sync_sigma_ns_ * 1e-9;
            r.sigma.rxdelay_s = rx_delay_sigma_ns_ * 1e-9;
            const double var = r.sigma.pick_s * r.sigma.pick_s + r.sigma.floor_s * r.sigma.floor_s
                             + r.sigma.sync_s * r.sigma.sync_s + r.sigma.rxdelay_s * r.sigma.rxdelay_s;
            r.toa_std_s = std::sqrt(var);

            if (!f.tx_on) {
                r.state = State::Invalid;
                r.time_quality = "TQ-4";
                r.reasons.push_back("tx_off");
            } else if (snr < min_snr_dB_) {
                r.state = State::Invalid;
                r.time_quality = "TQ-4";
                r.reasons.push_back("snr_below_min");
            } else {
                r.toa_s = f.delay_s + (bias_ns_ + rx_delay_ns_) * 1e-9 + r.toa_std_s * sub_rng_.normal();
                // 逐站的时统档只看站钟本身；融合时还要看残差拟合（EM-S-07 §10.3）
                r.time_quality = geo::to_string(geo::tdoa_time_grade(sync_sigma_ns_, 0.0, false));
                if (sync_state_ == "holdover") {
                    r.state = worst(r.state, State::Degraded);
                    r.reasons.push_back("clock_holdover");
                } else if (sync_state_ == "unsynced") {
                    r.state = State::Invalid;
                    r.time_quality = "TQ-4";
                    r.reasons.push_back("clock_unsynced");
                }
            }
            if (obs_ != 0) obs_->on_toa(r);
            outd.toas.push_back(r);
            ++produced;
        }
    }
    if (produced) {
        outd.has_data = true;
        out["out"] = outd;
    }
    status_.blocks_in++;
    status_.blocks_out += produced;
    return produced ? Step::Produced : Step::Idle;
}

void ToaEstimator::reset() {
    status_ = ComponentStatus();
    last_report_t_s_.clear();
}

// ------------------------------------------------------------ MultiSiteLocator

namespace {

/** "TQ-2" → 2；认不出即当最差（4）。 */
int tq_rank(const std::string& q) {
    if (q == "TQ-1") return 1;
    if (q == "TQ-2") return 2;
    if (q == "TQ-3") return 3;
    return 4;
}

ModelTrace fix_trace(const std::string& method, const std::string& trace_id) {
    ModelTrace t;
    // AOA 是 EM-S-06、TDOA 是 EM-S-07，融合两者都算
    t.model_id = method == "aoa" ? "EM-S-06" : (method == "tdoa" ? "EM-S-07" : "EM-S-06+07");
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M2";
    t.credibility = "V2";
    t.parameter_version = "fix-effect-v1";
    t.trace_id = trace_id;
    return t;
}

}  // namespace

ComponentInfo MultiSiteLocator::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "多站定位";
    i.description =
        "把各站的方位量测（与到达时间量测）融合成一个位置解（EM-S-06 交叉定位 / EM-S-07 时差定位，D-053）。"
        "aoa 用测向线的两遍加权最小二乘交汇（等权取初值，再按站距加权）；"
        "输出 2σ 误差椭圆、CEP、GDOP 与几何质量分级，椭圆的二维包含概率是 86.5%（不是一维的 95%）。"
        "站址随测向报告走，因此本组件不绑场景、不读场景文件。"
        "站数不足或几何退化时仍出一行并写明原因，不是不输出（铁律 15）。"
        "**指标是模型自洽性检查，不是设备定位精度**：上游的方位量测本身来自 M2 效应模型（truth_consumed）。";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "EM-S-06";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;
    i.stateful = false;
    i.params = {
        ParamSpec::choice("method", {"aoa", "tdoa", "aoa_tdoa"},
                          "定位体制：测向交叉 / 时差 / 两者融合（后者用交叉解作时差迭代的初值）")
            .def_text("aoa"),
        ParamSpec::number("min_crossing_angle_deg", "deg",
                          "测向线最大张角低于它即判几何退化。仍出解，只是标降级")
            .def(10.0).at_least(0.0).at_most(180.0),
        ParamSpec::number("geometry_condition_threshold", "",
                          "GDOP 上限，超过标退化（tdoa 用；aoa 按张角分级）")
            .def(15.0).at_least(1.0),
        ParamSpec::number("max_tdoa_feasibility_margin_m", "m",
                          "|Δr| 超过基线加这个余量即判可行性违例（EM-S-07 §10.4）。"
                          "**降级不剔除**：粗大违例多半是符号或关联错误，剔掉就看不见了")
            .def(50.0).at_least(0.0),
        ParamSpec::number("propagation_speed_mps", "m/s",
                          "传播速度。1 ns 时差约 0.3 m 距离差，光速精度直接进误差预算")
            .def(299792458.0).at_least(1.0),
        ParamSpec::choice("reference_station_rule", {"best_snr", "first"},
                          "时差定位的参考站选取：信噪比最高的那一站拾取最稳（EM-S-07 §10.5）")
            .def_text("best_snr"),
        ParamSpec::choice("weighting", {"correlated_reference", "independent_pairs"},
                          "时差量测的加权口径。correlated_reference 显式构造 R = c²(diag σ² + σ_0²·11ᵀ)，"
                          "参考站的噪声在各站对间相关；independent_pairs 是 emcore 的旧口径，把站对当独立。"
                          "两者并列保留、数值进模型卡，实测见 11 报告 §11.3")
            .def_text("correlated_reference"),
        ParamSpec::number("sync_quality_threshold", "",
                          "时统质量差于第几档（1..4）的站剔除；缺省 3 表示只剔 TQ-4（含失锁）")
            .def(3.0).at_least(1.0).at_most(4.0),
        ParamSpec::number("time_tolerance_s", "s",
                          "各站报告按时刻配对的容差；差得比它多就不算同一时刻的量测")
            .def(1e-6).at_least(0.0),
        ParamSpec::text("coord_version", "坐标版本，随定位产物落盘（05 §6.2.3）")
            .def_text("wgs84-2026-09"),
    };
    return i;
}

bool MultiSiteLocator::check_wiring(const std::vector<std::string>& wired, std::string& err) const {
    std::size_t nb = 0, nt = 0;
    for (std::size_t i = 0; i < wired.size(); ++i) {
        if (wired[i][0] == 'b') ++nb;
        else if (wired[i][0] == 't') ++nt;
    }
    if (method_ == "aoa" && nb < 2) {
        err = "交叉定位至少要接 2 路测向报告（b1..b8），实际 " + numstr(nb) + " 路";
        return false;
    }
    if (method_ == "tdoa" && nt < 3) {
        err = "时差定位至少要接 3 路到达时间报告（t1..t8），实际 " + numstr(nt) + " 路";
        return false;
    }
    if (method_ == "aoa_tdoa" && (nb < 2 || nt < 3)) {
        err = "融合定位要求测向 ≥ 2 路且到达时间 ≥ 3 路，实际 " + numstr(nb) + " / " + numstr(nt);
        return false;
    }
    return true;
}

bool MultiSiteLocator::configure(const std::map<std::string, double>& params,
                                 const std::map<std::string, std::string>& text_params,
                                 std::string& err) {
    get_text(text_params, "method", method_);
    if (method_.empty()) method_ = "aoa";
    if (method_ != "aoa" && method_ != "tdoa" && method_ != "aoa_tdoa") {
        err = "method 必须是 aoa / tdoa / aoa_tdoa 之一";
        return false;
    }
    min_crossing_angle_deg_ = get_num(params, "min_crossing_angle_deg", 10.0);
    geometry_condition_threshold_ = get_num(params, "geometry_condition_threshold", 15.0);
    max_tdoa_feasibility_margin_m_ = get_num(params, "max_tdoa_feasibility_margin_m", 50.0);
    propagation_speed_mps_ = get_num(params, "propagation_speed_mps", 299792458.0);
    sync_quality_threshold_ = static_cast<int>(get_num(params, "sync_quality_threshold", 3.0));
    time_tolerance_s_ = get_num(params, "time_tolerance_s", 1e-6);
    get_text(text_params, "reference_station_rule", reference_station_rule_);
    if (reference_station_rule_.empty()) reference_station_rule_ = "best_snr";
    if (reference_station_rule_ != "best_snr" && reference_station_rule_ != "first") {
        err = "reference_station_rule 必须是 best_snr / first 之一";
        return false;
    }
    get_text(text_params, "weighting", weighting_);
    if (weighting_.empty()) weighting_ = "correlated_reference";
    if (weighting_ != "correlated_reference" && weighting_ != "independent_pairs") {
        err = "weighting 必须是 correlated_reference / independent_pairs 之一";
        return false;
    }
    get_text(text_params, "coord_version", coord_version_);
    if (coord_version_.empty()) coord_version_ = "wgs84-2026-09";
    return true;
}

bool MultiSiteLocator::init(IRandom&, std::string&) {
    status_ = ComponentStatus();
    return true;
}

void MultiSiteLocator::solve_group(double t_s, const std::string& emitter_id,
                                   const std::vector<const BearingReport*>& bs,
                                   const std::vector<const ToaReport*>& ts) {
    PositionReport r;
    r.t_s = t_s;
    r.emitter_id = emitter_id;
    r.method = method_;
    r.coord_version = coord_version_;
    r.truth_consumed = true;
    r.trace = fix_trace(method_, emitter_id + "@" + numstr(t_s));

    // 参与解算的只有 use_policy != exclude 的量测；被剔除的进 outlier_sites，
    // 让读的人看得出「这一站有量测但没参与」，而不是以为它压根没报
    const bool want_aoa = method_ != "tdoa";
    const bool want_tdoa = method_ != "aoa";

    std::vector<geo::AoaPlaneObs> obs;
    std::vector<const BearingReport*> used;
    if (want_aoa) {
        for (std::size_t i = 0; i < bs.size(); ++i) {
            if (bs[i]->use_policy == "exclude" || bs[i]->df_result_state == State::Invalid) {
                r.outlier_sites.push_back(bs[i]->site_id);
                continue;
            }
            used.push_back(bs[i]);
        }
    }
    // 时差侧：时统档差于门限的站剔除（unsynced 恒为 TQ-4），进 outlier_sites
    std::vector<const ToaReport*> tused;
    if (want_tdoa) {
        for (std::size_t i = 0; i < ts.size(); ++i) {
            const int q = tq_rank(ts[i]->time_quality);
            if (ts[i]->state == State::Invalid || q > sync_quality_threshold_) {
                bool listed = false;
                for (std::size_t k = 0; k < r.outlier_sites.size(); ++k) {
                    if (r.outlier_sites[k] == ts[i]->site_id) { listed = true; break; }
                }
                if (!listed) r.outlier_sites.push_back(ts[i]->site_id);
                continue;
            }
            tused.push_back(ts[i]);
        }
    }

    const bool aoa_ok = !want_aoa || used.size() >= 2;
    const bool tdoa_ok = !want_tdoa || tused.size() >= 3;
    if (!aoa_ok || !tdoa_ok) {
        r.state = State::Invalid;
        r.geometry_quality = "degenerate";
        r.reasons.push_back("insufficient_stations");
        if (obs_ != 0) obs_->on_position(r);
        return;
    }
    if (method_ == "tdoa") {
        solve_tdoa(r, tused, 0, 0);
        if (obs_ != 0) obs_->on_position(r);
        return;
    }

    // ENU 原点取第一个参与站（05 §6.2.3：椭圆的旋转角相对原点的 ENU 东向才有意义）
    const geo::Lla origin(used[0]->site_lon, used[0]->site_lat, used[0]->site_alt_m);
    const geo::IGeodesy& gd = geo::default_geodesy();
    for (std::size_t i = 0; i < used.size(); ++i) {
        const geo::Lla p(used[i]->site_lon, used[i]->site_lat, used[i]->site_alt_m);
        const geo::Enu e = gd.to_enu(gd.to_ecef(p), origin);
        geo::AoaPlaneObs o;
        o.x_m = e.e;
        o.y_m = e.n;
        o.bearing_deg = used[i]->bearing_deg;
        o.sigma_deg = used[i]->bearing_std_deg;
        obs.push_back(o);
        r.participating_sites.push_back(used[i]->site_id);
    }

    const geo::AoaPlaneSolution s = geo::aoa_solve_plane(obs);
    if (!s.ok) {
        r.state = State::Invalid;
        r.geometry_quality = "degenerate";
        r.reasons.push_back("singular_geometry");
        if (obs_ != 0) obs_->on_position(r);
        return;
    }

    const geo::Ecef ec = gd.from_enu(geo::Enu(s.x_m, s.y_m, 0.0), origin);
    const geo::Lla fix = gd.to_lla(ec);
    r.lon = fix.lon_deg;
    r.lat = fix.lat_deg;
    r.origin_lon = origin.lon_deg;
    r.origin_lat = origin.lat_deg;
    r.origin_alt_m = origin.alt_m;
    r.cov_m2[0] = s.cov[0];
    r.cov_m2[1] = s.cov[1];
    r.cov_m2[2] = s.cov[2];
    r.ellipse.semi_major_m = s.stats.ellipse.semi_major_m;
    r.ellipse.semi_minor_m = s.stats.ellipse.semi_minor_m;
    r.ellipse.rotation_deg = s.stats.ellipse.rotation_deg;
    r.ellipse.confidence = geo::ellipse_confidence_2sigma();
    r.cep_m = s.stats.cep_m;
    r.gdop = s.stats.rms_trace_m;
    r.geometry_quality = geo::to_string(s.quality);
    for (std::size_t i = 0; i < s.residuals_deg.size() && i < used.size(); ++i) {
        FixResidual fr;
        fr.site_id = used[i]->site_id;
        fr.value = s.residuals_deg[i];
        fr.unit = "deg";
        r.residuals.push_back(fr);
    }

    // 几何退化与混叠都降级但仍给解——「有解但别太当真」比没有解更有用。
    // 判据用**最小两两交会角**而不是最大张角：参数名本来就叫 min_crossing_angle，
    // 而最大张角看不见「两条近乎平行的线 + 一条好线」这种近简并配置
    // （golden-03 上实测过：那种配置的 2σ 椭圆覆盖率只有 45%，却被最大张角判成 good）。
    r.min_crossing_angle_deg = s.min_crossing_deg;
    if (s.min_crossing_deg < min_crossing_angle_deg_) {
        r.state = State::Degraded;
        r.reasons.push_back("crossing_angle_below_min");
    }
    for (std::size_t i = 0; i < used.size(); ++i) {
        if (used[i]->use_policy == "low_weight") {
            r.state = worst(r.state, State::Degraded);
            r.reasons.push_back("low_weight:" + used[i]->site_id);
        }
    }

    // 融合：把交叉定位的解作为时差迭代的初值（emcore 的 initialGuess 就是为此留的），
    // 再用时差量测精化。参与站取并集，方法名写 aoa_tdoa。
    if (method_ == "aoa_tdoa") {
        const geo::Lla o2(r.origin_lon, r.origin_lat, r.origin_alt_m);
        const geo::Enu ie = gd.to_enu(gd.to_ecef(geo::Lla(r.lon, r.lat, 0.0)), o2);
        const double ix = ie.e, iy = ie.n;
        solve_tdoa(r, tused, &ix, &iy);
    }
    if (obs_ != 0) obs_->on_position(r);
}

/** 时差求解。`r` 里已有的 emitter/method/trace 保留，几何与椭圆按时差结果覆盖。 */
void MultiSiteLocator::solve_tdoa(PositionReport& r, const std::vector<const ToaReport*>& ts,
                                  const double* init_x, const double* init_y) {
    if (ts.size() < 3) {
        r.state = State::Invalid;
        r.geometry_quality = "degenerate";
        r.reasons.push_back("insufficient_stations");
        return;
    }
    // 参考站：信噪比最高的那一站拾取最稳（EM-S-07 §10.5）
    std::size_t ref = 0;
    if (reference_station_rule_ == "best_snr") {
        for (std::size_t i = 1; i < ts.size(); ++i) if (ts[i]->snr_dB > ts[ref]->snr_dB) ref = i;
    }

    const geo::Lla origin(ts[ref]->site_lon, ts[ref]->site_lat, ts[ref]->site_alt_m);
    const geo::IGeodesy& gd = geo::default_geodesy();
    std::vector<geo::ToaPlaneObs> obs;
    obs.reserve(ts.size());
    std::vector<std::string> sites;
    for (std::size_t i = 0; i < ts.size(); ++i) {
        const geo::Lla p(ts[i]->site_lon, ts[i]->site_lat, ts[i]->site_alt_m);
        const geo::Enu e = gd.to_enu(gd.to_ecef(p), origin);
        geo::ToaPlaneObs o;
        o.x_m = e.e;
        o.y_m = e.n;
        o.toa_s = ts[i]->toa_s;
        // 拾取项含时戳底噪，同步项单列——两者在协方差里的角色不同（同步项在站对间相关）
        o.sigma_pick_s = std::sqrt(ts[i]->sigma.pick_s * ts[i]->sigma.pick_s
                                   + ts[i]->sigma.floor_s * ts[i]->sigma.floor_s
                                   + ts[i]->sigma.rxdelay_s * ts[i]->sigma.rxdelay_s);
        o.sigma_sync_s = ts[i]->sigma.sync_s;
        obs.push_back(o);
        sites.push_back(ts[i]->site_id);
    }

    // 融合时初值是 AOA 解，但它在 AOA 的 ENU 原点里；这里的原点是参考站，要换过来
    double ix = 0.0, iy = 0.0;
    bool has_init = false;
    if (init_x && init_y) {
        const geo::Lla aoa_origin(r.origin_lon, r.origin_lat, r.origin_alt_m);
        const geo::Ecef ec = gd.from_enu(geo::Enu(*init_x, *init_y, 0.0), aoa_origin);
        const geo::Enu e = gd.to_enu(ec, origin);
        ix = e.e;
        iy = e.n;
        has_init = true;
    }

    const geo::TdoaWeighting w = weighting_ == "independent_pairs"
        ? geo::TdoaWeighting::IndependentPairs : geo::TdoaWeighting::CorrelatedReference;
    const geo::TdoaPlaneSolution s = geo::tdoa_solve_plane(
        obs, ref, w, has_init ? &ix : 0, has_init ? &iy : 0,
        max_tdoa_feasibility_margin_m_, propagation_speed_mps_);
    if (!s.ok) {
        r.state = State::Invalid;
        r.geometry_quality = "degenerate";
        r.reasons.push_back("singular_geometry");
        return;
    }

    const geo::Ecef ec = gd.from_enu(geo::Enu(s.x_m, s.y_m, 0.0), origin);
    const geo::Lla fix = gd.to_lla(ec);
    r.lon = fix.lon_deg;
    r.lat = fix.lat_deg;
    r.origin_lon = origin.lon_deg;
    r.origin_lat = origin.lat_deg;
    r.origin_alt_m = origin.alt_m;
    r.cov_m2[0] = s.cov[0];
    r.cov_m2[1] = s.cov[1];
    r.cov_m2[2] = s.cov[2];
    r.ellipse.semi_major_m = s.stats.ellipse.semi_major_m;
    r.ellipse.semi_minor_m = s.stats.ellipse.semi_minor_m;
    r.ellipse.rotation_deg = s.stats.ellipse.rotation_deg;
    r.ellipse.confidence = geo::ellipse_confidence_2sigma();
    r.cep_m = s.stats.cep_m;
    r.gdop = s.gdop;
    r.geometry_quality = geo::to_string(s.geometry_quality);
    r.time_quality = geo::to_string(s.time_quality);
    r.reference_site = sites[s.ref_index];
    r.participating_sites = sites;
    r.residuals.clear();
    std::size_t k = 0;
    for (std::size_t i = 0; i < sites.size(); ++i) {
        if (i == s.ref_index) continue;
        FixResidual fr;
        fr.site_id = sites[i];
        fr.value = k < s.residuals_m.size() ? s.residuals_m[k] : 0.0;
        fr.unit = "m";
        r.residuals.push_back(fr);
        ++k;
    }
    if (s.gdop > geometry_condition_threshold_) {
        r.state = worst(r.state, State::Degraded);
        r.reasons.push_back("gdop_above_threshold");
    }
    if (s.feasibility_violations > 0) {
        r.state = worst(r.state, State::Degraded);
        r.reasons.push_back("tdoa_infeasible");
    }
    if (s.time_quality != geo::TimeQuality::TQ1) {
        r.state = worst(r.state, State::Degraded);
        r.reasons.push_back(std::string("time_quality:") + geo::to_string(s.time_quality));
    }
}

Step MultiSiteLocator::process(PortMap& in, PortMap& out, std::string& err) {
    (void)err;
    (void)out;   // 末端节点，没有下游；报告经观察者走

    // 收齐本轮所有测向与到达时间报告，按 (时刻, 辐射源) 分组——一个目标一个解，
    // 各站的量测要凑到一起。时刻用 time_tolerance_s 配对，两类报告用同一把尺子。
    std::vector<const BearingReport*> all;
    for (int k = 1; k <= 8; ++k) {
        const std::string name = std::string("b") + static_cast<char>('0' + k);
        PortMap::iterator it = in.find(name);
        if (it == in.end() || !it->second.has_data) continue;
        for (std::size_t i = 0; i < it->second.bearings.size(); ++i) {
            all.push_back(&it->second.bearings[i]);
        }
    }
    std::vector<const ToaReport*> allt;
    for (int k = 1; k <= 8; ++k) {
        const std::string name = std::string("t") + static_cast<char>('0' + k);
        PortMap::iterator it = in.find(name);
        if (it == in.end() || !it->second.has_data) continue;
        for (std::size_t i = 0; i < it->second.toas.size(); ++i) {
            allt.push_back(&it->second.toas[i]);
        }
    }
    if (all.empty() && allt.empty()) return Step::Idle;

    // 只用时差时按到达时间报告分组，其余按测向报告分组
    struct Key { double t_s; std::string em; };
    std::vector<Key> keys;
    if (method_ == "tdoa") {
        for (std::size_t i = 0; i < allt.size(); ++i) {
            bool seen = false;
            for (std::size_t k = 0; k < keys.size(); ++k) {
                if (keys[k].em == allt[i]->emitter_id
                    && std::fabs(keys[k].t_s - allt[i]->t_s) <= time_tolerance_s_) { seen = true; break; }
            }
            if (!seen) { Key k; k.t_s = allt[i]->t_s; k.em = allt[i]->emitter_id; keys.push_back(k); }
        }
    } else {
        for (std::size_t i = 0; i < all.size(); ++i) {
            bool seen = false;
            for (std::size_t k = 0; k < keys.size(); ++k) {
                if (keys[k].em == all[i]->emitter_id
                    && std::fabs(keys[k].t_s - all[i]->t_s) <= time_tolerance_s_) { seen = true; break; }
            }
            if (!seen) { Key k; k.t_s = all[i]->t_s; k.em = all[i]->emitter_id; keys.push_back(k); }
        }
    }

    std::size_t produced = 0;
    for (std::size_t k = 0; k < keys.size(); ++k) {
        std::vector<const BearingReport*> gb;
        for (std::size_t i = 0; i < all.size(); ++i) {
            if (all[i]->emitter_id == keys[k].em && std::fabs(all[i]->t_s - keys[k].t_s) <= time_tolerance_s_) {
                gb.push_back(all[i]);
            }
        }
        std::vector<const ToaReport*> gt;
        for (std::size_t i = 0; i < allt.size(); ++i) {
            if (allt[i]->emitter_id == keys[k].em && std::fabs(allt[i]->t_s - keys[k].t_s) <= time_tolerance_s_) {
                gt.push_back(allt[i]);
            }
        }
        solve_group(keys[k].t_s, keys[k].em, gb, gt);
        ++produced;
    }
    status_.blocks_in++;
    status_.blocks_out += produced;
    return produced ? Step::Produced : Step::Idle;
}

void MultiSiteLocator::reset() { status_ = ComponentStatus(); }

}  // namespace cuav
