// 观测点组件与运行观察者（B-3）：产品文件与索引、与 SpectrumAnalyzer 同源、包络、确定性、回调。
#include "doctest/doctest.h"

#include "tmpdir.h"

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

std::string temp_root() { return cuav_test::temp_root("cuav_tap_test"); }

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
    // 合成链两路都标 model：行值就是 dBm，索引带常数与来源（D-047）
    CHECK(idx["scale"] == "dBm");
    CHECK(idx["calibration"]["source"] == "model");
    CHECK(idx["calibration"]["offset_dB"].get<double>() == 0.0);
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
    CHECK(eidx["scale"] == "sqrt_mW");                   // 已标定：包络列是 |x|，单位 sqrt(mW)（D-047）
    CHECK(eidx["calibration"]["source"] == "model");
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
    // 只要 iq 也是一种产品（Q-1，D-087）
    CHECK(t.configure({{"spectrum", 0}, {"envelope", 0}, {"iq", 1}}, {{"op_id", "s4"}, {"out_dir", "x"}}, err));
}

namespace {

PortData iq_block(std::uint64_t start, std::size_t n, double fs, float base) {
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq = Block(n);
    d.iq.meta.sample_rate_Hz = fs;
    d.iq.meta.center_frequency_Hz = 2.44e9;
    d.iq.meta.start_sample = start;
    d.iq.meta.calibration.calibrated = true;
    d.iq.meta.calibration.source = "model";
    for (std::size_t i = 0; i < n; ++i) {
        d.iq.samples[i] = Complex(base + static_cast<float>(i) * 1e-3f, -base + static_cast<float>(i) * 7e-4f);
    }
    return d;
}

}  // namespace

TEST_CASE("观测点 iq 产品：iq.cf32 与输入逐位相同、索引字段、谱与包络照旧（Q-1，D-087）") {
    const std::string dir = temp_root() + "/run_iq";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    ObservationTap tap;
    REQUIRE_MESSAGE(tap.configure({{"nfft", 256}, {"bucket_samples", 128}, {"iq", 1}},
                                  {{"op_id", "s3"}, {"out_dir", dir}}, err), err);
    Xoshiro256pp rng(3);
    REQUIRE_MESSAGE(tap.init(rng, err), err);
    std::vector<Complex> want;
    PortMap out;
    for (int b = 0; b < 3; ++b) {
        PortMap in;
        in["in"] = iq_block(1000 + 300u * static_cast<unsigned>(b), 300, 2e6, 0.01f * static_cast<float>(b + 1));
        for (const auto& c : in["in"].iq.samples) want.push_back(c);
        REQUIRE_MESSAGE(tap.process(in, out, err) == Step::Produced, err);
    }
    REQUIRE_MESSAGE(tap.flush(out, err) == Step::Finished, err);
    CHECK(tap.iq_samples() == 900u);

    const std::string op = dir + "/s3";
    auto raw = read_f32(op + "/iq.cf32");
    REQUIRE(raw.size() == 2u * want.size());
    for (std::size_t i = 0; i < want.size(); ++i) {       // 交织 I0 Q0 I1 Q1…，逐位相同
        CHECK(raw[2 * i] == want[i].real());
        CHECK(raw[2 * i + 1] == want[i].imag());
    }
    auto idx = read_json(op + "/iq.index.json");
    CHECK(idx["schema_version"] == "cuav-product/1");
    CHECK(idx["kind"] == "iq");
    CHECK(idx["dtype"] == "cf32_le");
    CHECK(idx["samples"] == 900);
    CHECK(idx["start_sample"] == 1000);
    CHECK(idx["t0_s"].get<double>() == doctest::Approx(1000.0 / 2e6));
    CHECK(idx["sample_rate_Hz"].get<double>() == 2e6);
    CHECK(idx["center_Hz"].get<double>() == 2.44e9);
    CHECK(idx["scale"] == "sqrt_mW");
    CHECK(idx["calibration"]["source"] == "model");
    CHECK(!idx.contains("rows"));                         // iq 不是定长行产品
    CHECK(idx["notes"].empty());                          // 谱 / 包络的收尾备注不串到 iq 上
    // 谱与包络照写：两份索引都在
    CHECK(read_json(op + "/spectrum.index.json")["kind"] == "spectrum");
    CHECK(read_json(op + "/envelope.index.json")["kind"] == "envelope");
}

