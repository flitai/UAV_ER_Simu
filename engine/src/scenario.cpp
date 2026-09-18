#include "cuav/components/scenario.h"

#include "cuav/buildings_json.h"

#include <algorithm>
#include <cmath>

#include "cuav/scenario_json.h"
#include "cuav_geo/activity.h"

namespace cuav {
namespace {

const double kPi = 3.14159265358979323846;
const double kTwoPi = 2.0 * kPi;

ModelTrace make_trace(const std::string& id, const std::string& trace_id) {
    ModelTrace t;
    t.model_id = id;
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M3";
    t.credibility = "V2";          // 合成场景，尚未与实测校准
    t.parameter_version = "scenario-thin-slice";
    t.trace_id = trace_id;
    return t;
}

PowerCalibration model_calibration() {
    PowerCalibration c;
    c.calibrated = true;
    c.offset_dB = 0.0;
    c.source = "model";
    c.note = "引擎内部功率约定：|x|^2 为 mW（D-047）";
    return c;
}

// 第 k 帧覆盖样点 [floor(k·fs/rate), floor((k+1)·fs/rate))。
// 纯整数边界：fs 不被 rate 整除时也确定，且 C++ 与浏览器 TypeScript 能逐位一致——
// 用秒做中间量就会在边界上差一个样点（08 报告 §9.2）。
std::uint64_t frame_start_sample(std::uint64_t k, double fs, double rate) {
    return static_cast<std::uint64_t>(std::floor(static_cast<double>(k) * fs / rate));
}

std::uint64_t frame_index_for_sample(std::uint64_t s, double fs, double rate) {
    double approx = std::floor(static_cast<double>(s) * rate / fs);
    if (!(approx > 0.0)) approx = 0.0;
    std::uint64_t k = static_cast<std::uint64_t>(approx);
    while (k > 0 && frame_start_sample(k, fs, rate) > s) --k;
    while (frame_start_sample(k + 1, fs, rate) <= s) ++k;
    return k;
}

bool get_text(const std::map<std::string, std::string>& t, const char* key, std::string& out) {
    std::map<std::string, std::string>::const_iterator it = t.find(key);
    if (it == t.end()) return false;
    out = it->second;
    return true;
}

double get_num(const std::map<std::string, double>& p, const char* key, double def) {
    std::map<std::string, double>::const_iterator it = p.find(key);
    return it == p.end() ? def : it->second;
}

// 场景绑定组件共用的装载：读文件、核对 scenario_id、给出场景。
bool load_bound_scenario(const std::string& who, const std::string& path, const std::string& want_id,
                         geo::Scenario& out, std::string& err) {
    if (path.empty()) {
        err = who + " 缺内部参数 scenario_path。它由装载器按节点的 scene_binding 解析注入"
              "（框图里只写 scene_binding，不写路径，D-037）；单机运行请给 cuav_run --scenario <场景文件>";
        return false;
    }
    LoadedScenario ls;
    if (!load_scenario_file(path, ls, err)) return false;
    if (!want_id.empty() && ls.scenario.scenario_id != want_id) {
        err = who + " 绑定的场景标识是 " + want_id + "，但 " + path + " 里的是 " + ls.scenario.scenario_id;
        return false;
    }
    out = ls.scenario;
    return true;
}

}  // namespace

// --------------------------------------------------------------- ScenarioSource

ScenarioSource::ScenarioSource() {}

ComponentInfo ScenarioSource::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Data;
    i.display_name = "场景参数源";
    i.description = "站点视角的场景运行时：按航线与活动时间线算出链路几何与链路预算，"
                    "每条链路输出一路慢变参数帧（10–100 Hz，帧内零阶保持），"
                    "实体状态与链路读数经观察者上报。参数帧按样点序号推进，不按墙钟，"
                    "因此同种子逐字节可复现（D-033）。首期路损为自由空间、视距在平地假设下恒真，"
                    "D3 接入建筑遮挡后帧结构不变。";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "EM-P-01";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs.clear();      // 端口按场景绑定动态生成，未绑定时目录里没有具体端口
    i.scene_bindable = true;
    i.stateful = true;
    i.has_dynamic_ports = true;
    i.dynamic_port_pattern = "link:<emitter_id>";
    i.dynamic_port_type = PortType::SceneParamFrame;
    i.dynamic_port_source = "scene_binding";
    i.params = {
        ParamSpec::number("sample_rate_Hz", "Hz", "链路的 IQ 采样率，须与站点接收机的 fs_Hz 一致").req().at_least(0.0, true),
        ParamSpec::number("total_samples", "", "覆盖的总样点数").req().at_least(1.0),
        ParamSpec::number("update_rate_Hz", "Hz", "参数帧更新率").def(20.0).at_least(10.0).at_most(100.0),
        ParamSpec::number("report_rate_Hz", "Hz", "实体状态与链路读数的上报率，不大于更新率").def(10.0).at_least(0.1),
        ParamSpec::boolean("report_entities", "是否上报实体状态；多站场景里只让一个节点报，避免重复").def_bool(true),
        ParamSpec::number("block_samples", "", "每块样点数；由 run.block_size 统一给定，不建议单节点覆盖").def(65536.0).at_least(1.0),

        // ---- 传播效应（D-058，12 号报告）。界面上显示在「传播信道」卡片右栏（槽位表的代理机制）。
        ParamSpec::choice("prop_level", {"E1", "E2", "E3"},
                          "传播精度档（01 的 E1–E4，直接写进溯源的 model_level）："
                          "E1 快速抽象 = 自由空间路损 + 多普勒 + 时延；"
                          "E2 工程 = 再加地面双径或城市经验（二选一）、统计阴影、大气与降雨；"
                          "E3 精细机理 = 建筑遮挡与刀口绕射，需逐建筑几何，待 D3（切片 ⑤），本版本收到即报错")
            .def_text("E1"),
        ParamSpec::choice("prop_primary", {"free_space", "two_ray", "urban_empirical"},
                          "替代型主模型，至多一个（EM-P-13 §10.9 防重复计损）：选中它就由它给出基础损耗，"
                          "不再单独叠加自由空间。two_ray = EM-P-02 地面双径，urban_empirical = EM-P-05 城市经验")
            .def_text("free_space"),
        ParamSpec::boolean("prop_shadow", "统计阴影衰落（EM-P-08）：dB 域零均值正态，沿航迹按空间相关一阶递推")
            .def_bool(false),
        ParamSpec::boolean("prop_weather", "大气吸收与降雨衰减（EM-P-07）。2.4 GHz、20 km 上是 0.1 dB 量级")
            .def_bool(false),
        ParamSpec::choice("env_class", {"open", "suburban", "urban", "dense_urban"},
                          "环境类别：决定城市经验的路损指数与偏置、统计阴影的标准差。"
                          "open 档的 n = 2、偏置 0，城市经验在该档恒等于自由空间")
            .def_text("urban"),
        ParamSpec::choice("ground_type", {"paved", "grass", "water", "dirt", "unknown"},
                          "地面反射面材质，查 εr / σ / 粗糙度默认表（地表材质工作流 §3.5）。只有地面双径用")
            .def_text("unknown"),
        ParamSpec::number("ground_roughness_m", "m",
                          "地表 RMS 粗糙度；填 -1 表示按 ground_type 取表值。0 是理想光滑面，是有意义的取值")
            .def(-1.0).at_least(-1.0),
        ParamSpec::number("coherence_rho", "",
                          "双径的相干因子 ρ_c（EM-P-02 §10.6）：1 = 完全相干（可见干涉起伏），"
                          "0 = 非相干（只作功率相加）。小于 1 时衰落状态一律降为 averaged")
            .def(1.0).at_least(0.0).at_most(1.0),
        ParamSpec::number("max_fade_depth_dB", "dB",
                          "双径相消的限幅（EM-P-02 §10.8 第 3 条）：数值上完全相消会给出不现实的无限损耗")
            .def(20.0).at_least(0.0),
        ParamSpec::number("path_loss_exponent", "",
                          "城市经验的路损指数 n；填 -1 表示按 env_class 取表值")
            .def(-1.0).at_least(-1.0),
        ParamSpec::number("ref_distance_m", "m",
                          "城市经验 log-distance 的参考距离 d0。距离在 d0 以内时近区退回自由空间并标降级")
            .def(100.0).at_least(0.0, true),
        ParamSpec::choice("urban_loss_mode", {"mean", "mean_with_shadow_margin"},
                          "城市经验给均值还是「均值 + 90% 分位阴影裕度」。"
                          "后者自带阴影，与 prop_shadow 同时开即同源双计，configure() 会报错")
            .def_text("mean"),
        ParamSpec::number("shadow_sigma_dB", "dB",
                          "统计阴影的标准差 σ；填 -1 表示按 env_class 与视距状态取表值")
            .def(-1.0).at_least(-1.0),
        ParamSpec::number("shadow_corr_distance_m", "m",
                          "阴影的空间相关距离 d_corr（相关系数降到 1/e 的距离）。阴影随空间位移变化，不随时间")
            .def(50.0).at_least(0.0),
        ParamSpec::number("rain_rate_mmh", "mm/h", "降雨率；0 表示无雨").def(0.0).at_least(0.0),

        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("site_id", "绑定的站点标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("scene_root",
                        "观测区域数据包的根目录，由装载器注入（cuav_run --scene-root）。"
                        "建筑几何在 <scene_root>/<aoi_id>/ 下，只有 prop_level = E3 才去读（懒加载，D3-4）")
            .internal_only(),
    };
    return i;
}

