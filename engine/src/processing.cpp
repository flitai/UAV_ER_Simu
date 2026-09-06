#include "cuav/components/processing.h"

#include <algorithm>
#include <cmath>

#include "cuav/dsp.h"

namespace cuav {
namespace {

const double kLn2 = 0.69314718055994530942;

double get(const std::map<std::string, double>& p, const std::string& k, double dflt) {
    auto it = p.find(k);
    return it == p.end() ? dflt : it->second;
}

ModelTrace make_trace(const std::string& id, const std::string& layer,
                      const std::string& level, const std::string& cred) {
    ModelTrace t;
    t.model_id = id;
    t.model_version = "0.1.0";
    t.model_level = level;
    t.model_layer = layer;
    t.credibility = cred;
    t.parameter_version = "engine-thin-slice";
    t.trace_id = id + ":0";
    return t;
}

double median_sorted_copy(std::vector<double> v) {
    if (v.empty()) return 0.0;
    const std::size_t n = v.size();
    std::sort(v.begin(), v.end());
    // 与 numpy.median 同定义：偶数个取中间两个的平均
    if (n % 2) return v[n / 2];
    return 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

}  // namespace

// -------------------------------------------------------------------- AddMixer

bool AddMixer::configure(const std::map<std::string, double>& params,
                         const std::map<std::string, std::string>&, std::string&) {
    gain_a_ = get(params, "gain_a", 1.0);
    gain_b_ = get(params, "gain_b", 1.0);
    return true;
}

bool AddMixer::init(IRandom&, std::string&) { status_ = ComponentStatus(); return true; }

Step AddMixer::process(PortMap& in, PortMap& out, std::string& err) {
    auto ia = in.find("a");
    auto ib = in.find("b");
    if (ia == in.end() || ib == in.end() || !ia->second.has_data || !ib->second.has_data) {
        return Step::Idle;
    }
    const Block& a = ia->second.iq;
    const Block& b = ib->second.iq;
    if (a.meta.sample_rate_Hz != b.meta.sample_rate_Hz ||
        a.meta.center_frequency_Hz != b.meta.center_frequency_Hz) {
        // 采样率或中心频率不同就不是同一个观测点上的东西，不能按样点相加
        err = "AddMixer 两路的采样率或中心频率不一致，拒绝相加";
        return Step::Error;
    }
    const std::size_t n = std::min(a.size(), b.size());
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.resize(n);
    const float ga = static_cast<float>(gain_a_);
    const float gb = static_cast<float>(gain_b_);
    for (std::size_t i = 0; i < n; ++i) d.iq.samples[i] = a.samples[i] * ga + b.samples[i] * gb;
    d.iq.meta = a.meta;
    d.iq.meta.trace = make_trace("AddMixer", "M3", "E2", "V3");
    d.iq.meta.state = worst(a.meta.state, b.meta.state);
    d.iq.meta.state_reasons = a.meta.state_reasons;
    for (const auto& r : b.meta.state_reasons) d.iq.meta.state_reasons.push_back(r);
    // 功率标定（D-047 ⑤）：两路都标定才算标定，来源取较弱的一路；任一路未标定则整体未标定，
    // 未标定的那一路自带的降级理由已经并进来了，这里不再重复
    PowerCalibration c;
    if (a.meta.calibration.calibrated && b.meta.calibration.calibrated) {
        const PowerCalibration& ca = a.meta.calibration;
        const PowerCalibration& cb = b.meta.calibration;
        c.calibrated = true;
        const std::string weak = weaker_source(ca.source, cb.source);
        const PowerCalibration& w = (weak == cb.source && weak != ca.source) ? cb : ca;
        c.offset_dB = w.offset_dB;
        c.source = weak;
        c.note = "混合：a 路 " + ca.source + "，b 路 " + cb.source + "，取较弱来源；各路已在源端换算到 mW";
    }
    d.iq.meta.calibration = c;
    if (a.size() != b.size()) {
        d.iq.meta.degrade("两路块长不同，按较短的一路截断");
    }
    out["out"] = d;
    status_.blocks_in += 2;
    status_.blocks_out++;
    status_.samples_out += n;
    status_.state = worst(status_.state, d.iq.meta.state);
    return Step::Produced;
}

void AddMixer::reset() { status_ = ComponentStatus(); }

// -------------------------------------------------------------- EnergyDetector

bool EnergyDetector::configure(const std::map<std::string, double>& params,
                               const std::map<std::string, std::string>&,
                               std::string& err) {
    nfft_ = static_cast<std::size_t>(get(params, "nfft", 1024.0));
    if (nfft_ == 0 || (nfft_ & (nfft_ - 1)) != 0) {
        err = "EnergyDetector 的 nfft 必须是 2 的幂";
        return false;
    }
    auto lo = params.find("band_lo_Hz");
    auto hi = params.find("band_hi_Hz");
    if (lo == params.end() || hi == params.end()) {
        err = "EnergyDetector 缺必填参数 band_lo_Hz / band_hi_Hz";
        return false;
    }
    band_lo_Hz_ = lo->second;
    band_hi_Hz_ = hi->second;
    if (band_hi_Hz_ <= band_lo_Hz_) { err = "EnergyDetector 频段上下限颠倒"; return false; }
    pfa_ = get(params, "pfa", 1e-3);
    if (!(pfa_ > 0.0 && pfa_ < 1.0)) { err = "EnergyDetector 的 pfa 必须在 (0,1)"; return false; }
    noise_frames_ = static_cast<std::size_t>(get(params, "noise_frames", 8192.0));
    if (noise_frames_ == 0) { err = "EnergyDetector 的 noise_frames 必须大于 0"; return false; }
    return true;
}

bool EnergyDetector::init(IRandom&, std::string&) {
    carry_.clear();
    probe_.clear();
    noise_per_bin_.clear();
    band_mask_.clear();
    pending_.clear();
    noise_ready_ = false;
    frames_ = 0;
    hits_ = 0;
    next_frame_start_ = 0;
    status_ = ComponentStatus();
    return true;
}

void EnergyDetector::build_mask() {
    band_mask_.assign(nfft_, false);
    m_bins_ = 0;
    for (std::size_t k = 0; k < nfft_; ++k) {
        // fftshift 之后第 k 个频点对应的频率，与 numpy.fft.fftshift(fftfreq) 一致
        const double idx = static_cast<double>(k) - static_cast<double>(nfft_ / 2);
        const double f = idx * sample_rate_Hz_ / static_cast<double>(nfft_);
        if (f >= band_lo_Hz_ && f < band_hi_Hz_) {
            band_mask_[k] = true;
            m_bins_++;
        }
    }
}

void EnergyDetector::finalise_noise() {
    noise_per_bin_.assign(nfft_, 0.0);
    for (std::size_t k = 0; k < nfft_; ++k) {
        std::vector<double> col;
        col.reserve(probe_.size());
        for (const auto& row : probe_) col.push_back(row[k]);
        noise_per_bin_[k] = median_sorted_copy(col) / kLn2;
    }
    noise_band_ = 0.0;
    for (std::size_t k = 0; k < nfft_; ++k) if (band_mask_[k]) noise_band_ += noise_per_bin_[k];
    eta_ = dsp::threshold_for_pfa(m_bins_, pfa_);
    noise_ready_ = true;
    // 探针帧本身也要判决，不能丢：它们同样是数据
    for (std::size_t i = 0; i < probe_.size(); ++i) {
        double e = 0.0;
        for (std::size_t k = 0; k < nfft_; ++k) if (band_mask_[k]) e += probe_[i][k];
        Detection d;
        d.frame_index = i;
        d.start_sample = static_cast<std::uint64_t>(i * nfft_);
        d.statistic = noise_band_ > 0.0 ? e / noise_band_ : 0.0;
        d.threshold = eta_;
        d.hit = d.statistic > eta_;
        if (d.hit) hits_++;
        pending_.push_back(d);
        frames_++;
    }
    probe_.clear();
}

void EnergyDetector::consume_frame(const std::vector<Complex>& frame,
                                   std::uint64_t start_sample) {
    std::vector<Complex> x = frame;
    dsp::fft_inplace(x);
    dsp::fftshift(x);
    std::vector<double> power(nfft_);
    for (std::size_t k = 0; k < nfft_; ++k) {
        const double re = static_cast<double>(x[k].real());
        const double im = static_cast<double>(x[k].imag());
        power[k] = re * re + im * im;
    }
    if (!noise_ready_) {
        probe_.push_back(power);
        if (probe_.size() >= noise_frames_) finalise_noise();
        return;
    }
    double e = 0.0;
    for (std::size_t k = 0; k < nfft_; ++k) if (band_mask_[k]) e += power[k];
    Detection d;
    d.frame_index = frames_;
    d.start_sample = start_sample;
    d.statistic = noise_band_ > 0.0 ? e / noise_band_ : 0.0;
    d.threshold = eta_;
    d.hit = d.statistic > eta_;
    if (d.hit) hits_++;
    pending_.push_back(d);
    frames_++;
}

Step EnergyDetector::process(PortMap& in, PortMap& out, std::string& err) {
    auto it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& blk = it->second.iq;
    if (sample_rate_Hz_ == 0.0) {
        sample_rate_Hz_ = blk.meta.sample_rate_Hz;
        center_frequency_Hz_ = blk.meta.center_frequency_Hz;
        if (sample_rate_Hz_ <= 0.0) { err = "EnergyDetector 收到的块没有采样率"; return Step::Error; }
        build_mask();
        if (m_bins_ == 0) { err = "EnergyDetector 的检测频段内没有频点"; return Step::Error; }
    } else if (blk.meta.sample_rate_Hz != sample_rate_Hz_) {
        err = "EnergyDetector 中途收到不同采样率的块";
        return Step::Error;
    }

    status_.blocks_in++;
    status_.samples_in += blk.size();
    status_.state = worst(status_.state, blk.meta.state);

    // 拼上上一块的余量再切帧；块大小由调度器定，组件不假设它是帧长的整数倍
    std::size_t pos = 0;
    while (pos < blk.size()) {
        const std::size_t need = nfft_ - carry_.size();
        const std::size_t take = std::min(need, blk.size() - pos);
        carry_.insert(carry_.end(), blk.samples.begin() + static_cast<long>(pos),
                      blk.samples.begin() + static_cast<long>(pos + take));
        pos += take;
        if (carry_.size() == nfft_) {
            consume_frame(carry_, next_frame_start_);
            next_frame_start_ += nfft_;
            carry_.clear();
        }
    }

    if (pending_.empty()) return Step::Idle;
    PortData d;
    d.type = PortType::DetectionList;
    d.has_data = true;
    d.detections.items.swap(pending_);
    d.detections.meta = blk.meta;
    d.detections.meta.trace = make_trace("EnergyDetector", "M2", "E2", "V3");
    out["out"] = d;
    status_.blocks_out++;
    return Step::Produced;
}

Step EnergyDetector::flush(PortMap& out, std::string& err) {
    (void)err;
    if (!noise_ready_ && !probe_.empty()) {
        // 数据不够探针帧数：仍然要给结果，但必须标 degraded 说明噪声估计样本不足，
        // 不能假装门限是按设计样本量标定出来的（铁律 15）
        noise_frames_ = probe_.size();
        finalise_noise();
        status_.state = worst(status_.state, State::Degraded);
        status_.notes.push_back("噪声估计只用了 " + std::to_string(noise_frames_) +
                                " 帧，少于配置值，门限可信度下降");
    }
    if (!carry_.empty()) {
        status_.notes.push_back("末尾 " + std::to_string(carry_.size()) +
                                " 个样点不足一帧，已丢弃（不补零，补零会造出假信号）");
        carry_.clear();
    }
    if (pending_.empty()) return Step::Finished;
    PortData d;
    d.type = PortType::DetectionList;
    d.has_data = true;
    d.detections.items.swap(pending_);
    d.detections.meta.sample_rate_Hz = sample_rate_Hz_;
    d.detections.meta.center_frequency_Hz = center_frequency_Hz_;
    d.detections.meta.trace = make_trace("EnergyDetector", "M2", "E2", "V3");
    out["out"] = d;
    status_.blocks_out++;
    return Step::Finished;
}

void EnergyDetector::reset() {
    carry_.clear(); probe_.clear(); pending_.clear();
    noise_ready_ = false; frames_ = 0; hits_ = 0; next_frame_start_ = 0;
    sample_rate_Hz_ = 0.0;
    status_ = ComponentStatus();
}

// ---------------------------------------------------------------- DetectionSink

Step DetectionSink::process(PortMap& in, PortMap& out, std::string& err) {
    (void)out; (void)err;
    auto it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const DetectionList& dl = it->second.detections;
    for (const auto& d : dl.items) {
        frames_++;
        if (d.hit) hits_++;
        if (d.statistic > max_stat_) max_stat_ = d.statistic;
        threshold_ = d.threshold;
    }
    status_.blocks_in++;
    status_.state = worst(status_.state, dl.meta.state);
    return Step::Produced;
}

// ------------------------------------------------------------------ describe()

ComponentInfo AddMixer::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Source;
    i.display_name = "加法混合";
    i.description = "两路 IQ 加权相加，用于真实背景加合成目标（04 §15.2 标准算例第 10 项）；"
                    "两路采样率与中心频率必须一致";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "AddMixer";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.params = {
        ParamSpec::number("gain_a", "", "a 路线性增益").def(1.0),
        ParamSpec::number("gain_b", "", "b 路线性增益").def(1.0),
    };
    return i;
}

ComponentInfo EnergyDetector::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "能量检测";
    i.description = "切帧不加窗不重叠，每帧 DFT 后取频段能量，除以逐频点帧维中位数噪声估计，与门限比较；"
                    "口径与 algos/reference/energy_detector.py 一致（EM-S-02，决策 D-026）";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "EnergyDetector";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = true;
    i.params = {
        ParamSpec::number("nfft", "", "帧长，等于 DFT 点数").def(1024.0).at_least(2.0).constrained("2 的幂"),
        ParamSpec::number("band_lo_Hz", "Hz", "检测频段下限，相对中心频率").req(),
        ParamSpec::number("band_hi_Hz", "Hz", "检测频段上限，相对中心频率").req()
            .constrained("band_hi_Hz > band_lo_Hz"),
        ParamSpec::number("pfa", "", "目标虚警率").def(1e-3).at_least(0.0, true).at_most(1.0, true),
        ParamSpec::number("noise_frames", "", "用于噪声估计的帧数").def(8192.0).at_least(1.0),
    };
    return i;
}

ComponentInfo DetectionSink::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "检测汇聚";
    i.description = "检测结果的计数与极值摘要";
    i.model_layer = "M2";
    i.model_level = "E1";
    i.model_id = "DetectionSink";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = true;
    return i;
}

}  // namespace cuav
