// C-4 步骤 3：合成波形经 检测(sliding) → 特征 → 识别 的 signal_role 准确率（10 报告 §8 C-4 验收，原型阶段验证值）。
//
// 三类：cw_beacon（长单音）、telemetry_burst（定周期的窄带噪声样短突发）、video_link（宽带白噪声长段）；
// rc_hopping 本期没有跳频生成器（G-6 未做），库里保留、验收留 C-8 / G-6（06 §9G）。
// 信号源是测试专用的调度源：背景白噪声（功率 1）+ 按时间表叠加的突发，自带发生器、逐样点确定；
// 窄带噪声样突发按 1024 点块在频域随机生成再逆变换，块网格相对突发起点而不是相对样点 0，
// 免得与检测器的分帧恰好对齐、把矩形帧的泄漏都抹掉。
// 信噪比按检测频段定义：S / N_band = 10（10 dB）。判定只统计 quality = full 且落在某个突发时间内的识别行；
// 突发之外的行是虚警，只报数不计入准确率。
#include "doctest/doctest.h"

#include <cmath>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "cuav/components/processing.h"
#include "cuav/components/recognition.h"
#include "cuav/dsp.h"
#include "cuav/graph.h"
#include "cuav/observer.h"
#include "cuav/random.h"

using namespace cuav;

namespace {

std::string library_v1() { return std::string(CUAV_SOURCE_DIR) + "/../models/recognition/library-v1.json"; }

struct Epoch {
    enum Kind { Tone, WhiteNoise, NarrowNoise };
    Kind kind = Tone;
    std::uint64_t start = 0, stop = 0;
    double offset_Hz = 0.0;     // Tone / NarrowNoise 的中心频偏
    double power = 1.0;         // 突发期间每样点平均功率（|x|²）
    double bw_Hz = 0.0;         // NarrowNoise 的带宽
    std::string label;          // 期望的 signal_role
};

struct ScheduledSource : IComponent {
    double fs = 1e6;
    std::uint64_t total = 0;
    std::size_t block = 32768;
    std::uint64_t seed = 1;
    std::vector<Epoch> epochs;
    static const std::size_t kSyn = 1024;
    std::unique_ptr<Xoshiro256pp> rng;
    std::uint64_t produced = 0;
    // 窄带块缓存：<epoch 下标, 块号> → 1024 个样点
    std::map<std::pair<std::size_t, std::uint64_t>, std::vector<Complex>> nb_cache;
    ComponentStatus st;

