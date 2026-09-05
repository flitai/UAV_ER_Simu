// 观测点组件与运行观察者（B-3）：产品文件与索引、与 SpectrumAnalyzer 同源、包络、确定性、回调。
#include "doctest/doctest.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/components/processing.h"
#include "cuav/components/sources.h"
#include "cuav/components/spectrum.h"
#include "cuav/components/tap.h"
#include "cuav/graph.h"
#include "cuav/platform.h"
#include "cuav/random.h"

using namespace cuav;

namespace {

std::string temp_root() {
    const char* t = std::getenv("TMPDIR");
    std::string d = t ? t : "/tmp/";
    if (!d.empty() && d[d.size() - 1] != '/') d += '/';
    return d + "cuav_tap_test";
}

std::vector<unsigned char> read_bytes(const std::string& p) {
    std::ifstream f(p.c_str(), std::ios::binary);
    return std::vector<unsigned char>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

std::vector<float> read_f32(const std::string& p) {
    auto b = read_bytes(p);
    std::vector<float> out(b.size() / 4);
    if (!out.empty()) std::memcpy(out.data(), b.data(), out.size() * 4);
    return out;
}

nlohmann::json read_json(const std::string& p) {
    std::ifstream f(p.c_str());
    REQUIRE_MESSAGE(f.good(), "打不开 " << p);
    nlohmann::json j;
    f >> j;
    return j;
}

struct CountingObserver : IRunObserver {
    std::uint64_t progress = 0, spec_rows = 0, env_rows = 0;
    double last_spec_t = -1.0;
    bool monotone = true;
    void on_progress(const ProgressInfo& p) override { ++progress; (void)p; }
    void on_product_row(const std::string&, const std::string& kind, std::uint64_t, const float*, std::size_t len, double t_s) override {
        if (kind == "spectrum") { ++spec_rows; CHECK(len == 256); if (t_s <= last_spec_t) monotone = false; last_spec_t = t_s; }
        else { ++env_rows; CHECK(len == 3); }
    }
};

// 单音 + 噪声 → 观测点；同一条 IQ 也接一个 SpectrumAnalyzer 作同源对照
struct Run {
    RunReport rep;
    std::uint64_t tap_spec_rows = 0, tap_env_rows = 0;
    std::vector<SpectrumFrame> analyzer_frames;
};

Run run_chain(const std::string& out_dir, std::uint64_t seed, IRunObserver* obs) {
    Graph g;
    std::string err;
    const double fs = 1e6;
    const double total = 256.0 * 40 + 100;   // 40 段满 + 100 尾样点
    std::unique_ptr<ToneSource> tone(new ToneSource());
    REQUIRE(tone->configure({{"sample_rate_Hz", fs}, {"total_samples", total}, {"offset_Hz", 3e4}, {"amplitude", 0.3},
                             {"block_samples", 1000}}, {}, err));
    std::unique_ptr<NoiseSource> noise(new NoiseSource());
    REQUIRE(noise->configure({{"sample_rate_Hz", fs}, {"total_samples", total}, {"power", 0.01}, {"block_samples", 1000}}, {}, err));
    std::unique_ptr<AddMixer> mix(new AddMixer());
    REQUIRE(mix->configure({}, {}, err));
    std::unique_ptr<ObservationTap> tap(new ObservationTap());
    REQUIRE_MESSAGE(tap->configure({{"nfft", 256}, {"bucket_samples", 500}}, {{"op_id", "s4"}, {"out_dir", out_dir}}, err), err);
    std::unique_ptr<SpectrumAnalyzer> sa(new SpectrumAnalyzer());
    REQUIRE(sa->configure({{"nfft", 256}}, {}, err));
    struct Sink : IComponent {
        std::vector<SpectrumFrame> got;
        std::string type_name() const override { return "SpecSink"; }
        std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::SpectrumFrame}}; }
        std::vector<PortSpec> outputs() const override { return {}; }
        bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
        bool init(IRandom&, std::string&) override { return true; }
        Step process(PortMap& in, PortMap&, std::string&) override { for (const auto& f : in["in"].spectra) got.push_back(f); return Step::Produced; }
        void reset() override {}
        ComponentStatus status() const override { return ComponentStatus(); }
    };
    std::unique_ptr<Sink> sink(new Sink());
    ObservationTap* tp = tap.get();
    Sink* sp = sink.get();
    NodeId a = g.add(std::move(tone), "tone");
    NodeId b = g.add(std::move(noise), "noise");
    NodeId m = g.add(std::move(mix), "mix");
    NodeId t = g.add(std::move(tap), "tap");
    NodeId s = g.add(std::move(sa), "sa");
    NodeId k = g.add(std::move(sink), "sink");
    REQUIRE(g.connect(a, "out", m, "a", err));
    REQUIRE(g.connect(b, "out", m, "b", err));
    REQUIRE(g.connect(m, "out", t, "in", err));    // 观测点并联在 mix.out 上
    REQUIRE(g.connect(m, "out", s, "in", err));
    REQUIRE(g.connect(s, "out", k, "in", err));
    REQUIRE(g.validate(err));
    Xoshiro256pp rng(seed);
    Run r;
    r.rep = obs ? g.run(rng, *obs) : g.run(rng);
    r.tap_spec_rows = tp->spectrum_rows();
    r.tap_env_rows = tp->envelope_rows();
    r.analyzer_frames = sp->got;
    return r;
}

}  // namespace

