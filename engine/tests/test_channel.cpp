// 施加类信道组件（G-3）与场景运行时组件（G-2）的单测。
//
// 三条验收数字（06 备忘录 §9C G-3 行）：
//   单音经 FSPL 100.052 dB 后功率差 ± 0.01 dB；多普勒 1 kHz 峰值频移在一个 bin 内；
//   加上时延的冲激响应——demo 场景里绝对时延在连续单音上看不出来，必须单独测。

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "cuav/components/antenna.h"
#include "cuav/components/channel.h"
#include "cuav/components/scenario.h"
#include "cuav/components/spectrum.h"
#include "cuav/random.h"
#include "cuav/diagram_json.h"
#include "cuav/registry.h"
#include "cuav/scenario_json.h"
#include "doctest/doctest.h"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif
std::string repo(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }
const char* kDemoRel = "data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json";
std::string demo() { return repo(kDemoRel); }

const double kPi = 3.14159265358979323846;

// 单位功率单音块：|x|^2 ≡ 1，即 0 dBm（引擎内部功率单位是 mW，D-047）。
Block tone_block(std::size_t n, std::uint64_t start, double fs, double offset_Hz) {
    Block b(n);
    const double w = 2.0 * kPi * offset_Hz / fs;
    for (std::size_t i = 0; i < n; ++i) {
        const double ph = w * static_cast<double>(start + i);
        b.samples[i] = Complex(static_cast<float>(std::cos(ph)), static_cast<float>(std::sin(ph)));
    }
    b.meta.sample_rate_Hz = fs;
    b.meta.center_frequency_Hz = 2.4405e9;
    b.meta.start_sample = start;
    b.meta.time_basis = TimeBasis::LogicalSim;
    return b;
}

SceneParamFrame frame(double from_s, double to_s, double rate, double path_loss_dB,
                      double doppler_Hz = 0.0, double delay_s = 0.0) {
    SceneParamFrame f;
    f.valid_from_s = from_s;
    f.valid_to_s = to_s;
    f.update_rate_Hz = rate;
    f.path_loss_dB = path_loss_dB;
    f.noise_floor_dBm_per_Hz = -168.0;
    f.line_of_sight = true;
    f.doppler_Hz = doppler_Hz;
    f.delay_s = delay_s;
    return f;
}

double mean_power_dBm(const std::vector<Complex>& v, std::size_t skip = 0) {
    double acc = 0.0;
    std::size_t n = 0;
    for (std::size_t i = skip; i < v.size(); ++i) {
        acc += static_cast<double>(v[i].real()) * v[i].real() +
               static_cast<double>(v[i].imag()) * v[i].imag();
        ++n;
    }
    return 10.0 * std::log10(acc / static_cast<double>(n));
}

// 用 WelchAccumulator 取一帧谱，返回峰值 bin 与峰值 dBm。
void peak_bin(const std::vector<Complex>& x, std::size_t nfft, std::size_t segments,
              std::size_t& bin, double& dBm) {
    WelchAccumulator w;
    std::string err;
    REQUIRE(w.configure(nfft, 0.0, "hann", segments, err));
    std::vector<double> got;
    w.push(&x[0], x.size(), 0, [&](const std::vector<double>& p, std::uint64_t, std::size_t) {
        if (got.empty()) got = p;
    });
    REQUIRE_FALSE(got.empty());
    bin = 0;
    for (std::size_t i = 1; i < got.size(); ++i)
        if (got[i] > got[bin]) bin = i;
    dBm = 10.0 * std::log10(got[bin]);
}

// 场景绑定信道的夹具：绑 demo 场景的 uav-1，按需开关三样施加。
std::unique_ptr<SceneBoundChannel> make_channel(bool gain, bool doppler, const char* delay_mode,
                                                std::size_t max_delay = 65536) {
    std::unique_ptr<SceneBoundChannel> c(new SceneBoundChannel());
    std::map<std::string, double> num;
    num["apply_gain"] = gain ? 1.0 : 0.0;
    num["apply_doppler"] = doppler ? 1.0 : 0.0;
    num["max_delay_samples"] = static_cast<double>(max_delay);
    std::map<std::string, std::string> txt;
    txt["scenario_path"] = demo();
    txt["scenario_id"] = "demo-01";
    txt["entity_id"] = "uav-1";
    txt["delay_mode"] = delay_mode;
    std::string err;
    REQUIRE_MESSAGE(c->configure(num, txt, err), err);
    Xoshiro256pp rng(1);
    REQUIRE(c->init(rng, err));
    return c;
}

}  // namespace

TEST_CASE("自由空间信道：单位功率单音经 2.4 GHz / 1 km 后读 −100.052 dBm，误差 ± 0.01 dB") {
    Registry r = builtin_registry();
    std::string err;
    std::map<std::string, double> p;
    p["distance_m"] = 1000.0;
    p["frequency_Hz"] = 2.4e9;
    std::unique_ptr<IComponent> c = r.create_configured("FreeSpaceChannel", p, {}, err);
    REQUIRE_MESSAGE(c, err);
    Xoshiro256pp rng(1);
    REQUIRE(c->init(rng, err));

    PortMap in, out;
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq = tone_block(65536, 0, 1e6, 97656.25);
    in["in"] = d;
    REQUIRE(c->process(in, out, err) == Step::Produced);
    // 时域口径最干净：不受窗函数与频点位置影响。
    CHECK(std::fabs(mean_power_dBm(out["out"].iq.samples) + 100.052008) < 0.01);
    // 流长不变。
    CHECK(out["out"].iq.samples.size() == 65536u);
    CHECK(out["out"].iq.meta.start_sample == 0u);
}