TEST_CASE("观测点 iq 产品：块间有缺口即报错，不写出一个看起来连续的文件（铁律 3）") {
    const std::string dir = temp_root() + "/run_iq_gap";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    ObservationTap tap;
    REQUIRE(tap.configure({{"spectrum", 0}, {"envelope", 0}, {"iq", 1}}, {{"op_id", "s3"}, {"out_dir", dir}}, err));
    Xoshiro256pp rng(3);
    REQUIRE(tap.init(rng, err));
    PortMap in, out;
    in["in"] = iq_block(0, 100, 1e6, 0.1f);
    REQUIRE(tap.process(in, out, err) == Step::Produced);
    in["in"] = iq_block(150, 100, 1e6, 0.1f);           // 期望 100，收到 150
    CHECK(tap.process(in, out, err) == Step::Error);
    CHECK(err.find("连续") != std::string::npos);
    // 没有正常收尾就没有 iq 索引：导出工具据此拒绝
    std::ifstream f((dir + "/s3/iq.index.json").c_str());
    CHECK(!f.good());
}

TEST_CASE("观测点缺省不写 iq：既有产品目录里没有 iq.cf32") {
    const std::string dir = temp_root() + "/run_noiq";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    Run r = run_chain(dir, 11, nullptr);
    REQUIRE(r.rep.ok);
    std::ifstream f((dir + "/s4/iq.cf32").c_str());
    CHECK(!f.good());
}

TEST_CASE("观测点：写完第一行就刷一次索引（B-7 读端靠它拿到几何参数，D-046）") {
    const std::string dir = temp_root() + "/run_first";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    const std::string op = dir + "/s4";
    std::remove((op + "/spectrum.index.json").c_str());
    std::remove((op + "/envelope.index.json").c_str());

    const std::size_t nfft = 256;
    const double fs = 1e6;
    ObservationTap tap;
    // overlap 0：一段就是一帧，喂 nfft 个样点恰好产出第一行谱；桶长 128 让包络也在同一块里出第一行
    REQUIRE_MESSAGE(tap.configure({{"nfft", double(nfft)}, {"overlap", 0.0}, {"bucket_samples", 128}},
                                  {{"op_id", "s4"}, {"out_dir", dir}}, err), err);
    Xoshiro256pp rng(7);
    REQUIRE_MESSAGE(tap.init(rng, err), err);

    PortMap in, out;
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq = Block(nfft);
    d.iq.meta.sample_rate_Hz = fs;
    d.iq.meta.center_frequency_Hz = 0.0;
    d.iq.meta.start_sample = 0;
    for (std::size_t i = 0; i < nfft; ++i) d.iq.samples[i] = Complex(0.25, -0.125);
    in["in"] = d;
    REQUIRE(tap.process(in, out, err) == Step::Produced);

    // 还没 flush，但两份索引都应已存在，且 rows == 1：读端据此就能算出频率轴与时间轴
    CHECK(tap.spectrum_rows() == 1u);
    CHECK(tap.envelope_rows() == 2u);   // 256 样点 / 128 = 2 个满桶
    auto sidx = read_json(op + "/spectrum.index.json");
    CHECK(sidx["rows"] == 1);
    CHECK(sidx["nfft"] == 256);
    CHECK(sidx["row_len"] == 256);
    CHECK(sidx["sample_rate_Hz"] == fs);
    CHECK(sidx["bin_width_Hz"] == fs / 256.0);
    auto eidx = read_json(op + "/envelope.index.json");
    CHECK(eidx["bucket_samples"] == 128);
    // 索引在第 1、64、128… 行刷新，所以这里记的是 1 行而文件已有 2 行——**索引落后于文件是常态**，
    // 视窗抽取端点因此一律按文件长度定行数（docs/display-products.md §1.1、§2；B-7）
    CHECK(eidx["rows"] == 1);
    CHECK(read_f32(op + "/spectrum.f32").size() == 256u);
    CHECK(read_f32(op + "/envelope.f32").size() == 6u);
}