TEST_CASE("观测点：产品文件、索引字段、与 SpectrumAnalyzer 同源、包络、观察者回调") {
    const std::string dir = temp_root() + "/run_a";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    CountingObserver obs;
    Run r = run_chain(dir, 20260905, &obs);
    REQUIRE_MESSAGE(r.rep.ok, r.rep.error);

    // 40 段 + 尾巴 100 样点 → 40 行谱；包络 10340 样点 / 500 → 20 满桶 + 1 末桶 = 21 行
    CHECK(r.tap_spec_rows == 40);
    CHECK(r.tap_env_rows == 21);
    CHECK(obs.spec_rows == 40);
    CHECK(obs.env_rows == 21);
    CHECK(obs.monotone);
    CHECK(obs.progress > 0);

    const std::string op = dir + "/s4";
    auto spec = read_f32(op + "/spectrum.f32");
    REQUIRE(spec.size() == 40u * 256u);
    auto idx = read_json(op + "/spectrum.index.json");
    CHECK(idx["schema_version"] == "cuav-product/1");
    CHECK(idx["kind"] == "spectrum");
    CHECK(idx["rows"] == 40);
    CHECK(idx["row_len"] == 256);
    CHECK(idx["byte_order"] == "little");
    CHECK(idx["scale"] == "dBFS");
    CHECK(idx["window"] == "hann");
    CHECK(idx["sample_rate_Hz"].get<double>() == 1e6);
    CHECK(idx["bin_width_Hz"].get<double>() == doctest::Approx(1e6 / 256));
    CHECK(idx["frame_hop_samples"] == 256);
    CHECK(idx["start_sample"] == 0);
    CHECK(idx["state"] == "valid");
    CHECK(idx["trace"]["model_id"] == "AddMixer");       // 被观测信号的溯源
    CHECK(idx["producer"]["component"] == "ObservationTap");

    // 同源：观测点写的每行 == SpectrumAnalyzer 同参数输出转 float32，逐位相同
    REQUIRE(r.analyzer_frames.size() == 40);
    for (std::size_t i = 0; i < 40; ++i) {
        for (std::size_t k = 0; k < 256; ++k) {
            CHECK(spec[i * 256 + k] == static_cast<float>(r.analyzer_frames[i].psd_dB[k]));
        }
    }
    // 单音 +30 kHz → bin 128 + 30e3/(1e6/256) = 128 + 7.68：峰值在 bin 135 或 136
    std::size_t peak = 0;
    for (std::size_t k = 1; k < 256; ++k) if (spec[k] > spec[peak]) peak = k;
    CHECK((peak == 135 || peak == 136));

    auto env = read_f32(op + "/envelope.f32");
    REQUIRE(env.size() == 21u * 3u);
    auto eidx = read_json(op + "/envelope.index.json");
    CHECK(eidx["kind"] == "envelope");
    CHECK(eidx["rows"] == 21);
    CHECK(eidx["row_len"] == 3);
    CHECK(eidx["bucket_samples"] == 500);
    CHECK(eidx["last_bucket_samples"] == 340);
    CHECK(eidx["state"] == "valid");                     // 末桶不满是流结束的自然结果：记备注，不降级
    CHECK(eidx["state_reasons"].empty());
    bool noted = false;
    for (const auto& s : eidx["notes"]) if (s.get<std::string>().find("末桶只有 340/500") != std::string::npos) noted = true;
    CHECK(noted);
    bool tail = false;
    for (const auto& s : idx["notes"]) if (s.get<std::string>().find("100 个样点") != std::string::npos) tail = true;
    CHECK(tail);                                         // 谱产品：尾巴 100 样点不满一段，备注里写明
    for (std::size_t i = 0; i < 21; ++i) {
        CHECK(env[3 * i] <= env[3 * i + 2]);     // min ≤ rms
        CHECK(env[3 * i + 2] <= env[3 * i + 1]); // rms ≤ max
    }
    // 单音幅度 0.3 加功率 0.01 的噪声：rms 约 sqrt(0.09 + 0.01) = 0.316
    CHECK(env[2] == doctest::Approx(0.316).epsilon(0.05));
}

