// 频谱分析组件（P1-4a）：三方互证黄金基准、块长无关性、单音归一化、收尾降级。
#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/components/sources.h"
#include "cuav/components/spectrum.h"
#include "cuav/graph.h"
#include "cuav/random.h"

using namespace cuav;

namespace {

std::string golden_dir() { return std::string(CUAV_SOURCE_DIR) + "/tests/golden/"; }

Block block_from_iq(const std::vector<double>& iq, double fs) {
    Block b(iq.size() / 2);
    for (std::size_t i = 0; i < b.size(); ++i) {
        b.samples[i] = Complex(static_cast<float>(iq[2 * i]), static_cast<float>(iq[2 * i + 1]));
    }
    b.meta.sample_rate_Hz = fs;
    b.meta.center_frequency_Hz = 0.0;
    b.meta.start_sample = 0;
    return b;
}

std::vector<double> linear_power(const SpectrumFrame& f) {
    std::vector<double> p(f.psd_dB.size());
    for (std::size_t k = 0; k < p.size(); ++k) p[k] = std::pow(10.0, f.psd_dB[k] / 10.0);
    return p;
}

// 逐频点判据：相对 1e-9，或绝对 1e-12 × 峰值
void check_power(const std::vector<double>& got, const std::vector<double>& want, double rel, double abs_rel_peak,
                 const char* who) {
    REQUIRE(got.size() == want.size());
    double peak = 0.0;
    for (double v : want) peak = std::max(peak, v);
    double worst_rel = 0.0;
    std::size_t worst_k = 0;
    for (std::size_t k = 0; k < got.size(); ++k) {
        const double diff = std::fabs(got[k] - want[k]);
        if (diff <= abs_rel_peak * peak) continue;
        const double r = diff / std::max(std::fabs(want[k]), 1e-300);
        if (r > worst_rel) { worst_rel = r; worst_k = k; }
    }
    CHECK_MESSAGE(worst_rel <= rel, who << " 最大相对误差 " << worst_rel << " @ bin " << worst_k);
}

}  // namespace