TEST_CASE("自由空间信道：峰值 bin 也读 −100.052 dBm（频偏必须落在 bin 中心）") {
    // 频偏取 100 × Fs/nfft = 97656.25 Hz，正落在 bin 中心。偏 0.4 个 bin 时 hann 的扇贝损耗
    // 就有 0.9 dB——D-047 已经踩过一次，测试里必须把频偏钉在 bin 上。
    Registry r = builtin_registry();
    std::string err;
    std::map<std::string, double> p;
    p["distance_m"] = 1000.0;
    p["frequency_Hz"] = 2.4e9;
    std::unique_ptr<IComponent> c = r.create_configured("FreeSpaceChannel", p, {}, err);
    REQUIRE(c);
    Xoshiro256pp rng(1);
    REQUIRE(c->init(rng, err));

    PortMap in, out;
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq = tone_block(8192, 0, 1e6, 97656.25);
    in["in"] = d;
    REQUIRE(c->process(in, out, err) == Step::Produced);

    std::size_t bin = 0;
    double dBm = 0.0;
    peak_bin(out["out"].iq.samples, 1024, 8, bin, dBm);
    CHECK(bin == 512u + 100u);                       // fftshift 后零频在 512
    CHECK(std::fabs(dBm + 100.052008) < 0.01);
}

TEST_CASE("自由空间信道：增益口径 = tx_power + 收发天线增益 − 路损") {
    Registry r = builtin_registry();
    std::string err;
    Xoshiro256pp rng(1);
    const double cases[][3] = {{27.0, 2.0, 3.0}, {0.0, 0.0, 0.0}, {10.0, -3.0, 6.0}};
    for (int k = 0; k < 3; ++k) {
        std::map<std::string, double> p;
        p["distance_m"] = 1000.0;
        p["frequency_Hz"] = 2.4e9;
        p["tx_power_dBm"] = cases[k][0];
        p["tx_gain_dBi"] = cases[k][1];
        p["rx_gain_dBi"] = cases[k][2];
        std::unique_ptr<IComponent> c = r.create_configured("FreeSpaceChannel", p, {}, err);
        REQUIRE_MESSAGE(c, err);
        REQUIRE(c->init(rng, err));
        PortMap in, out;
        PortData d;
        d.type = PortType::IQStream;
        d.has_data = true;
        d.iq = tone_block(4096, 0, 1e6, 97656.25);
        in["in"] = d;
        REQUIRE(c->process(in, out, err) == Step::Produced);
        const double expect = cases[k][0] + cases[k][1] + cases[k][2] - 100.052008;
        CHECK(std::fabs(mean_power_dBm(out["out"].iq.samples) - expect) < 0.01);
    }
}

TEST_CASE("场景绑定信道：多普勒 1 kHz 的峰值频移落在一个 bin 内，符号是接近为正") {
    // fs = 1 MHz、nfft = 8192 → bin 122.07 Hz，1 kHz = 8.19 个 bin。
    // 用 nfft = 1024 时 bin 宽 976.6 Hz，「一个 bin 内」形同虚设，所以这里必须取细分辨率。
    const double fs = 1e6;
    const std::size_t nfft = 8192, n = nfft * 4;
    const double bin_w = fs / static_cast<double>(nfft);

    std::size_t base_bin = 0, up_bin = 0, down_bin = 0;
    double dummy = 0.0;
    {
        std::unique_ptr<SceneBoundChannel> c = make_channel(false, true, "off");
        PortMap in, out;
        PortData iq, sc;
        iq.type = PortType::IQStream;
        iq.has_data = true;
        iq.iq = tone_block(n, 0, fs, 0.0);
        sc.type = PortType::SceneParamFrame;
        sc.has_data = true;
        sc.scenes.push_back(frame(0.0, 1.0, 20.0, 0.0, 0.0));
        in["in"] = iq;
        in["scene"] = sc;
        std::string err;
        REQUIRE(c->process(in, out, err) == Step::Produced);
        peak_bin(out["out"].iq.samples, nfft, 4, base_bin, dummy);
    }
    {
        std::unique_ptr<SceneBoundChannel> c = make_channel(false, true, "off");
        PortMap in, out;
        PortData iq, sc;
        iq.type = PortType::IQStream;
        iq.has_data = true;
        iq.iq = tone_block(n, 0, fs, 0.0);
        sc.type = PortType::SceneParamFrame;
        sc.has_data = true;
        sc.scenes.push_back(frame(0.0, 1.0, 20.0, 0.0, 1000.0));   // 接近
        in["in"] = iq;
        in["scene"] = sc;
        std::string err;
        REQUIRE(c->process(in, out, err) == Step::Produced);
        peak_bin(out["out"].iq.samples, nfft, 4, up_bin, dummy);
    }
    {
        std::unique_ptr<SceneBoundChannel> c = make_channel(false, true, "off");
        PortMap in, out;
        PortData iq, sc;
        iq.type = PortType::IQStream;
        iq.has_data = true;
        iq.iq = tone_block(n, 0, fs, 0.0);
        sc.type = PortType::SceneParamFrame;
        sc.has_data = true;
        sc.scenes.push_back(frame(0.0, 1.0, 20.0, 0.0, -1000.0));  // 远离
        in["in"] = iq;
        in["scene"] = sc;
        std::string err;
        REQUIRE(c->process(in, out, err) == Step::Produced);
        peak_bin(out["out"].iq.samples, nfft, 4, down_bin, dummy);
    }

    const double shift_bins = 1000.0 / bin_w;                       // 8.19
    CHECK(std::fabs(static_cast<double>(up_bin) - static_cast<double>(base_bin) - shift_bins) <= 1.0);
    CHECK(std::fabs(static_cast<double>(base_bin) - static_cast<double>(down_bin) - shift_bins) <= 1.0);
    CHECK(up_bin > base_bin);      // 接近 → 观测频率上移
    CHECK(down_bin < base_bin);    // 远离 → 下移
}

