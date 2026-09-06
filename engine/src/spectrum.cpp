#include "cuav/components/spectrum.h"

#include <algorithm>
#include <cmath>

#include "cuav/dsp.h"

namespace cuav {

namespace {

const double kPi = 3.14159265358979323846;

double get(const std::map<std::string, double>& p, const std::string& k, double dflt) {
    auto it = p.find(k);
    return it == p.end() ? dflt : it->second;
}

ModelTrace make_trace(const std::string& id) {
    ModelTrace t;
    t.model_id = id;
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M3";
    t.credibility = "V3";
    t.parameter_version = "engine-thin-slice";
    t.trace_id = id + ":0";
    return t;
}

bool build_window(const std::string& name, std::size_t n, std::vector<double>& w) {
    w.assign(n, 1.0);
    const double dn = static_cast<double>(n);
    for (std::size_t i = 0; i < n; ++i) {
        const double c1 = std::cos(2.0 * kPi * static_cast<double>(i) / dn);
        const double c2 = std::cos(4.0 * kPi * static_cast<double>(i) / dn);
        if (name == "hann") w[i] = 0.5 - 0.5 * c1;
        else if (name == "hamming") w[i] = 0.54 - 0.46 * c1;
        else if (name == "blackman") w[i] = 0.42 - 0.5 * c1 + 0.08 * c2;
        else if (name == "rect") w[i] = 1.0;
        else return false;
    }
    return true;
}

}  // namespace

// --------------------------------------------------------------- WelchAccumulator

bool WelchAccumulator::configure(std::size_t nfft, double overlap, const std::string& window,
                                 std::size_t segments_per_frame, std::string& err) {
    if (nfft < 8 || (nfft & (nfft - 1)) != 0) { err = "nfft 必须是不小于 8 的 2 的幂"; return false; }
    if (!(overlap >= 0.0 && overlap < 1.0)) { err = "overlap 必须在 [0, 1)"; return false; }
    const double hop_d = static_cast<double>(nfft) * (1.0 - overlap);
    const double hop_r = std::floor(hop_d + 0.5);
    if (std::fabs(hop_d - hop_r) > 1e-9 || hop_r < 1.0) {
        err = "nfft × (1 − overlap) 必须是正整数，当前为 " + std::to_string(hop_d);
        return false;
    }
    if (segments_per_frame == 0) { err = "segments_per_frame 必须大于 0"; return false; }
    if (!build_window(window, nfft, window_)) { err = "未知窗函数 " + window; return false; }
    nfft_ = nfft;
    hop_ = static_cast<std::size_t>(hop_r);
    segments_per_frame_ = segments_per_frame;
    window_name_ = window;
    double s = 0.0;
    for (double v : window_) s += v;
    window_sum_sq_ = s * s;
    reset();
    return true;
}

void WelchAccumulator::reset() {
    buf_.clear();
    head_ = 0;
    head_known_ = false;
    acc_.assign(nfft_, 0.0);
    seg_count_ = 0;
    dropped_tail_ = 0;
    covered_end_ = 0;
}

void WelchAccumulator::push(const Complex* samples, std::size_t count, std::uint64_t first_sample,
                            const Emit& emit) {
    if (!head_known_) {
        head_sample_ = first_sample;
        covered_end_ = first_sample;
        head_known_ = true;
    }
    buf_.insert(buf_.end(), samples, samples + count);
    while (buf_.size() - head_ >= nfft_) {
        consume_segment();
        if (seg_count_ == segments_per_frame_) emit_frame(emit);
        head_ += hop_;
        head_sample_ += hop_;
    }
    // 压实：已消费的前缀超过一半就搬一次，避免 erase 逐段搬动
    if (head_ > 0 && head_ >= buf_.size() / 2) {
        buf_.erase(buf_.begin(), buf_.begin() + static_cast<long>(head_));
        head_ = 0;
    }
}

void WelchAccumulator::consume_segment() {
    std::vector<std::complex<double>> seg(nfft_);
    for (std::size_t i = 0; i < nfft_; ++i) {
        const Complex& v = buf_[head_ + i];
        seg[i] = std::complex<double>(static_cast<double>(v.real()) * window_[i],
                                      static_cast<double>(v.imag()) * window_[i]);
    }
    dsp::fft_inplace(seg);
    if (seg_count_ == 0) frame_first_sample_ = head_sample_;
    covered_end_ = head_sample_ + nfft_;
    for (std::size_t k = 0; k < nfft_; ++k) acc_[k] += std::norm(seg[k]);
    ++seg_count_;
}

void WelchAccumulator::emit_frame(const Emit& emit) {
    std::vector<double> power(nfft_);
    const double scale = 1.0 / (static_cast<double>(seg_count_) * window_sum_sq_);
    for (std::size_t k = 0; k < nfft_; ++k) power[k] = acc_[k] * scale;
    dsp::fftshift(power);
    emit(power, frame_first_sample_, seg_count_);
    acc_.assign(nfft_, 0.0);
    seg_count_ = 0;
}

bool WelchAccumulator::flush(const Emit& emit) {
    // 丢弃的是从未被任何一段覆盖过的样点：有重叠时 head 之后的 nfft − hop 个样点已经进过上一段
    const std::uint64_t stream_end = head_sample_ + (buf_.size() - head_);
    dropped_tail_ = static_cast<std::size_t>(stream_end > covered_end_ ? stream_end - covered_end_ : 0);
    const bool produced = seg_count_ > 0;
    if (produced) emit_frame(emit);
    buf_.clear();
    head_ = 0;
    return produced;
}

// --------------------------------------------------------------- SpectrumAnalyzer

ComponentInfo SpectrumAnalyzer::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "频谱分析";
    i.description = "Welch 平均功率谱：每段加周期窗、DFT、|X|²、各段平均、除以 (Σw)²、零频居中；"
                    "复单音峰值等于其功率，满量程读 0 dBFS；未标定一律 dBFS（D-020）。"
                    "口径与 algos/reference/gen_spectrum_golden.py、matlab/ref/cuav_welch_power.m 三方互证";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "SpectrumAnalyzer";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = true;
    i.params = {
        ParamSpec::number("nfft", "", "每段点数，等于 DFT 点数").def(1024.0).at_least(8.0).constrained("2 的幂"),
        ParamSpec::choice("window", {"hann", "hamming", "blackman", "rect"}, "周期形式的窗函数").def_text("hann"),
        ParamSpec::number("overlap", "", "相邻段重叠比例").def(0.0).at_least(0.0).at_most(1.0, true)
            .constrained("nfft × (1 − overlap) 必须是正整数"),
        ParamSpec::number("segments_per_frame", "", "每帧平均的段数").def(1.0).at_least(1.0),
    };
    return i;
}