bool ScenarioSource::configure(const std::map<std::string, double>& params,
                               const std::map<std::string, std::string>& text_params,
                               std::string& err) {
    get_text(text_params, "scenario_path", scenario_path_);
    get_text(text_params, "scenario_id", scenario_id_);
    get_text(text_params, "site_id", site_id_);
    get_text(text_params, "scene_root", scene_root_);

    sample_rate_Hz_ = get_num(params, "sample_rate_Hz", 0.0);
    if (!(sample_rate_Hz_ > 0.0)) { err = "ScenarioSource 需要正的 sample_rate_Hz"; return false; }
    const double total = get_num(params, "total_samples", 0.0);
    if (!(total >= 1.0)) { err = "ScenarioSource 需要 total_samples（缺省由 run.duration_s 补齐）"; return false; }
    total_samples_ = static_cast<std::uint64_t>(total);
    update_rate_Hz_ = get_num(params, "update_rate_Hz", 20.0);
    if (!(update_rate_Hz_ >= 10.0) || !(update_rate_Hz_ <= 100.0)) {
        err = "update_rate_Hz 必须在 10 到 100 赫兹之间（docs/scenario-format.md §7）";
        return false;
    }
    report_rate_Hz_ = get_num(params, "report_rate_Hz", 10.0);
    if (!(report_rate_Hz_ > 0.0) || report_rate_Hz_ > update_rate_Hz_) {
        err = "report_rate_Hz 必须为正且不大于 update_rate_Hz";
        return false;
    }
    report_entities_ = get_num(params, "report_entities", 1.0) != 0.0;
    block_samples_ = static_cast<std::size_t>(get_num(params, "block_samples", 65536.0));
    if (block_samples_ == 0) { err = "block_samples 必须为正"; return false; }

    // 轮数预算：调度器默认上限一百万轮。与其跑到一半才报"超过最大轮数"，不如现在就说清楚。
    const std::uint64_t rounds = (total_samples_ + block_samples_ - 1) / block_samples_ + 1;
    if (rounds > 1000000u) {
        err = "本节点需要 " + std::to_string(rounds) + " 轮调度，超过默认上限一百万；"
              "请把 run.block_size 调大到至少 " + std::to_string(total_samples_ / 999000u + 1);
        return false;
    }

    // 传播效应配置（D-058）。枚举一律显式解析：认不出就报错，不拿缺省顶替（铁律 15）。
    {
        std::string txt;
        prop_ = geo::PropagationConfig();
        if (get_text(text_params, "prop_level", txt) && !geo::parse_prop_level(txt, prop_.level)) {
            err = "prop_level 必须是 E1 / E2 / E3 之一，收到 " + txt;
            return false;
        }
        if (get_text(text_params, "prop_primary", txt)
            && !geo::parse_primary_model(txt, prop_.primary)) {
            err = "prop_primary 必须是 free_space / two_ray / urban_empirical 之一，收到 " + txt;
            return false;
        }
        if (get_text(text_params, "env_class", txt) && !geo::parse_env_class(txt, prop_.env)) {
            err = "env_class 必须是 open / suburban / urban / dense_urban 之一，收到 " + txt;
            return false;
        }
        if (get_text(text_params, "ground_type", txt) && !geo::parse_ground_type(txt, prop_.ground)) {
            err = "ground_type 必须是 paved / grass / water / dirt / unknown 之一，收到 " + txt;
            return false;
        }
        if (get_text(text_params, "urban_loss_mode", txt)
            && !geo::parse_urban_loss_mode(txt, prop_.urban_mode)) {
            err = "urban_loss_mode 必须是 mean / mean_with_shadow_margin 之一，收到 " + txt;
            return false;
        }
        prop_.shadow = get_num(params, "prop_shadow", 0.0) != 0.0;
        prop_.weather = get_num(params, "prop_weather", 0.0) != 0.0;
        prop_.roughness_m = get_num(params, "ground_roughness_m", -1.0);
        prop_.coherence_rho = get_num(params, "coherence_rho", 1.0);
        prop_.max_fade_depth_dB = get_num(params, "max_fade_depth_dB", 20.0);
        prop_.path_loss_exponent = get_num(params, "path_loss_exponent", -1.0);
        prop_.ref_distance_m = get_num(params, "ref_distance_m", 100.0);
        prop_.shadow_sigma_dB = get_num(params, "shadow_sigma_dB", -1.0);
        prop_.shadow_corr_distance_m = get_num(params, "shadow_corr_distance_m", 50.0);
        prop_.rain_rate_mmh = get_num(params, "rain_rate_mmh", 0.0);
        // 档位与组合的跨参数约束都在这一处（E3 未实现、E1 却选了效应、城市经验裕度与统计阴影双计）
        if (!prop_.validate(err)) return false;
    }

    if (!load_bound_scenario("ScenarioSource", scenario_path_, scenario_id_, scene_, err)) return false;

    const geo::Site* site = scene_.find_site(site_id_);
    if (site == 0) {
        std::string avail;
        for (std::size_t i = 0; i < scene_.sites.size(); ++i)
            avail += (i ? ", " : "") + scene_.sites[i].id;
        err = "场景 " + scene_.scenario_id + " 里没有站点 " + site_id_ + "；可用的站点是：" + avail;
        return false;
    }
    // 采样率必须与站点接收机一致：不一致就说明框图与场景在讲两套事，参数帧与 IQ 块的样点窗口对不上。
    if (std::fabs(site->receiver.fs_Hz - sample_rate_Hz_) > 1e-6) {
        err = "sample_rate_Hz " + std::to_string(sample_rate_Hz_) + " 与站点 " + site_id_ +
              " 接收机的 fs_Hz " + std::to_string(site->receiver.fs_Hz) + " 不一致";
        return false;
    }

    links_.clear();
    ports_.clear();
    entities_.clear();
    for (std::size_t i = 0; i < scene_.emitters.size(); ++i) {
        geo::LinkFrameSource lf;
        if (!lf.build(scene_, site_id_, scene_.emitters[i].id, update_rate_Hz_, err, prop_))
            return false;
        links_.push_back(lf);
        ports_.push_back(PortSpec{"link:" + scene_.emitters[i].id, PortType::SceneParamFrame});
        geo::EmitterRuntime rt;
        if (!rt.build(scene_, scene_.emitters[i].id, err)) return false;
        entities_.push_back(rt);
    }
    const double every = update_rate_Hz_ / report_rate_Hz_;
    report_every_ = static_cast<std::uint64_t>(every + 0.5);
    if (report_every_ < 1) report_every_ = 1;
    return true;
}