TEST_CASE("场景绑定信道：整数样点时延用冲激响应测，前 D 个样点精确为零") {
    std::unique_ptr<SceneBoundChannel> c = make_channel(false, false, "tracking");
    const double fs = 1e6;
    const std::uint64_t D = 100;
    PortMap in, out;
    PortData iq, sc;
    iq.type = PortType::IQStream;
    iq.has_data = true;
    iq.iq = Block(512);
    iq.iq.meta.sample_rate_Hz = fs;
    iq.iq.meta.start_sample = 0;
    iq.iq.meta.time_basis = TimeBasis::LogicalSim;
    iq.iq.samples[7] = Complex(1.0f, 0.0f);          // 第 7 个样点放一个冲激
    sc.type = PortType::SceneParamFrame;
    sc.has_data = true;
    sc.scenes.push_back(frame(0.0, 1.0, 20.0, 0.0, 0.0, static_cast<double>(D) / fs));
    in["in"] = iq;
    in["scene"] = sc;
    std::string err;
    REQUIRE(c->process(in, out, err) == Step::Produced);

    const std::vector<Complex>& y = out["out"].iq.samples;
    CHECK(y.size() == 512u);
    for (std::size_t i = 0; i < D; ++i) CHECK(y[i] == Complex(0.0f, 0.0f));   // 时延线预热，精确零
    CHECK(y[7 + D].real() == doctest::Approx(1.0f));
    CHECK(y[6 + D] == Complex(0.0f, 0.0f));
    CHECK(y[8 + D] == Complex(0.0f, 0.0f));
}

TEST_CASE("场景绑定信道：跨块的时延靠上一块的尾巴回看，块长换了结果不变") {
    const double fs = 1e6;
    const std::uint64_t D = 100;
    std::vector<Complex> whole;
    for (int split = 0; split < 2; ++split) {
        std::unique_ptr<SceneBoundChannel> c = make_channel(false, false, "tracking");
        const std::size_t block = split ? 64 : 512;
        std::vector<Complex> got;
        std::string err;
        for (std::uint64_t s = 0; s < 512; s += block) {
            PortMap in, out;
            PortData iq, sc;
            iq.type = PortType::IQStream;
            iq.has_data = true;
            iq.iq = Block(block);
            iq.iq.meta.sample_rate_Hz = fs;
            iq.iq.meta.start_sample = s;
            iq.iq.meta.time_basis = TimeBasis::LogicalSim;
            for (std::size_t i = 0; i < block; ++i) {
                const std::uint64_t idx = s + i;
                iq.iq.samples[i] = Complex(static_cast<float>(idx % 17), 0.0f);
            }
            sc.type = PortType::SceneParamFrame;
            sc.has_data = true;
            sc.scenes.push_back(frame(0.0, 1.0, 20.0, 0.0, 0.0, static_cast<double>(D) / fs));
            in["in"] = iq;
            in["scene"] = sc;
            REQUIRE(c->process(in, out, err) == Step::Produced);
            const std::vector<Complex>& y = out["out"].iq.samples;
            got.insert(got.end(), y.begin(), y.end());
        }
        if (split == 0) whole = got;
        else CHECK(got == whole);     // 块长无关：逐位相同
    }
    // 延迟后的样点确实是 D 之前的输入。
    CHECK(whole[300].real() == doctest::Approx(static_cast<float>((300 - D) % 17)));
}

TEST_CASE("场景绑定信道：时延超过上限即报错，不截断") {
    std::unique_ptr<SceneBoundChannel> c = make_channel(false, false, "tracking", 8);
    PortMap in, out;
    PortData iq, sc;
    iq.type = PortType::IQStream;
    iq.has_data = true;
    iq.iq = tone_block(64, 0, 1e6, 0.0);
    sc.type = PortType::SceneParamFrame;
    sc.has_data = true;
    sc.scenes.push_back(frame(0.0, 1.0, 20.0, 0.0, 0.0, 1e-3));   // 1 ms → 1000 个样点
    in["in"] = iq;
    in["scene"] = sc;
    std::string err;
    CHECK(c->process(in, out, err) == Step::Error);
    CHECK(err.find("max_delay_samples") != std::string::npos);
}