TEST_CASE("观测点：同种子两次运行，产品文件逐字节相同") {
    std::string err;
    const std::string d1 = temp_root() + "/run_b1", d2 = temp_root() + "/run_b2";
    REQUIRE(platform::make_dirs(d1, err));
    REQUIRE(platform::make_dirs(d2, err));
    Run r1 = run_chain(d1, 7, nullptr);
    Run r2 = run_chain(d2, 7, nullptr);
    REQUIRE(r1.rep.ok);
    REQUIRE(r2.rep.ok);
    CHECK(read_bytes(d1 + "/s4/spectrum.f32") == read_bytes(d2 + "/s4/spectrum.f32"));
    CHECK(read_bytes(d1 + "/s4/envelope.f32") == read_bytes(d2 + "/s4/envelope.f32"));
    CHECK(read_json(d1 + "/s4/spectrum.index.json") == read_json(d2 + "/s4/spectrum.index.json"));
    // 换种子，噪声不同，文件必不同
    Run r3 = run_chain(temp_root() + "/run_b3", 8, nullptr);
    REQUIRE(r3.rep.ok);
    CHECK(read_bytes(d1 + "/s4/spectrum.f32") != read_bytes(temp_root() + "/run_b3/s4/spectrum.f32"));
}

TEST_CASE("观测点参数：缺 op_id、op_id 含非法字符、两种产品都关掉在 configure 被拒；缺 out_dir 到 init 才拒") {
    ObservationTap t;
    std::string err;
    CHECK(!t.configure({}, {{"out_dir", "x"}}, err));
    CHECK(err.find("op_id") != std::string::npos);
    // 缺 out_dir：configure 放行（只校验模式要能构造观测点，D-040），init 开文件前拒并点名
    REQUIRE(t.configure({}, {{"op_id", "s4"}}, err));
    Xoshiro256pp rng(1);
    CHECK(!t.init(rng, err));
    CHECK(err.find("out_dir") != std::string::npos);
    CHECK(!t.configure({}, {{"op_id", "S4/../x"}, {"out_dir", "x"}}, err));
    CHECK(err.find("op_id") != std::string::npos);
    CHECK(!t.configure({{"spectrum", 0}, {"envelope", 0}}, {{"op_id", "s4"}, {"out_dir", "x"}}, err));
    CHECK(err.find("至少") != std::string::npos);
}