namespace {
// geo/ 保持零第三方依赖，只声明 INormalSource；发生器仍是引擎这一份（铁律 9，12 §0 第 9 条）。
class NormalAdapter : public geo::INormalSource {
public:
    explicit NormalAdapter(std::uint64_t seed) : rng_(seed) {}
    double normal() override { return rng_.normal(); }
private:
    Xoshiro256pp rng_;
};
}  // namespace

bool ScenarioSource::init(IRandom& rng, std::string& err) {
    if (links_.empty()) {
        err = "ScenarioSource 没有任何链路：场景里至少要有一个辐射源";
        return false;
    }
    // 统计阴影（D-058）。**每条 (站, 源) 链路一条独立子流**，按 links_ 的固定顺序派生，
    // 于是多站多源互不干扰、同种子逐位复现。序列必须在这里一次算完——frame(k) 的无副作用
    // 与可乱序调用是硬不变量，而 process() 对同一个 k 确实会调两次（12 §3.4）。
    //
    // **不开阴影就一个数都不取**。这个守卫是实测逼出来的：`rng` 是全图共享的那一条流，
    // 每条链路无条件抽一个 u64 会把后面所有组件（噪声源、接收机前端…）的子种子整体挪位，
    // 于是「E1 缺省档逐数值等于今天」当场不成立——slice2 的产品字节比对第一次就红了。
    if (prop_.shadow && prop_.effects_enabled()) {
        const double duration_s = (sample_rate_Hz_ > 0.0)
            ? static_cast<double>(total_samples_) / sample_rate_Hz_ : 0.0;
        for (std::size_t i = 0; i < links_.size(); ++i) {
            NormalAdapter sub(rng.next_u64());
            if (!links_[i].init_shadow(sub, duration_s, err)) return false;
        }
    }
    // 建筑几何（D3-4）。**只有 E3 才读**：整份 16 MB、47662 栋，解析加建桶网格约 160 ms，
    // 而 E1 / E2 一栋也用不上。放在 init() 而不是 configure()，于是校验路径
    // （cuav_run --validate，装载器只调 configure）一个字节也不读，仍是 9 ms 那一档。
    if (!load_scene_map(err)) return false;
    if (!attach_scene_map(err)) return false;

    produced_ = 0;
    reported_upto_ = 0;
    return true;
}