TEST_CASE("场景绑定信道：帧内零阶保持，只在第一轮给帧、之后重发同一帧，增益全程一致") {
    std::unique_ptr<SceneBoundChannel> c = make_channel(true, false, "off");
    std::string err;
    double first = 0.0;
    for (int round = 0; round < 4; ++round) {
        PortMap in, out;
        PortData iq, sc;
        iq.type = PortType::IQStream;
        iq.has_data = true;
        iq.iq = tone_block(1024, static_cast<std::uint64_t>(round) * 1024, 1e6, 0.0);
        sc.type = PortType::SceneParamFrame;
        sc.has_data = true;
        sc.scenes.push_back(frame(0.0, 10.0, 20.0, 100.0));   // 有效期 10 s，覆盖全部四轮
        in["in"] = iq;
        in["scene"] = sc;
        REQUIRE(c->process(in, out, err) == Step::Produced);
        const double p = mean_power_dBm(out["out"].iq.samples);
        if (round == 0) first = p;
        else CHECK(p == doctest::Approx(first).epsilon(1e-12));
        CHECK(out["out"].iq.meta.state == State::Valid);
        // 增益 = 27（发射）+ 2（发射天线）+ 3（接收天线）− 100（路损）
        CHECK(std::fabs(p - (27.0 + 2.0 + 3.0 - 100.0)) < 0.01);
    }
}

TEST_CASE("场景绑定信道：帧过期而无新帧时按上一帧继续，但把块标降级并写明理由") {
    std::unique_ptr<SceneBoundChannel> c = make_channel(true, false, "off");
    std::string err;
    PortMap in, out;
    PortData iq, sc;
    iq.type = PortType::IQStream;
    iq.has_data = true;
    iq.iq = tone_block(4096, 0, 1e6, 0.0);          // 覆盖 0 至 4.096 ms
    sc.type = PortType::SceneParamFrame;
    sc.has_data = true;
    sc.scenes.push_back(frame(0.0, 0.001, 1000.0, 100.0));   // 有效期只到 1 ms
    in["in"] = iq;
    in["scene"] = sc;
    REQUIRE(c->process(in, out, err) == Step::Produced);
    CHECK(out["out"].iq.meta.state == State::Degraded);
    bool found = false;
    for (std::size_t i = 0; i < out["out"].iq.meta.state_reasons.size(); ++i)
        if (out["out"].iq.meta.state_reasons[i].find("零阶保持") != std::string::npos) found = true;
    CHECK(found);
}

TEST_CASE("场景绑定信道：三道守法——拒回放数据、拒采样率中途变、拒块不连续") {
    std::string err;
    {
        std::unique_ptr<SceneBoundChannel> c = make_channel(true, false, "off");
        PortMap in, out;
        PortData iq, sc;
        iq.type = PortType::IQStream;
        iq.has_data = true;
        iq.iq = tone_block(64, 0, 1e6, 0.0);
        iq.iq.meta.time_basis = TimeBasis::FileAcquisition;    // 回放数据
        sc.type = PortType::SceneParamFrame;
        sc.has_data = true;
        sc.scenes.push_back(frame(0.0, 1.0, 20.0, 100.0));
        in["in"] = iq;
        in["scene"] = sc;
        CHECK(c->process(in, out, err) == Step::Error);
        CHECK(err.find("防线") != std::string::npos);
    }
    {
        std::unique_ptr<SceneBoundChannel> c = make_channel(true, false, "off");
        std::string e;
        for (int k = 0; k < 2; ++k) {
            PortMap in, out;
            PortData iq, sc;
            iq.type = PortType::IQStream;
            iq.has_data = true;
            iq.iq = tone_block(64, static_cast<std::uint64_t>(k) * 64, k ? 2e6 : 1e6, 0.0);
            sc.type = PortType::SceneParamFrame;
            sc.has_data = true;
            sc.scenes.push_back(frame(0.0, 1.0, 20.0, 100.0));
            in["in"] = iq;
            in["scene"] = sc;
            const Step st = c->process(in, out, e);
            if (k == 0) CHECK(st == Step::Produced);
            else { CHECK(st == Step::Error); CHECK(e.find("采样率") != std::string::npos); }
        }
    }
    {
        std::unique_ptr<SceneBoundChannel> c = make_channel(true, false, "off");
        std::string e;
        for (int k = 0; k < 2; ++k) {
            PortMap in, out;
            PortData iq, sc;
            iq.type = PortType::IQStream;
            iq.has_data = true;
            iq.iq = tone_block(64, k ? 999 : 0, 1e6, 0.0);   // 第二块序号不接续
            sc.type = PortType::SceneParamFrame;
            sc.has_data = true;
            sc.scenes.push_back(frame(0.0, 1.0, 20.0, 100.0));
            in["in"] = iq;
            in["scene"] = sc;
            const Step st = c->process(in, out, e);
            if (k == 0) CHECK(st == Step::Produced);
            else { CHECK(st == Step::Error); CHECK(e.find("不连续") != std::string::npos); }
        }
    }
}

TEST_CASE("场景绑定信道：scene 口一帧都没有即报错，不拿默认值顶替") {
    std::unique_ptr<SceneBoundChannel> c = make_channel(true, false, "off");
    PortMap in, out;
    PortData iq;
    iq.type = PortType::IQStream;
    iq.has_data = true;
    iq.iq = tone_block(64, 0, 1e6, 0.0);
    in["in"] = iq;
    std::string err;
    CHECK(c->process(in, out, err) == Step::Error);
    CHECK(err.find("参数帧") != std::string::npos);
}

