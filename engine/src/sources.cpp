#include "cuav/components/sources.h"

#include <algorithm>
#include <cmath>
#include <fstream>

#include "nlohmann/json.hpp"

namespace cuav {
namespace {

double get(const std::map<std::string, double>& p, const std::string& k, double dflt) {
    auto it = p.find(k);
    return it == p.end() ? dflt : it->second;
}

bool require(const std::map<std::string, double>& p, const std::string& k, double& out,
             const std::string& who, std::string& err) {
    auto it = p.find(k);
    if (it == p.end()) {
        // 必填参数缺失不拿默认值顶替（铁律 15）
        err = who + " 缺必填参数 " + k;
        return false;
    }
    out = it->second;
    return true;
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

}  // namespace

// ------------------------------------------------------------------ ToneSource

bool ToneSource::configure(const std::map<std::string, double>& params,
                           const std::map<std::string, std::string>&,
                           std::string& err) {
    if (!require(params, "sample_rate_Hz", sample_rate_Hz_, "ToneSource", err)) return false;
    double total = 0.0;
    if (!require(params, "total_samples", total, "ToneSource", err)) return false;
    total_samples_ = static_cast<std::uint64_t>(total);
    center_frequency_Hz_ = get(params, "center_frequency_Hz", 0.0);
    offset_Hz_ = get(params, "offset_Hz", 0.0);
    amplitude_ = get(params, "amplitude", 1.0);
    phase_rad_ = get(params, "phase_rad", 0.0);
    start_sample_ = static_cast<std::uint64_t>(get(params, "start_sample", 0.0));
    stop_sample_ = static_cast<std::uint64_t>(get(params, "stop_sample", 0.0));
    block_samples_ = static_cast<std::size_t>(get(params, "block_samples", 65536.0));
    if (sample_rate_Hz_ <= 0.0) { err = "ToneSource 采样率必须大于 0"; return false; }
    if (block_samples_ == 0) { err = "ToneSource 块长必须大于 0"; return false; }
    // 频率占用检查：|Δf| 必须落在奈奎斯特范围内（铁律 4、04 §9.3）
    if (std::fabs(offset_Hz_) >= sample_rate_Hz_ / 2.0) {
        err = "ToneSource 频偏超出奈奎斯特范围";
        return false;
    }
    return true;
}

bool ToneSource::init(IRandom&, std::string&) {
    produced_ = 0;
    status_ = ComponentStatus();
    return true;
}

Step ToneSource::process(PortMap&, PortMap& out, std::string&) {
    if (produced_ >= total_samples_) return Step::Finished;
    const std::size_t n = static_cast<std::size_t>(
        std::min<std::uint64_t>(block_samples_, total_samples_ - produced_));
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.resize(n);
    const double w = 2.0 * 3.14159265358979323846 * offset_Hz_ / sample_rate_Hz_;
    for (std::size_t i = 0; i < n; ++i) {
        const std::uint64_t idx = produced_ + i;
        const bool on = idx >= start_sample_ && (stop_sample_ == 0 || idx < stop_sample_);
        if (!on) {
            d.iq.samples[i] = Complex(0.0f, 0.0f);
            continue;
        }
        // 相位按绝对样点号算，保证开断之间相位连续，不会在开关处造出假的相位跳变
        const double ph = w * static_cast<double>(idx) + phase_rad_;
        d.iq.samples[i] = Complex(static_cast<float>(amplitude_ * std::cos(ph)),
                                  static_cast<float>(amplitude_ * std::sin(ph)));
    }
    d.iq.meta.sample_rate_Hz = sample_rate_Hz_;
    d.iq.meta.center_frequency_Hz = center_frequency_Hz_;
    d.iq.meta.start_sample = produced_;
    d.iq.meta.time_basis = TimeBasis::LogicalSim;
    d.iq.meta.trace = make_trace("ToneSource", "M3", "E2", "V3");
    out["out"] = d;
    produced_ += n;
    status_.blocks_out++;
    status_.samples_out += n;
    return Step::Produced;
}

void ToneSource::reset() { produced_ = 0; status_ = ComponentStatus(); }

// ----------------------------------------------------------------- NoiseSource

bool NoiseSource::configure(const std::map<std::string, double>& params,
                            const std::map<std::string, std::string>&,
                            std::string& err) {
    if (!require(params, "sample_rate_Hz", sample_rate_Hz_, "NoiseSource", err)) return false;
    total_samples_ = static_cast<std::uint64_t>(get(params, "total_samples", 0.0));
    if (total_samples_ == 0) { err = "NoiseSource 缺必填参数 total_samples"; return false; }
    center_frequency_Hz_ = get(params, "center_frequency_Hz", 0.0);
    power_ = get(params, "power", 1.0);
    block_samples_ = static_cast<std::size_t>(get(params, "block_samples", 65536.0));
    if (power_ < 0.0) { err = "NoiseSource 功率不能为负"; return false; }
    return true;
}

bool NoiseSource::init(IRandom& rng, std::string&) {
    rng_ = &rng;
    produced_ = 0;
    status_ = ComponentStatus();
    return true;
}

Step NoiseSource::process(PortMap&, PortMap& out, std::string& err) {
    if (!rng_) { err = "NoiseSource 未注入随机源"; return Step::Error; }
    if (produced_ >= total_samples_) return Step::Finished;
    const std::size_t n = static_cast<std::size_t>(
        std::min<std::uint64_t>(block_samples_, total_samples_ - produced_));
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.resize(n);
    const float k = static_cast<float>(std::sqrt(power_));
    for (std::size_t i = 0; i < n; ++i) {
        float re, im;
        rng_->complex_normal(re, im);
        d.iq.samples[i] = Complex(re * k, im * k);
    }
    d.iq.meta.sample_rate_Hz = sample_rate_Hz_;
    d.iq.meta.center_frequency_Hz = center_frequency_Hz_;
    d.iq.meta.start_sample = produced_;
    d.iq.meta.time_basis = TimeBasis::LogicalSim;
    d.iq.meta.trace = make_trace("NoiseSource", "M3", "E2", "V3");
    out["out"] = d;
    produced_ += n;
    status_.blocks_out++;
    status_.samples_out += n;
    return Step::Produced;
}

void NoiseSource::reset() { produced_ = 0; status_ = ComponentStatus(); }

// ------------------------------------------------------------ FileReplaySource

bool FileReplaySource::configure(const std::map<std::string, double>& params,
                                 const std::map<std::string, std::string>& text_params,
                                 std::string& err) {
    auto it = text_params.find("manifest_path");
    if (it == text_params.end()) {
        err = "FileReplaySource 缺必填参数 manifest_path";
        return false;
    }
    manifest_path_ = it->second;
    block_samples_ = static_cast<std::size_t>(get(params, "block_samples", 65536.0));
    max_samples_ = static_cast<std::uint64_t>(get(params, "max_samples", 0.0));
    return load_manifest(err);
}

bool FileReplaySource::load_manifest(std::string& err) {
    std::ifstream f(manifest_path_.c_str());
    if (!f) { err = "打不开清单 " + manifest_path_; return false; }
    nlohmann::json j;
    try {
        f >> j;
    } catch (const std::exception& e) {
        err = std::string("清单不是合法 JSON：") + e.what();
        return false;
    }
    try {
        sample_rate_Hz_ = j.at("sampling").at("sample_rate_Hz").get<double>();
        center_frequency_Hz_ = j.at("frequency").at("center_frequency_Hz").get<double>();
        full_scale_ = j.at("power").at("full_scale").get<double>();
        const std::string fmt = j.at("sampling").at("sample_format").get<std::string>();
        const std::string order = j.at("sampling").at("byte_order").get<std::string>();
        if (fmt != "ci16_le" || order != "little") {
            // 字节序固定小端且不做自动探测（D-020）
            err = "只支持 ci16_le 小端，清单声明的是 " + fmt + " / " + order;
            return false;
        }
        const std::string q = j.at("quality").at("status").get<std::string>();
        if (q == "degraded") {
            file_state_ = State::Degraded;
            file_reasons_.push_back("源数据质量状态为 degraded，理由见清单 quality.reasons");
        } else if (q == "invalid") {
            file_state_ = State::Invalid;
            file_reasons_.push_back("源数据质量状态为 invalid");
        }
    } catch (const std::exception& e) {
        err = std::string("清单缺必填字段：") + e.what();
        return false;
    }

    // 分段路径：清单有 segments 就按它，否则退回同名 .iq
    std::string dir;
    const std::size_t slash = manifest_path_.find_last_of("/\\");
    if (slash != std::string::npos) dir = manifest_path_.substr(0, slash + 1);
    segment_paths_.clear();
    if (j.contains("segments") && !j["segments"].empty()) {
        for (const auto& s : j["segments"]) {
            segment_paths_.push_back(dir + s.at("file").get<std::string>());
        }
    } else {
        std::string stem = manifest_path_;
        const std::string suffix = ".manifest.json";
        if (stem.size() > suffix.size() &&
            stem.compare(stem.size() - suffix.size(), suffix.size(), suffix) == 0) {
            stem = stem.substr(0, stem.size() - suffix.size());
        }
        segment_paths_.push_back(stem + ".iq");
    }
    for (const auto& p : segment_paths_) {
        std::ifstream t(p.c_str(), std::ios::binary);
        if (!t) { err = "分段文件不存在：" + p; return false; }
    }
    return true;
}

bool FileReplaySource::init(IRandom&, std::string&) {
    segment_index_ = 0;
    offset_in_segment_ = 0;
    produced_ = 0;
    status_ = ComponentStatus();
    if (file_state_ != State::Valid) {
        status_.state = file_state_;
        for (const auto& r : file_reasons_) status_.notes.push_back(r);
    }
    return true;
}

Step FileReplaySource::process(PortMap&, PortMap& out, std::string& err) {
    if (max_samples_ && produced_ >= max_samples_) return Step::Finished;
    if (segment_index_ >= segment_paths_.size()) return Step::Finished;

    std::size_t want = block_samples_;
    if (max_samples_) {
        want = static_cast<std::size_t>(
            std::min<std::uint64_t>(want, max_samples_ - produced_));
    }
    std::vector<std::int16_t> raw(2 * want);
    std::size_t got = 0;
    while (got < want && segment_index_ < segment_paths_.size()) {
        std::ifstream f(segment_paths_[segment_index_].c_str(), std::ios::binary);
        if (!f) { err = "读不了 " + segment_paths_[segment_index_]; return Step::Error; }
        f.seekg(static_cast<std::streamoff>(offset_in_segment_ * 4), std::ios::beg);
        f.read(reinterpret_cast<char*>(raw.data() + 2 * got),
               static_cast<std::streamsize>((want - got) * 4));
        const std::size_t read_samples = static_cast<std::size_t>(f.gcount() / 4);
        got += read_samples;
        offset_in_segment_ += read_samples;
        if (read_samples == 0 || f.eof()) {
            // 本段读完，换下一段。分段是存储行为，时间上仍然连续（docs/iq-format.md 3.3）
            segment_index_++;
            offset_in_segment_ = 0;
            if (read_samples == 0) continue;
        }
    }
    if (got == 0) return Step::Finished;

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.resize(got);
    for (std::size_t i = 0; i < got; ++i) {
        d.iq.samples[i] = Complex(static_cast<float>(raw[2 * i]),
                                  static_cast<float>(raw[2 * i + 1]));
    }
    d.iq.meta.sample_rate_Hz = sample_rate_Hz_;
    d.iq.meta.center_frequency_Hz = center_frequency_Hz_;
    d.iq.meta.start_sample = produced_;
    d.iq.meta.time_basis = TimeBasis::FileAcquisition;
    d.iq.meta.full_scale = full_scale_;
    d.iq.meta.scale = -1.0;   // 未标定，不拿 1.0 顶替
    d.iq.meta.trace = make_trace("FileReplaySource", "M3", "E4", "V2");
    if (file_state_ != State::Valid) {
        for (const auto& r : file_reasons_) d.iq.meta.degrade(r);
    }
    d.iq.meta.degrade("量化码未标定，不能换算 dBm");
    out["out"] = d;
    produced_ += got;
    status_.blocks_out++;
    status_.samples_out += got;
    status_.state = worst(status_.state, d.iq.meta.state);
    return Step::Produced;
}

void FileReplaySource::reset() {
    segment_index_ = 0;
    offset_in_segment_ = 0;
    produced_ = 0;
    status_ = ComponentStatus();
}

}  // namespace cuav