bool ScenarioSource::load_scene_map(std::string& err) {
    map_ = 0;
    frame_ = geo::SceneFrame();
    if (prop_.level != geo::PropLevel::E3) return true;
    BuildingsStats stats;
    geo::SceneFrame frame;
    const geo::LocalSceneAdapter* m =
        shared_scene_map(scene_root_, scene_.aoi_id, stats, frame, err);
    if (m == 0) {
        err = "站点 " + site_id_ + " 选了 E3（建筑遮挡与绕射）但建筑几何取不到：" + err;
        return false;
    }
    map_ = m;
    frame_ = frame;
    // 剔了几件、忽略了几个孔都要说出来，不静默（铁律 15）。
    status_.notes.push_back(stats.summary());
    return true;
}

bool ScenarioSource::attach_scene_map(std::string& err) {
    for (std::size_t i = 0; i < links_.size(); ++i) {
        links_[i].set_scene_map(map_, frame_);
        // 兜底：E3 走到这一步还没有地图，就是「选了建筑遮挡却按自由空间算」。
        // load_scene_map() 正常会先报错，这一道是防将来改动把那条路绕过去（铁律 15）。
        if (links_[i].needs_scene_map()) {
            err = "链路 " + links_[i].link_id() + " 选了 E3 但没有建筑几何";
            return false;
        }
    }
    return true;
}

