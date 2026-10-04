// 分子带检测（Q-4b，D-093）对 algos/reference/subband.py 的逐帧对拍，黄金基准
// engine/tests/golden/energy_detector_subband.json（gen_engine_golden.py --mode subband 生成）。
//
// 输入两侧各自按同一种子生成：噪声（Xoshiro256++）+ 13 个门控单音（ToneSource 的闭式公式），
// 经一串 AddMixer 相加——每级只有一次加法，交换律逐位成立。判据：
//   · 特征值：两侧用不同方法求（Python 通用特征分解、这里久期方程），1e-12；
//   · 门限：1e-9；
//   · 每帧的簇数、首末频点、段号完全相同，簇统计量 1e-5（float32 FFT）；
//   · 帧级字段：同一输入关掉分子带再跑一次，统计量、命中、段号逐位相同——分子带不碰帧级判决。

#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/dsp.h"
#include "cuav/graph.h"
#include "cuav/components/processing.h"
#include "cuav/components/sources.h"
#include "cuav/observer.h"
#include "cuav/random.h"

using namespace cuav;

namespace {

std::string subband_golden_path() {
    return std::string(CUAV_SOURCE_DIR) + "/tests/golden/energy_detector_subband.json";
}

struct Rows : IRunObserver {
    std::vector<Detection> rows;
    void on_detection(const DetectionReport& r) override { rows.push_back(r.d); }
};

// 按黄金基准的参数搭图跑一遍；subband_bins = 0 即关
std::vector<Detection> run_chain(const nlohmann::json& p, int subband_bins, const EnergyDetector** keep,
                                 std::unique_ptr<Graph>& gr_out) {
    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::size_t nfft = p.at("nfft").get<std::size_t>();
    const std::uint64_t frames = p.at("frames").get<std::uint64_t>();
    const double total = static_cast<double>(frames * nfft);
    std::unique_ptr<Graph> gr(new Graph());
    std::string err;
    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::map<std::string, double> np{{"sample_rate_Hz", fs}, {"total_samples", total},
                                     {"power", p.at("noise_power").get<double>()}, {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId acc = gr->add(std::move(n), "noise");
    int i = 0;
    for (const auto& t : p.at("tones")) {
        std::unique_ptr<ToneSource> ts(new ToneSource());
        std::map<std::string, double> tp{{"sample_rate_Hz", fs}, {"total_samples", total},
                                         {"offset_Hz", t.at("offset_Hz").get<double>()},
                                         {"amplitude", t.at("amplitude").get<double>()},
                                         {"phase_rad", t.at("phase_rad").get<double>()},
                                         {"start_sample", t.at("start_sample").get<double>()},
                                         {"stop_sample", t.at("stop_sample").get<double>()},
                                         {"block_samples", 32768.0}};
        REQUIRE(ts->configure(tp, {}, err));
        NodeId tn = gr->add(std::move(ts), "tone" + std::to_string(i));
        std::unique_ptr<AddMixer> m(new AddMixer());
        REQUIRE(m->configure({}, {}, err));
        NodeId mn = gr->add(std::move(m), "mix" + std::to_string(i));
        REQUIRE(gr->connect(tn, "out", mn, "a", err));
        REQUIRE(gr->connect(acc, "out", mn, "b", err));
        acc = mn;
        ++i;
    }
    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    if (keep) *keep = d.get();
    std::map<std::string, double> dp{{"nfft", static_cast<double>(nfft)},
                                     {"band_lo_Hz", p.at("band_lo_Hz").get<double>()},
                                     {"band_hi_Hz", p.at("band_hi_Hz").get<double>()},
                                     {"pfa", p.at("pfa").get<double>()},
                                     {"noise_window_frames", p.at("noise_window_frames").get<double>()},
                                     {"merge_gap_frames", p.at("merge_gap_frames").get<double>()},
                                     {"subband_bins", static_cast<double>(subband_bins)}};
    REQUIRE(d->configure(dp, {{"noise_mode", "sliding"}}, err));
    NodeId dn = gr->add(std::move(d), "det");
    std::unique_ptr<DetectionSink> k(new DetectionSink());
    NodeId kn = gr->add(std::move(k), "sink");
    REQUIRE(gr->connect(acc, "out", dn, "in", err));
    REQUIRE(gr->connect(dn, "out", kn, "in", err));
    Rows obs;
    Xoshiro256pp rng(p.at("seed").get<std::uint64_t>());
    RunReport rep = gr->run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    gr_out = std::move(gr);
    return obs.rows;
}

}  // namespace

TEST_CASE("分子带：相关矩阵的特征值（久期方程）对 numpy 的通用特征分解") {
    std::ifstream f(subband_golden_path().c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << subband_golden_path());
    nlohmann::json g;
    f >> g;
    const double tol = g.at("tolerance").at("eigen_abs").get<double>();
    for (auto it = g.at("expected").at("eigenvalues").begin(); it != g.at("expected").at("eigenvalues").end(); ++it) {
        const std::size_t S = static_cast<std::size_t>(std::stoul(it.key()));
        const std::vector<double> got = dsp::hann_corr_eigs(S);
        REQUIRE(got.size() == it.value().size());
        double worst = 0.0;
        double sum = 0.0;
        for (std::size_t i = 0; i < got.size(); ++i) {
            worst = std::max(worst, std::fabs(got[i] - it.value()[i].get<double>()));
            sum += got[i];
        }
        MESSAGE("S = " << S << "：特征值最大差 " << worst);
        CHECK(worst <= tol);
        CHECK(std::fabs(sum - static_cast<double>(S)) < 1e-12);   // 迹 = S（对角全为 1）
    }
}

TEST_CASE("分子带：引擎逐帧复现 Python 参考（簇、段号、门限），且不碰帧级判决") {
    std::ifstream f(subband_golden_path().c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << subband_golden_path());
    nlohmann::json g;
    f >> g;
    const auto& p = g.at("params");
    const auto& e = g.at("expected");
    const auto& tol = g.at("tolerance");
    const int k0 = p.at("subband_bins").get<int>();
    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::size_t nfft = p.at("nfft").get<std::size_t>();
    const std::uint64_t frames = p.at("frames").get<std::uint64_t>();

    const EnergyDetector* det = nullptr;
    std::unique_ptr<Graph> keep1, keep2;
    const std::vector<Detection> rows = run_chain(p, k0, &det, keep1);
    REQUIRE(rows.size() == frames);
    const SubbandStage& st = det->subband();
    CHECK(st.tests() == e.at("tests").get<std::size_t>());
    CHECK(st.levels() == e.at("sizes").size());
    CHECK(std::fabs(st.pfa_test() - e.at("pfa_test").get<double>()) / e.at("pfa_test").get<double>() < 1e-15);

    // 门限
    const double thr_rel = tol.at("threshold_rel").get<double>();
    double worst_thr = 0.0;
    for (auto it = e.at("thresholds").begin(); it != e.at("thresholds").end(); ++it) {
        const std::size_t w = static_cast<std::size_t>(std::stoul(it.key()));
        const double want = it.value().get<double>();
        worst_thr = std::max(worst_thr, std::fabs(st.threshold_for(w) - want) / want);
    }
    MESSAGE("分子带门限最大相对差 " << worst_thr << "（判据 " << thr_rel << "）");
    CHECK(worst_thr <= thr_rel);

    // 逐帧的簇
    const double df = fs / static_cast<double>(nfft);
    const double band_lo = p.at("band_lo_Hz").get<double>();
    int first_bin = -1;   // 频段第一个频点相对 nfft/2 的偏移：与 build_mask 同一规则
    for (std::size_t k = 0; k < nfft; ++k) {
        const double fk = (static_cast<double>(k) - static_cast<double>(nfft / 2)) * df;
        if (fk >= band_lo) { first_bin = static_cast<int>(k); break; }
    }
    REQUIRE(first_bin >= 0);
    std::vector<const nlohmann::json*> want_of(frames, nullptr);
    for (const auto& r : e.at("rows")) want_of[r.at(0).get<std::size_t>()] = &r.at(1);
    const double stat_rel = tol.at("statistic_rel").get<double>();
    std::size_t struct_bad = 0, stat_bad = 0, hit_frames = 0;
    double worst_stat = 0.0;
    for (std::uint64_t i = 0; i < frames; ++i) {
        const Detection& d = rows[i];
        CHECK(d.subband_mode);
        const nlohmann::json* w = want_of[i];
        const std::size_t nw = w ? w->size() : 0;
        if (d.subbands.size() != nw || d.subband_hit != (nw > 0)) { ++struct_bad; continue; }
        if (nw) ++hit_frames;
        const double center = d.f_lo_Hz - band_lo;          // 帧级频段下沿 = 中心 + band_lo
        for (std::size_t c = 0; c < nw; ++c) {
            const auto& wc = (*w)[c];
            const std::size_t lo = wc.at(0).get<std::size_t>(), hi = wc.at(1).get<std::size_t>();
            const double flo = center + (static_cast<double>(first_bin + static_cast<int>(lo)) -
                                         static_cast<double>(nfft / 2)) * df - 0.5 * df;
            const double fhi = center + (static_cast<double>(first_bin + static_cast<int>(hi)) -
                                         static_cast<double>(nfft / 2)) * df + 0.5 * df;
            const SubbandHit& h = d.subbands[c];
            if (std::fabs(h.f_lo_Hz - flo) > 1e-6 || std::fabs(h.f_hi_Hz - fhi) > 1e-6 ||
                h.bins != hi - lo + 1 || h.segment_id != wc.at(2).get<std::int64_t>()) {
                ++struct_bad;
                continue;
            }
            const double want = wc.at(3).get<double>();
            const double rel = std::fabs(h.statistic - want) / std::max(std::fabs(want), 1e-300);
            worst_stat = std::max(worst_stat, rel);
            if (rel > stat_rel) ++stat_bad;
        }
    }
    MESSAGE("分子带：有簇的帧 " << hit_frames << "，簇统计量最大相对差 " << worst_stat);
    CHECK(struct_bad == 0);
    CHECK(stat_bad == 0);
    CHECK(hit_frames == e.at("hit_frames").get<std::size_t>());
    CHECK(st.segments() == e.at("segments").get<std::uint64_t>());
    CHECK(st.never_full_bins() == e.at("never_full_bins").get<std::size_t>());
    CHECK(st.stale_frames() == e.at("stale_frames").get<std::uint64_t>());

    // 帧级判决一字不受分子带影响
    const std::vector<Detection> plain = run_chain(p, 0, nullptr, keep2);
    REQUIRE(plain.size() == rows.size());
    std::size_t frame_bad = 0;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        if (rows[i].statistic != plain[i].statistic || rows[i].hit != plain[i].hit ||
            rows[i].segment_id != plain[i].segment_id || rows[i].threshold != plain[i].threshold ||
            plain[i].subband_mode || !plain[i].subbands.empty()) ++frame_bad;
    }
    CHECK(frame_bad == 0);
}

TEST_CASE("分子带：参数校验") {
    std::string err;
    EnergyDetector d;
    std::map<std::string, double> base{{"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5}};
    std::map<std::string, double> p = base;
    p["subband_bins"] = 8;
    CHECK_FALSE(d.configure(p, {}, err));                      // probe 不能开
    CHECK(err.find("sliding") != std::string::npos);
    p["subband_bins"] = 6;
    CHECK_FALSE(d.configure(p, {{"noise_mode", "sliding"}}, err));
    p["subband_bins"] = 8;
    CHECK(d.configure(p, {{"noise_mode", "sliding"}}, err));
    p["subband_bins"] = 0;
    CHECK(d.configure(p, {}, err));                            // 0 = 关，probe 照常
}
