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
    // 削顶计数相加（D-051）：混合增强模式下 ADC 只在合成目标那一路上，取哪一路当"主"都不对，
    // 两路相加才是这一块里被削顶的样点总数。两路都为 0 时结果仍是 0，既有框图不受影响。
    d.iq.meta.clip_count = a.meta.clip_count + b.meta.clip_count;
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

// --------------------------------------------------------------- Superposition

ComponentInfo Superposition::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Channel;
    i.display_name = "多路叠加";
    i.description = "把 N 路复基带逐样点相加，用于多辐射源在接收天线端汇成一路（D-053）。"
                    "落点选在接收天线之后、接收机前端之前：物理上电磁场在天线口面叠加，"
                    "接收机只有一条通道；放在前端之后等于给每个源配一台接收机。"
                    "八个输入口都是可选的，实际连上的路数不得少于 min_inputs。"
                    "各支路的采样率、中心频率、首样点序号与块长必须一致，任一项不一致即报错不截断"
                    "——调度器每轮无条件覆盖下游缓冲，截断会让较长那一路的尾部样点被静默丢掉（08 报告约定四）。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-B-09";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.params = {
        ParamSpec::number("min_inputs", "", "至少要连上几路；连得少于它即校验失败，"
                                            "免得「以为接了三路其实只接了一路」而无声出错")
            .def(2.0).at_least(1.0).at_most(8.0),
    };
    return i;
}

bool Superposition::check_wiring(const std::vector<std::string>& wired, std::string& err) const {
    if (wired.size() >= min_inputs_) return true;
    err = "多路叠加要求至少连上 " + std::to_string(min_inputs_) + " 路，实际只连了 " +
          std::to_string(wired.size()) + " 路";
    return false;
}

bool Superposition::configure(const std::map<std::string, double>& params,
                              const std::map<std::string, std::string>&, std::string& err) {
    const double m = get(params, "min_inputs", 2.0);
    if (!(m >= 1.0) || !(m <= 8.0)) { err = "min_inputs 必须在 1 到 8 之间"; return false; }
    min_inputs_ = static_cast<std::size_t>(m);
    return true;
}

bool Superposition::init(IRandom&, std::string&) { status_ = ComponentStatus(); return true; }

Step Superposition::process(PortMap& in, PortMap& out, std::string& err) {
    // 收齐本轮到手的支路。任一已连的口本轮没数据就整轮 Idle：少加一路等于凭空少了一个辐射源，
    // 而下一轮的块会把这一轮覆盖掉，缺的样点再也补不回来。
    std::vector<const Block*> parts;
    std::vector<std::string> names;
    for (int k = 1; k <= 8; ++k) {
        const std::string name = std::string("in") + static_cast<char>('0' + k);
        PortMap::iterator it = in.find(name);
        if (it == in.end()) continue;              // 这个口没连
        if (!it->second.has_data) return Step::Idle;
        parts.push_back(&it->second.iq);
        names.push_back(name);
    }
    if (parts.empty()) return Step::Idle;

    const Block& a = *parts[0];
    for (std::size_t k = 1; k < parts.size(); ++k) {
        const Block& b = *parts[k];
        const char* what = 0;
        if (a.meta.sample_rate_Hz != b.meta.sample_rate_Hz) what = "采样率";
        else if (a.meta.center_frequency_Hz != b.meta.center_frequency_Hz) what = "中心频率";
        else if (a.meta.start_sample != b.meta.start_sample) what = "首样点序号";
        else if (a.size() != b.size()) what = "块长";
        if (what != 0) {
            err = std::string("多路叠加的 ") + names[0] + " 与 " + names[k] + " 两路" + what +
                  "不一致，拒绝相加（截断会让较长一路的尾部样点被下一轮静默覆盖）";
            return Step::Error;
        }
    }

    const std::size_t n = a.size();
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.assign(a.samples.begin(), a.samples.end());
    for (std::size_t k = 1; k < parts.size(); ++k) {
        const std::vector<Complex>& v = parts[k]->samples;
        for (std::size_t i = 0; i < n; ++i) d.iq.samples[i] += v[i];
    }
    d.iq.meta = a.meta;
    d.iq.meta.trace = make_trace("EM-B-09", "M3", "E2", "V2");
    d.iq.meta.clip_count = 0;
    d.iq.meta.state_reasons.clear();
    State st = State::Valid;
    bool all_cal = true;
    std::string weak;
    for (std::size_t k = 0; k < parts.size(); ++k) {
        const BlockMeta& m = parts[k]->meta;
        st = worst(st, m.state);
        d.iq.meta.clip_count += m.clip_count;
        for (std::size_t r = 0; r < m.state_reasons.size(); ++r) {
            d.iq.meta.state_reasons.push_back(m.state_reasons[r]);
        }
        // 标定：全部支路都标定才算标定，来源取最弱的一路（与 AddMixer 同口径，D-047 ⑤）
        if (!m.calibration.calibrated) all_cal = false;
        else weak = weak.empty() ? m.calibration.source : weaker_source(weak, m.calibration.source);
    }
    d.iq.meta.state = st;
    PowerCalibration c;
    if (all_cal) {
        c.calibrated = true;
        c.source = weak;
        for (std::size_t k = 0; k < parts.size(); ++k) {
            if (parts[k]->meta.calibration.source == weak) {
                c.offset_dB = parts[k]->meta.calibration.offset_dB;
                break;
            }
        }
        c.note = "叠加 " + std::to_string(parts.size()) + " 路，取最弱来源 " + weak +
                 "；各路已在源端换算到 mW";
    }
    d.iq.meta.calibration = c;

    out["out"] = d;
    status_.blocks_in += parts.size();
    status_.blocks_out++;
    status_.samples_out += n;
    status_.state = worst(status_.state, st);
    return Step::Produced;
}

void Superposition::reset() { status_ = ComponentStatus(); }

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
