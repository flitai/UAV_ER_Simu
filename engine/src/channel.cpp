#include "cuav/numstr.h"
#include "cuav/components/channel.h"

#include <algorithm>
#include <cmath>
#include <complex>

#include "cuav/random.h"
#include "cuav/scenario_json.h"
#include "cuav_geo/link_budget.h"

namespace cuav {
namespace {

const double kPi = 3.14159265358979323846;
const double kTwoPi = 2.0 * kPi;
const double kEps = 1e-12;

ModelTrace make_trace(const std::string& id, const std::string& trace_id) {
    ModelTrace t;
    t.model_id = id;
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M3";
    t.credibility = "V2";
    t.parameter_version = "scenario-thin-slice";
    t.trace_id = trace_id;
    return t;
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

}  // namespace

// ------------------------------------------------------------ SceneBoundChannel

SceneBoundChannel::SceneBoundChannel() {}

ComponentInfo SceneBoundChannel::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Channel;
    i.display_name = "场景绑定信道";
    i.description = "把场景参数帧施加到 IQ 上：增益 = tx_power_dBm + 发射天线增益 + 接收天线增益 − 路损，"
                    "整数样点时延，多普勒相位斜坡（相位累加器跨块连续）。帧内零阶保持，"
                    "帧过期而无新帧到达时按上一帧继续并把块标降级。"
                    "输入应是归一化到单位功率的波形（SceneEmitterSource），否则电平会重复计入。"
                    "本组件不注入热噪声：帧里的 noise_floor_dBm_per_Hz 目前只供链路读数，"
                    "热噪声注入待接收机前端。时延为整数样点，delay_s 变化处有 ±1 样点跳变，"
                    "分数时延随 P3；单站场景里绝对时延在频谱上不可观测，它的意义在于为多站与"
                    "到达时间差定位预留结构。"
                    "小尺度衰落（fading = rician，Q-4）：视距帧按 fading_k_los_dB 的莱斯、非视距帧瑞利"
                    "（K 读帧的 line_of_sight），散射分量为 Jakes 谱的统计型正弦和，最大多普勒取 "
                    "max(平台速度·f/c, fading_min_doppler_Hz)；fading_delay_spread_ns > 0 时按 8 抽头"
                    "指数时延谱给出频率选择性。总平均功率为 1，不与路损重复计入。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-P-01";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = true;
    i.stateful = true;
    i.params = {
        ParamSpec::boolean("apply_gain", "是否施加链路预算增益").def_bool(true),
        ParamSpec::choice("gain_mode", {"link_budget", "path_loss_only"},
                          "增益口径：link_budget 施加 tx_power + 发射天线增益 + 接收天线增益 − 路损；"
                          "path_loss_only 只施加 −路损，另三项由辐射源与两个天线组件各自负责"
                          "（典型链路视图用后者，D-051）").def_text("link_budget"),
        ParamSpec::boolean("apply_doppler", "是否施加多普勒相位斜坡").def_bool(true),
        ParamSpec::choice("delay_mode", {"off", "fixed_at_start", "tracking"},
                          "时延模式：不施加 / 全程用起始时刻的整数时延 / 逐帧跟随").def_text("tracking"),
        ParamSpec::number("max_delay_samples", "", "时延历史缓冲的上限；帧要求超过它即报错，不截断")
            .def(65536.0).at_least(1.0),
        ParamSpec::choice("fading", {"off", "rician"},
                          "小尺度衰落：关，或莱斯（视距帧）/ 瑞利（非视距帧），散射分量为 Jakes 谱")
            .def_text("off"),
        ParamSpec::number("fading_k_los_dB", "dB", "视距帧的莱斯 K 因子；非视距帧固定为瑞利（K = 0）。取值 assumed")
            .def(9.0).at_least(-10.0).at_most(40.0),
        ParamSpec::number("fading_min_doppler_Hz", "Hz",
                          "最大多普勒的下限：悬停时平台速度为 0，取它代表摆动与地面散射体的运动。取值 assumed")
            .def(5.0).at_least(0.0).at_most(1000.0),
        ParamSpec::number("fading_delay_spread_ns", "ns",
                          "均方根时延扩展；0 为平坦衰落，大于 0 时按 8 抽头指数时延谱给出频率选择性。取值 assumed")
            .def(0.0).at_least(0.0).at_most(5000.0),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("entity_id", "绑定的辐射源标识，由装载器按 scene_binding 注入").internal_only(),
        ParamSpec::text("site_id",
                        "绑定的站点标识，由装载器按 scene_binding 注入（D-053）。"
                        "单站场景可省略，此时取唯一站点；多站场景必填，否则不知道接收天线增益取哪个站的")
            .internal_only(),
    };
    return i;
}

bool SceneBoundChannel::configure(const std::map<std::string, double>& params,
                                  const std::map<std::string, std::string>& text_params,
                                  std::string& err) {
    get_text(text_params, "scenario_path", scenario_path_);
    get_text(text_params, "scenario_id", scenario_id_);
    get_text(text_params, "entity_id", entity_id_);
    get_text(text_params, "site_id", site_id_);
    get_text(text_params, "gain_mode", gain_mode_);
    if (gain_mode_.empty()) gain_mode_ = "link_budget";
    if (gain_mode_ != "link_budget" && gain_mode_ != "path_loss_only") {
        err = "gain_mode 必须是 link_budget / path_loss_only 之一";
        return false;
    }
    get_text(text_params, "delay_mode", delay_mode_);
    if (delay_mode_.empty()) delay_mode_ = "tracking";
    if (delay_mode_ != "off" && delay_mode_ != "fixed_at_start" && delay_mode_ != "tracking") {
        err = "delay_mode 必须是 off / fixed_at_start / tracking 之一";
        return false;
    }
    apply_gain_ = get_num(params, "apply_gain", 1.0) != 0.0;
    apply_doppler_ = get_num(params, "apply_doppler", 1.0) != 0.0;
    const double md = get_num(params, "max_delay_samples", 65536.0);
    if (!(md >= 1.0)) { err = "max_delay_samples 必须为正"; return false; }
    max_delay_samples_ = static_cast<std::size_t>(md);

    std::string fading = "off";
    get_text(text_params, "fading", fading);
    if (fading.empty()) fading = "off";
    if (fading != "off" && fading != "rician") { err = "fading 必须是 off / rician 之一"; return false; }
    fading_on_ = (fading == "rician");
    fading_k_los_dB_ = get_num(params, "fading_k_los_dB", 9.0);
    fading_min_doppler_Hz_ = get_num(params, "fading_min_doppler_Hz", 5.0);
    fading_delay_spread_ns_ = get_num(params, "fading_delay_spread_ns", 0.0);
    if (fading_on_) {
        if (!std::isfinite(fading_k_los_dB_)) { err = "fading_k_los_dB 必须是有限值"; return false; }
        if (!(fading_min_doppler_Hz_ >= 0.0)) { err = "fading_min_doppler_Hz 不得为负"; return false; }
        if (!(fading_delay_spread_ns_ >= 0.0)) { err = "fading_delay_spread_ns 不得为负"; return false; }
    }

    if (scenario_path_.empty()) {
        err = "SceneBoundChannel 缺内部参数 scenario_path。它由装载器按节点的 scene_binding 解析注入"
              "（框图里只写 scene_binding，D-037）；单机运行请给 cuav_run --scenario <场景文件>";
        return false;
    }
    LoadedScenario ls;
    if (!load_scenario_file(scenario_path_, ls, err)) return false;
    if (!scenario_id_.empty() && ls.scenario.scenario_id != scenario_id_) {
        err = "SceneBoundChannel 绑定的场景标识是 " + scenario_id_ + "，但文件里的是 " + ls.scenario.scenario_id;
        return false;
    }
    const geo::Emitter* em = ls.scenario.find_emitter(entity_id_);
    if (em == 0) {
        err = "场景 " + ls.scenario.scenario_id + " 里没有辐射源 " + entity_id_;
        return false;
    }
    // 接收天线增益取哪个站的（D-053 替换了原来「首期只支持单站场景」的守卫）。
    // 三分支，第一支就是旧行为，所以既有的单站框图一字不用改：
    //   site_id 为空 + 单站 → 取唯一站；site_id 为空 + 多站 → 报错（不猜）；site_id 非空 → 按 id 找。
    // 原守卫的理由是「接收天线增益取唯一站点的」，而 C-2 之后增益已拆到 AntennaGain，
    // 典型链路用 gain_mode = path_loss_only，这条守卫早就名不副实了。
    const geo::Site* site = nullptr;
    if (site_id_.empty()) {
        if (ls.scenario.sites.size() != 1) {
            err = "多站场景（" + numstr(ls.scenario.sites.size()) +
                  " 个站点）的场景绑定信道必须在 scene_binding 里绑定 site_id，"
                  "否则不知道接收天线增益取哪个站的";
            return false;
        }
        site = &ls.scenario.sites[0];
    } else {
        site = ls.scenario.find_site(site_id_);
        if (site == 0) {
            err = "场景 " + ls.scenario.scenario_id + " 里没有站点 " + site_id_;
            return false;
        }
    }
    tx_power_dBm_ = em->emission.tx_power_dBm;
    tx_gain_dBi_ = em->emission.antenna_gain_dBi;
    rx_gain_dBi_ = site->antenna.gain_dBi;
    return true;
}

bool SceneBoundChannel::init(IRandom& rng, std::string& err) {
    (void)err;
    reset();
    // 衰落的随机量只在开衰落时从共享流取一个种子（D-058 ④ 阴影的先例）：不开就一个数不取，
    // 既有框图下游节点的子种子逐位不变。开了会挪动其后节点（含前端热噪声）的子种子，写在模型卡里。
    // 个数只由抽头数与正弦数决定、与采样率和时长无关，所以能在 init() 里一次取完。
    if (fading_on_) {
        Xoshiro256pp sub(rng.next_u64());
        fading::draw(sub, fd_);
    }
    return true;
}

// 推进到格点 m（Q-4，D-091）。first 为真时以 m 为起点、Φ = 0；否则 m 恰是上一格点加一。
// 右端格点的相位积分用**本格点所在帧**的最大多普勒推：只看已经到手的帧，不看未来，于是与块长无关。
void SceneBoundChannel::fading_advance(std::uint64_t m, const SceneParamFrame& f, bool first,
                                       std::string& err, bool& ok) {
    ok = true;
    double phi_m = 0.0;
    if (first) {
        fading::diffuse_at(fd_, fl_, 0.0, g_left_);
    } else {
        if (m != grid_m_ + 1) {
            err = "衰落格点不连续（" + numstr(grid_m_) + " → " + numstr(m) + "）";
            ok = false;
            return;
        }
        phi_m = grid_phi_next_;
        g_left_.swap(g_right_);
    }
    grid_m_ = m;
    grid_started_ = true;
    const double fd_max = std::max(f.speed_mps * f.tx_center_Hz / 299792458.0, fading_min_doppler_Hz_);
    const double step = kTwoPi * fd_max * static_cast<double>(grid_G_) / fs_;
    if (step > 0.3) {
        err = "衰落的最大多普勒 " + numstr(fd_max) + " Hz 对格点间隔 " + numstr(static_cast<double>(grid_G_)) +
              " 个样点（" + numstr(fs_) + " Hz）太快：一个格点相位转 " + numstr(step) +
              " rad，线性插值误差超出可接受范围（线 0.3 rad）";
        ok = false;
        return;
    }
    grid_phi_next_ = phi_m + step;
    fading::diffuse_at(fd_, fl_, grid_phi_next_, g_right_);
}

// 游标只前进：不做 k = floor(t·R) 的除法取整——t 恰为帧边界时浮点会把它推到上一帧，
// 而上一帧可能已经被丢掉了（08 报告 §9.3 约束 C）。
const SceneParamFrame* SceneBoundChannel::frame_for(double t_s) {
    if (pend_.empty()) return 0;
    while (cursor_ + 1 < pend_.size() && pend_[cursor_ + 1].valid_from_s <= t_s + kEps) ++cursor_;
    return &pend_[cursor_];
}

Step SceneBoundChannel::process(PortMap& in, PortMap& out, std::string& err) {
    PortMap::iterator iq_it = in.find("in");
    PortMap::iterator sc_it = in.find("scene");
    if (iq_it == in.end() || !iq_it->second.has_data) return Step::Idle;

    const Block& src = iq_it->second.iq;
    const std::size_t n = src.samples.size();

    if (src.meta.time_basis != TimeBasis::LogicalSim) {
        err = "场景绑定信道只接受逻辑仿真时基的样点；回放数据不得绑定场景"
              "（公开数据集片段与场景无关，06 备忘录防线二、三）";
        return Step::Error;
    }
    if (!have_fs_) {
        fs_ = src.meta.sample_rate_Hz;
        have_fs_ = true;
    } else if (std::fabs(src.meta.sample_rate_Hz - fs_) > 1e-9) {
        err = "输入采样率中途从 " + numstr(fs_) + " 变成 " +
              numstr(src.meta.sample_rate_Hz) + "；本组件不做重采样";
        return Step::Error;
    }
    if (!(fs_ > 0.0)) { err = "输入块没有采样率"; return Step::Error; }
    if (have_expect_ && src.meta.start_sample != expect_start_) {
        err = "输入块不连续：期望首样点序号 " + numstr(expect_start_) + "，实际 " +
              numstr(src.meta.start_sample) + "；不静默补零（铁律 3）";
        return Step::Error;
    }

    // 收帧：只追加比队尾更晚的帧，重发的同一帧自然被去掉。
    if (sc_it != in.end() && sc_it->second.has_data) {
        for (std::size_t i = 0; i < sc_it->second.scenes.size(); ++i) {
            const SceneParamFrame& f = sc_it->second.scenes[i];
            if (pend_.empty() || f.valid_from_s > pend_.back().valid_from_s + kEps) pend_.push_back(f);
        }
    }
    if (pend_.empty()) {
        err = "scene 口没有任何参数帧：场景参数源必须每轮产出（08 报告 §9.3）";
        return Step::Error;
    }
    if (fading_on_ && !fl_ready_) {
        if (!fading::layout(fading_delay_spread_ns_ * 1e-9, fs_, fl_, err)) return Step::Error;
        fl_ready_ = true;
        grid_G_ = std::max<std::uint64_t>(1, static_cast<std::uint64_t>(std::floor(fs_ / 1e5)));
        if (fl_.delay.back() > max_delay_samples_) {
            err = "衰落抽头的最大时延 " + numstr(static_cast<double>(fl_.delay.back())) +
                  " 个样点超过 max_delay_samples " + numstr(static_cast<double>(max_delay_samples_)) + "（不截断，铁律 15）";
            return Step::Error;
        }
        status_.notes.push_back(
            "小尺度衰落：视距莱斯 K = " + numstr(fading_k_los_dB_) + " dB、非视距瑞利；最大多普勒 max(速度·f/c, " +
            numstr(fading_min_doppler_Hz_) + " Hz)；均方根时延扩展 " + numstr(fading_delay_spread_ns_) + " ns → " +
            numstr(static_cast<double>(fl_.delay.size())) + " 个样点时延、实际 " +
            numstr(fl_.rms_delay_spread_s * 1e9) + " ns；格点 " + numstr(static_cast<double>(grid_G_)) +
            " 个样点（参数 assumed）");
    }

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.resize(n);
    d.iq.meta = src.meta;
    d.iq.meta.trace = make_trace("SceneBoundChannel", scenario_id_ + ":" + entity_id_);
    if (fading_on_) {
        // A 档参数主导（14 §9）：开衰落时降到 V1
        d.iq.meta.trace.parameter_version += "-fading";
        d.iq.meta.trace.credibility = "V1";
    }
    // 莱斯两端的权：视距帧 sqrt(K/(K+1)) 与 sqrt(1/(K+1))，非视距帧 0 与 1
    const double k_lin = std::pow(10.0, fading_k_los_dB_ / 10.0);
    const double a_los = std::sqrt(k_lin / (k_lin + 1.0)), a_dif_los = std::sqrt(1.0 / (k_lin + 1.0));
    const std::complex<double> los_phasor = std::polar(1.0, fd_.los_phase);
    const std::uint64_t fd_dmax = (fading_on_ && fl_ready_) ? fl_.delay.back() : 0;

    const std::uint64_t s0 = src.meta.start_sample;
    State frame_state = State::Valid;
    bool held_expired = false;
    double last_path_loss = 0.0;

    for (std::size_t i = 0; i < n; ++i) {
        const std::uint64_t idx = s0 + i;
        const double t = static_cast<double>(idx) / fs_;
        const SceneParamFrame* f = frame_for(t);
        if (f->valid_to_s < t - kEps) held_expired = true;
        frame_state = worst(frame_state, f->state);
        last_path_loss = f->path_loss_dB;

        // 时延：整数样点。
        std::uint64_t delay = 0;
        if (delay_mode_ != "off") {
            const double dsamp = f->delay_s * fs_;
            std::uint64_t want = static_cast<std::uint64_t>(dsamp + 0.5);
            if (delay_mode_ == "fixed_at_start") {
                if (!fixed_delay_set_) { fixed_delay_ = want; fixed_delay_set_ = true; }
                want = fixed_delay_;
            }
            if (want > max_delay_samples_) {
                err = "本帧时延 " + numstr(f->delay_s) + " 秒需要 " + numstr(want) +
                      " 个样点的历史，超过 max_delay_samples " + numstr(max_delay_samples_) +
                      "；请调大该参数或检查场景距离（不截断，铁律 15）";
                return Step::Error;
            }
            if (fading_on_ && want + fd_dmax > max_delay_samples_) {
                err = "本帧时延 " + numstr(f->delay_s) + " 秒加衰落抽头的最大时延需要 " + numstr(want + fd_dmax) +
                      " 个样点的历史，超过 max_delay_samples " + numstr(max_delay_samples_) +
                      "；请调大该参数（不截断，铁律 15）";
                return Step::Error;
            }
            delay = want;
            if (have_last_delay_ && delay != last_delay_) ++delay_steps_;
            last_delay_ = delay;
            have_last_delay_ = true;
        }

        // 取延迟后的输入样点：先看本块，再看上一块留下的尾巴，再往前就是流开头，输出精确零。
        auto fetch = [&](std::uint64_t dl) -> Complex {
            if (idx < dl) return Complex(0.0f, 0.0f);
            const std::uint64_t j = idx - dl;
            if (j >= s0) return src.samples[static_cast<std::size_t>(j - s0)];
            const std::uint64_t back = s0 - j;                  // 往回第 back 个
            if (back <= tail_.size()) return tail_[tail_.size() - static_cast<std::size_t>(back)];
            return Complex(0.0f, 0.0f);                         // 仍在时延线预热阶段
        };

        double g = 1.0;
        if (apply_gain_) {
            const double konst = (gain_mode_ == "path_loss_only")
                ? 0.0 : (tx_power_dBm_ + tx_gain_dBi_ + rx_gain_dBi_);
            const double gain_dB = konst - f->path_loss_dB;
            g = std::pow(10.0, gain_dB / 20.0);
        }
        if (fading_on_) {
            // 小尺度衰落（Q-4，D-091）：散射分量在格点上求值、格点间线性插值；K 与视距分量逐样点跟本样点的帧
            const std::uint64_t m = idx / grid_G_;
            if (!grid_started_ || m != grid_m_) {
                bool ok = true;
                fading_advance(m, *f, !grid_started_, err, ok);
                if (!ok) return Step::Error;
            }
            const double frac = static_cast<double>(idx - grid_m_ * grid_G_) / static_cast<double>(grid_G_);
            const double al = f->line_of_sight ? a_los : 0.0;
            const double ad = f->line_of_sight ? a_dif_los : 1.0;
            std::complex<double> acc(0.0, 0.0);
            for (std::size_t k = 0; k < fl_.delay.size(); ++k) {
                std::complex<double> h = ad * (g_left_[k] + frac * (g_right_[k] - g_left_[k]));
                if (k == 0) h += al * los_phasor;      // 视距分量只在 0 号时延（fl_.delay[0] 恒为 0）
                const Complex xs = fetch(delay + fl_.delay[k]);
                acc += h * std::complex<double>(xs.real(), xs.imag());
            }
            if (apply_doppler_) {
                acc *= std::complex<double>(std::cos(phase_), std::sin(phase_));
                phase_ += kTwoPi * f->doppler_Hz / fs_;
                if (phase_ >= kTwoPi) phase_ -= kTwoPi;
                else if (phase_ < 0.0) phase_ += kTwoPi;
            }
            d.iq.samples[i] = Complex(static_cast<float>(acc.real() * g), static_cast<float>(acc.imag() * g));
            continue;
        }
        Complex x = fetch(delay);
        if (apply_doppler_) {
            const float c = static_cast<float>(std::cos(phase_));
            const float s = static_cast<float>(std::sin(phase_));
            const float re = x.real() * c - x.imag() * s;
            const float im = x.real() * s + x.imag() * c;
            x = Complex(re, im);
            phase_ += kTwoPi * f->doppler_Hz / fs_;
            if (phase_ >= kTwoPi) phase_ -= kTwoPi;
            else if (phase_ < 0.0) phase_ += kTwoPi;
        }
        d.iq.samples[i] = Complex(static_cast<float>(x.real() * g), static_cast<float>(x.imag() * g));
    }

    // 尾巴：留下最近 max_delay_samples_ 个输入样点供下一块回看。
    {
        std::vector<Complex> merged;
        merged.reserve(tail_.size() + n);
        merged.insert(merged.end(), tail_.begin(), tail_.end());
        merged.insert(merged.end(), src.samples.begin(), src.samples.end());
        if (merged.size() > max_delay_samples_)
            merged.erase(merged.begin(), merged.begin() + static_cast<std::ptrdiff_t>(merged.size() - max_delay_samples_));
        tail_.swap(merged);
    }
    // 丢掉游标之前的帧，队列不无限长。
    if (cursor_ > 0) {
        pend_.erase(pend_.begin(), pend_.begin() + static_cast<std::ptrdiff_t>(cursor_));
        cursor_ = 0;
    }

    d.iq.meta.state = worst(d.iq.meta.state, frame_state);
    if (held_expired) {
        d.iq.meta.degrade("参数帧已过有效期而没有新帧到达，按上一帧零阶保持继续");
        if (!held_note_done_) {
            status_.notes.push_back("出现过参数帧过期后继续保持的块");
            held_note_done_ = true;
        }
    }
    (void)last_path_loss;

    out["out"] = d;
    expect_start_ = s0 + n;
    have_expect_ = true;
    status_.blocks_in++;
    status_.blocks_out++;
    status_.samples_in += n;
    status_.samples_out += n;
    status_.state = worst(status_.state, d.iq.meta.state);
    return Step::Produced;
}

void SceneBoundChannel::reset() {
    have_fs_ = false;
    fs_ = 0.0;
    have_expect_ = false;
    expect_start_ = 0;
    phase_ = 0.0;
    tail_.clear();
    pend_.clear();
    cursor_ = 0;
    fixed_delay_set_ = false;
    fixed_delay_ = 0;
    have_last_delay_ = false;
    last_delay_ = 0;
    held_note_done_ = false;
    // 衰落：只清动态状态，init() 取的正弦表与相位不清（reset 后同一次运行逐位复现）
    fl_ready_ = false;
    fl_ = fading::Layout();
    grid_G_ = 1;
    grid_m_ = 0;
    grid_started_ = false;
    grid_phi_next_ = 0.0;
    g_left_.clear();
    g_right_.clear();
    ComponentStatus fresh;
    // 时延跳变次数是跨 reset 的累计诊断量，运行结束时汇总进 notes。
    fresh.notes = status_.notes;
    status_ = fresh;
    delay_steps_ = 0;
}

// ------------------------------------------------------------- FreeSpaceChannel

ComponentInfo FreeSpaceChannel::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Channel;
    i.display_name = "自由空间信道";
    i.description = "定参自由空间传播：L = 20·log10(4πd/λ)，增益 = tx_power_dBm + 发射天线增益 + "
                    "接收天线增益 − L，逐样点常数。不绑定场景，供标准算例与解析锚点对拍用；"
                    "随时间变化的链路走场景绑定信道。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-P-01";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;
    i.params = {
        ParamSpec::number("distance_m", "m", "站点到辐射源的斜距").req().at_least(0.0, true),
        ParamSpec::number("frequency_Hz", "Hz", "载频").req().at_least(0.0, true),
        ParamSpec::number("tx_power_dBm", "dBm", "发射功率；输入应是归一化到单位功率的波形").def(0.0),
        ParamSpec::number("tx_gain_dBi", "dBi", "发射天线增益").def(0.0),
        ParamSpec::number("rx_gain_dBi", "dBi", "接收天线增益").def(0.0),
    };
    return i;
}