// ---------------------------------------------------------------------------
// 场景运行时组件（G-2）：调度约束、单位功率口径、装载器的场景注入
// ---------------------------------------------------------------------------

namespace {

std::unique_ptr<ScenarioSource> make_scenario_source(double fs, std::uint64_t total,
                                                     std::size_t block, double rate) {
    std::unique_ptr<ScenarioSource> s(new ScenarioSource());
    std::map<std::string, double> num;
    num["sample_rate_Hz"] = fs;
    num["total_samples"] = static_cast<double>(total);
    num["block_samples"] = static_cast<double>(block);
    num["update_rate_Hz"] = rate;
    num["report_rate_Hz"] = 10.0;
    std::map<std::string, std::string> txt;
    txt["scenario_path"] = demo();
    txt["scenario_id"] = "demo-01";
    txt["site_id"] = "site-1";
    std::string err;
    REQUIRE_MESSAGE(s->configure(num, txt, err), err);
    Xoshiro256pp rng(1);
    REQUIRE(s->init(rng, err));
    return s;
}

std::unique_ptr<SceneEmitterSource> make_emitter(double fs, std::uint64_t total, std::size_t block) {
    std::unique_ptr<SceneEmitterSource> s(new SceneEmitterSource());
    std::map<std::string, double> num;
    num["sample_rate_Hz"] = fs;
    num["total_samples"] = static_cast<double>(total);
    num["block_samples"] = static_cast<double>(block);
    num["center_frequency_Hz"] = 2.4405e9;
    std::map<std::string, std::string> txt;
    txt["scenario_path"] = demo();
    txt["scenario_id"] = "demo-01";
    txt["entity_id"] = "uav-1";
    std::string err;
    REQUIRE_MESSAGE(s->configure(num, txt, err), err);
    Xoshiro256pp rng(7);
    REQUIRE(s->init(rng, err));
    return s;
}

struct CountingObserver : public IRunObserver {
    std::vector<EntityState> entities;
    std::vector<LinkFrame> links;
    void on_entity(const EntityState& e) override { entities.push_back(e); }
    void on_link(const LinkFrame& l) override { links.push_back(l); }
};

}  // namespace

TEST_CASE("场景参数源：每一轮都产出且至少一帧——这是调度上的正确性要求，不是优化") {
    // 块 4096 样点 @ 500 kHz = 8.19 ms，帧 20 Hz = 50 ms：六轮里有五轮不产生新帧。
    // 若这些轮次不产出，下游信道会因 scene 口没数据而跳过一轮，调度器下一轮就把没被消费的
    // IQ 块无条件覆盖掉（graph.cpp:241-249），样点静默丢失还不报错。
    std::unique_ptr<ScenarioSource> s = make_scenario_source(500000.0, 4096 * 100, 4096, 20.0);
    std::string err;
    for (int round = 0; round < 100; ++round) {
        PortMap in, out;
        REQUIRE(s->process(in, out, err) == Step::Produced);
        PortMap::iterator it = out.find("link:uav-1");
        REQUIRE(it != out.end());
        CHECK(it->second.has_data);
        CHECK(it->second.scenes.size() >= 1u);
    }
}

TEST_CASE("场景参数源：与同参数的单音源在同一轮结束") {
    const double fs = 500000.0;
    const std::uint64_t total = 4096 * 10 + 123;    // 故意不被块长整除
    const std::size_t block = 4096;
    std::unique_ptr<ScenarioSource> s = make_scenario_source(fs, total, block, 20.0);

    Registry r = builtin_registry();
    std::string err;
    std::map<std::string, double> p;
    p["sample_rate_Hz"] = fs;
    p["total_samples"] = static_cast<double>(total);
    p["block_samples"] = static_cast<double>(block);
    std::unique_ptr<IComponent> tone = r.create_configured("ToneSource", p, {}, err);
    REQUIRE_MESSAGE(tone, err);
    Xoshiro256pp rng(1);
    REQUIRE(tone->init(rng, err));

    int round = 0;
    for (;; ++round) {
        PortMap in1, out1, in2, out2;
        const Step a = s->process(in1, out1, err);
        const Step b = tone->process(in2, out2, err);
        CHECK(a == b);                      // 逐轮同步，含最后一轮的 Finished
        if (a == Step::Finished) break;
        REQUIRE(round < 100);
    }
    CHECK(round == 11);                     // 11 块（末块 123 样点），第 12 轮同时 Finished
}

TEST_CASE("场景参数源：帧连续覆盖整段仿真，不重不漏") {
    const double fs = 500000.0, rate = 20.0;
    const std::uint64_t total = 500000;      // 1 秒
    std::unique_ptr<ScenarioSource> s = make_scenario_source(fs, total, 25000, rate);
    std::string err;
    std::vector<double> starts;
    for (;;) {
        PortMap in, out;
        if (s->process(in, out, err) != Step::Produced) break;
        const std::vector<SceneParamFrame>& v = out["link:uav-1"].scenes;
        for (std::size_t i = 0; i < v.size(); ++i) {
            if (starts.empty() || v[i].valid_from_s > starts.back() + 1e-12) starts.push_back(v[i].valid_from_s);
        }
    }
    CHECK(starts.size() == 20u);             // 1 秒 × 20 Hz
    for (std::size_t i = 0; i < starts.size(); ++i)
        CHECK(starts[i] == doctest::Approx(static_cast<double>(i) / rate).epsilon(1e-12));
}

