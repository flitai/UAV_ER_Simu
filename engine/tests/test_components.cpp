// 组件与端到端链路的单元测试。
#include "doctest/doctest.h"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <cstdlib>
#include <string>
#include <vector>

#include "cuav/graph.h"
#include "cuav/components/processing.h"
#include "cuav/components/recognition.h"
#include "cuav/platform.h"
#include "cuav/components/receiver.h"
#include "cuav/components/sources.h"
#include "cuav/observer.h"

using namespace cuav;

namespace {

std::string temp_dir() {
    const char* t = std::getenv("TMPDIR");
    std::string d = t ? t : "/tmp/";
    if (!d.empty() && d[d.size() - 1] != '/') d += '/';
    return d;
}

// 写一份最小但合规的产物：.iq 加旁挂清单（docs/iq-format.md 第 3、4 节）
void write_fixture(const std::string& stem, const std::vector<std::int16_t>& interleaved,
                   double fs, double fc, const std::string& calibration_json = "") {
    const std::string iq = temp_dir() + stem + ".iq";
    std::ofstream f(iq.c_str(), std::ios::binary);
    f.write(reinterpret_cast<const char*>(interleaved.data()),
            static_cast<std::streamsize>(interleaved.size() * 2));
    f.close();
    const std::string man = temp_dir() + stem + ".manifest.json";
    std::ofstream m(man.c_str());
    m << "{\n"
      << "  \"manifest_version\": \"1.0\",\n"
      << "  \"observation_point\": \"S4\",\n"
      << "  \"sampling\": {\"sample_format\": \"ci16_le\", \"byte_order\": \"little\",\n"
      << "    \"iq_layout\": \"interleaved_IQ\", \"internal_format\": \"cf32\",\n"
      << "    \"sample_rate_Hz\": " << fs << ", \"sample_count\": "
      << interleaved.size() / 2 << "},\n"
      << "  \"frequency\": {\"center_frequency_Hz\": " << fc
      << ", \"effective_bandwidth_Hz\": " << fs << "},\n"
      << "  \"power\": {\"full_scale\": 32768, \"scale\": null"
      << (calibration_json.empty() ? "" : ", \"calibration\": " + calibration_json) << "},\n"
      << "  \"quality\": {\"status\": \"degraded\", \"reasons\": [\"测试夹具\"]},\n"
      << "  \"segments\": []\n"
      << "}\n";
}

}  // namespace

TEST_CASE("单音源：频偏落在预期的频点上，越界要被拒") {
    ToneSource s;
    std::string err;
    std::map<std::string, double> bad{{"sample_rate_Hz", 1e6},
                                      {"total_samples", 1024.0},
                                      {"offset_Hz", 600000.0}};   // 超过 Fs/2
    CHECK_FALSE(s.configure(bad, {}, err));
    CHECK(err.find("奈奎斯特") != std::string::npos);

    std::map<std::string, double> miss{{"sample_rate_Hz", 1e6}};
    CHECK_FALSE(s.configure(miss, {}, err));
    CHECK(err.find("total_samples") != std::string::npos);
}