bool FreeSpaceChannel::configure(const std::map<std::string, double>& params,
                                 const std::map<std::string, std::string>&, std::string& err) {
    distance_m_ = get_num(params, "distance_m", 0.0);
    frequency_Hz_ = get_num(params, "frequency_Hz", 0.0);
    if (!(distance_m_ > 0.0)) { err = "FreeSpaceChannel 需要正的 distance_m"; return false; }
    if (!(frequency_Hz_ > 0.0)) { err = "FreeSpaceChannel 需要正的 frequency_Hz"; return false; }
    tx_power_dBm_ = get_num(params, "tx_power_dBm", 0.0);
    tx_gain_dBi_ = get_num(params, "tx_gain_dBi", 0.0);
    rx_gain_dBi_ = get_num(params, "rx_gain_dBi", 0.0);
    path_loss_dB_ = geo::fspl_dB(distance_m_, frequency_Hz_);
    amplitude_ = std::pow(10.0, (tx_power_dBm_ + tx_gain_dBi_ + rx_gain_dBi_ - path_loss_dB_) / 20.0);
    return true;
}

bool FreeSpaceChannel::init(IRandom&, std::string& err) {
    (void)err;
    status_ = ComponentStatus();
    return true;
}

Step FreeSpaceChannel::process(PortMap& in, PortMap& out, std::string& err) {
    (void)err;
    PortMap::iterator it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& src = it->second.iq;
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.meta = src.meta;
    d.iq.meta.trace = make_trace("FreeSpaceChannel", "free-space");
    d.iq.samples.resize(src.samples.size());
    const float a = static_cast<float>(amplitude_);
    for (std::size_t i = 0; i < src.samples.size(); ++i)
        d.iq.samples[i] = Complex(src.samples[i].real() * a, src.samples[i].imag() * a);
    out["out"] = d;
    status_.blocks_in++;
    status_.blocks_out++;
    status_.samples_in += src.samples.size();
    status_.samples_out += src.samples.size();
    return Step::Produced;
}

void FreeSpaceChannel::reset() { status_ = ComponentStatus(); }

}  // namespace cuav