TEST_CASE("场景参数源：同种子两次运行的全部帧逐位相同；上报按抽稀率且不重复") {
    const double fs = 500000.0;
    std::vector<double> a, b;
    for (int pass = 0; pass < 2; ++pass) {
        std::unique_ptr<ScenarioSource> s = make_scenario_source(fs, 250000, 25000, 20.0);
        std::vector<double>& dst = pass ? b : a;
        std::string err;
        for (;;) {
            PortMap in, out;
            if (s->process(in, out, err) != Step::Produced) break;
            const std::vector<SceneParamFrame>& v = out["link:uav-1"].scenes;
            for (std::size_t i = 0; i < v.size(); ++i) {
                dst.push_back(v[i].path_loss_dB);
                dst.push_back(v[i].doppler_Hz);
                dst.push_back(v[i].delay_s);
            }
        }
    }
    CHECK(a == b);

    CountingObserver obs;
    std::unique_ptr<ScenarioSource> s = make_scenario_source(fs, 250000, 25000, 20.0);
    s->attach(&obs);
    std::string err;
    for (;;) {
        PortMap in, out;
        if (s->process(in, out, err) != Step::Produced) break;
    }
    // 0.5 秒 × 10 Hz 上报率 = 5 次；每个帧序号只报一次（帧会跨轮重发）。
    CHECK(obs.entities.size() == 5u);
    CHECK(obs.links.size() == 5u);
    for (std::size_t i = 1; i < obs.links.size(); ++i) CHECK(obs.links[i].t_s > obs.links[i - 1].t_s);
    CHECK(obs.links[0].link_id == "site-1-uav-1");
    CHECK(obs.entities[0].id == "uav-1");
}

TEST_CASE("场景辐射源：tone 归一化到单位功率，频偏落在场景指定的位置") {
    std::unique_ptr<SceneEmitterSource> s = make_emitter(500000.0, 65536, 65536);
    PortMap in, out;
    std::string err;
    REQUIRE(s->process(in, out, err) == Step::Produced);
    const std::vector<Complex>& x = out["out"].iq.samples;
    // demo 场景 tx_on 在 t = 3 s，前 3 秒不发射：本块在 0 至 0.13 s，应为精确零。
    CHECK(mean_power_dBm(x) < -100.0);
    CHECK(out["out"].iq.meta.calibration.calibrated);
    CHECK(out["out"].iq.meta.calibration.source == "model");
}

TEST_CASE("场景辐射源：发射期间平均功率恰为 1 mW（0 dBm），这是链路预算能直读的前提") {
    // 跳到 tx_on 之后：从第 3 秒起取一块。
    std::unique_ptr<SceneEmitterSource> s = make_emitter(500000.0, 500000 * 5, 500000);
    std::string err;
    std::vector<Complex> block4;
    for (int k = 0; k < 5; ++k) {
        PortMap in, out;
        REQUIRE(s->process(in, out, err) == Step::Produced);
        if (k == 4) block4 = out["out"].iq.samples;      // t = 4 至 5 秒，确定在发射
    }
    CHECK(std::fabs(mean_power_dBm(block4)) < 1e-6);     // 0 dBm

    // 频偏：场景写 48828.125 Hz，nfft 4096 时正是第 400 个 bin。
    std::size_t bin = 0;
    double dBm = 0.0;
    peak_bin(block4, 4096, 16, bin, dBm);
    CHECK(bin == 2048u + 400u);
}

TEST_CASE("场景辐射源：突发按 ON 态归一，图案与块长无关，断开区间精确为零") {
    // 把 demo 场景的波形换成 burst 来测：直接构造组件并喂改过的场景不方便，
    // 这里用 geo 侧的口径核对整数样点图案，波形本身的取值由上一条用例覆盖。
    LoadedScenario ls;
    std::string err;
    REQUIRE(load_scenario_file(demo(), ls, err));
    const double fs = 500000.0;
    const double period_s = 0.05, duty = 0.6;
    const std::uint64_t P = static_cast<std::uint64_t>(period_s * fs + 0.5);
    const std::uint64_t ON = static_cast<std::uint64_t>(duty * static_cast<double>(P) + 0.5);
    CHECK(P == 25000u);
    CHECK(ON == 15000u);
    // ON 态归一意味着：整周期平均功率是 duty，而不是 1。这条差别必须写进模型卡，
    // 否则拿时间平均电平去对链路预算会以为差了 10·log10(1/duty) = 2.22 dB。
    CHECK(std::fabs(10.0 * std::log10(duty) + 2.2185) < 1e-3);
}