Step ScenarioSource::process(PortMap&, PortMap& out, std::string& err) {
    (void)err;
    // 与 ToneSource 同形：耗尽后直接 Finished 且不产出，两个源才会在同一轮结束。
    if (produced_ >= total_samples_) return Step::Finished;

    const std::uint64_t n = std::min<std::uint64_t>(block_samples_, total_samples_ - produced_);
    const std::uint64_t first = produced_;
    const std::uint64_t last = produced_ + n - 1;
    const std::uint64_t k0 = frame_index_for_sample(first, sample_rate_Hz_, update_rate_Hz_);
    const std::uint64_t k1 = frame_index_for_sample(last, sample_rate_Hz_, update_rate_Hz_);

    for (std::size_t li = 0; li < links_.size(); ++li) {
        PortData d;
        d.type = PortType::SceneParamFrame;
        d.has_data = true;              // 每轮必发，哪怕本块整个落在同一帧里（见头文件的调度约束）
        for (std::uint64_t k = k0; k <= k1; ++k) {
            const geo::LinkFrameSource::Frame f = links_[li].frame(k);
            SceneParamFrame sp;
            sp.valid_from_s = f.valid_from_s;
            sp.valid_to_s = f.valid_to_s;
            sp.update_rate_Hz = f.update_rate_Hz;
            sp.path_loss_dB = f.path_loss_dB;
            sp.noise_floor_dBm_per_Hz = f.noise_floor_dBm_per_Hz;
            sp.line_of_sight = f.line_of_sight;
            sp.doppler_Hz = f.doppler_Hz;
            sp.delay_s = f.delay_s;
            sp.aod_az_deg = f.aod_azimuth_deg;
            sp.aod_el_deg = f.aod_elevation_deg;
            sp.aoa_az_deg = f.azimuth_deg;
            sp.aoa_el_deg = f.elevation_deg;
            sp.tx_heading_deg = f.heading_deg;
            sp.tx_on = f.tx_on;
            sp.tx_center_Hz = f.center_Hz;
            // 传播模型自身的降级随帧走到 IQ 块元数据（channel.cpp 用 worst() 汇总），
            // 于是「这一段用的是退回自由空间的近区值」在结果四态上看得见（铁律 15）。
            // E1 缺省档下 degraded 恒假，与 D-058 之前逐字相同。
            sp.state = !f.valid ? State::Invalid : (f.degraded ? State::Degraded : State::Valid);
            // 身份三件（D-053）：消费端按它们分流，不去解析 trace_id
            sp.link_id = links_[li].link_id();
            sp.site_id = links_[li].site_id();
            sp.emitter_id = links_[li].emitter_id();
            sp.trace = make_trace("ScenarioSource", scene_.scenario_id + ":" + links_[li].link_id());
            d.scenes.push_back(sp);
        }
        out[ports_[li].name] = d;
    }

    // 上报：按 report_every_ 抽稀，且每个帧序号只报一次（帧会跨轮重发）。
    if (obs_ != 0) {
        for (std::uint64_t k = std::max(k0, reported_upto_); k <= k1; ++k) {
            if (k % report_every_ != 0) continue;
            const double t = static_cast<double>(k) / update_rate_Hz_;
            for (std::size_t li = 0; li < links_.size(); ++li) {
                const geo::LinkFrameSource::Frame f = links_[li].frame(k);
                LinkFrame lf;
                lf.link_id = links_[li].link_id();
                lf.t_s = t;
                lf.line_of_sight = f.line_of_sight;
                lf.distance_m = f.distance_m;
                lf.azimuth_deg = f.azimuth_deg;
                lf.elevation_deg = f.elevation_deg;
                lf.path_loss_dB = f.path_loss_dB;
                lf.delay_s = f.delay_s;
                lf.doppler_Hz = f.doppler_Hz;
                lf.valid_from_s = f.valid_from_s;
                lf.valid_to_s = f.valid_to_s;
                lf.update_rate_Hz = f.update_rate_Hz;
                lf.free_space_dB = f.free_space_dB;
                lf.extra_loss_dB = f.extra_loss_dB;
                lf.diffraction_dB = f.diffraction_dB;
                lf.included_loss_terms = f.included_loss_terms;
                // 传播模型自身的降级不算无效：数照旧给得出，只是可信度降一档（05 §6.2.3 四态）
                lf.state = !f.valid ? State::Invalid
                                    : (f.degraded ? State::Degraded : State::Valid);
                obs_->on_link(lf);

                if (report_entities_) {
                    const geo::MotionState m = entities_[li].motion_at(t);
                    EntityState es;
                    es.t_s = t;
                    es.id = entities_[li].id();
                    es.lon = m.position.lon_deg;
                    es.lat = m.position.lat_deg;
                    es.alt_m = m.position.alt_m;
                    es.heading_deg = m.heading_deg;
                    es.speed_mps = m.speed_mps;
                    es.tx_on = entities_[li].tx_on_at(t);
                    es.center_Hz = entities_[li].center_Hz_at(t);
                    obs_->on_entity(es);
                }
            }
        }
        if (k1 + 1 > reported_upto_) reported_upto_ = k1 + 1;
    }

    produced_ += n;
    status_.blocks_out++;
    status_.samples_out += n;
    return Step::Produced;
}

void ScenarioSource::reset() {
    produced_ = 0;
    reported_upto_ = 0;
    status_ = ComponentStatus();
}

// ----------------------------------------------------------- SceneEmitterSource

SceneEmitterSource::SceneEmitterSource() {}

ComponentInfo SceneEmitterSource::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Source;
    i.display_name = "场景辐射源";
    i.description = "按场景 emission.waveform 生成 tone / noise / burst，归一化到**发射期间**的"
                    "单位功率（0 dBm）；绝对电平由施加类信道按链路预算给出（D-045）。"
                    "因此本组件输出的全程平均功率对 burst 是 duty × 1 mW，"
                    "瀑布上的时间平均电平比链路预算低 10·log10(1/duty)，突发峰值才等于链路预算。"
                    "活动时间线的图传开关与跳频在这里生效，粒度是样点不是块（G-6）。"
                    "noise 按 emission.bw_Hz 做 4 阶巴特沃斯带限（阻带非砖墙）并搬移到 "
                    "emission.center_Hz；bw_Hz 不小于采样带宽时不带限、输出全带白噪声并标降级。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-B-09";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = true;
    i.stateful = true;
    i.params = {
        ParamSpec::number("sample_rate_Hz", "Hz", "复采样率，须与站点接收机的 fs_Hz 一致").req().at_least(0.0, true),
        ParamSpec::number("total_samples", "", "输出总样点数").req().at_least(1.0),
        ParamSpec::number("center_frequency_Hz", "Hz", "观测中心频率（站点接收机的），基带频偏据此算出").req().at_least(0.0, true),
        ParamSpec::number("block_samples", "", "每块样点数；由 run.block_size 统一给定").def(65536.0).at_least(1.0),
        ParamSpec::boolean("emit_at_tx_power",
                           "按场景的 tx_power_dBm 标定输出电平（发射期间 |x|² = 10^(tx_power/10)）。"
                           "为假时保持单位功率归一化，电平由施加类信道的链路预算给出。"
                           "典型链路视图恒为真：这样 S0 观测点读到的就是发射功率，"
                           "而天线增益由天线组件、路损由信道组件各自负责，不再折在一处")
            .def_bool(false),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("entity_id", "绑定的辐射源标识，由装载器按 scene_binding 注入").internal_only(),
    };
    return i;
}