    std::string type_name() const override { return "ScheduledSource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { rng.reset(new Xoshiro256pp(seed)); produced = 0; nb_cache.clear(); return true; }

    const std::vector<Complex>& narrow_block(std::size_t ei, std::uint64_t b) {
        auto key = std::make_pair(ei, b);
        auto it = nb_cache.find(key);
        if (it != nb_cache.end()) return it->second;
        const Epoch& e = epochs[ei];
        std::vector<Complex> X(kSyn, Complex(0.0f, 0.0f));
        const double bin = fs / static_cast<double>(kSyn);
        const long k0 = static_cast<long>(std::floor((e.offset_Hz - 0.5 * e.bw_Hz) / bin));
        const long k1 = static_cast<long>(std::floor((e.offset_Hz + 0.5 * e.bw_Hz) / bin));
        std::size_t m = 0;
        for (long k = k0; k <= k1; ++k) ++m;
        // Parseval：x = conj(fft(conj(X)))/N，mean|x|² = Σ|X|²/N²；要 mean|x|² = power → E|X|² = power·N²/m
        const float scale = static_cast<float>(std::sqrt(e.power * static_cast<double>(kSyn) * static_cast<double>(kSyn) / static_cast<double>(m)));
        for (long k = k0; k <= k1; ++k) {
            float re, im;
            rng->complex_normal(re, im);
            const std::size_t idx = static_cast<std::size_t>((k + static_cast<long>(kSyn)) % static_cast<long>(kSyn));
            X[idx] = Complex(re * scale, im * scale);
        }
        for (auto& v : X) v = std::conj(v);
        dsp::fft_inplace(X);
        const float inv = 1.0f / static_cast<float>(kSyn);
        for (auto& v : X) v = std::conj(v) * inv;
        nb_cache.erase(std::make_pair(ei, b - 2));   // 只留最近两块
        return nb_cache[key] = X;
    }

    Step process(PortMap&, PortMap& out, std::string&) override {
        if (produced >= total) return Step::Finished;
        const std::size_t n = static_cast<std::size_t>(std::min<std::uint64_t>(block, total - produced));
        PortData d;
        d.type = PortType::IQStream;
        d.has_data = true;
        d.iq.samples.resize(n);
        for (std::size_t i = 0; i < n; ++i) {
            float re, im;
            rng->complex_normal(re, im);
            Complex v(re, im);
            const std::uint64_t idx = produced + i;
            for (std::size_t ei = 0; ei < epochs.size(); ++ei) {
                const Epoch& e = epochs[ei];
                if (idx < e.start || idx >= e.stop) continue;
                if (e.kind == Epoch::Tone) {
                    const double ph = 2.0 * 3.14159265358979323846 * e.offset_Hz / fs * static_cast<double>(idx);
                    const float a = static_cast<float>(std::sqrt(e.power));
                    v += Complex(static_cast<float>(a * std::cos(ph)), static_cast<float>(a * std::sin(ph)));
                } else if (e.kind == Epoch::WhiteNoise) {
                    float nr, ni;
                    rng->complex_normal(nr, ni);
                    const float k = static_cast<float>(std::sqrt(e.power));
                    v += Complex(nr * k, ni * k);
                } else {
                    const std::uint64_t rel = idx - e.start;
                    const std::vector<Complex>& blk = narrow_block(ei, rel / kSyn);
                    v += blk[static_cast<std::size_t>(rel % kSyn)];
                }
            }
            d.iq.samples[i] = v;
        }
        d.iq.meta.sample_rate_Hz = fs;
        d.iq.meta.center_frequency_Hz = 2.44e9;
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

struct Collect : IRunObserver {
    std::vector<FeatureReport> feats;
    std::vector<RecognitionReport> recs;
    void on_feature(const FeatureReport& f) override { feats.push_back(f); }
    void on_recognition(const RecognitionReport& r) override { recs.push_back(r); }
};

struct Tally {
    std::size_t matched = 0, correct = 0, unmatched = 0;
    std::map<std::string, std::size_t> labels;   // 匹配上的行里各标签的计数
};

// 跑一条 调度源 → det(sliding) → feat → rec 的链，按时间表判分
Tally run_class(double fs, double duration_s, std::uint64_t seed, const std::vector<Epoch>& epochs, const std::string& note) {
    Graph g;
    std::string err;
    std::unique_ptr<ScheduledSource> src(new ScheduledSource());
    src->fs = fs;
    src->total = static_cast<std::uint64_t>(duration_s * fs);
    src->seed = seed;
    src->epochs = epochs;
    NodeId sn = g.add(std::move(src), "src");
    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    REQUIRE(d->configure({{"nfft", 1024.0}, {"band_lo_Hz", -0.45 * fs}, {"band_hi_Hz", 0.45 * fs},
                          {"pfa", 1e-3}, {"noise_window_frames", 256.0}, {"merge_gap_frames", 2.0}},
                         {{"noise_mode", "sliding"}}, err));
    NodeId dn = g.add(std::move(d), "det");
    std::unique_ptr<FeatureExtractor> f(new FeatureExtractor());
    REQUIRE(f->configure({{"nfft", 1024.0}, {"merge_gap_frames", 2.0}}, {}, err));
    NodeId fn = g.add(std::move(f), "feat");
    std::unique_ptr<TemplateClassifier> r(new TemplateClassifier());
    REQUIRE_MESSAGE(r->configure({}, {{"library_path", library_v1()}}, err), err);
    NodeId rn = g.add(std::move(r), "rec");
    REQUIRE(g.connect(sn, "out", dn, "in", err));
    REQUIRE(g.connect(sn, "out", fn, "iq", err));
    REQUIRE(g.connect(dn, "out", fn, "det", err));
    REQUIRE(g.connect(fn, "out", rn, "in", err));
    Collect obs;
    Xoshiro256pp rng(seed);
    RunReport rep = g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    REQUIRE(obs.recs.size() == obs.feats.size());

    Tally t;
    for (std::size_t i = 0; i < obs.recs.size(); ++i) {
        const FeatureRow& fr = obs.feats[i].row;
        const RecognitionRow& rr = obs.recs[i].row;
        if (fr.quality != "full") continue;
        const Epoch* hit = nullptr;
        for (const Epoch& e : epochs) {
            const double t0 = static_cast<double>(e.start) / fs, t1 = static_cast<double>(e.stop) / fs;
            if (fr.t_s >= t0 - 0.01 && fr.t_s < t1) { hit = &e; break; }
        }
        if (!hit) { ++t.unmatched; continue; }
        ++t.matched;
        ++t.labels[rr.label];
        if (rr.result != "unknown" && rr.label == hit->label) ++t.correct;
    }
    std::ostringstream o;
    for (const auto& kv : t.labels) o << kv.first << "=" << kv.second << " ";
    MESSAGE(note << "：突发 " << epochs.size() << "，匹配上的 full 行 " << t.matched << "，判对 " << t.correct
            << "，突发之外的 full 行 " << t.unmatched << "；标签分布 " << o.str());
    return t;
}

}  // namespace

TEST_CASE("C-4 验收：三类合成波形在 10 dB 带内信噪比下的 signal_role 准确率 ≥ 0.9（rc_hopping 待 G-6；原型阶段验证值）") {
    // 带内噪声 = 1 × 0.9（检测频段占 90%）；S = 9 → 10 dB
    const double S = 9.0;
    std::vector<Epoch> cw, tel, vid;
    {   // cw_beacon：0.6 s 单音、间隔 0.15 s，24 段，fs 500 kS/s（典型链路的采样率）
        const double fs = 500e3;
        for (int k = 0; k < 24; ++k) {
            Epoch e; e.kind = Epoch::Tone; e.offset_Hz = 30e3; e.power = S; e.label = "cw_beacon";
            const double t0 = 0.8 + 0.75 * k;
            e.start = static_cast<std::uint64_t>(t0 * fs); e.stop = static_cast<std::uint64_t>((t0 + 0.6) * fs);
            cw.push_back(e);
        }
    }
    {   // telemetry_burst：10 ms 的 40 kHz 窄带噪声样突发、周期 100 ms、定频，24 段，fs 500 kS/s
        const double fs = 500e3;
        for (int k = 0; k < 24; ++k) {
            Epoch e; e.kind = Epoch::NarrowNoise; e.offset_Hz = -50e3; e.bw_Hz = 40e3; e.power = S; e.label = "telemetry_burst";
            const double t0 = 1.0 + 0.1 * k;
            e.start = static_cast<std::uint64_t>(t0 * fs); e.stop = static_cast<std::uint64_t>((t0 + 0.010) * fs);
            tel.push_back(e);
        }
    }
    {   // video_link：0.55 s 的全带白噪声、间隔 0.1 s，8 段，fs 2.5 MS/s（检测频段 ±1.125 MHz ≥ 库里的 1 MHz 下界）
        const double fs = 2.5e6;
        for (int k = 0; k < 8; ++k) {
            Epoch e; e.kind = Epoch::WhiteNoise; e.power = S / 0.9; e.label = "video_link";   // 全带功率，带内取 90%
            const double t0 = 0.3 + 0.65 * k;
            e.start = static_cast<std::uint64_t>(t0 * fs); e.stop = static_cast<std::uint64_t>((t0 + 0.55) * fs);
            vid.push_back(e);
        }
    }
    Tally a = run_class(500e3, 0.8 + 0.75 * 24, 101, cw, "cw_beacon");
    Tally b = run_class(500e3, 1.0 + 0.1 * 24 + 0.2, 102, tel, "telemetry_burst");
    Tally c = run_class(2.5e6, 0.3 + 0.65 * 8, 103, vid, "video_link");

    // 每个突发都要出一行 full（漏检或段被切碎会让 matched 少于突发数）
    CHECK(a.matched >= 22);
    CHECK(b.matched >= 22);
    CHECK(c.matched >= 8);
    const std::size_t matched = a.matched + b.matched + c.matched;
    const std::size_t correct = a.correct + b.correct + c.correct;
    REQUIRE(matched >= 40);
    const double acc = static_cast<double>(correct) / static_cast<double>(matched);
    MESSAGE("合计 " << matched << " 段，判对 " << correct << "，准确率 " << acc << "（判据 ≥ 0.9，原型阶段验证值）");
    CHECK(acc >= 0.9);
    // 定频突发不得判成跳频
    CHECK(b.labels["rc_hopping"] == 0);
    // 虚警行（突发之外的 full 行）应当极少
    CHECK(a.unmatched + b.unmatched + c.unmatched <= 3);
}