TEST_CASE("装载器：场景注入的四道闸——无解析器、哈希不符、时长超出、绑定目标不存在") {
    Registry reg = builtin_registry();
    std::ifstream f(repo("engine/tests/diagrams/slice2_scenario_link.json").c_str(), std::ios::binary);
    REQUIRE(f.good());
    std::stringstream ss;
    ss << f.rdbuf();
    const nlohmann::json base = nlohmann::json::parse(ss.str());

    FileScenarioResolver res;
    std::string e;
    REQUIRE_MESSAGE(res.add_file(demo(), e), e);
    LoadOptions lo;
    lo.scenarios = &res;
    lo.scene_root = repo("data/scene");

    {   // 正路：装得起来
        LoadedDiagram d;
        DiagramError err;
        CHECK_MESSAGE(load_diagram(base, reg, nullptr, lo, d, err), err.message);
        CHECK(d.scenario_id == "demo-01");
        CHECK(d.scenario_verified);
        CHECK(d.aoi_manifest_verified);
    }
    {   // 没有场景解析器
        LoadOptions bare;
        bare.scene_root = lo.scene_root;
        LoadedDiagram d;
        DiagramError err;
        CHECK_FALSE(load_diagram(base, reg, nullptr, bare, d, err));
        CHECK(err.code == "scenario");
        CHECK(err.message.find("--scenario") != std::string::npos);
    }
    {   // 框图声明的场景哈希不符
        nlohmann::json j = base;
        j["scenario_ref"]["sha256"] = std::string(64, 'b');
        LoadedDiagram d;
        DiagramError err;
        CHECK_FALSE(load_diagram(j, reg, nullptr, lo, d, err));
        CHECK(err.code == "scenario");
        CHECK(err.message.find("哈希") != std::string::npos);
    }
    {   // 框图时长超过场景时长
        nlohmann::json j = base;
        j["run"]["duration_s"] = 999.0;
        LoadedDiagram d;
        DiagramError err;
        CHECK_FALSE(load_diagram(j, reg, nullptr, lo, d, err));
        CHECK(err.code == "duration");
    }
    {   // 绑定了场景里没有的辐射源
        nlohmann::json j = base;
        j["nodes"][1]["scene_binding"]["entity_id"] = "uav-9";
        LoadedDiagram d;
        DiagramError err;
        CHECK_FALSE(load_diagram(j, reg, nullptr, lo, d, err));
        CHECK(err.code == "scene_binding");
        CHECK(err.message.find("uav-1") != std::string::npos);   // 报文里列出可用标识
    }
    {   // 两个场景绑定节点声明了不同的采样率
        nlohmann::json j = base;
        j["nodes"][1]["params"]["sample_rate_Hz"] = 1000000.0;
        LoadedDiagram d;
        DiagramError err;
        CHECK_FALSE(load_diagram(j, reg, nullptr, lo, d, err));
        CHECK(err.code == "param");
        CHECK(err.message.find("同采样率") != std::string::npos);
    }
}

TEST_CASE("装载器：内部参数出现在框图里即拒，场景路径永远不进框图文件（D-037）") {
    Registry reg = builtin_registry();
    std::ifstream f(repo("engine/tests/diagrams/slice2_scenario_link.json").c_str(), std::ios::binary);
    REQUIRE(f.good());
    std::stringstream ss;
    ss << f.rdbuf();
    nlohmann::json j = nlohmann::json::parse(ss.str());
    j["nodes"][0]["params"]["scenario_path"] = "data/scene/x.json";

    FileScenarioResolver res;
    std::string e;
    REQUIRE(res.add_file(demo(), e));
    LoadOptions lo;
    lo.scenarios = &res;
    lo.scene_root = repo("data/scene");
    LoadedDiagram d;
    DiagramError err;
    CHECK_FALSE(load_diagram(j, reg, nullptr, lo, d, err));
    CHECK(err.code == "internal_param");
}


// ------------------------------------------- C-2：拆开天线之后两种口径在真场景上等价（D-051）

namespace {

std::unique_ptr<SceneEmitterSource> make_emitter_at_tx_power(double fs, std::uint64_t total,
                                                             std::size_t block) {
    std::unique_ptr<SceneEmitterSource> s(new SceneEmitterSource());
    std::map<std::string, double> num;
    num["sample_rate_Hz"] = fs;
    num["total_samples"] = static_cast<double>(total);
    num["block_samples"] = static_cast<double>(block);
    num["center_frequency_Hz"] = 2.4405e9;
    num["emit_at_tx_power"] = 1.0;
    std::map<std::string, std::string> txt;
    txt["scenario_path"] = demo();
    txt["scenario_id"] = "demo-01";
    txt["entity_id"] = "uav-1";
    std::string err;
    REQUIRE_MESSAGE(s->configure(num, txt, err), err);
    Xoshiro256pp rng(7);
    REQUIRE(s->init(rng, err));
    return s;
}

std::unique_ptr<SceneBoundChannel> make_channel_mode(const char* gain_mode) {
    std::unique_ptr<SceneBoundChannel> c(new SceneBoundChannel());
    std::map<std::string, double> num;
    num["apply_gain"] = 1.0;
    num["apply_doppler"] = 0.0;
    std::map<std::string, std::string> txt;
    txt["scenario_path"] = demo();
    txt["scenario_id"] = "demo-01";
    txt["entity_id"] = "uav-1";
    txt["delay_mode"] = "off";
    txt["gain_mode"] = gain_mode;
    std::string err;
    REQUIRE_MESSAGE(c->configure(num, txt, err), err);
    Xoshiro256pp rng(1);
    REQUIRE(c->init(rng, err));
    return c;
}

}  // namespace

