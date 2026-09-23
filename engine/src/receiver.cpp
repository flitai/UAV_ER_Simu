#include "cuav/numstr.h"
#include "cuav/components/receiver.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>

#include "cuav_geo/link_budget.h"

namespace cuav {
namespace {

const double kPi = 3.14159265358979323846;
const double kTwoPi = 2.0 * kPi;

ModelTrace make_trace(const std::string& model_id, const std::string& trace_id) {
    ModelTrace t;
    t.model_id = model_id;
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M3";
    t.credibility = "V2";
    t.parameter_version = "receiver-chain-v1";
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

// ------------------------------------------------------------ ReceiverFrontEnd

ComponentInfo ReceiverFrontEnd::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Receiver;
    i.display_name = "接收机前端";
    i.description =
        "接收机射频前端等效模型（04 §7.5）。按顺序施加：等效输入热噪声（由噪声系数生成，"
        "N0 = −174 dBm/Hz + 10·log10(T/290) + nf_dB，与场景参数帧里的链路噪声底同一常数）、"
        "总增益、本振频偏（相位累加器跨块连续）、IQ 幅相不平衡（K1·y + K2·conj(y) 形式，"
        "与 MATLAB comm.IQImbalance 同定义）、直流偏置。噪声加在增益之前，即噪声系数是输入折合的。"
        "本组件不做接收滤波：幅频响应与群时延是 M-3 的 Coder 产物，串在本组件之前。"
        "相位噪声、增益压缩与自动增益控制的动态过程随 P3（04 §7.5 的其余项）。"
        "noise_mode = none 用于混合增强模式：实测背景片段自带接收机噪声，再注入即重复计入。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-B-11";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;
    i.stateful = true;
    i.params = {
        ParamSpec::choice("noise_mode", {"thermal", "none"},
                          "热噪声注入：按噪声系数生成，或不注入（混合增强模式下背景已含噪声）")
            .def_text("thermal"),
        ParamSpec::number("nf_dB", "dB", "噪声系数").req().at_least(0.0).at_most(30.0),
        ParamSpec::number("reference_temperature_K", "K", "热噪声参考温度；290 K 时噪声底为 −174 dBm/Hz + nf")
            .def(290.0).at_least(100.0).at_most(1000.0),
        ParamSpec::number("gain_dB", "dB", "总增益，加在噪声之后（噪声系数是输入折合的）")
            .def(0.0).at_least(-20.0).at_most(80.0),
        ParamSpec::number("lo_offset_Hz", "Hz", "本振频偏").def(0.0),
        ParamSpec::number("iq_gain_imbalance_dB", "dB", "IQ 幅度不平衡")
            .def(0.0).at_least(-3.0).at_most(3.0),
        ParamSpec::number("iq_phase_imbalance_deg", "deg", "IQ 相位不平衡")
            .def(0.0).at_least(-20.0).at_most(20.0),
        ParamSpec::number("dc_offset_mW", "mW", "直流分量功率，I、Q 各占一半；0 为关")
            .def(0.0).at_least(0.0),
    };
    return i;
}

bool ReceiverFrontEnd::configure(const std::map<std::string, double>& params,
                                 const std::map<std::string, std::string>& text_params,
                                 std::string& err) {
    get_text(text_params, "noise_mode", noise_mode_);
    if (noise_mode_.empty()) noise_mode_ = "thermal";
    if (noise_mode_ != "thermal" && noise_mode_ != "none") {
        err = "ReceiverFrontEnd 的 noise_mode 必须是 thermal / none";
        return false;
    }
    std::map<std::string, double>::const_iterator nf = params.find("nf_dB");
    if (nf == params.end()) { err = "ReceiverFrontEnd 缺必填参数 nf_dB"; return false; }
    nf_dB_ = nf->second;
    if (nf_dB_ < 0.0) { err = "ReceiverFrontEnd 的 nf_dB 不得为负"; return false; }

    reference_temperature_K_ = get_num(params, "reference_temperature_K", 290.0);
    if (!(reference_temperature_K_ > 0.0)) {
        err = "ReceiverFrontEnd 的 reference_temperature_K 必须为正";
        return false;
    }
    gain_dB_ = get_num(params, "gain_dB", 0.0);
    lo_offset_Hz_ = get_num(params, "lo_offset_Hz", 0.0);
    iq_gain_imbalance_dB_ = get_num(params, "iq_gain_imbalance_dB", 0.0);
    iq_phase_imbalance_deg_ = get_num(params, "iq_phase_imbalance_deg", 0.0);
    dc_offset_mW_ = get_num(params, "dc_offset_mW", 0.0);
    if (dc_offset_mW_ < 0.0) { err = "ReceiverFrontEnd 的 dc_offset_mW 不得为负（它是功率）"; return false; }
    return true;
}

double ReceiverFrontEnd::noise_psd_dBm_per_Hz() const {
    // 常数只有一处定义：与 geo/link_budget.cpp 共用，使参数帧里的链路噪声底读数
    // 与这里实际注入的噪声逐项一致（D-051）。
    return geo::thermal_noise_dBm_per_Hz(nf_dB_) + 10.0 * std::log10(reference_temperature_K_ / 290.0);
}

double ReceiverFrontEnd::noise_power_dBm(double fs_Hz) const {
    if (!(fs_Hz > 0.0)) return 0.0;
    // 复基带噪声占满整个复奈奎斯特带，带宽等于复采样率
    return noise_psd_dBm_per_Hz() + 10.0 * std::log10(fs_Hz);
}

bool ReceiverFrontEnd::init(IRandom& rng, std::string& err) {
    (void)err;
    // 私有子流：与节点书写顺序解耦（08 报告 §11.1、§15 ⑨）
    sub_rng_ = Xoshiro256pp(rng.next_u64());
    sub_ready_ = true;
    phase_ = 0.0;
    fs_ = 0.0;
    have_fs_ = false;
    status_ = ComponentStatus();
    return true;
}

Step ReceiverFrontEnd::process(PortMap& in, PortMap& out, std::string& err) {
    PortMap::iterator it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    if (!sub_ready_) { err = "ReceiverFrontEnd 未注入随机源"; return Step::Error; }
    const Block& src = it->second.iq;

    if (!have_fs_) {
        fs_ = src.meta.sample_rate_Hz;
        if (!(fs_ > 0.0)) { err = "ReceiverFrontEnd 收到的块没有采样率"; return Step::Error; }
        have_fs_ = true;
        if (noise_mode_ == "thermal") {
            status_.notes.push_back("等效输入噪声 " + numstr(noise_power_dBm(fs_)) +
                                    " dBm（噪声系数 " + numstr(nf_dB_) + " dB，带宽 " +
                                    numstr(fs_) + " Hz）");
        }
    } else if (src.meta.sample_rate_Hz != fs_) {
        err = "ReceiverFrontEnd 中途收到不同采样率的块";
        return Step::Error;
    }

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.meta = src.meta;
    d.iq.meta.trace = make_trace("EM-B-11", noise_mode_);
    const std::size_t n = src.samples.size();
    d.iq.samples.resize(n);

    // 噪声总功率按整个复奈奎斯特带算，逐样点方差 = 总功率（复高斯 E|z|² = 1 时乘 sqrt(P)）
    const double noise_amp = (noise_mode_ == "thermal")
        ? std::sqrt(std::pow(10.0, noise_power_dBm(fs_) / 10.0)) : 0.0;
    const double g = std::pow(10.0, gain_dB_ / 20.0);
    // IQ 不平衡：K1 = (1 + g·e^{jφ})/2，K2 = (1 − g·e^{jφ})/2，与 comm.IQImbalance 同定义
    const double gi = std::pow(10.0, iq_gain_imbalance_dB_ / 20.0);
    const double ph = iq_phase_imbalance_deg_ * kPi / 180.0;
    const double k1r = 0.5 * (1.0 + gi * std::cos(ph)), k1i = 0.5 * (gi * std::sin(ph));
    const double k2r = 0.5 * (1.0 - gi * std::cos(ph)), k2i = 0.5 * (-gi * std::sin(ph));
    const bool imbalance = (iq_gain_imbalance_dB_ != 0.0 || iq_phase_imbalance_deg_ != 0.0);
    const double dc = (dc_offset_mW_ > 0.0) ? std::sqrt(dc_offset_mW_ / 2.0) : 0.0;
    const double dphi = kTwoPi * lo_offset_Hz_ / fs_;

    for (std::size_t i = 0; i < n; ++i) {
        double re = src.samples[i].real(), im = src.samples[i].imag();
        if (noise_amp > 0.0) {
            float nr = 0.0f, ni = 0.0f;
            sub_rng_.complex_normal(nr, ni);      // E|z|² = 1
            re += nr * noise_amp;
            im += ni * noise_amp;
        }
        re *= g;
        im *= g;
        if (lo_offset_Hz_ != 0.0) {
            const double c = std::cos(phase_), s = std::sin(phase_);
            const double r2 = re * c - im * s;
            const double i2 = re * s + im * c;
            re = r2; im = i2;
        }
        if (imbalance) {
            // K1·y + K2·conj(y)
            const double r2 = k1r * re - k1i * im + k2r * re + k2i * im;
            const double i2 = k1r * im + k1i * re - k2r * im + k2i * re;
            re = r2; im = i2;
        }
        re += dc;
        im += dc;
        d.iq.samples[i] = Complex(static_cast<float>(re), static_cast<float>(im));
        // 相位始终推进，与块长无关；逐样点回卷保证结果只是绝对样点号的函数
        phase_ += dphi;
        if (phase_ >= kTwoPi) phase_ -= kTwoPi;
        else if (phase_ < 0.0) phase_ += kTwoPi;
    }

    out["out"] = d;
    status_.blocks_in++;
    status_.blocks_out++;
    status_.samples_in += n;
    status_.samples_out += n;
    status_.state = worst(status_.state, d.iq.meta.state);
    return Step::Produced;
}

void ReceiverFrontEnd::reset() {
    phase_ = 0.0;
    fs_ = 0.0;
    have_fs_ = false;
    status_ = ComponentStatus();
}

// --------------------------------------------------------------- AdcQuantizer

ComponentInfo AdcQuantizer::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Receiver;
    i.display_name = "ADC 量化";
    i.description =
        "ADC 采样与量化（04 §7.6）。I、Q 各按 bits 位均匀量化，量化步长 q = 2A / 2^bits，"
        "其中 A = 10^(full_scale_dBm/20) 是满量程复单音的幅度；超出可表示范围的样点在 ±A 处削波。"
        "满量程复单音的量化信噪比为 6.02·bits + 1.76 dB。"
        "**削波是数据标记不是降级**：逐块的削波样点数写进块元数据 clip_count 与 state_reasons，"
        "四态不变；只有全程削波比例超过 degrade_clip_ratio 才在收尾时把组件状态标降级（D-051）。"
        "采样时钟偏差、丢样与不连续注入是 04 §7.6 的可选项，本版本未实现。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-B-11";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;
    i.stateful = true;   // 削波计数跨块累计
    i.params = {
        ParamSpec::choice("bits", {"8", "10", "12", "14", "16"}, "I、Q 各自的量化位数").def_text("14"),
        ParamSpec::number("full_scale_dBm", "dBm", "满量程复单音对应的功率")
            .req().at_least(-60.0).at_most(30.0),
        ParamSpec::choice("rounding", {"nearest"}, "量化取整方式；抖动随后续版本").def_text("nearest"),
        ParamSpec::number("degrade_clip_ratio", "", "全程削波样点比例超过它才标降级")
            .def(0.01).at_least(0.0, true).at_most(1.0),
    };
    return i;
}

bool AdcQuantizer::configure(const std::map<std::string, double>& params,
                             const std::map<std::string, std::string>& text_params,
                             std::string& err) {
    std::string bits;
    get_text(text_params, "bits", bits);
    if (bits.empty()) bits = "14";
    if (bits != "8" && bits != "10" && bits != "12" && bits != "14" && bits != "16") {
        err = "AdcQuantizer 的 bits 必须是 8 / 10 / 12 / 14 / 16 之一";
        return false;
    }
    bits_ = std::atoi(bits.c_str());

    std::map<std::string, double>::const_iterator fs = params.find("full_scale_dBm");
    if (fs == params.end()) { err = "AdcQuantizer 缺必填参数 full_scale_dBm"; return false; }
    full_scale_dBm_ = fs->second;

    get_text(text_params, "rounding", rounding_);
    if (rounding_.empty()) rounding_ = "nearest";
    if (rounding_ != "nearest") { err = "AdcQuantizer 的 rounding 本版本只支持 nearest"; return false; }

    degrade_clip_ratio_ = get_num(params, "degrade_clip_ratio", 0.01);
    if (!(degrade_clip_ratio_ > 0.0) || degrade_clip_ratio_ > 1.0) {
        err = "AdcQuantizer 的 degrade_clip_ratio 必须在 (0, 1] 内";
        return false;
    }

    full_scale_amp_ = std::pow(10.0, full_scale_dBm_ / 20.0);
    const double levels = std::pow(2.0, static_cast<double>(bits_));
    lsb_ = 2.0 * full_scale_amp_ / levels;
    code_max_ = levels / 2.0 - 1.0;      // 二进制补码的正端比负端少一个码
    code_min_ = -levels / 2.0;
    return true;
}

bool AdcQuantizer::init(IRandom&, std::string& err) {
    (void)err;
    clipped_ = 0;
    seen_ = 0;
    status_ = ComponentStatus();
    return true;
}

Step AdcQuantizer::process(PortMap& in, PortMap& out, std::string& err) {
    (void)err;
    PortMap::iterator it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& src = it->second.iq;

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.meta = src.meta;
    d.iq.meta.trace = make_trace("EM-B-11", "adc");
    const std::size_t n = src.samples.size();
    d.iq.samples.resize(n);

    std::uint64_t clipped_here = 0;
    for (std::size_t i = 0; i < n; ++i) {
        double v[2] = {src.samples[i].real(), src.samples[i].imag()};
        bool clipped = false;
        for (int k = 0; k < 2; ++k) {
            double code = std::floor(v[k] / lsb_ + 0.5);
            if (code > code_max_) { code = code_max_; clipped = true; }
            else if (code < code_min_) { code = code_min_; clipped = true; }
            v[k] = code * lsb_;
        }
        if (clipped) clipped_here++;
        d.iq.samples[i] = Complex(static_cast<float>(v[0]), static_cast<float>(v[1]));
    }
    clipped_ += clipped_here;
    seen_ += n;

    // 标记而非降级：四态不动，只把计数与理由随块带走（D-051）
    d.iq.meta.clip_count = clipped_here;
    if (clipped_here > 0) {
        d.iq.meta.state_reasons.push_back("adc_clip:" + numstr(clipped_here));
    }

    out["out"] = d;
    status_.blocks_in++;
    status_.blocks_out++;
    status_.samples_in += n;
    status_.samples_out += n;
    status_.state = worst(status_.state, d.iq.meta.state);
    return Step::Produced;
}

Step AdcQuantizer::flush(PortMap&, std::string& err) {
    (void)err;
    if (seen_ > 0 && clipped_ > 0) {
        const double ratio = static_cast<double>(clipped_) / static_cast<double>(seen_);
        status_.notes.push_back("削波 " + numstr(clipped_) + " / " + numstr(seen_) +
                                " 样点");
        if (ratio > degrade_clip_ratio_) {
            // 持续过载的数据对下游检测识别确实不可信，这时才降级（EM-S-02 的 overload_flag 同理）
            status_.state = worst(status_.state, State::Degraded);
            status_.notes.push_back("削波比例超过 " + numstr(degrade_clip_ratio_) +
                                    "，量化结果不足以支撑下游判决");
        }
    }
    return Step::Finished;
}

void AdcQuantizer::reset() {
    clipped_ = 0;
    seen_ = 0;
    status_ = ComponentStatus();
}

}  // namespace cuav
