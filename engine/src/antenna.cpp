#include "cuav/components/antenna.h"

#include <algorithm>
#include <cmath>

namespace cuav {
namespace {

ModelTrace make_trace(const std::string& trace_id) {
    ModelTrace t;
    t.model_id = "EM-B-07";
    t.model_version = "0.1.0";
    t.model_level = "E1";     // 解析式方向图是 EM-B-07 §15 的 E1 档；查表是 E2，随 P3
    t.model_layer = "M3";
    t.credibility = "V2";
    t.parameter_version = "antenna-analytic-v1";
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

// 角度差归约到 (−180, 180]
double wrap180(double d) {
    while (d > 180.0) d -= 360.0;
    while (d <= -180.0) d += 360.0;
    return d;
}

bool is_polarization(const std::string& s) {
    return s == "vertical" || s == "horizontal" || s == "slant45" || s == "rhcp" || s == "lhcp";
}

bool is_linear(const std::string& s) {
    return s == "vertical" || s == "horizontal" || s == "slant45";
}

}  // namespace

ComponentInfo AntennaGain::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Antenna;
    i.display_name = "天线增益";
    i.description =
        "按方向图施加天线增益。全向为常量增益；定向按 12·[(Δaz/θaz)² + (Δel/θel)²] 的抛物线主瓣"
        "衰减并截止于副瓣底（Δ = θ/2 处恰为 3 dB，即半功率波束宽度的定义，EM-B-07 §10.3 的 E1 抽象）。"
        "来波 / 去波方向优先取 scene 口的参数帧（role = tx 用离开角，role = rx 用到达角）；"
        "scene 口是可选输入，不接时按 aspect_az_deg / aspect_el_deg 当常量方向。"
        "极化失配损耗与馈线损耗只在 role = rx 时各计一次，避免两端重复计入。"
        "首期没有方向图查表、阵列流形、互耦与平台遮挡（04 §7.4），那些随 P3。";
    i.model_layer = "M3";
    i.model_level = "E1";
    i.model_id = "EM-B-07";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;   // 场景派生的缺省由典型链路视图填入，组件自己不读场景文件
    i.stateful = true;          // 帧队列
    i.params = {
        ParamSpec::choice("role", {"tx", "rx"},
                          "本天线在链路的哪一端：tx 用参数帧的离开角，rx 用到达角，"
                          "且只有 rx 端计极化失配与馈线损耗").req(),
        ParamSpec::choice("pattern", {"omni", "directional"}, "方向图形式").def_text("omni"),
        ParamSpec::number("gain_dBi", "dBi", "峰值增益").req().at_least(-10.0).at_most(40.0),
        ParamSpec::number("beamwidth_az_deg", "deg", "方位半功率波束宽度，仅 directional")
            .def(60.0).at_least(0.0, true).at_most(360.0),
        ParamSpec::number("beamwidth_el_deg", "deg", "俯仰半功率波束宽度，仅 directional")
            .def(60.0).at_least(0.0, true).at_most(180.0),
        ParamSpec::number("sidelobe_dB", "dB", "副瓣底相对峰值的衰减上限，仅 directional")
            .def(20.0).at_least(0.0).at_most(60.0),
        ParamSpec::choice("pointing", {"fixed", "heading"},
                          "视轴指向：固定方位，或跟随平台航向（只对 role = tx 有意义）").def_text("fixed"),
        ParamSpec::number("boresight_az_deg", "deg", "视轴方位，真北顺时针")
            .def(0.0).at_least(0.0).at_most(360.0, true),
        ParamSpec::number("boresight_el_deg", "deg", "视轴俯仰，水平为 0")
            .def(0.0).at_least(-90.0).at_most(90.0),
        ParamSpec::choice("polarization", {"vertical", "horizontal", "slant45", "rhcp", "lhcp"},
                          "本天线极化").def_text("vertical"),
        ParamSpec::choice("peer_polarization", {"vertical", "horizontal", "slant45", "rhcp", "lhcp"},
                          "对端天线极化；典型链路视图从场景 emission.polarization 带出").def_text("vertical"),
        ParamSpec::number("feeder_loss_dB", "dB", "馈线固定损耗，正值为损耗；只在 role = rx 端计")
            .def(0.0).at_least(0.0).at_most(20.0),
        ParamSpec::number("aspect_az_deg", "deg", "scene 口未接时的常量来波 / 去波方位")
            .def(0.0).at_least(0.0).at_most(360.0, true),
        ParamSpec::number("aspect_el_deg", "deg", "scene 口未接时的常量来波 / 去波俯仰")
            .def(0.0).at_least(-90.0).at_most(90.0),
    };
    return i;
}

bool AntennaGain::configure(const std::map<std::string, double>& params,
                            const std::map<std::string, std::string>& text_params,
                            std::string& err) {
    role_.clear();
    get_text(text_params, "role", role_);
    if (role_ != "tx" && role_ != "rx") {
        err = "AntennaGain 缺必填参数 role，或取值不是 tx / rx";
        return false;
    }
    get_text(text_params, "pattern", pattern_);
    if (pattern_.empty()) pattern_ = "omni";
    if (pattern_ != "omni" && pattern_ != "directional") {
        err = "AntennaGain 的 pattern 必须是 omni / directional";
        return false;
    }
    get_text(text_params, "pointing", pointing_);
    if (pointing_.empty()) pointing_ = "fixed";
    if (pointing_ != "fixed" && pointing_ != "heading") {
        err = "AntennaGain 的 pointing 必须是 fixed / heading";
        return false;
    }
    get_text(text_params, "polarization", polarization_);
    if (polarization_.empty()) polarization_ = "vertical";
    get_text(text_params, "peer_polarization", peer_polarization_);
    if (peer_polarization_.empty()) peer_polarization_ = "vertical";
    if (!is_polarization(polarization_) || !is_polarization(peer_polarization_)) {
        err = "AntennaGain 的极化必须是 vertical / horizontal / slant45 / rhcp / lhcp 之一";
        return false;
    }

    std::map<std::string, double>::const_iterator g = params.find("gain_dBi");
    if (g == params.end()) { err = "AntennaGain 缺必填参数 gain_dBi"; return false; }
    gain_dBi_ = g->second;

    beamwidth_az_deg_ = get_num(params, "beamwidth_az_deg", 60.0);
    beamwidth_el_deg_ = get_num(params, "beamwidth_el_deg", 60.0);
    if (!(beamwidth_az_deg_ > 0.0) || !(beamwidth_el_deg_ > 0.0)) {
        err = "AntennaGain 的波束宽度必须为正";
        return false;
    }
    sidelobe_dB_ = get_num(params, "sidelobe_dB", 20.0);
    if (sidelobe_dB_ < 0.0) { err = "AntennaGain 的 sidelobe_dB 不得为负（它是衰减量）"; return false; }
    boresight_az_deg_ = get_num(params, "boresight_az_deg", 0.0);
    boresight_el_deg_ = get_num(params, "boresight_el_deg", 0.0);
    feeder_loss_dB_ = get_num(params, "feeder_loss_dB", 0.0);
    if (feeder_loss_dB_ < 0.0) { err = "AntennaGain 的 feeder_loss_dB 不得为负（它是损耗量）"; return false; }
    aspect_az_deg_ = get_num(params, "aspect_az_deg", 0.0);
    aspect_el_deg_ = get_num(params, "aspect_el_deg", 0.0);
    return true;
}

bool AntennaGain::init(IRandom&, std::string& err) {
    (void)err;
    reset();
    return true;
}

void AntennaGain::reset() {
    pend_.clear();
    cursor_ = 0;
    fs_ = 0.0;
    have_fs_ = false;
    no_scene_note_done_ = false;
    status_ = ComponentStatus();
}

double AntennaGain::gain_at_dB(double d_az_deg, double d_el_deg) const {
    double g = gain_dBi_;
    if (pattern_ == "directional") {
        const double a = wrap180(d_az_deg) / beamwidth_az_deg_;
        const double e = d_el_deg / beamwidth_el_deg_;
        // 12·(Δ/θ)² 在 Δ = θ/2 处等于 3 dB，即半功率波束宽度的定义
        const double drop = 12.0 * (a * a + e * e);
        g -= std::min(drop, sidelobe_dB_);
    }
    if (role_ == "rx") g -= feeder_loss_dB_;
    return g;
}

double AntennaGain::polarization_loss_dB() const {
    // 只在接收端计一次；发射端计一次接收端再计一次会重复计入。
    if (role_ != "rx") return 0.0;
    if (polarization_ == peer_polarization_) return 0.0;
    const bool a_lin = is_linear(polarization_), b_lin = is_linear(peer_polarization_);
    // 线极化与圆极化之间理论上恰好 3 dB
    if (a_lin != b_lin) return 3.0;
    // 圆极化之间旋向相反：理论上完全隔离，工程上取 20 dB 的标称值，不用无穷大
    if (!a_lin && !b_lin) return 20.0;
    // 线极化之间：正交 20 dB（工程标称），与 slant45 差 45° 恰好 3 dB
    const bool a45 = (polarization_ == "slant45"), b45 = (peer_polarization_ == "slant45");
    if (a45 || b45) return 3.0;
    return 20.0;
}

// 游标只前进，与 SceneBoundChannel::frame_for 同法：不做 k = floor(t·R) 的除法反算，
// t 恰在帧边界时浮点会把它推到上一帧，而上一帧可能已经被丢掉了（08 报告 §9.3）。
const SceneParamFrame* AntennaGain::frame_for(double t_s) {
    while (cursor_ + 1 < pend_.size() && pend_[cursor_ + 1].valid_from_s <= t_s) ++cursor_;
    if (pend_.empty()) return 0;
    return &pend_[cursor_];
}

Step AntennaGain::process(PortMap& in, PortMap& out, std::string& err) {
    PortMap::iterator sit = in.find("scene");
    if (sit != in.end() && sit->second.has_data) {
        for (std::size_t i = 0; i < sit->second.scenes.size(); ++i)
            pend_.push_back(sit->second.scenes[i]);
    }
    PortMap::iterator it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& src = it->second.iq;

    if (!have_fs_) {
        fs_ = src.meta.sample_rate_Hz;
        if (!(fs_ > 0.0)) { err = "AntennaGain 收到的块没有采样率"; return Step::Error; }
        have_fs_ = true;
    } else if (src.meta.sample_rate_Hz != fs_) {
        err = "AntennaGain 中途收到不同采样率的块";
        return Step::Error;
    }

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.meta = src.meta;
    d.iq.meta.trace = make_trace(role_ + ":" + pattern_);
    const std::size_t n = src.samples.size();
    d.iq.samples.resize(n);

    const double pol = polarization_loss_dB();
    if (pend_.empty()) {
        // 没有参数帧：按常量方向。这是声明过的能力（scene 是可选口），不是拿默认值顶替，
        // 但仍然记一条说明，免得日后看产品时以为方向图跟着航迹动过（铁律 15）。
        if (!no_scene_note_done_) {
            status_.notes.push_back("scene 口未接，方向按 aspect_az_deg / aspect_el_deg 的常量值施加");
            no_scene_note_done_ = true;
        }
        const double g_dB = gain_at_dB(aspect_az_deg_ - boresight_az_deg_,
                                       aspect_el_deg_ - boresight_el_deg_) - pol;
        const float g = static_cast<float>(std::pow(10.0, g_dB / 20.0));
        for (std::size_t i = 0; i < n; ++i)
            d.iq.samples[i] = Complex(src.samples[i].real() * g, src.samples[i].imag() * g);
    } else {
        // 逐样点查帧，帧内零阶保持——与信道的增益施加同一口径（08 报告 §9.5）
        for (std::size_t i = 0; i < n; ++i) {
            const std::uint64_t idx = src.meta.start_sample + i;
            const SceneParamFrame* f = frame_for(static_cast<double>(idx) / fs_);
            double az = 0.0, el = 0.0;
            if (role_ == "tx") { az = f->aod_az_deg; el = f->aod_el_deg; }
            else { az = f->aoa_az_deg; el = f->aoa_el_deg; }
            double bore_az = boresight_az_deg_;
            if (pointing_ == "heading") bore_az = f->tx_heading_deg + boresight_az_deg_;
            const double g_dB = gain_at_dB(az - bore_az, el - boresight_el_deg_) - pol;
            const float g = static_cast<float>(std::pow(10.0, g_dB / 20.0));
            d.iq.samples[i] = Complex(src.samples[i].real() * g, src.samples[i].imag() * g);
        }
        if (cursor_ > 0) {
            pend_.erase(pend_.begin(), pend_.begin() + static_cast<std::ptrdiff_t>(cursor_));
            cursor_ = 0;
        }
    }

    out["out"] = d;
    status_.blocks_in++;
    status_.blocks_out++;
    status_.samples_in += n;
    status_.samples_out += n;
    status_.state = worst(status_.state, d.iq.meta.state);
    return Step::Produced;
}

}  // namespace cuav