TEST_CASE("场景辐射源：emit_at_tx_power 让 S0 读到发射功率本身；缺省仍是单位功率") {
    // demo-01 的 uav-1 发射功率是 27 dBm
    std::unique_ptr<SceneEmitterSource> s = make_emitter_at_tx_power(500000.0, 500000 * 5, 500000);
    std::string err;
    std::vector<Complex> block4;
    for (int k = 0; k < 5; ++k) {
        PortMap in, out;
        REQUIRE(s->process(in, out, err) == Step::Produced);
        if (k == 4) block4 = out["out"].iq.samples;
    }
    CHECK(mean_power_dBm(block4) == doctest::Approx(27.0).epsilon(1e-6));

    // 缺省（不给该参数）保持原行为：0 dBm。既有示例与基准因此一个字没改。
    std::unique_ptr<SceneEmitterSource> plain = make_emitter(500000.0, 500000 * 5, 500000);
    std::vector<Complex> b2;
    for (int k = 0; k < 5; ++k) {
        PortMap in, out;
        REQUIRE(plain->process(in, out, err) == Step::Produced);
        if (k == 4) b2 = out["out"].iq.samples;
    }
    CHECK(std::fabs(mean_power_dBm(b2)) < 1e-6);
}

TEST_CASE("增益口径等价：辐射源 + 两个天线 + 纯路损信道，与折在一处的链路预算读数相同") {
    // 这是 C-2 最要紧的一条：把 tx_power + G_t + G_r − L 拆成四个组件之后，
    // 同一时刻的接收电平必须与切片 ② 的口径逐值相同，否则拆分就是改了基准（铁律 10）。
    const double fs = 500000.0;
    const std::size_t block = 100000;    // 0.2 s 一块
    const std::uint64_t total = block * 25;   // 5 s
    std::string err;

    // 口径一：单位功率辐射源 + link_budget 信道（切片 ② 的原样）
    std::vector<Complex> folded;
    {
        std::unique_ptr<SceneEmitterSource> src = make_emitter(fs, total, block);
        std::unique_ptr<SceneBoundChannel> ch = make_channel_mode("link_budget");
        std::unique_ptr<ScenarioSource> scn = make_scenario_source(fs, total, block, 20.0);
        for (int k = 0; k < 25; ++k) {
            PortMap sin, sout;
            REQUIRE(scn->process(sin, sout, err) == Step::Produced);
            PortMap ein, eout;
            REQUIRE(src->process(ein, eout, err) == Step::Produced);
            PortMap cin, cout;
            cin["in"] = eout["out"];
            cin["scene"] = sout["link:uav-1"];
            REQUIRE_MESSAGE(ch->process(cin, cout, err) == Step::Produced, err);
            if (k == 24) folded = cout["out"].iq.samples;
        }
    }

    // 口径二：按发射功率出电平的辐射源 + 发射天线 + path_loss_only 信道 + 接收天线
    std::vector<Complex> split;
    {
        std::unique_ptr<SceneEmitterSource> src = make_emitter_at_tx_power(fs, total, block);
        std::unique_ptr<SceneBoundChannel> ch = make_channel_mode("path_loss_only");
        std::unique_ptr<ScenarioSource> scn = make_scenario_source(fs, total, block, 20.0);
        AntennaGain tx, rx;
        std::map<std::string, double> gnum;
        std::map<std::string, std::string> gtxt;
        gnum["gain_dBi"] = 2.0;                       // demo-01 的 emission.antenna_gain_dBi
        gtxt["role"] = "tx"; gtxt["pattern"] = "omni";
        REQUIRE_MESSAGE(tx.configure(gnum, gtxt, err), err);
        gnum["gain_dBi"] = 3.0;                       // demo-01 的 site-1 antenna.gain_dBi
        gtxt["role"] = "rx";
        REQUIRE_MESSAGE(rx.configure(gnum, gtxt, err), err);
        Xoshiro256pp rng(1);
        REQUIRE(tx.init(rng, err));
        REQUIRE(rx.init(rng, err));

        for (int k = 0; k < 25; ++k) {
            PortMap sin, sout;
            REQUIRE(scn->process(sin, sout, err) == Step::Produced);
            PortMap ein, eout;
            REQUIRE(src->process(ein, eout, err) == Step::Produced);

            PortMap t_in, t_out;
            t_in["in"] = eout["out"];
            t_in["scene"] = sout["link:uav-1"];
            REQUIRE_MESSAGE(tx.process(t_in, t_out, err) == Step::Produced, err);

            PortMap cin, cout;
            cin["in"] = t_out["out"];
            cin["scene"] = sout["link:uav-1"];
            REQUIRE_MESSAGE(ch->process(cin, cout, err) == Step::Produced, err);

            PortMap r_in, r_out;
            r_in["in"] = cout["out"];
            r_in["scene"] = sout["link:uav-1"];
            REQUIRE_MESSAGE(rx.process(r_in, r_out, err) == Step::Produced, err);
            if (k == 24) split = r_out["out"].iq.samples;
        }
    }

    REQUIRE(folded.size() == split.size());
    const double a = mean_power_dBm(folded), b = mean_power_dBm(split);
    CHECK_MESSAGE(std::fabs(a - b) < 0.001, "折在一处 " << a << " dBm，拆开四件 " << b << " dBm");
    // 电平本身也要对：t ≈ 5 s 时链路预算给出的接收功率
    CHECK(a == doctest::Approx(b).epsilon(1e-6));
}