bool SceneEmitterSource::configure(const std::map<std::string, double>& params,
                                   const std::map<std::string, std::string>& text_params,
                                   std::string& err) {
    get_text(text_params, "scenario_path", scenario_path_);
    get_text(text_params, "scenario_id", scenario_id_);
    get_text(text_params, "entity_id", entity_id_);

    sample_rate_Hz_ = get_num(params, "sample_rate_Hz", 0.0);
    if (!(sample_rate_Hz_ > 0.0)) { err = "SceneEmitterSource 需要正的 sample_rate_Hz"; return false; }
    center_frequency_Hz_ = get_num(params, "center_frequency_Hz", 0.0);
    if (!(center_frequency_Hz_ > 0.0)) { err = "SceneEmitterSource 需要正的 center_frequency_Hz"; return false; }
    const double total = get_num(params, "total_samples", 0.0);
    if (!(total >= 1.0)) { err = "SceneEmitterSource 需要 total_samples（缺省由 run.duration_s 补齐）"; return false; }
    total_samples_ = static_cast<std::uint64_t>(total);
    block_samples_ = static_cast<std::size_t>(get_num(params, "block_samples", 65536.0));
    if (block_samples_ == 0) { err = "block_samples 必须为正"; return false; }

    if (!load_bound_scenario("SceneEmitterSource", scenario_path_, scenario_id_, scene_, err)) return false;

    const geo::Emitter* em = scene_.find_emitter(entity_id_);
    if (em == 0) {
        std::string avail;
        for (std::size_t i = 0; i < scene_.emitters.size(); ++i)
            avail += (i ? ", " : "") + scene_.emitters[i].id;
        err = "场景 " + scene_.scenario_id + " 里没有辐射源 " + entity_id_ + "；可用的是：" + avail;
        return false;
    }
    // 样点域的活动时间线（G-6，D-069）：开关与跳频的边界折到绝对样点号上，与块长无关。
    if (!sched_.build(scene_, entity_id_, sample_rate_Hz_, err)) return false;
    for (std::size_t i = 0; i < sched_.notes().size(); ++i)
        status_.notes.push_back(sched_.notes()[i]);
    waveform_ = em->emission.waveform;
    emitter_center_Hz_ = em->emission.center_Hz;
    bw_Hz_ = em->emission.bw_Hz;
    emit_at_tx_power_ = get_num(params, "emit_at_tx_power", 0.0) != 0.0;
    tx_power_amp_ = emit_at_tx_power_ ? std::pow(10.0, em->emission.tx_power_dBm / 20.0) : 1.0;

    // 铁律 4：|Δf| + B/2 + 保护带 < Fs/2。这里的 Δf 是基带频偏，B 是占用带宽。
    // **跳频点逐个查**（G-6，D-069）：基频过闸不代表序列里每一跳都过得了，跳出奈奎斯特
    // 不会有任何征兆、只会静默混叠（铁律 15）。
    const double offset = waveform_.offset_Hz;
    {
        const std::vector<geo::CenterPoint> centers = geo::emitter_center_set(scene_, entity_id_);
        for (std::size_t ci = 0; ci < centers.size(); ++ci) {
            const double df = centers[ci].Hz + offset - center_frequency_Hz_;
            if (std::fabs(df) + bw_Hz_ / 2.0 < sample_rate_Hz_ / 2.0) continue;
            if (centers[ci].where == "emission.center_Hz") {
                err = "辐射源 " + entity_id_ + " 的基带频偏 " + std::to_string(df) +
                      " Hz 加半带宽超出奈奎斯特（|Δf| + B/2 < Fs/2，铁律 4）";
            } else {
                // 需要多大的采样率才装得下最坏的那个频点——算得出来就别让用户猜
                double worst = 0.0;
                for (std::size_t k = 0; k < centers.size(); ++k)
                    worst = std::max(worst, std::fabs(centers[k].Hz + offset - center_frequency_Hz_));
                const double need = 2.0 * (worst + bw_Hz_ / 2.0);
                err = "辐射源 " + entity_id_ + " 的跳频点 " + std::to_string(centers[ci].Hz) +
                      " Hz（" + centers[ci].where + "）折成基带频偏 " + std::to_string(df) +
                      " Hz，加半带宽 " + std::to_string(bw_Hz_ / 2.0) + " Hz 不小于 Fs/2 = " +
                      std::to_string(sample_rate_Hz_ / 2.0) +
                      " Hz（|Δf| + B/2 < Fs/2，铁律 4）；请收窄跳频序列的跨度、调小 emission.bw_Hz，"
                      "或把站点 fs_Hz 提到大于 " + std::to_string(need) + " Hz";
            }
            return false;
        }
    }

    // noise 波形的带限（C-8 / G-6，D-069）。此前 noise 直接出全带白高斯，
    // 于是「2 MHz 图传落在 10 MS/s 的观测带里」在谱上根本不成立，且连 offset_Hz 都不起作用。
    // 截止取 bw_Hz/2（复基带占 [−fc, +fc]，总占用带宽正好 bw_Hz）；bw ≥ fs 时不滤波（见 process 的降级注记）。
    band_limit_ = false;
    alias_frac_ = 0.0;
    if (waveform_.type == geo::WaveformType::Noise && bw_Hz_ > 0.0 && bw_Hz_ < sample_rate_Hz_) {
        const double fc = bw_Hz_ / 2.0;
        if (!dsp::butterworth_lp4(fc, sample_rate_Hz_, lp_, err)) {
            err = "辐射源 " + entity_id_ + " 的噪声带限：" + err;
            return false;
        }
        double gain = 0.0;
        if (!dsp::impulse_power_gain(lp_, gain, lp_settle_, err)) {
            err = "辐射源 " + entity_id_ + " 的噪声带限（截止 " + std::to_string(fc) + " Hz / 采样率 " +
                  std::to_string(sample_rate_Hz_) + " Hz）：" + err;
            return false;
        }
        lp_gain_norm_ = 1.0 / std::sqrt(gain);
        band_limit_ = true;
        // 绕折功率占比。搬移在离散域里是循环旋转：离中心比 Fs/2 更远的那半边裙边会绕到
        // 带的另一头去。量的是**积分**占比 —— 只看带边那一点的衰减会把物理上没问题的配置
        // 误判成降级（实测带边 39 dB 抑制对应的绕折功率只有 2.4e-5）。
        // |H(f)|² = 1/(1 + (tan(πf/fs)/K)^8)，中点法 4096 格，确定性、与平台无关。
        const double edge = sample_rate_Hz_ / 2.0 -
            std::fabs(emitter_center_Hz_ + waveform_.offset_Hz - center_frequency_Hz_);
        const double K = std::tan(kPi * fc / sample_rate_Hz_);
        const std::size_t kGrid = 4096;
        double total = 0.0, tail = 0.0;
        for (std::size_t k = 0; k < kGrid; ++k) {
            const double f = -sample_rate_Hz_ / 2.0 +
                (static_cast<double>(k) + 0.5) * sample_rate_Hz_ / static_cast<double>(kGrid);
            const double r = std::tan(kPi * std::fabs(f) / sample_rate_Hz_) / K;
            double r8 = 1.0;
            for (int q = 0; q < 8; ++q) r8 *= r;
            const double h2 = 1.0 / (1.0 + r8);
            total += h2;
            if (std::fabs(f) > std::max(edge, 0.0)) tail += h2;
        }
        alias_frac_ = total > 0.0 ? tail / total : 1.0;
    }

    if (waveform_.type == geo::WaveformType::Burst) {
        const double p = waveform_.period_s * sample_rate_Hz_;
        burst_period_n_ = static_cast<std::uint64_t>(p + 0.5);
        burst_on_n_ = static_cast<std::uint64_t>(waveform_.duty * static_cast<double>(burst_period_n_) + 0.5);
        if (burst_period_n_ == 0 || burst_on_n_ == 0 || burst_on_n_ >= burst_period_n_) {
            err = "突发周期 " + std::to_string(waveform_.period_s) + " s 与占空比 " +
                  std::to_string(waveform_.duty) + " 在 " + std::to_string(sample_rate_Hz_) +
                  " Hz 下折不出有效的整数样点图案（导通 " + std::to_string(burst_on_n_) + " / 周期 " +
                  std::to_string(burst_period_n_) + "）；不把占空比夹到端点（铁律 15）";
            return false;
        }
    }
    return true;
}

