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
