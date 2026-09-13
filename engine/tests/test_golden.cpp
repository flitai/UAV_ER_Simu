// 引擎侧与 Python 参考实现的对拍（跨层一致性算例 ① 的引擎侧）。
//
// 黄金基准由 algos/reference/gen_engine_golden.py 生成，两侧从同一个种子各自生成输入，
// 因此不需要二进制夹具。判据分三档，写在黄金文件的 tolerance 字段里：
//   门限 1e-9（两侧同为 float64 同算法）
//   逐帧检测量 1e-5（引擎内部按规范用 float32，参考实现用 float64）
//   判决结果逐帧一致
#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/dsp.h"
#include "cuav/graph.h"
#include "cuav/components/processing.h"
#include "cuav/components/recognition.h"
#include "cuav/components/sources.h"
#include "cuav/observer.h"

using namespace cuav;

namespace {

std::string golden_path() {
    // CTest 的工作目录是构建目录，源码目录由 CMake 通过宏传进来
    return std::string(CUAV_SOURCE_DIR) + "/tests/golden/energy_detector.json";
}

std::string sliding_golden_path() {
    return std::string(CUAV_SOURCE_DIR) + "/tests/golden/energy_detector_sliding.json";
}

std::string features_golden_path() {
    return std::string(CUAV_SOURCE_DIR) + "/tests/golden/features.json";
}

// 门控噪声源（测试专用，C-4）：自带发生器 seed2，逐样点 complex_normal × float32(√power)，
// 门外置零但照样抽数——Python 复刻按「全流生成再乘门」就能逐位对上（gen_engine_golden.py 的 gated_noise）。
// 不进注册表：它只是为了给黄金基准造一段噪声型突发，NoiseSource 没有门控参数（加了就是目录基准变化）。
struct GatedNoiseSource : IComponent {
    double fs = 1e6;
    std::uint64_t total = 0, start = 0, stop = 0, seed = 0;
    double power = 1.0;
    std::size_t block = 32768;
    std::uint64_t produced = 0;
    std::unique_ptr<Xoshiro256pp> rng;
    ComponentStatus st;