bool SpectrumAnalyzer::configure(const std::map<std::string, double>& params,
                                 const std::map<std::string, std::string>& text_params,
                                 std::string& err) {
    nfft_ = static_cast<std::size_t>(get(params, "nfft", 1024.0));
    overlap_ = get(params, "overlap", 0.0);
    segments_per_frame_ = static_cast<std::size_t>(get(params, "segments_per_frame", 1.0));
    auto w = text_params.find("window");
    window_ = (w == text_params.end()) ? "hann" : w->second;
    std::string e;
    if (!acc_.configure(nfft_, overlap_, window_, segments_per_frame_, e)) {
        err = "SpectrumAnalyzer " + e;
        return false;
    }
    return true;
}

bool SpectrumAnalyzer::init(IRandom&, std::string&) {
    reset();
    return true;
}

void SpectrumAnalyzer::reset() {
    acc_.reset();
    sample_rate_Hz_ = 0.0;
    seen_block_ = false;
    status_ = ComponentStatus();
}

SpectrumFrame SpectrumAnalyzer::make_frame(const std::vector<double>& power, std::uint64_t first_sample,
                                           std::size_t segments, bool partial) const {
    SpectrumFrame f;
    f.psd_dB.resize(power.size());
    for (std::size_t k = 0; k < power.size(); ++k) {
        // 下限 1e-30（−300 dB）：矩形窗加频点中心单音会出现精确的零，−∞ 进不了显示产品
        f.psd_dB[k] = 10.0 * std::log10(std::max(power[k], 1e-30));
    }
    f.bin_width_Hz = sample_rate_Hz_ / static_cast<double>(nfft_);
    f.segments = segments;
    f.scale = last_meta_.calibration.calibrated ? "dBm" : "dBFS";   // D-047：源端已换算到 mW 时就是 dBm
    f.window = window_;
    f.meta = last_meta_;
    f.meta.start_sample = first_sample;
    f.meta.trace = make_trace("SpectrumAnalyzer");
    if (partial) {
        f.meta.degrade("末帧只有 " + std::to_string(segments) + "/" +
                       std::to_string(segments_per_frame_) + " 段");
    }
    return f;
}

Step SpectrumAnalyzer::process(PortMap& in, PortMap& out, std::string& err) {
    auto it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& blk = it->second.iq;
    if (!seen_block_) {
        sample_rate_Hz_ = blk.meta.sample_rate_Hz;
        center_frequency_Hz_ = blk.meta.center_frequency_Hz;
        if (sample_rate_Hz_ <= 0.0) { err = "SpectrumAnalyzer 收到的块没有采样率"; return Step::Error; }
        seen_block_ = true;
    } else if (blk.meta.sample_rate_Hz != sample_rate_Hz_) {
        err = "SpectrumAnalyzer 中途收到不同采样率的块";
        return Step::Error;
    }
    last_meta_ = blk.meta;
    status_.blocks_in++;
    status_.samples_in += blk.size();
    status_.state = worst(status_.state, blk.meta.state);

    PortData d;
    d.type = PortType::SpectrumFrame;
    acc_.push(blk.samples.data(), blk.size(), blk.meta.start_sample,
              [&](const std::vector<double>& power, std::uint64_t first, std::size_t segs) {
                  d.spectra.push_back(make_frame(power, first, segs, false));
              });
    if (d.spectra.empty()) return Step::Idle;
    d.has_data = true;
    status_.blocks_out++;
    status_.samples_out += d.spectra.size() * nfft_;
    out["out"] = d;
    return Step::Produced;
}

Step SpectrumAnalyzer::flush(PortMap& out, std::string&) {
    PortData d;
    d.type = PortType::SpectrumFrame;
    const bool produced = acc_.flush([&](const std::vector<double>& power, std::uint64_t first, std::size_t segs) {
        d.spectra.push_back(make_frame(power, first, segs, segs < segments_per_frame_));
    });
    if (acc_.dropped_tail_samples() > 0) {
        status_.notes.push_back("收尾丢弃不满一段的 " + std::to_string(acc_.dropped_tail_samples()) + " 个样点");
    }
    if (produced) {
        d.has_data = true;
        status_.blocks_out++;
        out["out"] = d;
    }
    return Step::Finished;
}

}  // namespace cuav
