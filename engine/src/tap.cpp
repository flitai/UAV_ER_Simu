#include "cuav/components/tap.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>

#include "nlohmann/json.hpp"

#include "cuav/platform.h"

namespace cuav {

namespace {

double get(const std::map<std::string, double>& p, const std::string& k, double dflt) {
    auto it = p.find(k);
    return it == p.end() ? dflt : it->second;
}

std::string text(const std::map<std::string, std::string>& p, const std::string& k, const std::string& dflt) {
    auto it = p.find(k);
    return it == p.end() ? dflt : it->second;
}

nlohmann::json trace_json(const ModelTrace& t) {
    return nlohmann::json{
        {"model_id", t.model_id}, {"model_version", t.model_version}, {"model_level", t.model_level},
        {"model_layer", t.model_layer}, {"credibility", t.credibility},
        {"parameter_version", t.parameter_version}, {"trace_id", t.trace_id},
    };
}

}  // namespace

ObservationTap::~ObservationTap() { close_files(); }

ComponentInfo ObservationTap::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "观测点";
    i.description = "接任一 IQ 输出口，写显示产品：功率谱行（口径同频谱分析，dBFS）与包络行（桶内 |x| 的 min、max、rms），"
                    "定长行二进制加索引（docs/display-products.md）；每行同时交给运行观察者供实时推送。"
                    "框图里由 observation_points[] 在装载时并联生成（docs/diagram-format.md §5）";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "ObservationTap";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = true;
    i.params = {
        ParamSpec::text("op_id", "观测点标识，即 observation_points[].id，也是产品子目录名").req(),
        ParamSpec::text("out_dir", "产品目录 data/runs/<task_id>/，由运行器注入；不得出现在框图文件里").internal_only(),
        ParamSpec::boolean("spectrum", "是否写功率谱产品").def_bool(true),
        ParamSpec::boolean("envelope", "是否写包络产品").def_bool(true),
        ParamSpec::number("nfft", "", "功率谱每段点数").def(1024.0).at_least(8.0).constrained("2 的幂"),
        ParamSpec::choice("window", {"hann", "hamming", "blackman", "rect"}, "周期形式的窗函数").def_text("hann"),
        ParamSpec::number("overlap", "", "相邻段重叠比例").def(0.0).at_least(0.0).at_most(1.0, true)
            .constrained("nfft × (1 − overlap) 必须是正整数"),
        ParamSpec::number("segments_per_frame", "", "每行功率谱平均的段数").def(1.0).at_least(1.0),
        ParamSpec::number("bucket_samples", "", "包络每桶样点数").def(4096.0).at_least(1.0),
    };
    return i;
}

bool ObservationTap::configure(const std::map<std::string, double>& params,
                               const std::map<std::string, std::string>& text_params,
                               std::string& err) {
    op_id_ = text(text_params, "op_id", "");
    if (op_id_.empty()) { err = "ObservationTap 缺必填参数 op_id"; return false; }
    for (char ch : op_id_) {
        if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-')) {
            err = "ObservationTap 的 op_id 只允许 [a-z0-9_-]：" + op_id_;
            return false;
        }
    }
    // out_dir 是内部参数，由运行器注入。这里只收下不查空：框图装载器的「只校验」模式
    // （cuav_run --validate）没有产品目录，也要能把观测点构造出来核对其余参数；
    // 缺 out_dir 到 init() 开文件时才拒（决策 D-040）。
    out_dir_ = text(text_params, "out_dir", "");
    want_spectrum_ = get(params, "spectrum", 1.0) != 0.0;
    want_envelope_ = get(params, "envelope", 1.0) != 0.0;
    if (!want_spectrum_ && !want_envelope_) { err = "ObservationTap 至少要写一种产品"; return false; }
    nfft_ = static_cast<std::size_t>(get(params, "nfft", 1024.0));
    overlap_ = get(params, "overlap", 0.0);
    segments_per_frame_ = static_cast<std::size_t>(get(params, "segments_per_frame", 1.0));
    bucket_samples_ = static_cast<std::size_t>(get(params, "bucket_samples", 4096.0));
    if (bucket_samples_ == 0) { err = "ObservationTap 的 bucket_samples 必须大于 0"; return false; }
    window_ = text(text_params, "window", "hann");
    std::string e;
    if (!acc_.configure(nfft_, overlap_, window_, segments_per_frame_, e)) { err = "ObservationTap " + e; return false; }
    if (!platform::is_little_endian()) {
        err = "ObservationTap 运行在大端机上；交换格式固定小端，本版本尚未实现字节序转换";
        return false;
    }
    return true;
}

bool ObservationTap::init(IRandom&, std::string& err) {
    reset();
    if (out_dir_.empty()) {
        err = "ObservationTap 缺 out_dir（内部参数，应由运行器注入；框图文件里不写）";
        return false;
    }
    return open_files(err);
}