TEST_CASE("噪声源加能量检测：合成白噪声下的虚警率应当接近目标值") {
    Graph g;
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t frames = 20000;

    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::string err;
    std::map<std::string, double> np{{"sample_rate_Hz", fs},
                                     {"total_samples", static_cast<double>(frames * nfft)},
                                     {"power", 1.0}, {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId src = g.add(std::move(n), "noise");

    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    std::map<std::string, double> dp{{"nfft", static_cast<double>(nfft)},
                                     {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                                     {"pfa", 1e-2}, {"noise_frames", 4000.0}};
    REQUIRE(d->configure(dp, {}, err));
    EnergyDetector* det = d.get();
    NodeId dn = g.add(std::move(d), "det");

    std::unique_ptr<DetectionSink> k(new DetectionSink());
    DetectionSink* sink = k.get();
    NodeId kn = g.add(std::move(k), "sink");

    REQUIRE(g.connect(src, "out", dn, "in", err));
    REQUIRE(g.connect(dn, "out", kn, "in", err));

    Xoshiro256pp rng(20260904);
    RunReport rep = g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    CHECK(det->band_bins() == 51);          // 256 点、1 MHz 采样率下 ±100 kHz 内的频点数
    CHECK(sink->frames() == frames);
    // 二项分布 4 sigma 加两成余量
    const double target = 1e-2;
    const double tol = 4.0 * std::sqrt(target * (1 - target) / frames) + 0.2 * target;
    CHECK(std::fabs(sink->hit_rate() - target) < tol);
}

TEST_CASE("连续满带信号会被中位数噪声估计吸收——这是检测器的真实局限，不是缺陷") {
    // 噪声估计取逐频点的帧维中位数。若信号从第一帧起就一直在，它就成了「底噪」的一部分，
    // 检出率反而趋近于零。工程含义：估底噪必须有一段无信号的窗口，或者用带外参考频段。
    // P1-4 做恒虚警率处理时要正面解决这件事，这里先把行为钉住。
    Graph g;
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t total = 256 * 3000;
    std::string err;

    std::unique_ptr<ToneSource> t(new ToneSource());
    std::map<std::string, double> tp{{"sample_rate_Hz", fs},
                                     {"total_samples", static_cast<double>(total)},
                                     {"offset_Hz", 50000.0}, {"amplitude", 0.5},
                                     {"block_samples", 32768.0}};
    REQUIRE(t->configure(tp, {}, err));
    NodeId tone = g.add(std::move(t), "tone");

    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::map<std::string, double> np{{"sample_rate_Hz", fs},
                                     {"total_samples", static_cast<double>(total)},
                                     {"power", 1.0}, {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId noise = g.add(std::move(n), "noise");

    std::unique_ptr<AddMixer> m(new AddMixer());
    REQUIRE(m->configure({}, {}, err));
    NodeId mix = g.add(std::move(m), "mix");

    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    std::map<std::string, double> dp{{"nfft", static_cast<double>(nfft)},
                                     {"band_lo_Hz", 40000.0}, {"band_hi_Hz", 60000.0},
                                     {"pfa", 1e-3}, {"noise_frames", 1000.0}};
    REQUIRE(d->configure(dp, {}, err));
    NodeId dn = g.add(std::move(d), "det");

    std::unique_ptr<DetectionSink> k(new DetectionSink());
    DetectionSink* sink = k.get();
    NodeId kn = g.add(std::move(k), "sink");

    REQUIRE(g.connect(tone, "out", mix, "a", err));
    REQUIRE(g.connect(noise, "out", mix, "b", err));
    REQUIRE(g.connect(mix, "out", dn, "in", err));
    REQUIRE(g.connect(dn, "out", kn, "in", err));

    Xoshiro256pp rng(11);
    RunReport rep = g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    CHECK(sink->hit_rate() < 0.05);
}

TEST_CASE("单音在噪声估计窗口之后出现：必然检出") {
    Graph g;
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t total = 256 * 4000;
    std::string err;

    std::unique_ptr<ToneSource> t(new ToneSource());
    // 单音从第 1000 帧之后才开，正好让检测器的 1000 帧探针窗口是干净噪声
    const std::uint64_t on_at = 1000 * nfft;
    std::map<std::string, double> tp{{"sample_rate_Hz", fs},
                                     {"total_samples", static_cast<double>(total)},
                                     {"offset_Hz", 50000.0}, {"amplitude", 0.5},
                                     {"start_sample", static_cast<double>(on_at)},
                                     {"block_samples", 32768.0}};
    REQUIRE(t->configure(tp, {}, err));
    NodeId tone = g.add(std::move(t), "tone");

    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::map<std::string, double> np{{"sample_rate_Hz", fs},
                                     {"total_samples", static_cast<double>(total)},
                                     {"power", 1.0}, {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId noise = g.add(std::move(n), "noise");

    std::unique_ptr<AddMixer> m(new AddMixer());
    REQUIRE(m->configure({}, {}, err));
    NodeId mix = g.add(std::move(m), "mix");

    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    std::map<std::string, double> dp{{"nfft", static_cast<double>(nfft)},
                                     {"band_lo_Hz", 40000.0}, {"band_hi_Hz", 60000.0},
                                     {"pfa", 1e-3}, {"noise_frames", 1000.0}};
    REQUIRE(d->configure(dp, {}, err));
    NodeId dn = g.add(std::move(d), "det");

    std::unique_ptr<DetectionSink> k(new DetectionSink());
    DetectionSink* sink = k.get();
    NodeId kn = g.add(std::move(k), "sink");

    REQUIRE(g.connect(tone, "out", mix, "a", err));
    REQUIRE(g.connect(noise, "out", mix, "b", err));
    REQUIRE(g.connect(mix, "out", dn, "in", err));
    REQUIRE(g.connect(dn, "out", kn, "in", err));

    Xoshiro256pp rng(11);
    RunReport rep = g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    // 前 1000 帧无信号、其余有信号：命中率应当接近有信号帧的占比。
    // 从常量推导而不是写死数字，免得改了总长忘了改期望值。
    const double total_frames = static_cast<double>(total / nfft);
    const double on_ratio = 1.0 - 1000.0 / total_frames;
    CHECK(sink->hit_rate() == doctest::Approx(on_ratio).epsilon(0.02));
    CHECK(rep.state == State::Valid);
}

TEST_CASE("文件回放源：读得出样点，并把源的质量状态传下去") {
    const double fs = 2e6, fc = 2.44e9;
    std::vector<std::int16_t> data;
    for (int i = 0; i < 4096; ++i) {
        data.push_back(static_cast<std::int16_t>((i % 100) - 50));
        data.push_back(static_cast<std::int16_t>((i % 7) - 3));
    }
    write_fixture("cuav_engine_fixture", data, fs, fc);

    FileReplaySource src;
    std::string err;
    std::map<std::string, std::string> tp{
        {"manifest_path", temp_dir() + "cuav_engine_fixture.manifest.json"}};
    std::map<std::string, double> p{{"block_samples", 512.0}};
    REQUIRE_MESSAGE(src.configure(p, tp, err), err);
    Xoshiro256pp rng(1);
    REQUIRE(src.init(rng, err));

    PortMap in, out;
    Step st = src.process(in, out, err);
    REQUIRE(st == Step::Produced);
    const Block& b = out["out"].iq;
    CHECK(b.size() == 512u);
    CHECK(b.meta.sample_rate_Hz == doctest::Approx(fs));
    CHECK(b.meta.center_frequency_Hz == doctest::Approx(fc));
    CHECK(b.meta.time_basis == TimeBasis::FileAcquisition);
    // 量化码除满量程（D-047）：此前量化码直接进流，谱值比 dBFS 高 90.31 dB，这里把换算锁死
    CHECK(b.samples[0].real() == doctest::Approx(-50.0f / 32768.0f));
    CHECK(b.samples[1].real() == doctest::Approx(-49.0f / 32768.0f));
    // 清单里质量是 degraded，且量化码未标定：两条理由都要传下来（铁律 15）
    CHECK(b.meta.state == State::Degraded);
    CHECK(b.meta.state_reasons.size() >= 2u);
    CHECK_FALSE(b.meta.calibration.calibrated);
    CHECK(b.meta.calibration.source.empty());
}

TEST_CASE("文件回放源：清单带 power.calibration 时按常数换算到 mW，块元数据标已标定（D-047）") {
    const double fs = 2e6, fc = 2.44e9;
    std::vector<std::int16_t> data;
    for (int i = 0; i < 1024; ++i) {
        data.push_back(static_cast<std::int16_t>(i - 50));
        data.push_back(static_cast<std::int16_t>(7));
    }
    write_fixture("cuav_engine_fixture_cal", data, fs, fc,
                  "{\"full_scale_dBm\": -40.0, \"source\": \"paper\", \"note\": \"测试常数\"}");

    FileReplaySource src;
    std::string err;
    std::map<std::string, std::string> tp{
        {"manifest_path", temp_dir() + "cuav_engine_fixture_cal.manifest.json"}};
    std::map<std::string, double> p{{"block_samples", 256.0}};
    REQUIRE_MESSAGE(src.configure(p, tp, err), err);
    Xoshiro256pp rng(1);
    REQUIRE(src.init(rng, err));
    PortMap in, out;
    REQUIRE(src.process(in, out, err) == Step::Produced);
    const Block& b = out["out"].iq;
    // -40 dBm 满量程：k = 10^(-40/20) / 32768 = 0.01 / 32768
    const float k = 0.01f / 32768.0f;
    CHECK(b.samples[0].real() == doctest::Approx(-50.0f * k));
    CHECK(b.samples[0].imag() == doctest::Approx(7.0f * k));
    CHECK(b.meta.calibration.calibrated);
    CHECK(b.meta.calibration.offset_dB == doctest::Approx(-40.0));
    CHECK(b.meta.calibration.source == "paper");
    CHECK(b.meta.calibration.note == "测试常数");
    // 只剩清单质量 degraded 这一条理由，「未标定」不再出现
    CHECK(b.meta.state == State::Degraded);
    REQUIRE(b.meta.state_reasons.size() == 1u);
    CHECK(b.meta.state_reasons[0].find("未标定") == std::string::npos);

    // 常数格式不对要拒，不许猜
    write_fixture("cuav_engine_fixture_badcal", data, fs, fc, "{\"source\": \"paper\"}");
    FileReplaySource bad;
    std::map<std::string, std::string> tb{
        {"manifest_path", temp_dir() + "cuav_engine_fixture_badcal.manifest.json"}};
    CHECK_FALSE(bad.configure(p, tb, err));
    CHECK(err.find("full_scale_dBm") != std::string::npos);
}

TEST_CASE("合成源按 dBm 给功率：level_dBm / power_dBm 与线性参数互斥，块元数据标 model（D-047）") {
    ToneSource t;
    std::string err;
    std::map<std::string, double> both{{"sample_rate_Hz", 1e6}, {"total_samples", 16.0},
                                       {"amplitude", 0.5}, {"level_dBm", -70.0}};
    CHECK_FALSE(t.configure(both, {}, err));
    CHECK(err.find("只能给一个") != std::string::npos);

    std::map<std::string, double> lv{{"sample_rate_Hz", 1e6}, {"total_samples", 16.0}, {"level_dBm", -70.0}};
    REQUIRE_MESSAGE(t.configure(lv, {}, err), err);
    Xoshiro256pp rng(1);
    REQUIRE(t.init(rng, err));
    PortMap in, out;
    REQUIRE(t.process(in, out, err) == Step::Produced);
    const Block& b = out["out"].iq;
    // -70 dBm = 1e-7 mW → |x| = sqrt(1e-7) = 3.1623e-4
    CHECK(std::abs(b.samples[3]) == doctest::Approx(3.16227766e-4).epsilon(1e-6));
    CHECK(b.meta.calibration.calibrated);
    CHECK(b.meta.calibration.source == "model");
    CHECK(b.meta.calibration.offset_dB == 0.0);

    NoiseSource n;
    std::map<std::string, double> nboth{{"sample_rate_Hz", 1e6}, {"total_samples", 16.0},
                                        {"power", 1.0}, {"power_dBm", -100.0}};
    CHECK_FALSE(n.configure(nboth, {}, err));
    CHECK(err.find("只能给一个") != std::string::npos);
    std::map<std::string, double> np{{"sample_rate_Hz", 1e6}, {"total_samples", 200000.0}, {"power_dBm", -100.0},
                                     {"block_samples", 200000.0}};
    REQUIRE(n.configure(np, {}, err));
    REQUIRE(n.init(rng, err));
    PortMap nin, nout;
    REQUIRE(n.process(nin, nout, err) == Step::Produced);
    const Block& nb = nout["out"].iq;
    double acc = 0.0;
    for (const auto& x : nb.samples) acc += std::norm(x);
    // 每样点功率 1e-10 mW；20 万样点的均值相对误差约 1/sqrt(2e5)
    CHECK(10.0 * std::log10(acc / static_cast<double>(nb.size())) == doctest::Approx(-100.0).epsilon(0.02));
    CHECK(nb.meta.calibration.source == "model");
}

TEST_CASE("加法混合器合并功率标定：两路都标定取较弱来源，任一路未标定则整体未标定（D-047）") {
    AddMixer m;
    std::string err;
    REQUIRE(m.configure({}, {}, err));
    Xoshiro256pp rng(1);
    REQUIRE(m.init(rng, err));
    PortMap in, out;
    PortData a, b;
    a.has_data = b.has_data = true;
    a.iq.samples.resize(4); b.iq.samples.resize(4);
    a.iq.meta.sample_rate_Hz = b.iq.meta.sample_rate_Hz = 1e6;
    a.iq.meta.calibration.calibrated = true; a.iq.meta.calibration.source = "model"; a.iq.meta.calibration.offset_dB = 0.0;
    b.iq.meta.calibration.calibrated = true; b.iq.meta.calibration.source = "paper"; b.iq.meta.calibration.offset_dB = -45.0;
    in["a"] = a; in["b"] = b;
    REQUIRE(m.process(in, out, err) == Step::Produced);
    CHECK(out["out"].iq.meta.calibration.calibrated);
    CHECK(out["out"].iq.meta.calibration.source == "model");     // model 弱于 paper
    CHECK(out["out"].iq.meta.calibration.offset_dB == 0.0);

    b.iq.meta.calibration.source = "assumed";
    in["b"] = b;
    REQUIRE(m.process(in, out, err) == Step::Produced);
    CHECK(out["out"].iq.meta.calibration.source == "assumed");
    CHECK(out["out"].iq.meta.calibration.offset_dB == doctest::Approx(-45.0));

    b.iq.meta.calibration = PowerCalibration();
    b.iq.meta.degrade("量化码未标定，不能换算 dBm");
    in["b"] = b;
    REQUIRE(m.process(in, out, err) == Step::Produced);
    CHECK_FALSE(out["out"].iq.meta.calibration.calibrated);
    CHECK(out["out"].iq.meta.state == State::Degraded);
}

TEST_CASE("文件回放源：清单缺失或字节序不对都要报错，不许猜") {
    FileReplaySource src;
    std::string err;
    std::map<std::string, std::string> tp{{"manifest_path", temp_dir() + "no_such_file.json"}};
    CHECK_FALSE(src.configure({}, tp, err));
    CHECK(err.find("打不开清单") != std::string::npos);

    FileReplaySource s2;
    std::map<std::string, std::string> empty;
    CHECK_FALSE(s2.configure({}, empty, err));
    CHECK(err.find("manifest_path") != std::string::npos);
}

TEST_CASE("加法混合器拒绝采样率不同的两路") {
    AddMixer m;
    std::string err;
    REQUIRE(m.configure({}, {}, err));
    Xoshiro256pp rng(1);
    REQUIRE(m.init(rng, err));
    PortMap in, out;
    PortData a, b;
    a.has_data = b.has_data = true;
    a.iq.samples.resize(4); b.iq.samples.resize(4);
    a.iq.meta.sample_rate_Hz = 1e6; b.iq.meta.sample_rate_Hz = 2e6;
    in["a"] = a; in["b"] = b;
    CHECK(m.process(in, out, err) == Step::Error);
    CHECK(err.find("不一致") != std::string::npos);
}

// ----------------------------------------------------------- Superposition（D-053，L-2）

namespace {

// 造一路支路块：n 个恒定复样点，元数据按给定的采样率 / 中心频率 / 首样点
PortData branch(std::size_t n, Complex v, double fs, double fc, std::uint64_t start) {
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.assign(n, v);
    d.iq.meta.sample_rate_Hz = fs;
    d.iq.meta.center_frequency_Hz = fc;
    d.iq.meta.start_sample = start;
    return d;
}

}  // namespace

TEST_CASE("多路叠加：N 路逐样点相加，元数据取最差状态并累加削顶计数") {
    Superposition s;
    std::string err;
    REQUIRE(s.configure({{"min_inputs", 2.0}}, {}, err));
    Xoshiro256pp rng(1);
    REQUIRE(s.init(rng, err));

    PortMap in, out;
    in["in1"] = branch(8, Complex(1.0f, 0.0f), 1e6, 2.44e9, 0);
    in["in2"] = branch(8, Complex(0.0f, 2.0f), 1e6, 2.44e9, 0);
    in["in3"] = branch(8, Complex(-0.5f, 0.0f), 1e6, 2.44e9, 0);
    in["in2"].iq.meta.clip_count = 3;
    in["in3"].iq.meta.clip_count = 4;
    in["in3"].iq.meta.degrade("第三路自带的降级理由");

    REQUIRE(s.process(in, out, err) == Step::Produced);
    const Block& b = out["out"].iq;
    CHECK(b.size() == 8);
    for (std::size_t i = 0; i < b.size(); ++i) {
        CHECK(b.samples[i].real() == doctest::Approx(0.5));
        CHECK(b.samples[i].imag() == doctest::Approx(2.0));
    }
    CHECK(b.meta.clip_count == 7);                      // 3 + 4，与 AddMixer 同法
    CHECK(b.meta.state == State::Degraded);             // 取最差
    CHECK(b.meta.state_reasons.size() == 1);
    CHECK(b.meta.trace.model_layer == "M3");
    CHECK(s.status().blocks_in == 3);
}

TEST_CASE("多路叠加：四项一致性任一不符即报错，绝不截断") {
    // 截断会让较长那一路的尾部样点被下一轮无条件覆盖掉，样点丢了还不报错（08 报告约定四）
    struct Case { const char* what; double fs; double fc; std::uint64_t start; std::size_t n; };
    const Case cases[] = {
        {"采样率",   2e6,   2.44e9, 0, 8},
        {"中心频率", 1e6,   5.8e9,  0, 8},
        {"首样点序号", 1e6, 2.44e9, 1, 8},
        {"块长",     1e6,   2.44e9, 0, 9},
    };
    for (const Case& c : cases) {
        Superposition s;
        std::string err;
        REQUIRE(s.configure({}, {}, err));
        Xoshiro256pp rng(1);
        REQUIRE(s.init(rng, err));
        PortMap in, out;
        in["in1"] = branch(8, Complex(1.0f, 0.0f), 1e6, 2.44e9, 0);
        in["in2"] = branch(c.n, Complex(1.0f, 0.0f), c.fs, c.fc, c.start);
        CHECK_MESSAGE(s.process(in, out, err) == Step::Error, c.what);
        CHECK_MESSAGE(err.find(c.what) != std::string::npos, err);
    }
}

TEST_CASE("多路叠加：已连的口本轮没数据就整轮 Idle，不少加一路") {
    Superposition s;
    std::string err;
    REQUIRE(s.configure({}, {}, err));
    Xoshiro256pp rng(1);
    REQUIRE(s.init(rng, err));
    PortMap in, out;
    in["in1"] = branch(8, Complex(1.0f, 0.0f), 1e6, 2.44e9, 0);
    in["in2"] = PortData();                   // 已连但本轮无数据
    in["in2"].type = PortType::IQStream;
    CHECK(s.process(in, out, err) == Step::Idle);
    CHECK(out.find("out") == out.end());
}

TEST_CASE("多路叠加：连得少于 min_inputs 即 check_wiring 拒绝（错误码 port_optional 的来源）") {
    Superposition s;
    std::string err;
    REQUIRE(s.configure({{"min_inputs", 3.0}}, {}, err));
    std::vector<std::string> wired;
    wired.push_back("in1");
    wired.push_back("in2");
    CHECK_FALSE(s.check_wiring(wired, err));
    CHECK(err.find("至少连上 3 路") != std::string::npos);
    wired.push_back("in3");
    CHECK(s.check_wiring(wired, err));

    // 八个输入口全声明为可选，否则 Graph::validate 会把没连的口报成悬空
    const std::vector<PortSpec> ins = s.inputs();
    CHECK(ins.size() == 8);
    for (std::size_t i = 0; i < ins.size(); ++i) CHECK(ins[i].optional);
}

TEST_CASE("多路叠加：全部支路都标定才算标定，来源取最弱的一路（与 AddMixer 同口径，D-047）") {
    Superposition s;
    std::string err;
    REQUIRE(s.configure({}, {}, err));
    Xoshiro256pp rng(1);
    REQUIRE(s.init(rng, err));

    PortMap in, out;
    in["in1"] = branch(4, Complex(1.0f, 0.0f), 1e6, 2.44e9, 0);
    in["in2"] = branch(4, Complex(1.0f, 0.0f), 1e6, 2.44e9, 0);
    in["in1"].iq.meta.calibration.calibrated = true;
    in["in1"].iq.meta.calibration.source = "measured";
    in["in1"].iq.meta.calibration.offset_dB = -1.0;
    in["in2"].iq.meta.calibration.calibrated = true;
    in["in2"].iq.meta.calibration.source = "model";
    in["in2"].iq.meta.calibration.offset_dB = -50.0;
    REQUIRE(s.process(in, out, err) == Step::Produced);
    CHECK(out["out"].iq.meta.calibration.calibrated);
    CHECK(out["out"].iq.meta.calibration.source == "model");     // 较弱者
    CHECK(out["out"].iq.meta.calibration.offset_dB == doctest::Approx(-50.0));

    // 任一路未标定 → 整体未标定
    PortMap in2, out2;
    in2["in1"] = in["in1"];
    in2["in2"] = branch(4, Complex(1.0f, 0.0f), 1e6, 2.44e9, 0);
    s.reset();
    REQUIRE(s.process(in2, out2, err) == Step::Produced);
    CHECK_FALSE(out2["out"].iq.meta.calibration.calibrated);
}

// ================================================================ C-3（D-063）：滑动噪声估计、分段、上报
//
// 这一组用例守的是 10 报告 §4.2 的滑动模式与 detections.jsonl 的行语义。
// probe 模式的行为由 test_golden.cpp 与上面的既有用例守着，这里一个数都不碰。

namespace {

struct CollectDetections : IRunObserver {
    std::vector<DetectionReport> rows;
    std::vector<DetectionSummary> summaries;
    void on_detection(const DetectionReport& r) override { rows.push_back(r); }
    void on_detection_summary(const DetectionSummary& s) override { summaries.push_back(s); }
};

struct ToneBurst {
    double offset_Hz;
    double amplitude;
    std::uint64_t start_sample;
    std::uint64_t stop_sample;   // 0 = 直到结束
};

struct DetChain {
    Graph g;
    EnergyDetector* det = nullptr;
    DetectionSink* sink = nullptr;
    NodeId iq_node = 0;    // 检测器的上游（特征提取器的 iq 口也接它，C-4）
    NodeId det_node = 0;
};

// 噪声 + 若干门控单音 → 逐级加法混合 → [ADC] → 能量检测 → 汇聚。
// 单音走混合器的 a 口（块元数据取 a 路），噪声与前一级走 b 口。
void build_det_chain(DetChain& c, double fs, std::size_t nfft, std::uint64_t total,
                     const std::vector<ToneBurst>& tones,
                     const std::map<std::string, double>& det_num,
                     const std::map<std::string, std::string>& det_txt,
                     bool with_adc = false, double adc_full_scale_dBm = 0.0) {
    std::string err;
    std::unique_ptr<NoiseSource> n(new NoiseSource());
    std::map<std::string, double> np{{"sample_rate_Hz", fs},
                                     {"total_samples", static_cast<double>(total)},
                                     {"power", 1.0}, {"block_samples", 32768.0}};
    REQUIRE(n->configure(np, {}, err));
    NodeId prev = c.g.add(std::move(n), "noise");
    for (std::size_t i = 0; i < tones.size(); ++i) {
        std::unique_ptr<ToneSource> t(new ToneSource());
        std::map<std::string, double> tp{{"sample_rate_Hz", fs},
                                         {"total_samples", static_cast<double>(total)},
                                         {"offset_Hz", tones[i].offset_Hz},
                                         {"amplitude", tones[i].amplitude},
                                         {"start_sample", static_cast<double>(tones[i].start_sample)},
                                         {"stop_sample", static_cast<double>(tones[i].stop_sample)},
                                         {"block_samples", 32768.0}};
        REQUIRE(t->configure(tp, {}, err));
        NodeId tn = c.g.add(std::move(t), "tone" + std::to_string(i));
        std::unique_ptr<AddMixer> m(new AddMixer());
        REQUIRE(m->configure({}, {}, err));
        NodeId mn = c.g.add(std::move(m), "mix" + std::to_string(i));
        REQUIRE(c.g.connect(tn, "out", mn, "a", err));
        REQUIRE(c.g.connect(prev, "out", mn, "b", err));
        prev = mn;
    }
    if (with_adc) {
        std::unique_ptr<AdcQuantizer> q(new AdcQuantizer());
        REQUIRE(q->configure({{"full_scale_dBm", adc_full_scale_dBm}}, {{"bits", "12"}}, err));
        NodeId qn = c.g.add(std::move(q), "adc");
        REQUIRE(c.g.connect(prev, "out", qn, "in", err));
        prev = qn;
    }
    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    c.det = d.get();
    REQUIRE_MESSAGE(d->configure(det_num, det_txt, err), err);
    NodeId dn = c.g.add(std::move(d), "det");
    REQUIRE(c.g.connect(prev, "out", dn, "in", err));
    c.iq_node = prev;
    c.det_node = dn;
    std::unique_ptr<DetectionSink> k(new DetectionSink());
    c.sink = k.get();
    NodeId kn = c.g.add(std::move(k), "sink");
    REQUIRE(c.g.connect(dn, "out", kn, "in", err));
}

const std::map<std::string, std::string> kSliding{{"noise_mode", "sliding"}};

}  // namespace

TEST_CASE("sliding：纯噪声下暖机后的虚警率接近目标值，第 0 帧按约定先入环") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t frames = 20000;
    DetChain c;
    build_det_chain(c, fs, nfft, frames * nfft, {},
                    {{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                     {"pfa", 1e-2}, {"noise_window_frames", 256.0}},
                    kSliding);
    CollectDetections obs;
    Xoshiro256pp rng(7);
    RunReport rep = c.g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    REQUIRE(obs.rows.size() == frames);
    CHECK(c.sink->frames() == frames);

    // 第 0 帧：环空 → 先入环 → 噪声估计 = 自身 / ln2 → Λ 恒为 ln2，不会命中
    CHECK(obs.rows[0].d.noise_frames_used == 1);
    CHECK(obs.rows[0].d.statistic == doctest::Approx(0.69314718055994530942).epsilon(1e-9));
    CHECK_FALSE(obs.rows[0].d.hit);
    // 环单调填满到 W，之后停在 W
    std::uint32_t prev_used = 0;
    for (const auto& r : obs.rows) {
        CHECK(r.d.noise_frames_used >= prev_used);
        CHECK(r.d.noise_frames_used <= 256);
        prev_used = r.d.noise_frames_used;
    }
    CHECK(obs.rows.back().d.noise_frames_used == 256);

    // 暖机（前 W 帧）之后统计：均值 ≈ 1、虚警率与目标同量级。
    // 滑动估计自带估计噪声（每 bin 中位数 256 帧的相对散布约 8%，51 bin 求和后约 1%），
    // 加上删截去掉了最高的 1% 帧，虚警率会比 probe 略高——判据留到目标值的一倍以内，不放到无意义。
    double sum = 0.0;
    std::uint64_t n = 0, hits = 0;
    for (const auto& r : obs.rows) {
        if (r.d.frame_index < 256) continue;
        sum += r.d.statistic;
        ++n;
        if (r.d.hit) ++hits;
    }
    const double rate = static_cast<double>(hits) / static_cast<double>(n);
    MESSAGE("sliding H0 虚警率 " << rate << "（目标 1e-2），均值 " << sum / static_cast<double>(n));
    CHECK(sum / static_cast<double>(n) == doctest::Approx(1.0).epsilon(0.02));
    CHECK(rate > 0.5e-2);
    CHECK(rate < 2.0e-2);
    CHECK(c.det->noise_stale_frames() == 0);
    CHECK(rep.state == State::Valid);
}

TEST_CASE("sliding：清净起步后出现的持续单音保持检出——环被删截冻结，陈旧帧只记 note 不降级") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t frames = 4000;
    DetChain c;
    build_det_chain(c, fs, nfft, frames * nfft,
                    {{50000.0, 0.5, 1000 * nfft, 0}},
                    {{"nfft", 256.0}, {"band_lo_Hz", 40000.0}, {"band_hi_Hz", 60000.0},
                     {"pfa", 1e-3}, {"noise_window_frames", 256.0}},
                    kSliding);
    CollectDetections obs;
    Xoshiro256pp rng(11);
    RunReport rep = c.g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    REQUIRE(obs.rows.size() == frames);

    std::uint64_t before = 0, after_hits = 0, after = 0;
    for (const auto& r : obs.rows) {
        if (r.d.frame_index < 1000) { if (r.d.hit) ++before; }
        else { ++after; if (r.d.hit) ++after_hits; }
    }
    // 1000 帧以前只有虚警（期望 1 次量级）；以后持续检出
    CHECK(before <= 10);
    CHECK(static_cast<double>(after_hits) / static_cast<double>(after) >= 0.99);
    // 单音一来，命中帧不再入环，环停在 1000 帧前的干净噪声上：这正是删截的意义，
    // 代价是估计不再更新，按 10 §4.2 计陈旧帧、记 note、不降级
    CHECK(c.det->noise_stale_frames() > 0);
    CHECK(c.det->noise_stale_frames() < after);
    bool noted = false;
    for (const auto& s : c.det->status().notes) if (s.find("陈旧") != std::string::npos) noted = true;
    CHECK(noted);
    CHECK(rep.state == State::Valid);
    // 从 1000 帧起的命中属于同一个突发（虚警帧之间的空隙远大于 merge_gap，不会被并进来）
    CHECK(obs.rows[1000].d.hit);
    CHECK(obs.rows[1000].d.segment_id == obs.rows.back().d.segment_id);
    // 行自描述：时间与绝对频段
    CHECK(obs.rows[1000].d.t_s == doctest::Approx(1000.0 * 256.0 / fs));
    CHECK(obs.rows[1000].d.f_lo_Hz == doctest::Approx(40000.0));
    CHECK(obs.rows[1000].d.f_hi_Hz == doctest::Approx(60000.0));
    CHECK(obs.rows[1000].d.snr_dB == doctest::Approx(10.0 * std::log10(obs.rows[1000].d.statistic)));
}

TEST_CASE("sliding：从第一帧起就在的持续信号同样被吸收——删截救不了没有干净参考的估计") {
    // 与上面 probe 的「连续满带信号会被中位数噪声估计吸收」是同一件事：
    // 第 0 帧无条件入环，此后每帧都不命中、都被纳入，估计始终含信号。这是已知行为，写进模型卡。
    const double fs = 1e6;
    const std::size_t nfft = 256;
    DetChain c;
    build_det_chain(c, fs, nfft, 3000 * nfft,
                    {{50000.0, 0.5, 0, 0}},
                    {{"nfft", 256.0}, {"band_lo_Hz", 40000.0}, {"band_hi_Hz", 60000.0},
                     {"pfa", 1e-3}, {"noise_window_frames", 256.0}},
                    kSliding);
    Xoshiro256pp rng(11);
    RunReport rep = c.g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    CHECK(c.sink->hit_rate() < 0.05);
}

TEST_CASE("突发分段：命中帧之间的空隙不大于 merge_gap_frames 即并入同一段") {
    // 两段单音 [1000, 1100) 与 [1102, 1200)，中间空 2 帧；pfa 取 1e-6 让虚警造出的碎段可忽略。
    // 暖机期除外：环里只有一两帧时估计极不可靠（M = 5 个 bin、1 帧中位数），头几帧的虚警率
    // 远高于目标——这是 10 §4.2「环未满时用已有帧、不标降级」的真实后果（实测种子 5 在第 1 帧
    // 命中一次），所以断言只看暖机（W 帧）之后，段号按行分组比较而不是数全局段数。
    const double fs = 1e6;
    const std::size_t nfft = 256;
    for (double gap = 1.0; gap <= 2.0; gap += 1.0) {
        DetChain c;
        build_det_chain(c, fs, nfft, 2000 * nfft,
                        {{50000.0, 0.5, 1000 * nfft, 1100 * nfft},
                         {50000.0, 0.5, 1102 * nfft, 1200 * nfft}},
                        {{"nfft", 256.0}, {"band_lo_Hz", 40000.0}, {"band_hi_Hz", 60000.0},
                         {"pfa", 1e-6}, {"noise_window_frames", 256.0}, {"merge_gap_frames", gap}},
                        kSliding);
        CollectDetections obs;
        Xoshiro256pp rng(5);
        RunReport rep = c.g.run(rng, obs);
        REQUIRE_MESSAGE(rep.ok, rep.error);
        REQUIRE(obs.rows.size() == 2000);
        std::uint64_t hits_after_warmup = 0;
        for (const auto& r : obs.rows) if (r.d.frame_index >= 256 && r.d.hit) ++hits_after_warmup;
        MESSAGE("gap " << gap << "：暖机后命中 " << hits_after_warmup << "，全程段数 " << c.det->segments()
                << "，η " << c.det->threshold() << "，Λ[1050] " << obs.rows[1050].d.statistic
                << "，Λ[1100] " << obs.rows[1100].d.statistic);
        CHECK(hits_after_warmup == 198);
        const std::int64_t a = obs.rows[1000].d.segment_id;
        const std::int64_t b = obs.rows[1102].d.segment_id;
        CHECK(a >= 0);
        CHECK(b >= 0);
        for (std::size_t i = 1000; i < 1100; ++i) CHECK(obs.rows[i].d.segment_id == a);
        for (std::size_t i = 1102; i < 1200; ++i) CHECK(obs.rows[i].d.segment_id == b);
        CHECK_FALSE(obs.rows[1100].d.hit);
        CHECK(obs.rows[1100].d.segment_id == -1);
        CHECK(obs.rows[1101].d.segment_id == -1);
        CHECK(obs.rows[1200].d.segment_id == -1);
        if (gap >= 2.0) CHECK(a == b); else CHECK(b == a + 1);
        REQUIRE(obs.summaries.size() == 1);
        CHECK(obs.summaries[0].segments == c.det->segments());
        CHECK(obs.summaries[0].hits == c.det->hits());
    }
}

TEST_CASE("削顶标记随块传到检测行：有 ADC 且削顶时 overload 为真，无 ADC 恒假；dBm 读数随标定走") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::map<std::string, double> dp{{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                                           {"pfa", 1e-2}, {"noise_window_frames", 64.0}};
    SUBCASE("无 ADC") {
        DetChain c;
        build_det_chain(c, fs, nfft, 300 * nfft, {}, dp, kSliding);
        CollectDetections obs;
        Xoshiro256pp rng(3);
        REQUIRE(c.g.run(rng, obs).ok);
        REQUIRE(obs.rows.size() == 300);
        for (const auto& r : obs.rows) {
            CHECK_FALSE(r.d.overload);
            // 合成源已标定（来源 model），有 dBm 读数；频段功率 ≈ 0 dBm（单位功率白噪声、频段占 78%）
            CHECK(r.d.has_dBm);
            CHECK(std::isfinite(r.d.band_power_dBm));
            CHECK(std::isfinite(r.d.noise_dBm));
        }
        CHECK(obs.rows[200].d.band_power_dBm == doctest::Approx(10.0 * std::log10(0.2 * 1e6 / fs * 1.0) + 0.0).epsilon(0.5));
        REQUIRE(obs.summaries.size() == 1);
        CHECK(obs.summaries[0].overload_frames == 0);
        CHECK(obs.summaries[0].calibrated);
    }
    SUBCASE("有 ADC，满量程远低于噪声电平：每块都削顶，每帧都标 overload") {
        DetChain c;
        build_det_chain(c, fs, nfft, 300 * nfft, {}, dp, kSliding, true, -20.0);
        CollectDetections obs;
        Xoshiro256pp rng(3);
        REQUIRE(c.g.run(rng, obs).ok);
        REQUIRE(obs.rows.size() == 300);
        for (const auto& r : obs.rows) CHECK(r.d.overload);
        REQUIRE(obs.summaries.size() == 1);
        CHECK(obs.summaries[0].overload_frames == 300);
    }
    SUBCASE("band_power_dBm 参数关掉：行里不带 dBm") {
        std::map<std::string, double> dp2 = dp;
        dp2["band_power_dBm"] = 0.0;
        DetChain c;
        build_det_chain(c, fs, nfft, 100 * nfft, {}, dp2, kSliding);
        CollectDetections obs;
        Xoshiro256pp rng(3);
        REQUIRE(c.g.run(rng, obs).ok);
        for (const auto& r : obs.rows) CHECK_FALSE(r.d.has_dBm);
    }
}

TEST_CASE("检测行经观察者上报：行数等于帧数、带节点名；site_id 只在注入时出现；摘要恰一次") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::map<std::string, double> dp{{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                                           {"pfa", 1e-2}, {"noise_window_frames", 64.0}, {"noise_frames", 100.0}};
    SUBCASE("sliding，注入 site_id") {
        DetChain c;
        build_det_chain(c, fs, nfft, 500 * nfft, {}, dp, {{"noise_mode", "sliding"}, {"site_id", "site-9"}});
        CollectDetections obs;
        Xoshiro256pp rng(2);
        REQUIRE(c.g.run(rng, obs).ok);
        CHECK(obs.rows.size() == c.sink->frames());
        CHECK(obs.rows.size() == 500);
        for (const auto& r : obs.rows) {
            CHECK(r.node_id == "det");
            CHECK(r.site_id == "site-9");
        }
        REQUIRE(obs.summaries.size() == 1);
        const DetectionSummary& s = obs.summaries[0];
        CHECK(s.node_id == "det");
        CHECK(s.site_id == "site-9");
        CHECK(s.frames == 500);
        CHECK(s.hits == c.det->hits());
        CHECK(s.segments == c.det->segments());
        CHECK(s.noise_mode == "sliding");
        CHECK(s.noise_window_frames == 64);
        CHECK(s.merge_gap_frames == 2);
        CHECK(s.threshold == doctest::Approx(c.det->threshold()));
        CHECK(s.dt_s == doctest::Approx(256.0 / fs));
        CHECK(s.trace.model_id == "EnergyDetector");
        CHECK(s.trace.trace_id == "EnergyDetector:site-9");
        CHECK(s.band_lo_Hz == doctest::Approx(-1e5));
    }
    SUBCASE("probe，不注入 site_id：同样逐帧上报，探针帧在攒够后一次补报") {
        DetChain c;
        build_det_chain(c, fs, nfft, 500 * nfft, {}, dp, {});
        CollectDetections obs;
        Xoshiro256pp rng(2);
        REQUIRE(c.g.run(rng, obs).ok);
        CHECK(obs.rows.size() == 500);
        for (std::size_t i = 0; i < obs.rows.size(); ++i) {
            CHECK(obs.rows[i].site_id.empty());
            CHECK(obs.rows[i].d.frame_index == i);
            CHECK(obs.rows[i].d.noise_frames_used == 100);
        }
        REQUIRE(obs.summaries.size() == 1);
        CHECK(obs.summaries[0].noise_mode == "probe");
        CHECK(obs.summaries[0].noise_window_frames == 100);
        CHECK(obs.summaries[0].trace.trace_id == "EnergyDetector:0");
    }
}

// ================================================================ C-4：特征提取
//
// 守 10 报告 §4.3 的行语义与两条调度约定（IQ 块不连续即报错；消费即产出）。
// 与 Python 参考的逐段对拍在 test_golden.cpp。

namespace {

struct CollectFeatures : IRunObserver {
    std::vector<FeatureReport> rows;
    void on_feature(const FeatureReport& r) override { rows.push_back(r); }
};

// 在 build_det_chain 的链上再挂特征提取器：iq 取检测器的同一上游，det 取检测器输出（一个输出口扇出两条边合法）
FeatureExtractor* add_feat(DetChain& c, const std::map<std::string, double>& num,
                           const std::map<std::string, std::string>& txt = {}) {
    std::string err;
    std::unique_ptr<FeatureExtractor> f(new FeatureExtractor());
    FeatureExtractor* p = f.get();
    REQUIRE_MESSAGE(f->configure(num, txt, err), err);
    NodeId fn = c.g.add(std::move(f), "feat");
    REQUIRE(c.g.connect(c.iq_node, "out", fn, "iq", err));
    REQUIRE(c.g.connect(c.det_node, "out", fn, "det", err));
    return p;
}

PortData iq_block(std::uint64_t start, std::size_t n, double fs) {
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.assign(n, Complex(0.01f, -0.02f));
    d.iq.meta.sample_rate_Hz = fs;
    d.iq.meta.start_sample = start;
    return d;
}

PortData det_list(const std::vector<Detection>& items) {
    PortData d;
    d.type = PortType::DetectionList;
    d.has_data = true;
    d.detections.items = items;
    return d;
}

std::vector<const FeatureRow*> rows_with_frames_at_least(const std::vector<FeatureReport>& rows, std::uint64_t n) {
    std::vector<const FeatureRow*> v;
    for (const auto& r : rows) if (r.row.frames >= n) v.push_back(&r.row);
    return v;
}

}  // namespace

TEST_CASE("特征提取：单音突发出一行——质心在单音处、带宽只占几个 bin、平坦度低、时间与帧数与检测行一致") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t frames = 3000;
    DetChain c;
    // 单音幅度 0.8（功率 0.64）：带内 Λ ≈ 4.2，pfa 1e-6 的门限约 1.75，段内不会漏帧；
    // 幅度 0.5 时 Λ ≈ 2.25、信号与噪声的交叉项把 Λ 的散布抬到 0.26，每百帧漏三帧左右——那是物理，不是缺陷
    build_det_chain(c, fs, nfft, frames * nfft, {{50000.0, 0.8, 1000 * nfft, 1400 * nfft}},
                    {{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                     {"pfa", 1e-6}, {"noise_window_frames", 256.0}},
                    kSliding);
    FeatureExtractor* feat = add_feat(c, {{"nfft", 256.0}});
    CollectFeatures obs;
    Xoshiro256pp rng(3);
    RunReport rep = c.g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);

    // pfa 1e-6 下 3000 帧几乎不会有虚警；若有也是一帧的 short 行，不干扰下面的断言
    CHECK(obs.rows.size() <= 2);
    std::vector<const FeatureRow*> full = rows_with_frames_at_least(obs.rows, 2);
    REQUIRE(full.size() == 1);
    const FeatureRow& r = *full[0];
    CHECK(obs.rows[0].node_id == "feat");
    CHECK(obs.rows[0].site_id.empty());
    CHECK(obs.rows[0].trace.model_id == "FeatureExtractor");
    CHECK(obs.rows[0].trace.model_layer == "M3");
    CHECK(r.frames == 400);
    CHECK(r.t_s == doctest::Approx(1000.0 * 256.0 / fs));
    CHECK(r.t_end_s == doctest::Approx(1400.0 * 256.0 / fs));
    CHECK(r.duration_s == doctest::Approx(400.0 * 256.0 / fs));
    const double bin = fs / 256.0;
    CHECK(std::fabs(r.center_Hz - 50000.0) < bin);
    CHECK(r.bandwidth_Hz >= bin);
    CHECK(r.bandwidth_Hz <= 5.0 * bin);          // 周期 Hann 的主瓣：矩形帧的 sinc² 旁瓣会量到几十个 bin
    CHECK(r.signal_bins >= 1);
    CHECK(r.signal_bins <= 6);
    CHECK(r.spectral_flatness < 0.3);
    CHECK(r.quality == "full");
    CHECK_FALSE(r.overload);
    CHECK(r.has_dBm);
    CHECK(r.duty == 1.0);
    // 带内功率 = 单音 0.64 + 带内噪声 51/256（Parseval，与检测行同式）；信噪比是 (S+N)/N
    const double want_p = 10.0 * std::log10(0.64 + 51.0 / 256.0);
    const double want_snr = 10.0 * std::log10((0.64 + 51.0 / 256.0) / (51.0 / 256.0));
    CHECK(std::fabs(r.band_power_dBm - want_p) < 0.3);
    CHECK(std::fabs(r.snr_dB - want_snr) < 0.3);
    CHECK(r.peak_dBm > -3.5);                   // 单音 0.64 → −1.94 dBm，0.2 bin 偏置的 Hann 扇贝损耗约 0.3 dB
    CHECK(r.peak_dBm < -1.0);
    CHECK(r.crest_factor_dB > 0.0);
    CHECK(r.crest_factor_dB < 20.0);
    CHECK(feat->frames() == frames);
    CHECK(feat->status().state == State::Valid);
    CHECK(rep.state == State::Valid);
}

TEST_CASE("特征提取：多段的间隔与跳频差；不足 min_frames 的段标 short 且不充当「上一段」") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t frames = 2000;
    DetChain c;
    build_det_chain(c, fs, nfft, frames * nfft,
                    {{20000.0, 0.8, 500 * nfft, 600 * nfft},
                     {-30000.0, 0.8, 700 * nfft, 701 * nfft},
                     {-30000.0, 0.8, 800 * nfft, 900 * nfft}},
                    {{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                     {"pfa", 1e-6}, {"noise_window_frames", 256.0}},
                    kSliding);
    FeatureExtractor* feat = add_feat(c, {{"nfft", 256.0}, {"min_frames", 2.0}});
    CollectFeatures obs;
    Xoshiro256pp rng(5);
    RunReport rep = c.g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    REQUIRE(obs.rows.size() == 3);
    const FeatureRow& a = obs.rows[0].row;
    const FeatureRow& b = obs.rows[1].row;
    const FeatureRow& d = obs.rows[2].row;
    const double bin = fs / 256.0;
    CHECK(a.frames == 100); CHECK(a.quality == "full"); CHECK_FALSE(a.has_prev);
    CHECK(std::fabs(a.center_Hz - 20000.0) < bin);
    CHECK(b.frames == 1); CHECK(b.quality == "short"); CHECK(b.has_prev);
    CHECK(b.interval_from_prev_s == doctest::Approx((700.0 - 600.0) * 256.0 / fs));
    CHECK(std::fabs(b.hop_from_prev_Hz - (-50000.0)) < 2.0 * bin);
    // 第三段的「上一段」是 A 不是 B：一帧的段不能充当参考
    CHECK(d.frames == 100); CHECK(d.quality == "full"); CHECK(d.has_prev);
    CHECK(d.interval_from_prev_s == doctest::Approx((800.0 - 600.0) * 256.0 / fs));
    CHECK(std::fabs(d.hop_from_prev_Hz - (-50000.0)) < 2.0 * bin);
    CHECK(a.segment_id < b.segment_id);
    CHECK(b.segment_id < d.segment_id);
    CHECK(feat->segments() == 3);
}

TEST_CASE("特征提取：IQ 块不连续即报错，不静默丢块（铁律 15）") {
    FeatureExtractor f;
    std::string err;
    REQUIRE(f.configure({{"nfft", 64.0}}, {}, err));
    Xoshiro256pp rng(1);
    REQUIRE(f.init(rng, err));
    PortMap in, out;
    in["iq"] = iq_block(0, 128, 1e6);
    in["det"] = det_list({});
    REQUIRE(f.process(in, out, err) == Step::Produced);
    CHECK(out["out"].has_data);                       // 消费即产出，哪怕是空的
    CHECK(out["out"].features.items.empty());
    in["iq"] = iq_block(128, 64, 1e6);                // 首尾相接：合法
    out.clear();
    REQUIRE(f.process(in, out, err) == Step::Produced);
    in["iq"] = iq_block(320, 64, 1e6);                // 跳过了 [192, 320)：上游有一轮没产出
    out.clear();
    CHECK(f.process(in, out, err) == Step::Error);
    CHECK(err.find("不连续") != std::string::npos);
}

TEST_CASE("特征提取：检测行与本组件的帧对不上（nfft 不同或没有对应 IQ 帧）即报错") {
    FeatureExtractor f;
    std::string err;
    REQUIRE(f.configure({{"nfft", 64.0}}, {}, err));
    Xoshiro256pp rng(1);
    REQUIRE(f.init(rng, err));
    PortMap in, out;
    // 检测器按 nfft 32 出了 frame 1（start 32），本组件按 64 切帧，下一帧是 index 0 → 对不上
    Detection d;
    d.frame_index = 1; d.start_sample = 32; d.hit = false;
    in["iq"] = iq_block(0, 64, 1e6);
    in["det"] = det_list({d});
    CHECK(f.process(in, out, err) == Step::Error);
    CHECK(err.find("对不上") != std::string::npos);

    FeatureExtractor g;
    REQUIRE(g.configure({{"nfft", 64.0}}, {}, err));
    REQUIRE(g.init(rng, err));
    Detection d0;
    d0.frame_index = 0; d0.start_sample = 0;
    in["iq"] = iq_block(0, 32, 1e6);                  // 半帧 IQ 却来了一条检测行：没有对应帧
    in["det"] = det_list({d0});
    out.clear();
    CHECK(g.process(in, out, err) == Step::Error);
    CHECK(err.find("没有对应的 IQ 帧") != std::string::npos);
}

TEST_CASE("检测器消费了块就产出：块长小于 nfft、probe 收集期都不会让下游双输入节点丢块") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t frames = 500;
    Graph g;
    std::string err;
    std::unique_ptr<NoiseSource> n(new NoiseSource());
    REQUIRE(n->configure({{"sample_rate_Hz", fs}, {"total_samples", static_cast<double>(frames * nfft)},
                          {"power", 1.0}, {"block_samples", 100.0}}, {}, err));
    NodeId nn = g.add(std::move(n), "noise");
    std::unique_ptr<EnergyDetector> d(new EnergyDetector());
    EnergyDetector* det = d.get();
    REQUIRE(d->configure({{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                          {"pfa", 1e-3}, {"noise_frames", 64.0}}, {{"noise_mode", "probe"}}, err));
    NodeId dn = g.add(std::move(d), "det");
    std::unique_ptr<FeatureExtractor> f(new FeatureExtractor());
    FeatureExtractor* feat = f.get();
    REQUIRE(f->configure({{"nfft", 256.0}}, {}, err));
    NodeId fn = g.add(std::move(f), "feat");
    REQUIRE(g.connect(nn, "out", dn, "in", err));
    REQUIRE(g.connect(nn, "out", fn, "iq", err));
    REQUIRE(g.connect(dn, "out", fn, "det", err));
    Xoshiro256pp rng(9);
    RunReport rep = g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    // 每一块都产出（空列表也算），下游每一轮都跑，500 帧一帧不少地等到了检测行
    CHECK(det->status().blocks_out == det->status().blocks_in);
    CHECK(feat->frames() == frames);
    CHECK(feat->status().state == State::Valid);
    for (const auto& note : feat->status().notes) CHECK(note.find("没有等到") == std::string::npos);
}

// ================================================================ C-4：模板匹配识别
//
// 守 10 报告 §4.4 的判决语义与模板库的结构校验。与 Python 参考的逐行对拍在 test_golden.cpp。

namespace {

std::string library_v1() { return std::string(CUAV_SOURCE_DIR) + "/../models/recognition/library-v1.json"; }

std::string temp_dir_components() {
    const char* t = std::getenv("TMPDIR");
    std::string d = t ? t : "/tmp/";
    if (!d.empty() && d[d.size() - 1] != '/') d += '/';
    return d + "cuav_components_test/";
}

std::string write_temp(const std::string& name, const std::string& text) {
    const std::string dir = temp_dir_components();
    std::string err;
    platform::make_dirs(dir, err);
    const std::string path = dir + name;
    std::ofstream f(path.c_str(), std::ios::binary | std::ios::trunc);
    f << text;
    return path;
}

FeatureRow feat_row(double bw, std::size_t bins, double dur, double duty, double flat,
                    const std::string& quality = "full", bool has_prev = false,
                    double interval = 0.0, double hop = 0.0) {
    FeatureRow f;
    f.t_s = 1.0; f.t_end_s = 1.0 + dur; f.duration_s = dur; f.frames = 10; f.segment_id = 0;
    f.center_Hz = 2.44e9; f.bandwidth_Hz = bw; f.signal_bins = bins; f.has_dBm = true;
    f.band_power_dBm = -60.0; f.peak_dBm = -65.0; f.snr_dB = 12.0; f.spectral_flatness = flat;
    f.crest_factor_dB = 9.0; f.duty = duty; f.overload = false; f.quality = quality;
    f.has_prev = has_prev; f.interval_from_prev_s = interval; f.hop_from_prev_Hz = hop;
    return f;
}

struct CollectRecognitions : IRunObserver {
    std::vector<RecognitionReport> rows;
    void on_recognition(const RecognitionReport& r) override { rows.push_back(r); }
};

}  // namespace

TEST_CASE("模板识别：四类中心各归各类；缺上一段时定频与跳频分摊后验；离谁都远即 unknown_novel；低质量直接 unknown_low_quality") {
    TemplateClassifier c;
    std::string err;
    REQUIRE_MESSAGE(c.configure({}, {{"library_path", library_v1()}}, err), err);
    CHECK(c.labels() == std::vector<std::string>{"video_link", "telemetry_burst", "rc_hopping", "cw_beacon"});

    RecognitionRow cw = c.classify(feat_row(2000.0, 3, 2.0, 1.0, 0.05));
    CHECK(cw.result == "known"); CHECK(cw.label == "cw_beacon"); CHECK(cw.posterior >= 0.6); CHECK(cw.distance == 0.0);
    CHECK(cw.unknown_kind.empty()); CHECK(cw.evidence_quality == "full"); CHECK(cw.library_version == "v1");
    REQUIRE(cw.top_n.size() == 3); CHECK(cw.top_n[0].label == "cw_beacon");

    RecognitionRow vid = c.classify(feat_row(8e6, 800, 1.5, 0.95, 0.9));
    CHECK(vid.result == "known"); CHECK(vid.label == "video_link");

    RecognitionRow tel = c.classify(feat_row(100e3, 20, 0.01, 0.2, 0.6, "full", true, 0.1, 0.0));
    CHECK(tel.result == "known"); CHECK(tel.label == "telemetry_burst");

    RecognitionRow rc = c.classify(feat_row(200e3, 40, 0.005, 0.3, 0.6, "full", true, 0.02, 1.2e6));
    CHECK(rc.result == "known"); CHECK(rc.label == "rc_hopping");

    // 没有上一段：跳频差与间隔缺失，telemetry 与 rc 在其余特征上同距 → 后验分摊、都不过门限
    RecognitionRow amb = c.classify(feat_row(100e3, 20, 0.01, 0.3, 0.6));
    CHECK(amb.result == "unknown"); CHECK(amb.label == "unknown"); CHECK(amb.unknown_kind == "unknown_ambiguous");
    REQUIRE(amb.top_n.size() >= 2);
    CHECK(amb.top_n[0].label == "telemetry_burst");      // 并列时保持库序
    CHECK(amb.top_n[1].label == "rc_hopping");
    CHECK(amb.top_n[0].posterior == doctest::Approx(amb.top_n[1].posterior));
    CHECK(amb.distance == 0.0);

    RecognitionRow nov = c.classify(feat_row(1e5, 20, 100.0, 0.0, 0.99, "full", true, 5.0, 0.0));
    CHECK(nov.result == "unknown"); CHECK(nov.unknown_kind == "unknown_novel"); CHECK(nov.distance > 4.0);
    CHECK(nov.posterior > 0.0);

    RecognitionRow low = c.classify(feat_row(0.0, 0, 0.002, 0.1, 0.5, "low_snr"));
    CHECK(low.result == "unknown"); CHECK(low.unknown_kind == "unknown_low_quality");
    CHECK(low.top_n.empty()); CHECK(low.distance < 0.0); CHECK(low.posterior == 0.0);

    // min_quality = full：short 也直接 unknown_low_quality
    TemplateClassifier strict;
    REQUIRE(strict.configure({}, {{"library_path", library_v1()}, {"min_quality", "full"}}, err));
    RecognitionRow sh = strict.classify(feat_row(30e3, 4, 0.002, 0.1, 0.5, "short", true, 0.05, 3e3));
    CHECK(sh.unknown_kind == "unknown_low_quality");
    // 缺省 short 时 short 照算
    RecognitionRow sh2 = c.classify(feat_row(30e3, 4, 0.002, 0.1, 0.5, "short", true, 0.05, 3e3));
    CHECK(sh2.result == "known"); CHECK(sh2.label == "telemetry_burst"); CHECK(sh2.evidence_quality == "short");
}

TEST_CASE("模板识别：ambiguous 只在非缺省参数下可达——缺省 0.6 / 0.2 使 p1 ≥ 0.6 蕴含领先 ≥ 0.2（模型卡 §2）") {
    TemplateClassifier c;
    std::string err;
    REQUIRE(c.configure({{"accept_threshold", 0.4}, {"ambiguity_margin", 0.3}}, {{"library_path", library_v1()}}, err));
    RecognitionRow r = c.classify(feat_row(100e3, 20, 0.01, 0.3, 0.6));
    CHECK(r.result == "ambiguous");
    CHECK(r.label == "telemetry_burst");
    CHECK(r.posterior >= 0.4);
    CHECK(r.unknown_kind.empty());
}

TEST_CASE("模板识别：坏库被拒——未知键、区间颠倒、线性特征缺上界、缺权重、引用不存在的特征、版本不符、文件不存在") {
    std::string err;
    TemplateClassifier::Library lib;
    REQUIRE_MESSAGE(TemplateClassifier::load_library(library_v1(), lib, err), err);
    CHECK(lib.version == "v1"); CHECK(lib.source == "assumed"); CHECK(lib.templates.size() == 4); CHECK(lib.features.size() == 6);

    const std::string good = [] {
        std::ifstream f(library_v1().c_str(), std::ios::binary);
        std::ostringstream o; o << f.rdbuf(); return o.str();
    }();
    auto bad = [&](const std::string& name, const std::string& from, const std::string& to, const std::string& expect) {
        std::string t = good;
        const std::size_t pos = t.find(from);
        REQUIRE_MESSAGE(pos != std::string::npos, "夹具里找不到 " << from);
        t.replace(pos, from.size(), to);
        TemplateClassifier::Library l;
        std::string e;
        CHECK_FALSE(TemplateClassifier::load_library(write_temp(name, t), l, e));
        CHECK_MESSAGE(e.find(expect) != std::string::npos, name << "：报错 " << e << " 不含 " << expect);
    };
    bad("unknown_key.json", "\"label_layer\"", "\"label_layerx\"", "未知键");
    bad("reversed.json", "\"duty\": [0.8, 1.0]", "\"duty\": [1.0, 0.8]", "上界必须大于下界");
    bad("linear_open.json", "\"duty\": [0.8, 1.0]", "\"duty\": [0.8, null]", "线性特征");
    bad("no_weight.json", "\"weights\": { \"bandwidth_Hz\": 2.0, \"duration_s\": 1.0, \"duty\": 2.0, \"spectral_flatness\": 1.0 }",
        "\"weights\": { \"bandwidth_Hz\": 2.0, \"duration_s\": 1.0, \"duty\": 2.0 }", "缺正的权重");
    bad("no_such_feature.json", "\"bandwidth_Hz\", \"duration_s\", \"duty\"", "\"bandwidth_Hz\", \"nonesuch\", \"duty\"", "没有的特征");
    bad("bad_schema.json", "cuav-recognition-library/1", "cuav-recognition-library/2", "schema");

    TemplateClassifier c;
    CHECK_FALSE(c.configure({}, {{"library_path", library_v1()}, {"library_version", "v2"}}, err));
    CHECK(err.find("library_version") != std::string::npos);
    CHECK_FALSE(c.configure({}, {{"library_path", temp_dir_components() + "missing.json"}}, err));
    CHECK(err.find("打不开") != std::string::npos);
    CHECK_FALSE(c.configure({}, {}, err));
    CHECK(err.find("library_path") != std::string::npos);
}

TEST_CASE("模板识别：接在特征提取器之后跑通一条链——每行特征一行识别，持续半秒的单音判为 cw_beacon，行带节点名与 trace") {
    const double fs = 1e6;
    const std::size_t nfft = 256;
    const std::uint64_t frames = 3500;
    DetChain c;
    build_det_chain(c, fs, nfft, frames * nfft, {{50000.0, 0.8, 1000 * nfft, 3000 * nfft}},
                    {{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5},
                     {"pfa", 1e-6}, {"noise_window_frames", 256.0}},
                    kSliding);
    add_feat(c, {{"nfft", 256.0}});
    std::string err;
    std::unique_ptr<TemplateClassifier> r(new TemplateClassifier());
    TemplateClassifier* rec = r.get();
    REQUIRE_MESSAGE(r->configure({}, {{"library_path", library_v1()}}, err), err);
    NodeId rn = c.g.add(std::move(r), "rec");
    NodeId fn = 0;
    for (NodeId i = 0; i < c.g.size(); ++i) if (c.g.name(i) == "feat") fn = i;
    REQUIRE(c.g.connect(fn, "out", rn, "in", err));
    struct Both : IRunObserver {
        std::vector<FeatureReport> feats;
        std::vector<RecognitionReport> recs;
        void on_feature(const FeatureReport& f) override { feats.push_back(f); }
        void on_recognition(const RecognitionReport& x) override { recs.push_back(x); }
    } obs;
    Xoshiro256pp rng(21);
    RunReport rep = c.g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    REQUIRE(obs.recs.size() == obs.feats.size());
    CHECK(rec->rows() == obs.recs.size());
    const RecognitionReport* longest = nullptr;
    for (std::size_t i = 0; i < obs.recs.size(); ++i) {
        CHECK(obs.recs[i].node_id == "rec");
        CHECK(obs.recs[i].trace.model_id == "TemplateClassifier");
        CHECK(obs.recs[i].trace.model_layer == "M2");
        CHECK(obs.recs[i].row.segment_id == obs.feats[i].row.segment_id);
        if (!longest || obs.feats[i].row.frames > obs.feats[longest - &obs.recs[0]].row.frames) longest = &obs.recs[i];
    }
    REQUIRE(longest);
    {
        const FeatureRow& fr = obs.feats[static_cast<std::size_t>(longest - &obs.recs[0])].row;
        std::ostringstream top;
        for (const auto& c : longest->row.top_n) top << c.label << "=" << c.posterior << "(D " << c.distance << ") ";
        MESSAGE("最长段特征：帧 " << fr.frames << "、时长 " << fr.duration_s << " s、带宽 " << fr.bandwidth_Hz << " Hz、平坦度 "
                << fr.spectral_flatness << "、占空比 " << fr.duty << "、质量 " << fr.quality << "；识别 " << longest->row.result
                << " " << longest->row.label << "，top_n " << top.str());
    }
    CHECK(longest->row.result == "known");
    CHECK(longest->row.label == "cw_beacon");
    CHECK(rep.state == State::Valid);
}