    std::string type_name() const override { return "GatedNoiseSource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { rng.reset(new Xoshiro256pp(seed)); produced = 0; return true; }
    Step process(PortMap&, PortMap& out, std::string&) override {
        if (produced >= total) return Step::Finished;
        const std::size_t n = static_cast<std::size_t>(std::min<std::uint64_t>(block, total - produced));
        PortData d;
        d.type = PortType::IQStream;
        d.has_data = true;
        d.iq.samples.resize(n);
        const float k = static_cast<float>(std::sqrt(power));
        for (std::size_t i = 0; i < n; ++i) {
            float re, im;
            rng->complex_normal(re, im);
            const std::uint64_t idx = produced + i;
            d.iq.samples[i] = (idx >= start && idx < stop) ? Complex(re * k, im * k) : Complex(0.0f, 0.0f);
        }
        d.iq.meta.sample_rate_Hz = fs;
        d.iq.meta.center_frequency_Hz = 0.0;
        d.iq.meta.start_sample = produced;
        d.iq.meta.calibration.calibrated = true;
        d.iq.meta.calibration.source = "model";
        produced += n;
        out["out"] = d;
        return Step::Produced;
    }
    void reset() override { produced = 0; }
    ComponentStatus status() const override { return st; }
};

struct CollectFeatures : IRunObserver {
    std::vector<FeatureReport> rows;
    void on_feature(const FeatureReport& r) override { rows.push_back(r); }
};

struct CollectRows : IRunObserver {
    std::vector<Detection> rows;
    void on_detection(const DetectionReport& r) override { rows.push_back(r.d); }
};

}  // namespace

TEST_CASE("黄金基准：引擎的能量检测器复现 Python 参考实现") {
    std::ifstream f(golden_path().c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << golden_path());
    nlohmann::json g;
    f >> g;

    const auto& p = g.at("params");
    const auto& e = g.at("expected");
    const auto& tol = g.at("tolerance");

    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::size_t nfft = p.at("nfft").get<std::size_t>();
    const std::uint64_t frames = p.at("frames").get<std::uint64_t>();
    const std::uint64_t seed = p.at("seed").get<std::uint64_t>();

    Graph gr;
    std::string err;
    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::map<std::string, double> np{
        {"sample_rate_Hz", fs},
        {"total_samples", static_cast<double>(frames * nfft)},
        {"power", p.at("noise_power").get<double>()},
        {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId src = gr.add(std::move(n), "noise");

    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    std::map<std::string, double> dp{
        {"nfft", static_cast<double>(nfft)},
        {"band_lo_Hz", p.at("band_lo_Hz").get<double>()},
        {"band_hi_Hz", p.at("band_hi_Hz").get<double>()},
        {"pfa", p.at("pfa").get<double>()},
        {"noise_frames", p.at("noise_frames").get<double>()}};
    REQUIRE(d->configure(dp, {}, err));
    EnergyDetector* det = d.get();
    NodeId dn = gr.add(std::move(d), "det");

    // 逐帧检测量要留存下来比对，所以这里不用汇聚组件，直接收 DetectionList
    std::unique_ptr<DetectionSink> k(new DetectionSink());
    DetectionSink* sink = k.get();
    NodeId kn = gr.add(std::move(k), "sink");
    REQUIRE(gr.connect(src, "out", dn, "in", err));
    REQUIRE(gr.connect(dn, "out", kn, "in", err));

    Xoshiro256pp rng(seed);
    RunReport rep = gr.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);

    CHECK(det->band_bins() == e.at("m_bins").get<int>());
    // 门限：两侧同算法同精度，按黄金基准口径卡 1e-9
    const double eta_want = e.at("threshold").get<double>();
    CHECK(std::fabs(det->threshold() - eta_want) / eta_want
          < tol.at("threshold_rel").get<double>());

    CHECK(sink->frames() == e.at("frames").get<std::uint64_t>());
    // 判决结果逐帧一致：命中数必须相等
    CHECK(sink->hits() == e.at("hits").get<std::uint64_t>());
    // 检测量的最大值受 float32 影响，按 1e-5 卡
    const double max_want = e.at("lambda_max").get<double>();
    CHECK(std::fabs(sink->max_statistic() - max_want) / max_want
          < tol.at("statistic_rel").get<double>());
    CHECK(e.at("borderline_frames").get<int>() == 0);
}

TEST_CASE("黄金基准：随机源本身逐位可复现") {
    // 引擎与参考实现共用同一个发生器复刻，先确认引擎侧的序列没被改动过。
    // 这几个数由 engine/src/random.cpp 的实现决定，改实现就要改这里，且必须解释原因。
    Xoshiro256pp r(20260904);
    const std::uint64_t a = r.next_u64();
    const std::uint64_t b = r.next_u64();
    Xoshiro256pp r2(20260904);
    CHECK(r2.next_u64() == a);
    CHECK(r2.next_u64() == b);
    CHECK(a != b);
}

// 滑动模式（C-3，D-063）：同一噪声流 + 一段门控单音，Python 侧按 ToneSource 的公式逐样点复刻，
// 两侧逐帧比。判据比 probe 基准多三样必须**完全相同**的量：命中、段号、noise_frames_used——
// 环的内容取决于此前每一帧的判决，一次翻转会级联到后面所有帧，所以这里红一片是想要的行为，
// 不是把容差放宽的理由；生成器已断言没有帧卡在门限 ±1e-5 内。
TEST_CASE("黄金基准：引擎的 sliding 模式逐帧复现 Python 参考实现（含删截与分段）") {
    std::ifstream f(sliding_golden_path().c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << sliding_golden_path());
    nlohmann::json g;
    f >> g;
    const auto& p = g.at("params");
    const auto& e = g.at("expected");
    const auto& tol = g.at("tolerance");
    const auto& tone = p.at("tone");

    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::size_t nfft = p.at("nfft").get<std::size_t>();
    const std::uint64_t frames = p.at("frames").get<std::uint64_t>();
    const std::uint64_t seed = p.at("seed").get<std::uint64_t>();
    const double total = static_cast<double>(frames * nfft);

    Graph gr;
    std::string err;
    std::unique_ptr<ToneSource> t(new ToneSource());
    std::map<std::string, double> tp{{"sample_rate_Hz", fs}, {"total_samples", total},
                                     {"offset_Hz", tone.at("offset_Hz").get<double>()},
                                     {"amplitude", tone.at("amplitude").get<double>()},
                                     {"phase_rad", tone.at("phase_rad").get<double>()},
                                     {"start_sample", tone.at("start_sample").get<double>()},
                                     {"stop_sample", tone.at("stop_sample").get<double>()},
                                     {"block_samples", 32768.0}};
    REQUIRE(t->configure(tp, {}, err));
    NodeId tn = gr.add(std::move(t), "tone");
    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::map<std::string, double> np{{"sample_rate_Hz", fs}, {"total_samples", total},
                                     {"power", p.at("noise_power").get<double>()},
                                     {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId nn = gr.add(std::move(n), "noise");
    std::unique_ptr<AddMixer> m(new AddMixer());
    REQUIRE(m->configure({}, {}, err));
    NodeId mn = gr.add(std::move(m), "mix");
    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    EnergyDetector* det = d.get();
    std::map<std::string, double> dp{{"nfft", static_cast<double>(nfft)},
                                     {"band_lo_Hz", p.at("band_lo_Hz").get<double>()},
                                     {"band_hi_Hz", p.at("band_hi_Hz").get<double>()},
                                     {"pfa", p.at("pfa").get<double>()},
                                     {"noise_window_frames", p.at("noise_window_frames").get<double>()},
                                     {"merge_gap_frames", p.at("merge_gap_frames").get<double>()}};
    REQUIRE(d->configure(dp, {{"noise_mode", p.at("noise_mode").get<std::string>()}}, err));
    NodeId dn = gr.add(std::move(d), "det");
    std::unique_ptr<DetectionSink> k(new DetectionSink());
    DetectionSink* sink = k.get();
    NodeId kn = gr.add(std::move(k), "sink");
    REQUIRE(gr.connect(tn, "out", mn, "a", err));
    REQUIRE(gr.connect(nn, "out", mn, "b", err));
    REQUIRE(gr.connect(mn, "out", dn, "in", err));
    REQUIRE(gr.connect(dn, "out", kn, "in", err));

    CollectRows obs;
    Xoshiro256pp rng(seed);
    RunReport rep = gr.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);

    CHECK(det->band_bins() == e.at("m_bins").get<int>());
    const double eta_want = e.at("threshold").get<double>();
    CHECK(std::fabs(det->threshold() - eta_want) / eta_want < tol.at("threshold_rel").get<double>());
    REQUIRE(obs.rows.size() == frames);
    CHECK(sink->frames() == e.at("frames").get<std::uint64_t>());
    CHECK(e.at("borderline_frames").get<int>() == 0);

    const double stat_rel = tol.at("statistic_rel").get<double>();
    const auto& stat = e.at("statistic");
    REQUIRE(stat.size() == frames);
    double worst = 0.0;
    std::size_t bad = 0;
    for (std::size_t i = 0; i < frames; ++i) {
        const double want = stat[i].get<double>();
        const double got = obs.rows[i].statistic;
        const double rel = std::fabs(got - want) / std::max(std::fabs(want), 1e-300);
        if (rel > worst) worst = rel;
        if (rel > stat_rel) ++bad;
    }
    MESSAGE("sliding 逐帧检测量最大相对误差 " << worst << "（判据 " << stat_rel << "）");
    CHECK(bad == 0);

    // 命中帧集合、段号、暖机期的环大小：完全相同
    const auto& hit_frames = e.at("hit_frames");
    const auto& seg_of_hits = e.at("segment_id_of_hits");
    std::vector<std::uint64_t> got_hits;
    for (const auto& r : obs.rows) if (r.hit) got_hits.push_back(r.frame_index);
    REQUIRE(got_hits.size() == hit_frames.size());
    std::size_t mism = 0;
    for (std::size_t i = 0; i < got_hits.size(); ++i) {
        if (got_hits[i] != hit_frames[i].get<std::uint64_t>()) ++mism;
        if (obs.rows[got_hits[i]].segment_id != seg_of_hits[i].get<std::int64_t>()) ++mism;
    }
    CHECK(mism == 0);
    CHECK(sink->hits() == e.at("hits").get<std::uint64_t>());
    CHECK(det->segments() == e.at("segments").get<std::uint64_t>());
    CHECK(det->noise_stale_frames() == e.at("noise_stale_frames").get<std::uint64_t>());
    const auto& used_head = e.at("noise_frames_used_head");
    for (std::size_t i = 0; i < used_head.size() && i < frames; ++i) {
        CHECK(obs.rows[i].noise_frames_used == used_head[i].get<std::uint32_t>());
    }
    // 非命中帧的段号恒为 −1；命中帧的 snr 是 Λ 的分贝
    for (const auto& r : obs.rows) {
        if (!r.hit) CHECK(r.segment_id == -1);
    }
    CHECK(obs.rows[0].statistic == doctest::Approx(0.69314718055994530942).epsilon(1e-6));
    const double max_want = e.at("lambda_max").get<double>();
    CHECK(std::fabs(sink->max_statistic() - max_want) / max_want < stat_rel);
    CHECK(rep.state == State::Valid);
}

// 特征提取（C-4）：同一噪声流 + 四段门控单音 + 一段门控噪声突发，检测按 sliding，Python 侧 features.py
// 逐段算特征。计数、时间、段号、质量、按 bin 计的带宽必须**完全相同**；谱类量按黄金文件里的容差比。
// 生成器已断言没有 bin 卡在噪声闸或累积功率边界 ±1e-4 内——那里的翻转会让带宽差一个 bin，
// 红了先查是不是新的 float32 / float64 差异，不是放宽容差的理由。
TEST_CASE("黄金基准：引擎的特征提取器逐段复现 Python 参考实现（窗、去噪、带宽、质心、平坦度、峰均比）") {
    std::ifstream f(features_golden_path().c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << features_golden_path());
    nlohmann::json g;
    f >> g;
    const auto& p = g.at("params");
    const auto& e = g.at("expected");
    const auto& tol = g.at("tolerance");
    const auto& fp = p.at("feature");

    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::size_t nfft = p.at("nfft").get<std::size_t>();
    const std::uint64_t frames = p.at("frames").get<std::uint64_t>();
    const std::uint64_t seed = p.at("seed").get<std::uint64_t>();
    const double total = static_cast<double>(frames * nfft);

    Graph gr;
    std::string err;
    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::map<std::string, double> np{{"sample_rate_Hz", fs}, {"total_samples", total},
                                     {"power", p.at("noise_power").get<double>()},
                                     {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId prev = gr.add(std::move(n), "noise");
    std::size_t ti = 0;
    for (const auto& tone : p.at("tones")) {
        std::unique_ptr<ToneSource> t(new ToneSource());
        std::map<std::string, double> tp{{"sample_rate_Hz", fs}, {"total_samples", total},
                                         {"offset_Hz", tone.at("offset_Hz").get<double>()},
                                         {"amplitude", tone.at("amplitude").get<double>()},
                                         {"phase_rad", tone.at("phase_rad").get<double>()},
                                         {"start_sample", tone.at("start_sample").get<double>()},
                                         {"stop_sample", tone.at("stop_sample").get<double>()},
                                         {"block_samples", 32768.0}};
        REQUIRE(t->configure(tp, {}, err));
        NodeId tn = gr.add(std::move(t), "tone" + std::to_string(ti));
        std::unique_ptr<AddMixer> m(new AddMixer());
        REQUIRE(m->configure({}, {}, err));
        NodeId mn = gr.add(std::move(m), "mix" + std::to_string(ti));
        REQUIRE(gr.connect(tn, "out", mn, "a", err));
        REQUIRE(gr.connect(prev, "out", mn, "b", err));
        prev = mn;
        ++ti;
    }
    {
        const auto& nb = p.at("noise_burst");
        std::unique_ptr<GatedNoiseSource> gs(new GatedNoiseSource());
        gs->fs = fs;
        gs->total = frames * nfft;
        gs->start = nb.at("start_sample").get<std::uint64_t>();
        gs->stop = nb.at("stop_sample").get<std::uint64_t>();
        gs->power = nb.at("power").get<double>();
        gs->seed = p.at("seed2").get<std::uint64_t>();
        NodeId gn = gr.add(std::move(gs), "gated");
        std::unique_ptr<AddMixer> m(new AddMixer());
        REQUIRE(m->configure({}, {}, err));
        NodeId mn = gr.add(std::move(m), "mixg");
        REQUIRE(gr.connect(gn, "out", mn, "a", err));
        REQUIRE(gr.connect(prev, "out", mn, "b", err));
        prev = mn;
    }
    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    EnergyDetector* det = d.get();
    std::map<std::string, double> dp{{"nfft", static_cast<double>(nfft)},
                                     {"band_lo_Hz", p.at("band_lo_Hz").get<double>()},
                                     {"band_hi_Hz", p.at("band_hi_Hz").get<double>()},
                                     {"pfa", p.at("pfa").get<double>()},
                                     {"noise_window_frames", p.at("noise_window_frames").get<double>()},
                                     {"merge_gap_frames", p.at("merge_gap_frames").get<double>()}};
    REQUIRE(d->configure(dp, {{"noise_mode", p.at("noise_mode").get<std::string>()}}, err));
    NodeId dn = gr.add(std::move(d), "det");
    std::unique_ptr<FeatureExtractor> fx(new FeatureExtractor());
    FeatureExtractor* feat = fx.get();
    std::map<std::string, double> fnum{{"nfft", fp.at("nfft").get<double>()},
                                       {"min_frames", fp.at("min_frames").get<double>()},
                                       {"window_frames", fp.at("window_frames").get<double>()},
                                       {"merge_gap_frames", fp.at("merge_gap_frames").get<double>()},
                                       {"noise_gate", fp.at("noise_gate").get<double>()}};
    REQUIRE(fx->configure(fnum, {{"bandwidth_method", fp.at("bandwidth_method").get<std::string>()}}, err));
    NodeId fn = gr.add(std::move(fx), "feat");
    REQUIRE(gr.connect(prev, "out", dn, "in", err));
    REQUIRE(gr.connect(prev, "out", fn, "iq", err));
    REQUIRE(gr.connect(dn, "out", fn, "det", err));

    CollectFeatures obs;
    Xoshiro256pp rng(seed);
    RunReport rep = gr.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    CHECK(det->band_bins() == e.at("m_bins").get<int>());
    CHECK(det->frames() == frames);
    CHECK(det->hits() == e.at("hits").get<std::uint64_t>());
    CHECK(det->segments() == e.at("segments").get<std::uint64_t>());
    CHECK(e.at("borderline_frames").get<int>() == 0);
    CHECK(feat->frames() == frames);

    const auto& rows = e.at("rows");
    REQUIRE(obs.rows.size() == rows.size());
    CHECK(feat->segments() == rows.size());
    const double c_abs = tol.at("center_Hz_abs").get<double>();
    const double h_abs = tol.at("hop_Hz_abs").get<double>();
    const double fl_abs = tol.at("flatness_abs").get<double>();
    const double db_abs = tol.at("dB_abs").get<double>();
    const double cr_rel = tol.at("crest_rel").get<double>();
    double worst_c = 0.0, worst_fl = 0.0, worst_db = 0.0, worst_cr = 0.0;
    std::size_t bad = 0;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const auto& w = rows[i];
        const FeatureRow& r = obs.rows[i].row;
        CHECK(obs.rows[i].node_id == "feat");
        if (r.segment_id != w.at("segment_id").get<std::int64_t>()) ++bad;
        if (r.frames != w.at("frames").get<std::uint64_t>()) ++bad;
        if (r.signal_bins != w.at("signal_bins").get<std::size_t>()) ++bad;
        if (r.quality != w.at("quality").get<std::string>()) ++bad;
        if (r.overload != w.at("overload").get<bool>()) ++bad;
        if (r.has_dBm != w.at("has_dBm").get<bool>()) ++bad;
        if (r.has_prev != w.at("has_prev").get<bool>()) ++bad;
        if (r.t_s != w.at("t_s").get<double>()) ++bad;
        if (r.t_end_s != w.at("t_end_s").get<double>()) ++bad;
        if (r.duration_s != w.at("duration_s").get<double>()) ++bad;
        if (r.duty != w.at("duty").get<double>()) ++bad;
        if (r.bandwidth_Hz != w.at("bandwidth_Hz").get<double>()) ++bad;
        if (r.has_prev) {
            if (r.interval_from_prev_s != w.at("interval_from_prev_s").get<double>()) ++bad;
            const double dh = std::fabs(r.hop_from_prev_Hz - w.at("hop_from_prev_Hz").get<double>());
            if (dh > h_abs) ++bad;
        }
        const double dc = std::fabs(r.center_Hz - w.at("center_Hz").get<double>());
        const double dfl = std::fabs(r.spectral_flatness - w.at("spectral_flatness").get<double>());
        const double dsnr = std::fabs(r.snr_dB - w.at("snr_dB").get<double>());
        double ddb = dsnr;
        if (r.has_dBm) {
            ddb = std::max(ddb, std::fabs(r.band_power_dBm - w.at("band_power_dBm").get<double>()));
            ddb = std::max(ddb, std::fabs(r.peak_dBm - w.at("peak_dBm").get<double>()));
        }
        const double wc = w.at("crest_factor_dB").get<double>();
        const double dcr = std::fabs(r.crest_factor_dB - wc) / std::max(std::fabs(wc), 1e-300);
        worst_c = std::max(worst_c, dc);
        worst_fl = std::max(worst_fl, dfl);
        worst_db = std::max(worst_db, ddb);
        worst_cr = std::max(worst_cr, dcr);
        if (dc > c_abs || dfl > fl_abs || ddb > db_abs || dcr > cr_rel) ++bad;
    }
    MESSAGE("features 逐段最大误差：质心 " << worst_c << " Hz（判据 " << c_abs << "），平坦度 " << worst_fl
            << "（" << fl_abs << "），dB " << worst_db << "（" << db_abs << "），峰均比 rel " << worst_cr
            << "（" << cr_rel << "）");
    CHECK(bad == 0);
    CHECK(rep.state == State::Valid);
}

// 模板匹配识别（C-4）：黄金文件里是手造的特征行与 Python 参考算出的识别行，两侧同为 float64 同算法，
// 后验与距离按 1e-9，标签、判决、unknown_kind 与 top_n 的顺序逐字相同。
TEST_CASE("黄金基准：引擎的模板匹配识别器逐行复现 Python 参考实现") {
    const std::string path = std::string(CUAV_SOURCE_DIR) + "/tests/golden/recognition.json";
    std::ifstream f(path.c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << path);
    nlohmann::json g;
    f >> g;
    const std::string lib = std::string(CUAV_SOURCE_DIR) + "/../" + g.at("library").get<std::string>();
    const auto& p = g.at("params");
    const double rel = g.at("tolerance").at("rel").get<double>();

    TemplateClassifier c;
    std::string err;
    REQUIRE_MESSAGE(c.configure({{"accept_threshold", p.at("accept_threshold").get<double>()},
                                 {"ambiguity_margin", p.at("ambiguity_margin").get<double>()},
                                 {"unknown_distance", p.at("unknown_distance").get<double>()}},
                                {{"library_path", lib}, {"min_quality", p.at("min_quality").get<std::string>()},
                                 {"library_version", g.at("library_version").get<std::string>()}}, err), err);
    const auto& rows = g.at("rows");
    const auto& want = g.at("expected");
    REQUIRE(rows.size() == want.size());
    auto close = [&](double a, double b) { return std::fabs(a - b) <= rel * std::max(std::fabs(b), 1e-300) || std::fabs(a - b) < 1e-300; };
    std::size_t bad = 0;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const auto& r = rows[i];
        FeatureRow fr;
        fr.t_s = r.at("t_s").get<double>(); fr.t_end_s = r.at("t_end_s").get<double>();
        fr.duration_s = r.at("duration_s").get<double>(); fr.segment_id = r.at("segment_id").get<std::int64_t>();
        fr.frames = r.at("frames").get<std::uint64_t>(); fr.center_Hz = r.at("center_Hz").get<double>();
        fr.bandwidth_Hz = r.at("bandwidth_Hz").get<double>(); fr.signal_bins = r.at("signal_bins").get<std::size_t>();
        fr.has_dBm = r.at("has_dBm").get<bool>(); fr.band_power_dBm = r.at("band_power_dBm").get<double>();
        fr.peak_dBm = r.at("peak_dBm").get<double>(); fr.snr_dB = r.at("snr_dB").get<double>();
        fr.spectral_flatness = r.at("spectral_flatness").get<double>(); fr.crest_factor_dB = r.at("crest_factor_dB").get<double>();
        fr.duty = r.at("duty").get<double>(); fr.overload = r.at("overload").get<bool>();
        fr.quality = r.at("quality").get<std::string>(); fr.has_prev = r.at("has_prev").get<bool>();
        fr.interval_from_prev_s = r.at("interval_from_prev_s").get<double>(); fr.hop_from_prev_Hz = r.at("hop_from_prev_Hz").get<double>();
        const RecognitionRow got = c.classify(fr);
        const auto& w = want[i];
        std::string why;
        if (got.label != w.at("label").get<std::string>()) why += " label";
        if (got.result != w.at("result").get<std::string>()) why += " result";
        const std::string uk = w.at("unknown_kind").is_null() ? std::string() : w.at("unknown_kind").get<std::string>();
        if (got.unknown_kind != uk) why += " unknown_kind";
        if (!close(got.posterior, w.at("posterior").get<double>())) why += " posterior";
        if (w.at("distance").is_null() ? got.distance >= 0.0 : !close(got.distance, w.at("distance").get<double>())) why += " distance";
        const auto& top = w.at("top_n");
        if (got.top_n.size() != top.size()) why += " top_n.size";
        else for (std::size_t n = 0; n < top.size(); ++n) {
            if (got.top_n[n].label != top[n].at("label").get<std::string>()) why += " top_n.label";
            if (!close(got.top_n[n].posterior, top[n].at("posterior").get<double>())) why += " top_n.posterior";
            if (!close(got.top_n[n].distance, top[n].at("distance").get<double>())) why += " top_n.distance";
        }
        if (got.evidence_quality != w.at("evidence_quality").get<std::string>()) why += " evidence_quality";
        if (!why.empty()) { ++bad; MESSAGE("第 " << i << " 行不符：" << why); }
    }
    CHECK(bad == 0);
}