void ObservationTap::reset() {
    close_files();
    acc_.reset();
    seen_block_ = false;
    spec_rows_ = env_rows_ = 0;
    spec_first_known_ = false;
    bucket_count_ = 0;
    bucket_min_ = 0.0; bucket_max_ = 0.0; bucket_sumsq_ = 0.0;
    last_bucket_samples_ = 0;
    reasons_.clear();
    status_ = ComponentStatus();
}

bool ObservationTap::open_files(std::string& err) {
    const std::string dir = platform::join(out_dir_, op_id_);
    if (!platform::make_dirs(dir, err)) return false;
    if (want_spectrum_) {
        spec_file_ = std::fopen(platform::join(dir, "spectrum.f32").c_str(), "wb");
        if (!spec_file_) { err = "打不开 spectrum.f32 写入：" + dir; return false; }
    }
    if (want_envelope_) {
        env_file_ = std::fopen(platform::join(dir, "envelope.f32").c_str(), "wb");
        if (!env_file_) { err = "打不开 envelope.f32 写入：" + dir; return false; }
    }
    return true;
}

void ObservationTap::close_files() {
    if (spec_file_) { std::fclose(spec_file_); spec_file_ = nullptr; }
    if (env_file_) { std::fclose(env_file_); env_file_ = nullptr; }
}

bool ObservationTap::write_index(const char* kind, std::string& err) {
    const bool spectrum = std::strcmp(kind, "spectrum") == 0;
    nlohmann::json j;
    j["schema_version"] = "cuav-product/1";
    j["kind"] = kind;
    j["dtype"] = "float32";
    j["byte_order"] = "little";
    j["op_id"] = op_id_;
    j["row_len"] = spectrum ? nfft_ : 3;
    j["rows"] = spectrum ? spec_rows_ : env_rows_;
    j["sample_rate_Hz"] = sample_rate_Hz_;
    j["center_Hz"] = center_frequency_Hz_;
    j["start_sample"] = spectrum ? spec_first_sample_ : first_sample_;
    j["t0_s"] = sample_rate_Hz_ > 0 ? static_cast<double>(spectrum ? spec_first_sample_ : first_sample_) / sample_rate_Hz_ : 0.0;
    if (spectrum) {
        j["bin_width_Hz"] = sample_rate_Hz_ > 0 ? sample_rate_Hz_ / static_cast<double>(nfft_) : 0.0;
        j["frame_hop_samples"] = acc_.hop() * segments_per_frame_;
        j["nfft"] = nfft_;
        j["segments_per_frame"] = segments_per_frame_;
        j["window"] = window_;
        j["scale"] = "dBFS";
        j["floor_dB"] = -300.0;
    } else {
        j["bucket_samples"] = bucket_samples_;
        j["last_bucket_samples"] = last_bucket_samples_;
        j["columns"] = {"min_abs", "max_abs", "rms_abs"};
        j["scale"] = "linear_FS";
    }
    State st = worst(last_meta_.state, status_.state);
    j["state"] = to_string(st);
    nlohmann::json reasons = nlohmann::json::array();
    for (const auto& r : last_meta_.state_reasons) reasons.push_back(r);
    j["state_reasons"] = reasons;                                     // 只有降级或无效才有内容
    nlohmann::json notes = nlohmann::json::array();                   // 说明性备注：末行段数、末桶样点数、丢弃尾样点
    for (const auto& r : reasons_) notes.push_back(r);
    j["notes"] = notes;
    j["trace"] = trace_json(last_meta_.trace);                       // 被观测信号的溯源
    j["producer"] = {{"component", "ObservationTap"}, {"version", "0.1.0"}, {"engine_version", engine_version()}};

    const std::string dir = platform::join(out_dir_, op_id_);
    const std::string dst = platform::join(dir, std::string(kind) + ".index.json");
    const std::string tmp = dst + ".tmp";
    {
        std::ofstream f(tmp.c_str(), std::ios::binary | std::ios::trunc);
        if (!f.good()) { err = "写索引失败：" + tmp; return false; }
        f << j.dump(2) << "\n";
    }
    return platform::atomic_replace(tmp, dst, err);
}

bool ObservationTap::write_spectrum_row(const std::vector<double>& power, std::uint64_t first_sample,
                                        std::size_t segments, std::string& err) {
    (void)segments;
    if (!spec_first_known_) { spec_first_sample_ = first_sample; spec_first_known_ = true; }
    std::vector<float> row(power.size());
    for (std::size_t k = 0; k < power.size(); ++k) {
        row[k] = static_cast<float>(10.0 * std::log10(std::max(power[k], 1e-30)));
    }
    if (spec_file_) {
        if (std::fwrite(row.data(), sizeof(float), row.size(), spec_file_) != row.size()) {
            err = "写 spectrum.f32 失败"; return false;
        }
        std::fflush(spec_file_);   // 逐行落盘：运行器随即发 product_row 事件，服务端按事件读这一行（B-4）
    }
    const double t_s = sample_rate_Hz_ > 0 ? static_cast<double>(first_sample) / sample_rate_Hz_ : 0.0;
    if (obs_) obs_->on_product_row(op_id_, "spectrum", spec_rows_, row.data(), row.size(), t_s);
    ++spec_rows_;
    if ((spec_rows_ & 63) == 0) {   // 每 64 行刷一次索引，让读端在运行中就能取到已写完的行
        std::fflush(spec_file_);
        if (!write_index("spectrum", err)) return false;
    }
    return true;
}