TEST_CASE("黄金基准：Welch 功率谱与 Python 参考（及 MATLAB pwelch，若已生成）三方互证") {
    std::ifstream f((golden_dir() + "spectrum_welch.json").c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 spectrum_welch.json");
    nlohmann::json g;
    f >> g;
    const auto& p = g.at("params");
    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::size_t nfft = p.at("nfft").get<std::size_t>();
    const double overlap = p.at("overlap").get<double>();
    const std::size_t segments = p.at("segments").get<std::size_t>();
    const double tol_rel = g.at("tolerance").at("power_rel").get<double>();
    const double tol_abs = g.at("tolerance").at("power_abs_rel_to_peak").get<double>();
    const std::vector<double> iq = g.at("input").at("iq").get<std::vector<double>>();

    SpectrumAnalyzer sa;
    std::string err;
    REQUIRE_MESSAGE(sa.configure({{"nfft", double(nfft)}, {"overlap", overlap}, {"segments_per_frame", double(segments)}},
                                 {{"window", "hann"}}, err), err);
    Xoshiro256pp rng(1);
    REQUIRE(sa.init(rng, err));

    PortMap in, out;
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq = block_from_iq(iq, fs);
    in["in"] = d;
    REQUIRE(sa.process(in, out, err) == Step::Produced);
    REQUIRE(out.count("out") == 1);
    REQUIRE(out["out"].spectra.size() == 1);
    const SpectrumFrame& fr = out["out"].spectra[0];
    CHECK(fr.segments == segments);
    CHECK(fr.scale == "dBFS");
    CHECK(fr.meta.start_sample == 0);
    CHECK(fr.bin_width_Hz == doctest::Approx(fs / nfft));
    CHECK(fr.meta.state == State::Valid);

    const std::vector<double> got = linear_power(fr);
    const auto& py = g.at("expected").at("python");
    check_power(got, py.at("power").get<std::vector<double>>(), tol_rel, tol_abs, "Python");
    // 峰值频点一致（0.5 幅度、bin 32 的单音，−6.02 dBFS）
    std::size_t peak = 0;
    for (std::size_t k = 1; k < fr.psd_dB.size(); ++k) if (fr.psd_dB[k] > fr.psd_dB[peak]) peak = k;
    CHECK(peak == py.at("peak_bin").get<std::size_t>());
    CHECK(fr.psd_dB[peak] == doctest::Approx(py.at("peak_dB").get<double>()).epsilon(1e-9));

    std::ifstream mf((golden_dir() + "spectrum_welch.matlab.json").c_str());
    if (mf.good()) {
        nlohmann::json m;
        mf >> m;
        check_power(got, m.at("power").get<std::vector<double>>(), tol_rel, tol_abs, "MATLAB pwelch");
        CHECK(m.at("peak_bin").get<std::size_t>() == peak);
        MESSAGE("MATLAB 一方已核对：" << m.at("matlab_version").get<std::string>());
    } else {
        MESSAGE("未找到 spectrum_welch.matlab.json，本次只与 Python 参考对拍；跑 matlab/run_all.m 生成");
    }

    // 收尾：输入正好 8 段，不该有降级帧也不该丢样点
    PortMap fout;
    CHECK(sa.flush(fout, err) == Step::Finished);
    CHECK(fout.count("out") == 0);
    CHECK(sa.status().notes.empty());
}

TEST_CASE("块长无关：同一输入按 1 块与按 97 样点小块喂，帧逐位相同") {
    std::ifstream f((golden_dir() + "spectrum_welch.json").c_str());
    REQUIRE(f.good());
    nlohmann::json g;
    f >> g;
    const std::vector<double> iq = g.at("input").at("iq").get<std::vector<double>>();
    const double fs = g.at("params").at("sample_rate_Hz").get<double>();
    const std::map<std::string, double> params{{"nfft", 256}, {"overlap", 0.5}, {"segments_per_frame", 2}};
    std::string err;

    auto run = [&](std::size_t chunk) {
        SpectrumAnalyzer sa;
        REQUIRE(sa.configure(params, {{"window", "blackman"}}, err));
        Xoshiro256pp rng(1);
        REQUIRE(sa.init(rng, err));
        Block whole = block_from_iq(iq, fs);
        std::vector<SpectrumFrame> frames;
        for (std::size_t pos = 0; pos < whole.size(); pos += chunk) {
            Block b;
            b.meta = whole.meta;
            b.meta.start_sample = pos;
            const std::size_t n = std::min(chunk, whole.size() - pos);
            b.samples.assign(whole.samples.begin() + static_cast<long>(pos), whole.samples.begin() + static_cast<long>(pos + n));
            PortMap in, out;
            PortData d;
            d.type = PortType::IQStream; d.has_data = true; d.iq = b;
            in["in"] = d;
            Step st = sa.process(in, out, err);
            REQUIRE(st != Step::Error);
            if (out.count("out")) for (const auto& fr : out["out"].spectra) frames.push_back(fr);
        }
        PortMap fout;
        sa.flush(fout, err);
        if (fout.count("out")) for (const auto& fr : fout["out"].spectra) frames.push_back(fr);
        return frames;
    };
    const auto a = run(1152);
    const auto b = run(97);
    REQUIRE(a.size() == 4);   // 8 段 / 每帧 2 段
    REQUIRE(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i) {
        CHECK(a[i].meta.start_sample == b[i].meta.start_sample);
        CHECK(a[i].meta.start_sample == i * 2 * 128);
        REQUIRE(a[i].psd_dB.size() == b[i].psd_dB.size());
        for (std::size_t k = 0; k < a[i].psd_dB.size(); ++k) CHECK(a[i].psd_dB[k] == b[i].psd_dB[k]);
    }
}

TEST_CASE("单音归一化：频点中心的复单音峰值等于其功率，四种窗一致；收尾不满一帧标降级") {
    const double fs = 1.0e6;
    const std::size_t nfft = 256;
    const double f0 = 10.0 * fs / nfft;   // bin +10
    for (const char* win : {"hann", "hamming", "blackman", "rect"}) {
        Graph g;
        std::string err;
        std::unique_ptr<ToneSource> tone(new ToneSource());
        REQUIRE(tone->configure({{"sample_rate_Hz", fs}, {"total_samples", 256.0 * 3 + 100}, {"offset_Hz", f0},
                                 {"amplitude", 0.5}, {"block_samples", 300}}, {}, err));
        std::unique_ptr<SpectrumAnalyzer> sa(new SpectrumAnalyzer());
        REQUIRE(sa->configure({{"nfft", double(nfft)}, {"segments_per_frame", 4}}, {{"window", win}}, err));
        SpectrumAnalyzer* sap = sa.get();
        // 用一个小的汇聚器接住帧
        struct Sink : IComponent {
            std::vector<SpectrumFrame> got;
            std::string type_name() const override { return "SpecSink"; }
            std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::SpectrumFrame}}; }
            std::vector<PortSpec> outputs() const override { return {}; }
            bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
            bool init(IRandom&, std::string&) override { return true; }
            Step process(PortMap& in, PortMap&, std::string&) override {
                for (const auto& f : in["in"].spectra) got.push_back(f);
                return Step::Produced;
            }
            void reset() override {}
            ComponentStatus status() const override { return ComponentStatus(); }
        };
        std::unique_ptr<Sink> sink(new Sink());
        Sink* sp = sink.get();
        NodeId a = g.add(std::move(tone), "tone");
        NodeId b = g.add(std::move(sa), "sa");
        NodeId c = g.add(std::move(sink), "sink");
        REQUIRE(g.connect(a, "out", b, "in", err));
        REQUIRE(g.connect(b, "out", c, "in", err));
        Xoshiro256pp rng(3);
        RunReport rep = g.run(rng);
        REQUIRE_MESSAGE(rep.ok, rep.error);
        // 3 段满帧被凑成 1 帧（每帧 4 段，收尾时只有 3 段 → 降级），尾巴 100 样点丢弃
        REQUIRE(sp->got.size() == 1);
        const SpectrumFrame& fr = sp->got[0];
        CHECK(fr.segments == 3);
        CHECK(fr.meta.state == State::Degraded);
        CHECK(fr.window == std::string(win));
        const std::size_t bin = nfft / 2 + 10;
        // 输入样点是 float32，量化把峰值功率扰动 1e-7 量级；这里验的是归一化关系，不是三方对拍
        CHECK_MESSAGE(fr.psd_dB[bin] == doctest::Approx(10.0 * std::log10(0.25)).epsilon(1e-6), win);
        (void)sap;
        bool noted = false;
        for (const auto& n : rep.notes) if (n.find("100") != std::string::npos) noted = true;
        CHECK(noted);
    }
}

TEST_CASE("参数校验：非 2 的幂、重叠导致非整数步进、未知窗都被拒") {
    SpectrumAnalyzer sa;
    std::string err;
    CHECK(!sa.configure({{"nfft", 100}}, {}, err));
    CHECK(err.find("2 的幂") != std::string::npos);
    CHECK(!sa.configure({{"nfft", 256}, {"overlap", 0.3}}, {}, err));
    CHECK(err.find("正整数") != std::string::npos);
    CHECK(!sa.configure({{"nfft", 256}}, {{"window", "kaiser"}}, err));
    CHECK(err.find("kaiser") != std::string::npos);
    CHECK(sa.configure({{"nfft", 256}, {"overlap", 0.75}}, {{"window", "hamming"}}, err));
}