bool SceneEmitterSource::init(IRandom& rng, std::string& err) {
    (void)err;
    // 私有随机子流：调度器的拓扑序等于框图里节点的书写顺序，多个噪声源共用同一个 IRandom 时，
    // 调换 nodes[] 的顺序就会改变样点。取一个 u64 建自己的流，把耦合降到 init 顺序这一处。
    // 不动 NoiseSource——它已有黄金基准（铁律 10）。
    sub_rng_ = Xoshiro256pp(rng.next_u64());
    sub_ready_ = true;
    produced_ = 0;
    phase_ = 0.0;
    band_note_done_ = false;
    for (int k = 0; k < 4; ++k) lp_state_[k] = std::complex<double>(0.0, 0.0);
    if (band_limit_) {
        // 冷启动瞬态推掉：组件对外的合同是「发射期间平均功率恰为 1 mW」，
        // 不丢暖机段的话这句话在开头几百个样点上不成立。消耗的随机数在私有子流内，
        // 不影响任何别的组件（铁律 9）。Python 参考照做同样的丢弃。
        const std::size_t warm = std::min<std::size_t>(lp_settle_, 1u << 16);
        for (std::size_t k = 0; k < warm; ++k) {
            float re = 0.0f, im = 0.0f;
            sub_rng_.complex_normal(re, im);
            dsp::biquad2_step(lp_, lp_state_, std::complex<double>(re, im));
        }
    }
    return true;
}

