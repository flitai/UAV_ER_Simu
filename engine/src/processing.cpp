#include "cuav/components/processing.h"

#include <algorithm>
#include <cmath>

#include "cuav/dsp.h"
#include "cuav/observer.h"

namespace cuav {
namespace {

const double kLn2 = 0.69314718055994530942;
const double kTwoPi = 6.283185307179586476925286766559;

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
                               const std::map<std::string, std::string>& text_params,
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

    // C-3（D-063）新增：噪声估计模式、滑动窗、突发合并、dBm 读数、站点身份
    noise_mode_ = "probe";
    auto nm = text_params.find("noise_mode");
    if (nm != text_params.end() && !nm->second.empty()) noise_mode_ = nm->second;
    if (noise_mode_ != "probe" && noise_mode_ != "sliding") {
        err = "EnergyDetector 的 noise_mode 必须是 probe / sliding";
        return false;
    }
    const double w = get(params, "noise_window_frames", 256.0);
    if (!(w >= 2.0)) { err = "EnergyDetector 的 noise_window_frames 必须不小于 2"; return false; }
    window_frames_ = static_cast<std::size_t>(w);
    const double gap = get(params, "merge_gap_frames", 2.0);
    if (gap < 0.0) { err = "EnergyDetector 的 merge_gap_frames 不得为负"; return false; }
    merge_gap_ = static_cast<std::uint64_t>(gap);
    want_dBm_ = get(params, "band_power_dBm", 1.0) != 0.0;
    auto sid = text_params.find("site_id");
    site_id_ = sid == text_params.end() ? std::string() : sid->second;
    return true;
}

void EnergyDetector::clear_state() {
    carry_.clear();
    probe_.clear();
    probe_overload_.clear();
    noise_per_bin_.clear();
    band_mask_.clear();
    band_bins_.clear();
    pending_.clear();
    noise_band_ = 0.0;
    eta_ = 0.0;
    m_bins_ = 0;
    noise_ready_ = false;
    probe_used_ = 0;
    frames_ = 0;
    hits_ = 0;
    next_frame_start_ = 0;
    ring_.clear();
    sorted_.clear();
    ring_dirty_ = false;
    ring_ever_full_ = false;
    frames_since_admit_ = 0;
    noise_stale_ = 0;
    last_hit_frame_ = -1;
    segment_counter_ = -1;
    segments_ = 0;
    overload_frames_ = 0;
    frame_overload_ = false;
    frame_calibrated_ = false;
    summary_sent_ = false;
    status_ = ComponentStatus();
}

bool EnergyDetector::init(IRandom&, std::string&) {
    clear_state();
    return true;
}

ModelTrace EnergyDetector::trace() const {
    ModelTrace t = make_trace("EnergyDetector", "M2", "E2", "V3");
    if (!site_id_.empty()) t.trace_id = "EnergyDetector:" + site_id_;
    return t;
}

void EnergyDetector::build_mask() {
    band_mask_.assign(nfft_, false);
    band_bins_.clear();
    m_bins_ = 0;
    for (std::size_t k = 0; k < nfft_; ++k) {
        // fftshift 之后第 k 个频点对应的频率，与 numpy.fft.fftshift(fftfreq) 一致
        const double idx = static_cast<double>(k) - static_cast<double>(nfft_ / 2);
        const double f = idx * sample_rate_Hz_ / static_cast<double>(nfft_);
        if (f >= band_lo_Hz_ && f < band_hi_Hz_) {
            band_mask_[k] = true;
            band_bins_.push_back(k);
            m_bins_++;
        }
    }
}

// 一帧判决的公共部分：统计量、门限、命中、时间与频段、dBm 读数、突发编号。
// probe 与 sliding 两条路径都经这里，statistic / threshold / hit 三个字段的算式与切片 ① 相同。
Detection EnergyDetector::make_detection(double e, std::uint64_t frame_index,
                                         std::uint64_t start_sample, bool overload) {
    Detection d;
    d.frame_index = frame_index;
    d.start_sample = start_sample;
    d.statistic = noise_band_ > 0.0 ? e / noise_band_ : 0.0;
    d.threshold = eta_;
    d.hit = d.statistic > eta_;
    d.t_s = sample_rate_Hz_ > 0.0 ? static_cast<double>(start_sample) / sample_rate_Hz_ : 0.0;
    d.f_lo_Hz = center_frequency_Hz_ + band_lo_Hz_;
    d.f_hi_Hz = center_frequency_Hz_ + band_hi_Hz_;
    // Λ = 0（噪声估计为零）时 log10 是 −inf，nlohmann 会写成 null；照 tap.cpp 的做法钳住
    d.snr_dB = 10.0 * std::log10(std::max(d.statistic, 1e-30));
    d.has_dBm = want_dBm_ && frame_calibrated_;
    if (d.has_dBm) {
        // 引擎内部 |x|² = mW（D-047）；未归一化 DFT 的 Parseval：Σ_k |X_k|² = nfft · Σ_n |x_n|²，
        // 频段内每样点平均功率 = Σ_band |X_k|² / nfft²
        const double n2 = static_cast<double>(nfft_) * static_cast<double>(nfft_);
        d.band_power_dBm = 10.0 * std::log10(std::max(e / n2, 1e-30));
        d.noise_dBm = 10.0 * std::log10(std::max(noise_band_ / n2, 1e-30));
    }
    d.overload = overload;
    if (overload) overload_frames_++;
    if (d.hit) {
        // 突发合并（EM-S-02 merge_time_gap）：与上一命中帧之间的非命中帧数不超过 merge_gap 即同段
        const std::int64_t fi = static_cast<std::int64_t>(frame_index);
        if (!(last_hit_frame_ >= 0 && fi - last_hit_frame_ - 1 <= static_cast<std::int64_t>(merge_gap_))) {
            ++segment_counter_;
            ++segments_;
        }
        d.segment_id = segment_counter_;
        last_hit_frame_ = fi;
        hits_++;
    }
    return d;
}

void EnergyDetector::report(const Detection& d) {
    if (obs_ == nullptr) return;
    DetectionReport r;
    r.node_id = node_name_;
    r.site_id = site_id_;
    r.d = d;
    obs_->on_detection(r);
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
    probe_used_ = probe_.size();
    // 探针帧本身也要判决，不能丢：它们同样是数据
    for (std::size_t i = 0; i < probe_.size(); ++i) {
        double e = 0.0;
        for (std::size_t k = 0; k < nfft_; ++k) if (band_mask_[k]) e += probe_[i][k];
        Detection d = make_detection(e, i, static_cast<std::uint64_t>(i * nfft_), probe_overload_[i]);
        d.noise_frames_used = static_cast<std::uint32_t>(probe_used_);
        pending_.push_back(d);
        report(d);
        frames_++;
    }
    probe_.clear();
    probe_overload_.clear();
}

// ---- sliding：环的维护与噪声重算 ----

void EnergyDetector::ring_push(const std::vector<double>& power) {
    if (ring_.size() == window_frames_) {
        const std::vector<double>& old = ring_.front();
        for (std::size_t j = 0; j < band_bins_.size(); ++j) {
            std::vector<double>& s = sorted_[j];
            // 值是逐位相同的 double，lower_bound 必命中；有重复值时删哪一个都一样
            auto it = std::lower_bound(s.begin(), s.end(), old[band_bins_[j]]);
            if (it != s.end()) s.erase(it);
        }
        ring_.pop_front();
    }
    for (std::size_t j = 0; j < band_bins_.size(); ++j) {
        std::vector<double>& s = sorted_[j];
        const double v = power[band_bins_[j]];
        s.insert(std::lower_bound(s.begin(), s.end(), v), v);
    }
    ring_.push_back(power);
    if (ring_.size() == window_frames_) ring_ever_full_ = true;
    ring_dirty_ = true;
}

void EnergyDetector::recompute_noise_from_ring() {
    noise_band_ = 0.0;
    for (std::size_t j = 0; j < band_bins_.size(); ++j) {
        const std::vector<double>& s = sorted_[j];
        const std::size_t n = s.size();
        // 与 numpy.median 同定义：偶数个取中间两个的平均
        const double med = (n % 2) ? s[n / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
        noise_band_ += med / kLn2;
    }
    ring_dirty_ = false;
}

// 滑动模式的一帧。顺序是契约的一部分（Python 参考同序，黄金基准逐帧对拍）：
//   ① 环空 → 本帧先入环（第 0 帧的 Λ 因此恒为 ln 2，不会命中）；
//   ② 环变过 → 重算噪声；
//   ③ 判决（noise_frames_used = 判决时的环大小）；判决时环已连续 > W 帧没更新 → 计一帧陈旧；
//   ④ 未命中且尚未入环 → 入环（满则弹最旧）；命中的帧不入环（删截）。
void EnergyDetector::judge_sliding(const std::vector<double>& power, std::uint64_t start_sample) {
    bool admitted = false;
    if (ring_.empty()) { ring_push(power); admitted = true; }
    if (ring_dirty_) recompute_noise_from_ring();
    double e = 0.0;
    for (std::size_t j = 0; j < band_bins_.size(); ++j) e += power[band_bins_[j]];
    const std::uint32_t used = static_cast<std::uint32_t>(ring_.size());
    if (frames_since_admit_ > window_frames_) noise_stale_++;
    Detection d = make_detection(e, frames_, start_sample, frame_overload_);
    d.noise_frames_used = used;
    if (!d.hit && !admitted) { ring_push(power); admitted = true; }
    frames_since_admit_ = admitted ? 0 : frames_since_admit_ + 1;
    pending_.push_back(d);
    report(d);
    frames_++;
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
    if (noise_mode_ == "sliding") {
        judge_sliding(power, start_sample);
        return;
    }
    if (!noise_ready_) {
        probe_.push_back(power);
        probe_overload_.push_back(frame_overload_);
        if (probe_.size() >= noise_frames_) finalise_noise();
        return;
    }
    double e = 0.0;
    for (std::size_t k = 0; k < nfft_; ++k) if (band_mask_[k]) e += power[k];
    Detection d = make_detection(e, frames_, start_sample, frame_overload_);
    d.noise_frames_used = static_cast<std::uint32_t>(probe_used_);
    pending_.push_back(d);
    report(d);
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
        if (noise_mode_ == "sliding") {
            // 门限只依赖 M 与 pfa，与噪声估计无关，第一块就能定；probe 仍在 finalise_noise 里算（一字不改）
            eta_ = dsp::threshold_for_pfa(m_bins_, pfa_);
            sorted_.assign(band_bins_.size(), std::vector<double>());
            for (auto& s : sorted_) s.reserve(window_frames_ + 1);
        }
    } else if (blk.meta.sample_rate_Hz != sample_rate_Hz_) {
        err = "EnergyDetector 中途收到不同采样率的块";
        return Step::Error;
    }

    status_.blocks_in++;
    status_.samples_in += blk.size();
    status_.state = worst(status_.state, blk.meta.state);
    frame_calibrated_ = blk.meta.calibration.calibrated;
    const bool blk_clipped = blk.meta.clip_count > 0;

    // 拼上上一块的余量再切帧；块大小由调度器定，组件不假设它是帧长的整数倍。
    // 一帧可能跨两块：只要任一块含削顶样点，这一帧就标 overload。
    std::size_t pos = 0;
    while (pos < blk.size()) {
        const std::size_t need = nfft_ - carry_.size();
        const std::size_t take = std::min(need, blk.size() - pos);
        carry_.insert(carry_.end(), blk.samples.begin() + static_cast<long>(pos),
                      blk.samples.begin() + static_cast<long>(pos + take));
        if (take > 0 && blk_clipped) frame_overload_ = true;
        pos += take;
        if (carry_.size() == nfft_) {
            consume_frame(carry_, next_frame_start_);
            next_frame_start_ += nfft_;
            carry_.clear();
            frame_overload_ = false;
        }
    }

    // 消费了块就产出，没有完成帧时给**空列表**（C-4）。此前这里返回 Idle：下游双输入节点
    // （FeatureExtractor 的 iq + det）那一轮会因 det 口没数据被跳过，IQ 块被下一轮覆盖，静默丢块。
    // 空列表对既有下游无害（DetectionSink 只是空转一轮），黄金基准只比行不比块数。
    PortData d;
    d.type = PortType::DetectionList;
    d.has_data = true;
    d.detections.items.swap(pending_);
    d.detections.meta = blk.meta;
    d.detections.meta.trace = trace();
    out["out"] = d;
    status_.blocks_out++;
    return Step::Produced;
}

void EnergyDetector::emit_summary() {
    if (obs_ == nullptr || summary_sent_) return;
    summary_sent_ = true;
    DetectionSummary s;
    s.node_id = node_name_;
    s.site_id = site_id_;
    s.trace = trace();
    s.nfft = nfft_;
    s.sample_rate_Hz = sample_rate_Hz_;
    s.center_Hz = center_frequency_Hz_;
    s.band_lo_Hz = center_frequency_Hz_ + band_lo_Hz_;
    s.band_hi_Hz = center_frequency_Hz_ + band_hi_Hz_;
    s.m_bins = static_cast<std::size_t>(m_bins_);
    s.pfa = pfa_;
    s.threshold = eta_;
    s.noise_mode = noise_mode_;
    s.noise_window_frames = noise_mode_ == "sliding" ? window_frames_ : probe_used_;
    s.merge_gap_frames = static_cast<std::size_t>(merge_gap_);
    s.dt_s = sample_rate_Hz_ > 0.0 ? static_cast<double>(nfft_) / sample_rate_Hz_ : 0.0;
    s.frames = frames_;
    s.hits = hits_;
    s.segments = segments_;
    s.noise_stale_frames = noise_stale_;
    s.overload_frames = overload_frames_;
    s.calibrated = frame_calibrated_;
    s.state = status_.state;
    s.notes = status_.notes;
    obs_->on_detection_summary(s);
}

Step EnergyDetector::flush(PortMap& out, std::string& err) {
    (void)err;
    if (noise_mode_ == "probe" && !noise_ready_ && !probe_.empty()) {
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
    if (noise_mode_ == "sliding" && frames_ > 0) {
        if (!ring_ever_full_) {
            // 与 probe 的「探针不足即降级」对称：环从未填满，全程的门限都建立在少于 W 帧的估计上
            status_.state = worst(status_.state, State::Degraded);
            status_.notes.push_back("滑动噪声估计的环从未填满：配置 " + std::to_string(window_frames_) +
                                    " 帧，全程最多纳入 " + std::to_string(ring_.size()) +
                                    " 帧，门限可信度下降");
        }
        if (noise_stale_ > 0) {
            // 信号持续占满时的正常状态：没有未命中帧可纳入，估计停留在最近一次更新。记 note 不降级（10 §4.2）
            status_.notes.push_back("噪声估计陈旧 " + std::to_string(noise_stale_) +
                                    " 帧：连续超过 " + std::to_string(window_frames_) +
                                    " 帧没有未命中帧可纳入，估计停留在最近一次更新");
        }
    }
    emit_summary();
    if (pending_.empty()) return Step::Finished;
    PortData d;
    d.type = PortType::DetectionList;
    d.has_data = true;
    d.detections.items.swap(pending_);
    d.detections.meta.sample_rate_Hz = sample_rate_Hz_;
    d.detections.meta.center_frequency_Hz = center_frequency_Hz_;
    d.detections.meta.trace = trace();
    out["out"] = d;
    status_.blocks_out++;
    return Step::Finished;
}

void EnergyDetector::reset() {
    clear_state();
    sample_rate_Hz_ = 0.0;
}

// -------------------------------------------------------------- FeatureExtractor

bool FeatureExtractor::configure(const std::map<std::string, double>& params,
                                 const std::map<std::string, std::string>& text_params,
                                 std::string& err) {
    nfft_ = static_cast<std::size_t>(get(params, "nfft", 1024.0));
    if (nfft_ == 0 || (nfft_ & (nfft_ - 1)) != 0) {
        err = "FeatureExtractor 的 nfft 必须是 2 的幂";
        return false;
    }
    bandwidth_method_ = "occupied_99";
    auto bm = text_params.find("bandwidth_method");
    if (bm != text_params.end() && !bm->second.empty()) bandwidth_method_ = bm->second;
    if (bandwidth_method_ != "occupied_99" && bandwidth_method_ != "edge_minus_20dB") {
        err = "FeatureExtractor 的 bandwidth_method 必须是 occupied_99 / edge_minus_20dB";
        return false;
    }
    const double mf = get(params, "min_frames", 2.0);
    if (mf < 1.0) { err = "FeatureExtractor 的 min_frames 必须不小于 1"; return false; }
    min_frames_ = static_cast<std::uint64_t>(mf);
    const double wf = get(params, "window_frames", 64.0);
    if (wf < 1.0) { err = "FeatureExtractor 的 window_frames 必须不小于 1"; return false; }
    window_frames_ = static_cast<std::size_t>(wf);
    const double gap = get(params, "merge_gap_frames", 2.0);
    if (gap < 0.0) { err = "FeatureExtractor 的 merge_gap_frames 不得为负"; return false; }
    merge_gap_ = static_cast<std::uint64_t>(gap);
    noise_gate_ = get(params, "noise_gate", 4.0);
    if (noise_gate_ < 0.0) { err = "FeatureExtractor 的 noise_gate 不得为负"; return false; }
    auto sid = text_params.find("site_id");
    site_id_ = sid == text_params.end() ? std::string() : sid->second;
    // 周期 Hann（与 SpectrumAnalyzer 同式），窗值存 float32 与样点相乘；Σw、Σw² 按存下的 float32 值用 double 累加
    window_.assign(nfft_, 0.0f);
    wsum_ = 0.0;
    wsq_ = 0.0;
    for (std::size_t n = 0; n < nfft_; ++n) {
        const double w = 0.5 - 0.5 * std::cos(kTwoPi * static_cast<double>(n) / static_cast<double>(nfft_));
        window_[n] = static_cast<float>(w);
        wsum_ += static_cast<double>(window_[n]);
        wsq_ += static_cast<double>(window_[n]) * static_cast<double>(window_[n]);
    }
    return true;
}

void FeatureExtractor::clear_state() {
    has_expected_ = false;
    expected_start_ = 0;
    carry_.clear();
    next_frame_index_ = 0;
    frame_calibrated_ = false;
    pending_frames_.clear();
    band_ready_ = false;
    band_lo_Hz_ = band_hi_Hz_ = 0.0;
    band_bins_.clear();
    open_ = false;
    cur_ = Segment();
    gap_ = 0;
    hit_window_.clear();
    has_prev_ = false;
    prev_t_end_s_ = prev_center_Hz_ = 0.0;
    pending_rows_.clear();
    frames_ = 0;
    segments_ = 0;
    status_ = ComponentStatus();
}

// 不抽共享随机流：本组件没有随机性，抽一个数就会把后面所有节点的子种子挪位（D-058 ④ 的教训）。
bool FeatureExtractor::init(IRandom&, std::string&) {
    clear_state();
    return true;
}

ModelTrace FeatureExtractor::trace() const {
    ModelTrace t = make_trace("FeatureExtractor", "M3", "E2", "V3");
    if (!site_id_.empty()) t.trace_id = "FeatureExtractor:" + site_id_;
    return t;
}

// 频段 bin 与检测器 build_mask 同一规则：fftshift 后第 k 个 bin 的频率 (k − nfft/2)·fs/nfft 落在 [lo, hi)。
// 频段取自检测行的绝对频率再减中心频率：两端都是整数 Hz 时这一步精确，与检测器的 bin 集合逐个相同。
void FeatureExtractor::build_band(double f_lo_abs, double f_hi_abs) {
    band_lo_Hz_ = f_lo_abs - center_frequency_Hz_;
    band_hi_Hz_ = f_hi_abs - center_frequency_Hz_;
    band_bins_.clear();
    for (std::size_t k = 0; k < nfft_; ++k) {
        const double idx = static_cast<double>(k) - static_cast<double>(nfft_ / 2);
        const double f = idx * sample_rate_Hz_ / static_cast<double>(nfft_);
        if (f >= band_lo_Hz_ && f < band_hi_Hz_) band_bins_.push_back(k);
    }
    band_ready_ = true;
}

void FeatureExtractor::push_frame(const std::vector<Complex>& frame) {
    Frame f;
    f.index = next_frame_index_++;
    std::vector<Complex> x = frame;
    dsp::fft_inplace(x);
    dsp::fftshift(x);
    f.power.resize(nfft_);
    for (std::size_t k = 0; k < nfft_; ++k) {
        const double re = static_cast<double>(x[k].real());
        const double im = static_cast<double>(x[k].imag());
        f.power[k] = re * re + im * im;
    }
    std::vector<Complex> xw(nfft_);
    for (std::size_t n = 0; n < nfft_; ++n) xw[n] = frame[n] * window_[n];
    dsp::fft_inplace(xw);
    dsp::fftshift(xw);
    f.power_w.resize(nfft_);
    for (std::size_t k = 0; k < nfft_; ++k) {
        const double re = static_cast<double>(xw[k].real());
        const double im = static_cast<double>(xw[k].imag());
        f.power_w[k] = re * re + im * im;
    }
    double s = 0.0, mx = 0.0;
    for (std::size_t i = 0; i < frame.size(); ++i) {
        const double re = static_cast<double>(frame[i].real());
        const double im = static_cast<double>(frame[i].imag());
        const double a = re * re + im * im;
        s += a;
        if (a > mx) mx = a;
    }
    f.sum_abs2 = s;
    f.max_abs2 = mx;
    f.calibrated = frame_calibrated_;
    pending_frames_.push_back(f);
}

void FeatureExtractor::apply(const Detection& d, const Frame& f) {
    hit_window_.push_back(d.hit);
    if (hit_window_.size() > window_frames_) hit_window_.pop_front();
    if (d.hit) {
        if (open_ && cur_.id != d.segment_id) close_segment();
        if (!open_) {
            cur_ = Segment();
            cur_.id = d.segment_id;
            cur_.first_frame = d.frame_index;
            cur_.psd_sum.assign(nfft_, 0.0);
            cur_.psd_w_sum.assign(nfft_, 0.0);
            open_ = true;
        }
        cur_.last_frame = d.frame_index;
        cur_.frames++;
        for (std::size_t k = 0; k < nfft_; ++k) cur_.psd_sum[k] += f.power[k];
        for (std::size_t k = 0; k < nfft_; ++k) cur_.psd_w_sum[k] += f.power_w[k];
        // 带内能量按 bin 升序累加，与检测器的 e 逐位相同；噪声估计由 Λ 反推：noise = e / Λ
        double e = 0.0;
        for (std::size_t j = 0; j < band_bins_.size(); ++j) e += f.power[band_bins_[j]];
        cur_.e_sum += e;
        cur_.noise_sum += d.statistic > 0.0 ? e / d.statistic : 0.0;
        cur_.sum_abs2 += f.sum_abs2;
        if (f.max_abs2 > cur_.max_abs2) cur_.max_abs2 = f.max_abs2;
        cur_.overload = cur_.overload || d.overload;
        cur_.calibrated = cur_.calibrated && f.calibrated;
        std::size_t hits = 0;
        for (std::deque<bool>::const_iterator it = hit_window_.begin(); it != hit_window_.end(); ++it) if (*it) ++hits;
        cur_.duty = static_cast<double>(hits) / static_cast<double>(hit_window_.size());
        gap_ = 0;
    } else if (open_) {
        gap_++;
        if (gap_ > merge_gap_) close_segment();
    }
}

FeatureRow FeatureExtractor::compute_row(const Segment& s) const {
    FeatureRow r;
    const double fs = sample_rate_Hz_;
    const double F = static_cast<double>(s.frames);
    const std::size_t M = band_bins_.size();
    r.segment_id = s.id;
    r.frames = s.frames;
    r.t_s = static_cast<double>(s.first_frame * nfft_) / fs;
    r.t_end_s = static_cast<double>((s.last_frame + 1) * nfft_) / fs;
    r.duration_s = r.t_end_s - r.t_s;

    std::vector<double> mean_psd(nfft_);
    for (std::size_t k = 0; k < nfft_; ++k) mean_psd[k] = s.psd_w_sum[k] / F;   // 形状量用加窗 PSD
    const double e_mean = s.e_sum / F;
    const double noise_mean = s.noise_sum / F;
    // 每 bin 噪声：矩形帧下 noise_band / M；加窗后白噪声每 bin 功率按 Σw²/nfft 缩放
    const double n_bin = M ? noise_mean / static_cast<double>(M) * (wsq_ / static_cast<double>(nfft_)) : 0.0;
    const double gate = n_bin * noise_gate_ / std::sqrt(F);

    // 去噪 + 过闸后的信号 bin
    std::vector<double> sig(M, 0.0);
    double total = 0.0;
    std::size_t nsig = 0;
    for (std::size_t j = 0; j < M; ++j) {
        const double v = mean_psd[band_bins_[j]] - n_bin;
        sig[j] = v > gate ? v : 0.0;
        if (sig[j] > 0.0) ++nsig;
        total += sig[j];
    }
    r.signal_bins = nsig;
    const double bin = fs / static_cast<double>(nfft_);
    if (total > 0.0) {
        double num = 0.0;
        for (std::size_t j = 0; j < M; ++j) {
            const double idx = static_cast<double>(band_bins_[j]) - static_cast<double>(nfft_ / 2);
            num += idx * fs / static_cast<double>(nfft_) * sig[j];
        }
        r.center_Hz = center_frequency_Hz_ + num / total;
        std::size_t lo = 0, hi = M - 1;
        if (bandwidth_method_ == "occupied_99") {
            const double edge = 0.005 * total;
            double cum = 0.0;
            for (std::size_t j = 0; j < M; ++j) { cum += sig[j]; if (cum >= edge) { lo = j; break; } }
            cum = 0.0;
            for (std::size_t j = M; j-- > 0;) { cum += sig[j]; if (cum >= edge) { hi = j; break; } }
        } else {
            double peak = 0.0;
            for (std::size_t j = 0; j < M; ++j) if (sig[j] > peak) peak = sig[j];
            const double thr = peak * 0.01;
            for (std::size_t j = 0; j < M; ++j) if (sig[j] >= thr) { lo = j; break; }
            for (std::size_t j = M; j-- > 0;) if (sig[j] >= thr) { hi = j; break; }
        }
        r.bandwidth_Hz = static_cast<double>(band_bins_[hi] - band_bins_[lo] + 1) * bin;
    } else {
        r.center_Hz = center_frequency_Hz_ + 0.5 * (band_lo_Hz_ + band_hi_Hz_);
        r.bandwidth_Hz = 0.0;
    }

    // 平坦度：带内**原始**段均 PSD（含噪声底）的几何均值 / 算术均值（EM-S-03 的定义）
    bool anyzero = M == 0;
    double logsum = 0.0, arith = 0.0;
    for (std::size_t j = 0; j < M; ++j) {
        const double v = mean_psd[band_bins_[j]];
        if (v <= 0.0) anyzero = true; else logsum += std::log(v);
        arith += v;
    }
    r.spectral_flatness = (anyzero || arith <= 0.0) ? 0.0
                          : std::exp(logsum / static_cast<double>(M)) / (arith / static_cast<double>(M));

    const double n2 = static_cast<double>(nfft_) * static_cast<double>(nfft_);
    r.has_dBm = s.calibrated;
    if (r.has_dBm) {
        // 带内功率按矩形帧的 Parseval（与检测行同式）；峰值 bin 按加窗 PSD 除以相干增益 (Σw)²
        r.band_power_dBm = 10.0 * std::log10(std::max(e_mean / n2, 1e-30));
        double pk = 0.0;
        for (std::size_t j = 0; j < M; ++j) if (mean_psd[band_bins_[j]] > pk) pk = mean_psd[band_bins_[j]];
        r.peak_dBm = 10.0 * std::log10(std::max(pk / (wsum_ * wsum_), 1e-30));
    }
    r.snr_dB = 10.0 * std::log10(std::max(e_mean, 1e-30) / std::max(noise_mean, 1e-30));
    const double mean_abs2 = s.sum_abs2 / (F * static_cast<double>(nfft_));
    r.crest_factor_dB = mean_abs2 > 0.0 ? 10.0 * std::log10(std::max(s.max_abs2 / mean_abs2, 1e-30)) : 0.0;
    r.duty = s.duty;
    r.overload = s.overload;
    r.quality = s.overload ? "overload" : (s.frames < min_frames_ ? "short" : (nsig == 0 ? "low_snr" : "full"));
    return r;
}

void FeatureExtractor::close_segment() {
    FeatureRow r = compute_row(cur_);
    r.has_prev = has_prev_;
    if (has_prev_) {
        r.interval_from_prev_s = r.t_s - prev_t_end_s_;
        r.hop_from_prev_Hz = r.center_Hz - prev_center_Hz_;
    }
    // 只有量得出信号的段才充当「上一段」：一帧虚警夹在两个真突发之间，不该把跳频差与间隔搅乱
    if (r.quality == "full" || r.quality == "overload") {
        has_prev_ = true;
        prev_t_end_s_ = r.t_end_s;
        prev_center_Hz_ = r.center_Hz;
    }
    pending_rows_.push_back(r);
    report(r);
    segments_++;
    open_ = false;
    gap_ = 0;
}

void FeatureExtractor::report(const FeatureRow& r) {
    if (obs_ == nullptr) return;
    FeatureReport fr;
    fr.node_id = node_name_;
    fr.site_id = site_id_;
    fr.row = r;
    fr.trace = trace();
    obs_->on_feature(fr);
}

Step FeatureExtractor::process(PortMap& in, PortMap& out, std::string& err) {
    auto iq = in.find("iq");
    auto dt = in.find("det");
    if (iq == in.end() || !iq->second.has_data || dt == in.end() || !dt->second.has_data) return Step::Idle;
    const Block& blk = iq->second.iq;
    if (sample_rate_Hz_ == 0.0) {
        sample_rate_Hz_ = blk.meta.sample_rate_Hz;
        center_frequency_Hz_ = blk.meta.center_frequency_Hz;
        if (sample_rate_Hz_ <= 0.0) { err = "FeatureExtractor 收到的块没有采样率"; return Step::Error; }
    } else if (blk.meta.sample_rate_Hz != sample_rate_Hz_) {
        err = "FeatureExtractor 中途收到不同采样率的块";
        return Step::Error;
    }
    if (has_expected_ && blk.meta.start_sample != expected_start_) {
        err = "FeatureExtractor 的 IQ 块不连续：期望首样点 " + std::to_string(expected_start_) + "，收到 " +
              std::to_string(blk.meta.start_sample) +
              "——上游有一轮没产出、深度 1 的缓冲被覆盖了；不静默丢块（铁律 15）";
        return Step::Error;
    }
    expected_start_ = blk.meta.start_sample + blk.size();
    has_expected_ = true;
    status_.blocks_in++;
    status_.samples_in += blk.size();
    status_.state = worst(status_.state, blk.meta.state);
    frame_calibrated_ = blk.meta.calibration.calibrated;

    // 切帧与检测器同律：拼余量、满 nfft 出一帧、不加窗不重叠
    std::size_t pos = 0;
    while (pos < blk.size()) {
        const std::size_t need = nfft_ - carry_.size();
        const std::size_t take = std::min(need, blk.size() - pos);
        carry_.insert(carry_.end(), blk.samples.begin() + static_cast<long>(pos),
                      blk.samples.begin() + static_cast<long>(pos + take));
        pos += take;
        if (carry_.size() == nfft_) {
            push_frame(carry_);
            carry_.clear();
        }
    }

    // 逐行对齐检测行：本组件的第 k 帧 = 检测行 frame_index = k
    for (const Detection& d : dt->second.detections.items) {
        if (pending_frames_.empty()) {
            err = "FeatureExtractor 收到检测行 frame_index = " + std::to_string(d.frame_index) +
                  "，却没有对应的 IQ 帧：检测器与本组件的 nfft 不同，或上游丢了块";
            return Step::Error;
        }
        const Frame& f = pending_frames_.front();
        if (f.index != d.frame_index || d.start_sample != d.frame_index * nfft_) {
            err = "FeatureExtractor 与检测器的帧对不上：检测行 frame_index = " + std::to_string(d.frame_index) +
                  "、start_sample = " + std::to_string(d.start_sample) + "，本组件下一帧 index = " +
                  std::to_string(f.index) + "（nfft = " + std::to_string(nfft_) + "）；两边的 nfft 必须相同";
            return Step::Error;
        }
        if (!band_ready_) build_band(d.f_lo_Hz, d.f_hi_Hz);
        apply(d, f);
        pending_frames_.pop_front();
        frames_++;
    }

    // 消费即产出（可为空）
    PortData o;
    o.type = PortType::FeatureVector;
    o.has_data = true;
    o.features.items.swap(pending_rows_);
    o.features.meta = blk.meta;
    o.features.meta.trace = trace();
    out["out"] = o;
    status_.blocks_out++;
    return Step::Produced;
}

Step FeatureExtractor::flush(PortMap& out, std::string& err) {
    (void)err;
    if (open_) close_segment();
    if (!carry_.empty()) {
        status_.notes.push_back("末尾 " + std::to_string(carry_.size()) + " 个样点不足一帧，已丢弃（与检测器同律）");
        carry_.clear();
    }
    if (!pending_frames_.empty()) {
        // 检测器在收尾时才产出的行到不了双输入节点（调度器只给单输入的下游转发尾块），
        // 这些帧因此没有判决可依，按缺失记降级，不假装它们不存在
        status_.state = worst(status_.state, State::Degraded);
        status_.notes.push_back("有 " + std::to_string(pending_frames_.size()) +
                                " 帧 IQ 没有等到对应的检测行，未参与特征提取");
        pending_frames_.clear();
    }
    if (pending_rows_.empty()) return Step::Finished;
    PortData o;
    o.type = PortType::FeatureVector;
    o.has_data = true;
    o.features.items.swap(pending_rows_);
    o.features.meta.sample_rate_Hz = sample_rate_Hz_;
    o.features.meta.center_frequency_Hz = center_frequency_Hz_;
    o.features.meta.trace = trace();
    out["out"] = o;
    status_.blocks_out++;
    return Step::Finished;
}

void FeatureExtractor::reset() {
    clear_state();
    sample_rate_Hz_ = 0.0;
    center_frequency_Hz_ = 0.0;
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
                    "噪声估计可选 probe（前 noise_frames 帧估一次后固定）或 sliding（带删截的滑动中位数，"
                    "只纳入未命中帧，D-026 交付形态）；命中帧按 merge_gap_frames 并成突发；"
                    "口径与 algos/reference/energy_detector.py 一致（EM-S-02，决策 D-026 / D-063）";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "EnergyDetector";
    i.version = "0.2.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = true;
    // 绑站只为给检测行注入 site_id（多站下每站一个检测器，D-053）；本组件不读场景文件
    i.scene_bindable = true;
    i.params = {
        ParamSpec::number("nfft", "", "帧长，等于 DFT 点数").def(1024.0).at_least(2.0).constrained("2 的幂"),
        ParamSpec::number("band_lo_Hz", "Hz", "检测频段下限，相对中心频率").req(),
        ParamSpec::number("band_hi_Hz", "Hz", "检测频段上限，相对中心频率").req()
            .constrained("band_hi_Hz > band_lo_Hz"),
        ParamSpec::number("pfa", "", "目标虚警率").def(1e-3).at_least(0.0, true).at_most(1.0, true),
        ParamSpec::number("noise_frames", "", "probe 模式用于噪声估计的探针帧数").def(8192.0).at_least(1.0),
        ParamSpec::choice("noise_mode", {"probe", "sliding"},
                          "噪声估计：probe = 前 noise_frames 帧估一次后固定；"
                          "sliding = 带删截的滑动中位数，只纳入未命中帧，门限随背景漂移（D-026 交付形态）")
            .def_text("probe"),
        ParamSpec::number("noise_window_frames", "", "sliding 模式的滑动窗长（帧）").def(256.0).at_least(2.0),
        ParamSpec::number("merge_gap_frames", "", "命中帧之间的空隙不大于此值即并入同一突发（EM-S-02 merge_time_gap）")
            .def(2.0).at_least(0.0),
        ParamSpec::boolean("band_power_dBm", "输入已标定时在检测行里附带频段功率与噪声估计的 dBm 读数").def_bool(true),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入；本组件不读它").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器注入").internal_only(),
        ParamSpec::text("site_id", "本检测器所属站点，由装载器按 scene_binding 注入；只作检测行的身份，不影响算法")
            .internal_only(),
    };
    return i;
}

ComponentInfo FeatureExtractor::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "特征提取";
    i.description = "按检测器并好的突发出一行特征（EM-S-03 §10.5–§10.10，10 报告 §4.3）：与检测器同律切帧"
                    "（同 nfft、不加窗不重叠、按 frame_index 对齐），段内命中帧的平均功率谱减去由 Λ 反推的"
                    "带内噪声估计并过闸后，给出功率质心、99% 占用带宽（或 −20 dB 边）、带内功率与峰值、"
                    "信噪比、谱平坦度、峰均比、占空比、与上一段的间隔与频差、质量标记；"
                    "口径与 algos/reference/features.py 一致，黄金基准逐段对拍。"
                    "IQ 块不连续即报错、检测行与帧对不上即报错，不猜不补";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-S-03";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = true;
    // 绑站只为给特征行注入 site_id（与检测器同法，D-063 ④）；本组件不读场景文件
    i.scene_bindable = true;
    i.params = {
        ParamSpec::number("nfft", "", "帧长，必须等于上游检测器的 nfft（装载器核对）")
            .def(1024.0).at_least(2.0).constrained("2 的幂；= EnergyDetector.nfft"),
        ParamSpec::choice("bandwidth_method", {"occupied_99", "edge_minus_20dB"},
                          "带宽口径：占用带宽（去噪后累积功率 0.5%–99.5% 的跨度）或峰值以下 20 dB 的边")
            .def_text("occupied_99"),
        ParamSpec::number("min_frames", "", "少于这么多命中帧的段标 quality = short，仍出行").def(2.0).at_least(1.0),
        ParamSpec::number("window_frames", "", "占空比的统计窗（帧），在段末命中帧处回看").def(64.0).at_least(1.0),
        ParamSpec::number("merge_gap_frames", "", "段收口判据：连续未命中帧超过它即收口；必须等于检测器的同名参数（装载器核对）")
            .def(2.0).at_least(0.0).constrained("= EnergyDetector.merge_gap_frames"),
        ParamSpec::number("noise_gate", "", "去噪后信号 bin 的闸：段均 PSD 减噪声后须高于 noise_gate · 每 bin 噪声 / √帧数")
            .def(4.0).at_least(0.0),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入；本组件不读它").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器注入").internal_only(),
        ParamSpec::text("site_id", "本节点所属站点，由装载器按 scene_binding 注入；只作特征行的身份，不影响算法")
            .internal_only(),
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
