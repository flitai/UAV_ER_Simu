#include "cuav/components/scenario.h"

#include <algorithm>
#include <cmath>

#include "cuav/scenario_json.h"

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
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("site_id", "绑定的站点标识，由装载器按 scene_binding 注入").internal_only(),
    };
    return i;
}

bool ScenarioSource::configure(const std::map<std::string, double>& params,
                               const std::map<std::string, std::string>& text_params,
                               std::string& err) {
    get_text(text_params, "scenario_path", scenario_path_);
    get_text(text_params, "scenario_id", scenario_id_);
    get_text(text_params, "site_id", site_id_);

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
        if (!lf.build(scene_, site_id_, scene_.emitters[i].id, update_rate_Hz_, err)) return false;
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

bool ScenarioSource::init(IRandom&, std::string& err) {
    if (links_.empty()) {
        err = "ScenarioSource 没有任何链路：场景里至少要有一个辐射源";
        return false;
    }
    produced_ = 0;
    reported_upto_ = 0;
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
            sp.state = f.valid ? State::Valid : State::Invalid;
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
                lf.state = f.valid ? State::Valid : State::Invalid;
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
                    "活动时间线的图传开关与跳频在这里生效。noise 首期不做带限，"
                    "emission.bw_Hz 小于采样带宽时输出全带白噪声并标降级。";
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
    if (!emitter_.build(scene_, entity_id_, err)) return false;
    waveform_ = em->emission.waveform;
    emitter_center_Hz_ = em->emission.center_Hz;
    bw_Hz_ = em->emission.bw_Hz;
    emit_at_tx_power_ = get_num(params, "emit_at_tx_power", 0.0) != 0.0;
    tx_power_amp_ = emit_at_tx_power_ ? std::pow(10.0, em->emission.tx_power_dBm / 20.0) : 1.0;

    // 铁律 4：|Δf| + B/2 + 保护带 < Fs/2。这里的 Δf 是基带频偏，B 是占用带宽。
    const double offset = (waveform_.type == geo::WaveformType::Noise) ? 0.0 : waveform_.offset_Hz;
    const double df = emitter_center_Hz_ + offset - center_frequency_Hz_;
    if (std::fabs(df) + bw_Hz_ / 2.0 >= sample_rate_Hz_ / 2.0) {
        err = "辐射源 " + entity_id_ + " 的基带频偏 " + std::to_string(df) + " Hz 加半带宽超出奈奎斯特"
              "（|Δf| + B/2 < Fs/2，铁律 4）";
        return false;
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

    // 跳频与图传开关按块起点取值（活动时间线是秒级事件，块长在毫秒量级）。
    const double t0 = static_cast<double>(produced_) / sample_rate_Hz_;
    const double center_now = emitter_.center_Hz_at(t0);
    const bool tx = emitter_.tx_on_at(t0);
    const double offset =
        center_now + ((waveform_.type == geo::WaveformType::Noise) ? 0.0 : waveform_.offset_Hz) -
        center_frequency_Hz_;
    // 相位用累加器而不是绝对样点号的闭式：跳频后频率会变，闭式重算会在跳频处造出相位跳变。
    // 逐样点累加与逐样点回卷都只是绝对样点号的函数，因此结果与块长无关。
    const double dphi = kTwoPi * offset / sample_rate_Hz_;

    for (std::size_t i = 0; i < n; ++i) {
        const std::uint64_t idx = produced_ + i;
        bool on = tx;
        if (on && waveform_.type == geo::WaveformType::Burst)
            on = (idx % burst_period_n_) < burst_on_n_;

        // a = 1 时逐样点乘法被优化掉，既有框图的结果逐位不变（emit_at_tx_power 缺省为假）
        const float a = static_cast<float>(tx_power_amp_);
        if (waveform_.type == geo::WaveformType::Noise) {
            float re = 0.0f, im = 0.0f;
            sub_rng_.complex_normal(re, im);      // E|z|^2 = 1，即单位功率
            d.iq.samples[i] = on ? Complex(re * a, im * a) : Complex(0.0f, 0.0f);
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

    d.iq.meta.sample_rate_Hz = sample_rate_Hz_;
    d.iq.meta.center_frequency_Hz = center_frequency_Hz_;
    d.iq.meta.start_sample = produced_;
    d.iq.meta.time_basis = TimeBasis::LogicalSim;
    d.iq.meta.calibration = model_calibration();
    d.iq.meta.trace = make_trace("SceneEmitterSource", scene_.scenario_id + ":" + entity_id_);

    // 已知的模型简化摆到台面上：首期没有带限滤波器（铁律 15，不静默）。
    if (waveform_.type == geo::WaveformType::Noise && bw_Hz_ < sample_rate_Hz_) {
        d.iq.meta.degrade("噪声波形未做带限：emission.bw_Hz 小于采样带宽，本版本输出全带白噪声，占用带宽偏大");
        if (!band_note_done_) {
            status_.notes.push_back("噪声波形未做带限，占用带宽按采样带宽计");
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