Step SceneEmitterSource::process(PortMap&, PortMap& out, std::string& err) {
    (void)err;
    if (produced_ >= total_samples_) return Step::Finished;
    const std::size_t n = static_cast<std::size_t>(
        std::min<std::uint64_t>(block_samples_, total_samples_ - produced_));

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.resize(n);

    // 跳频与图传开关按**样点**推进（G-6，D-069）：把本块切成若干「同频同开关」的子段，
    // 子段边界来自活动时间线而不是块边界，于是结果与块长无关（铁律 9）。
    // 改动前是按块起点取值，10 MS/s 下块长 65536 = 6.55 ms，1–20 ms 的跳频停留会被糊掉。
    const std::uint64_t s0 = produced_;
    std::size_t i = 0;
    while (i < n) {
        const geo::ActivitySchedule::Segment seg = sched_.segment_at(s0 + i);
        const std::uint64_t stop = std::min<std::uint64_t>(seg.end, s0 + n);
        // 段长必须为正，否则死循环。ActivitySchedule 保证 end > 查询点，这里显式兜一道。
        if (stop <= s0 + i) {
            err = "活动时间线给出的子段长度为零（样点 " + std::to_string(s0 + i) + "）";
            return Step::Error;
        }
        // 带限之后 noise 也走同一条相位搬移路径，offset_Hz 对三种波形一视同仁（C-8）
        const double offset = seg.center_Hz + waveform_.offset_Hz - center_frequency_Hz_;
        // 相位用累加器而不是绝对样点号的闭式：跳频后频率会变，闭式重算会在跳频处造出相位跳变。
        // 逐样点累加与逐样点回卷都只是绝对样点号的函数，因此结果与块长无关。
        // 子段之间**不重置相位**——这是 DDS 型的相位连续跳频；非相干跳频（每跳随机相位）
        // 是另一种建模，本期不做（模型卡里写明，别让它成为隐含假设）。
        const double dphi = kTwoPi * offset / sample_rate_Hz_;

        for (std::uint64_t idx = s0 + i; idx < stop; ++idx, ++i) {
            bool on = seg.tx_on;
            if (on && waveform_.type == geo::WaveformType::Burst)
                on = (idx % burst_period_n_) < burst_on_n_;

            // a = 1 时逐样点乘法被优化掉，既有框图的结果逐位不变（emit_at_tx_power 缺省为假）
            const float a = static_cast<float>(tx_power_amp_);
            if (waveform_.type == geo::WaveformType::Noise) {
                float re = 0.0f, im = 0.0f;
                sub_rng_.complex_normal(re, im);      // E|z|^2 = 1，即单位功率
                double zr = re, zi = im;
                if (band_limit_) {
                    // 带限：状态跨块跨子段保持，于是只是绝对样点号的函数（铁律 9）
                    const std::complex<double> y =
                        dsp::biquad2_step(lp_, lp_state_, std::complex<double>(re, im));
                    zr = y.real() * lp_gain_norm_;
                    zi = y.imag() * lp_gain_norm_;
                }
                // 频率搬移：与 tone / burst 共用同一个相位累加器。带限之前 noise 不乘相位，
                // 于是 emission.center_Hz 与 offset_Hz 对它完全不起作用（C-8 修）。
                const double c = std::cos(phase_), sp = std::sin(phase_);
                d.iq.samples[i] = on ? Complex(static_cast<float>((zr * c - zi * sp)) * a,
                                               static_cast<float>((zr * sp + zi * c)) * a)
                                     : Complex(0.0f, 0.0f);
            } else {
                d.iq.samples[i] = on ? Complex(static_cast<float>(std::cos(phase_)) * a,
                                               static_cast<float>(std::sin(phase_)) * a)
                                     : Complex(0.0f, 0.0f);
            }
            // 载波相位始终推进：不发射时只是关门，不是把振荡器停掉。
            phase_ += dphi;
            if (phase_ >= kTwoPi) phase_ -= kTwoPi;
            else if (phase_ < 0.0) phase_ += kTwoPi;
        }
    }

    d.iq.meta.sample_rate_Hz = sample_rate_Hz_;
    d.iq.meta.center_frequency_Hz = center_frequency_Hz_;
    d.iq.meta.start_sample = produced_;
    d.iq.meta.time_basis = TimeBasis::LogicalSim;
    d.iq.meta.calibration = model_calibration();
    d.iq.meta.trace = make_trace("SceneEmitterSource", scene_.scenario_id + ":" + entity_id_);

    // 带限的三种处境摆到台面上（铁律 15，不静默）。C-8 之前只有第一支，且是无条件降级。
    if (waveform_.type == geo::WaveformType::Noise) {
        if (!band_limit_) {
            d.iq.meta.degrade("噪声波形的 emission.bw_Hz 不小于采样带宽，不作带限，"
                              "输出全带白噪声，占用带宽按采样带宽计");
            if (!band_note_done_) {
                status_.notes.push_back("噪声波形未带限：bw_Hz 不小于采样带宽，占用带宽按采样带宽计");
                band_note_done_ = true;
            }
        } else if (alias_frac_ > 1e-3) {
            // 带限了，但信号离带边太近：裙边绕折过去的功率不可忽略，如实降级
            d.iq.meta.degrade("噪声波形搬移后有 " + std::to_string(alias_frac_ * 100.0) +
                              "% 的功率绕折到带的另一头（中心频偏加带宽相对 Fs/2 太靠边）");
            if (!band_note_done_) {
                status_.notes.push_back("噪声带限：绕折功率占比超过千分之一，频偏相对采样带宽太靠边");
                band_note_done_ = true;
            }
        } else if (!band_note_done_) {
            // 正路：不降级，只记一行说明滤波器是什么形状（阻带不是砖墙）
            status_.notes.push_back("噪声波形按 4 阶巴特沃斯带限，−3 dB 截止 " +
                                    std::to_string(bw_Hz_ / 2.0) + " Hz，阻带非砖墙");
            band_note_done_ = true;
        }
    }

    out["out"] = d;
    produced_ += n;
    status_.blocks_out++;
    status_.samples_out += n;
    return Step::Produced;
}

void SceneEmitterSource::reset() {
    produced_ = 0;
    phase_ = 0.0;
    band_note_done_ = false;
    status_ = ComponentStatus();
}

}  // namespace cuav