bool ObservationTap::write_envelope_row(std::string& err) {
    float row[3];
    row[0] = static_cast<float>(bucket_min_);
    row[1] = static_cast<float>(bucket_max_);
    row[2] = static_cast<float>(std::sqrt(bucket_sumsq_ / static_cast<double>(bucket_count_)));
    if (env_file_ && std::fwrite(row, sizeof(float), 3, env_file_) != 3) { err = "写 envelope.f32 失败"; return false; }
    if (env_file_) std::fflush(env_file_);   // 逐行落盘，同 spectrum
    const double t_s = sample_rate_Hz_ > 0 ? static_cast<double>(bucket_start_sample_) / sample_rate_Hz_ : 0.0;
    if (obs_) obs_->on_product_row(op_id_, "envelope", env_rows_, row, 3, t_s);
    ++env_rows_;
    last_bucket_samples_ = bucket_count_;
    bucket_count_ = 0;
    if ((env_rows_ & 63) == 0) {
        std::fflush(env_file_);
        if (!write_index("envelope", err)) return false;
    }
    return true;
}

void ObservationTap::feed_envelope(const Block& blk, std::string& err, bool& ok) {
    for (std::size_t i = 0; i < blk.size() && ok; ++i) {
        const double a = std::abs(std::complex<double>(blk.samples[i].real(), blk.samples[i].imag()));
        if (bucket_count_ == 0) {
            bucket_start_sample_ = blk.meta.start_sample + i;
            bucket_min_ = a; bucket_max_ = a; bucket_sumsq_ = 0.0;
        }
        bucket_min_ = std::min(bucket_min_, a);
        bucket_max_ = std::max(bucket_max_, a);
        bucket_sumsq_ += a * a;
        ++bucket_count_;
        if (bucket_count_ == bucket_samples_) ok = write_envelope_row(err);
    }
}

Step ObservationTap::process(PortMap& in, PortMap&, std::string& err) {
    auto it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& blk = it->second.iq;
    if (!seen_block_) {
        sample_rate_Hz_ = blk.meta.sample_rate_Hz;
        center_frequency_Hz_ = blk.meta.center_frequency_Hz;
        first_sample_ = blk.meta.start_sample;
        if (sample_rate_Hz_ <= 0.0) { err = "ObservationTap 收到的块没有采样率"; return Step::Error; }
        seen_block_ = true;
    } else if (blk.meta.sample_rate_Hz != sample_rate_Hz_) {
        err = "ObservationTap 中途收到不同采样率的块";
        return Step::Error;
    }
    last_meta_ = blk.meta;
    status_.blocks_in++;
    status_.samples_in += blk.size();
    status_.state = worst(status_.state, blk.meta.state);

    bool ok = true;
    if (want_spectrum_) {
        acc_.push(blk.samples.data(), blk.size(), blk.meta.start_sample,
                  [&](const std::vector<double>& power, std::uint64_t first, std::size_t segs) {
                      if (ok) ok = write_spectrum_row(power, first, segs, err);
                  });
    }
    if (ok && want_envelope_) feed_envelope(blk, err, ok);
    if (!ok) return Step::Error;
    status_.blocks_out++;
    return Step::Produced;   // 产出的是文件与回调，不是端口数据
}

Step ObservationTap::flush(PortMap&, std::string& err) {
    bool ok = true;
    if (want_spectrum_) {
        acc_.flush([&](const std::vector<double>& power, std::uint64_t first, std::size_t segs) {
            // 末行段数不足是流结束的自然结果，行数据本身正确，记备注不降级；索引里 rows 与备注一起给读端判断
            if (segs < segments_per_frame_) {
                reasons_.push_back("末行只有 " + std::to_string(segs) + "/" + std::to_string(segments_per_frame_) + " 段");
            }
            if (ok) ok = write_spectrum_row(power, first, segs, err);
        });
        if (acc_.dropped_tail_samples() > 0) {
            const std::string n = "收尾丢弃不满一段的 " + std::to_string(acc_.dropped_tail_samples()) + " 个样点";
            status_.notes.push_back(n);
            reasons_.push_back(n);
        }
    }
    if (ok && want_envelope_ && bucket_count_ > 0) {
        reasons_.push_back("末桶只有 " + std::to_string(bucket_count_) + "/" + std::to_string(bucket_samples_) + " 个样点");
        ok = write_envelope_row(err);
    }
    if (!ok) return Step::Error;
    close_files();
    if (want_spectrum_ && !write_index("spectrum", err)) return Step::Error;
    if (want_envelope_ && !write_index("envelope", err)) return Step::Error;
    return Step::Finished;
}

}  // namespace cuav
