// 组件与端到端链路的单元测试。
#include "doctest/doctest.h"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include "cuav/graph.h"
#include "cuav/components/processing.h"
#include "cuav/components/sources.h"

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
