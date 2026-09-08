// 天线、接收机前端与 ADC 三件的单元测试（06 备忘录 §9G C-2；决策 D-051、D-050）。
//
// 判据全部来自 10 号报告 §3.2 / §3.4 / §3.5 的解析锚点：能算出闭式值的用闭式对拍，
// 随机量用蒙特卡洛矩校验（铁律 9），不拿"跑出来是多少就是多少"当基准。
#include "doctest/doctest.h"

#include <cmath>
#include <complex>
#include <cstdlib>
#include <fstream>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/components/antenna.h"
#include "cuav/components/receiver.h"
#include "cuav/graph.h"
#include "cuav/random.h"
#include "cuav/platform.h"
#include "cuav/registry.h"

using namespace cuav;

namespace {

using Num = std::map<std::string, double>;
using Txt = std::map<std::string, std::string>;

// 造一块给定幅度的常量复样点，采样率与中心频率照给。
Block const_block(std::size_t n, double amp, double fs, std::uint64_t start = 0) {
    Block b(n);
    for (std::size_t i = 0; i < n; ++i) b.samples[i] = Complex(static_cast<float>(amp), 0.0f);
    b.meta.sample_rate_Hz = fs;
    b.meta.center_frequency_Hz = 2.44e9;
    b.meta.start_sample = start;
    return b;
}

PortData wrap(const Block& b) {
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq = b;
    return d;
}

double mean_power(const std::vector<Complex>& v) {
    double s = 0.0;
    for (std::size_t i = 0; i < v.size(); ++i) {
        const double re = v[i].real(), im = v[i].imag();
        s += re * re + im * im;
    }
    return v.empty() ? 0.0 : s / static_cast<double>(v.size());
}

}  // namespace

// ------------------------------------------------------------------ AntennaGain

TEST_CASE("天线：全向就是常量增益，接收端另减馈线损耗，发射端不减") {
    AntennaGain rx;
    std::string err;
    REQUIRE(rx.configure(Num{{"gain_dBi", 3.0}, {"feeder_loss_dB", 1.5}},
                         Txt{{"role", "rx"}, {"pattern", "omni"}}, err));
    CHECK(rx.gain_at_dB(0.0, 0.0) == doctest::Approx(1.5));
    CHECK(rx.gain_at_dB(123.0, -40.0) == doctest::Approx(1.5));   // 全向与方向无关

    AntennaGain tx;
    REQUIRE(tx.configure(Num{{"gain_dBi", 3.0}, {"feeder_loss_dB", 1.5}},
                         Txt{{"role", "tx"}, {"pattern", "omni"}}, err));
    // 馈线损耗只在接收端计一次，两端各计一次会重复
    CHECK(tx.gain_at_dB(0.0, 0.0) == doctest::Approx(3.0));
}

TEST_CASE("天线：定向方向图的三个解析锚点（EM-B-07 §10.3 的 E1 抽象）") {
    AntennaGain a;
    std::string err;
    REQUIRE(a.configure(Num{{"gain_dBi", 12.0}, {"beamwidth_az_deg", 60.0},
                            {"beamwidth_el_deg", 60.0}, {"sidelobe_dB", 20.0}},
                        Txt{{"role", "tx"}, {"pattern", "directional"}}, err));
    // 视轴上是峰值增益
    CHECK(a.gain_at_dB(0.0, 0.0) == doctest::Approx(12.0));
    // Δ = θ/2 = 30° 处恰好 3 dB —— 这正是半功率波束宽度的定义
    CHECK(a.gain_at_dB(30.0, 0.0) == doctest::Approx(12.0 - 3.0));
    CHECK(a.gain_at_dB(0.0, 30.0) == doctest::Approx(12.0 - 3.0));
    // Δaz = 90° 时 12·(1.5)² = 27 dB，被副瓣底 20 dB 截住
    CHECK(a.gain_at_dB(90.0, 0.0) == doctest::Approx(12.0 - 20.0));
    // 方位差按 (−180, 180] 归约：+350° 等价于 −10°
    CHECK(a.gain_at_dB(350.0, 0.0) == doctest::Approx(a.gain_at_dB(-10.0, 0.0)));
}

TEST_CASE("天线：极化失配五档表，且只在接收端计一次") {
    std::string err;
    struct Case { const char* mine; const char* peer; double loss; };
    const Case cases[] = {
        {"vertical", "vertical", 0.0},
        {"vertical", "horizontal", 20.0},
        {"horizontal", "vertical", 20.0},
        {"vertical", "slant45", 3.0},
        {"slant45", "horizontal", 3.0},
        {"rhcp", "lhcp", 20.0},
        {"rhcp", "rhcp", 0.0},
        {"vertical", "rhcp", 3.0},
        {"lhcp", "horizontal", 3.0},
    };
    for (const Case& c : cases) {
        AntennaGain rx;
        REQUIRE(rx.configure(Num{{"gain_dBi", 0.0}},
                             Txt{{"role", "rx"}, {"polarization", c.mine},
                                 {"peer_polarization", c.peer}}, err));
        CHECK_MESSAGE(rx.polarization_loss_dB() == doctest::Approx(c.loss),
                      c.mine << " vs " << c.peer);
        AntennaGain tx;
        REQUIRE(tx.configure(Num{{"gain_dBi", 0.0}},
                             Txt{{"role", "tx"}, {"polarization", c.mine},
                                 {"peer_polarization", c.peer}}, err));
        CHECK(tx.polarization_loss_dB() == doctest::Approx(0.0));
    }
}

TEST_CASE("天线：scene 口未接时按常量方向施加，并记一条说明（不是静默顶替）") {
    AntennaGain a;
    std::string err;
    REQUIRE(a.configure(Num{{"gain_dBi", 6.0}, {"aspect_az_deg", 0.0}},
                        Txt{{"role", "tx"}, {"pattern", "omni"}}, err));
    Xoshiro256pp rng(1);
    REQUIRE(a.init(rng, err));

    PortMap in, out;
    in["in"] = wrap(const_block(64, 1.0, 1e6));
    REQUIRE(a.process(in, out, err) == Step::Produced);
    const double g = std::pow(10.0, 6.0 / 20.0);
    CHECK(out["out"].iq.samples[0].real() == doctest::Approx(g).epsilon(1e-6));
    CHECK(out["out"].iq.samples.size() == 64);          // 不改变流长度
    REQUIRE(a.status().notes.size() == 1);
    CHECK(a.status().notes[0].find("scene 口未接") != std::string::npos);
}

TEST_CASE("天线：接了 scene 口就按帧里的角度逐样点施加，tx 用离开角、rx 用到达角") {
    // 一帧：离开角 0°（对准），到达角 30°（偏离半个波束）
    SceneParamFrame f;
    f.valid_from_s = 0.0;
    f.valid_to_s = 1.0;
    f.update_rate_Hz = 1.0;
    f.aod_az_deg = 0.0;
    f.aod_el_deg = 0.0;
    f.aoa_az_deg = 30.0;
    f.aoa_el_deg = 0.0;

    for (int role = 0; role < 2; ++role) {
        AntennaGain a;
        std::string err;
        REQUIRE(a.configure(Num{{"gain_dBi", 10.0}, {"beamwidth_az_deg", 60.0}, {"beamwidth_el_deg", 60.0}},
                            Txt{{"role", role == 0 ? "tx" : "rx"}, {"pattern", "directional"}}, err));
        Xoshiro256pp rng(1);
        REQUIRE(a.init(rng, err));
        PortMap in, out;
        in["in"] = wrap(const_block(16, 1.0, 1e6));
        PortData sd;
        sd.type = PortType::SceneParamFrame;
        sd.has_data = true;
        sd.scenes.push_back(f);
        in["scene"] = sd;
        REQUIRE(a.process(in, out, err) == Step::Produced);
        // tx 用离开角 0° → 满增益 10 dB；rx 用到达角 30° → 10 − 3 = 7 dB
        const double want_dB = (role == 0) ? 10.0 : 7.0;
        const double g = std::pow(10.0, want_dB / 20.0);
        CHECK_MESSAGE(out["out"].iq.samples[0].real() == doctest::Approx(g).epsilon(1e-5),
                      "role = " << role);
        CHECK(a.status().notes.empty());   // 接了 scene 口就不该有"未接"的说明
    }
}

TEST_CASE("天线：pointing = heading 时视轴跟随平台航向") {
    SceneParamFrame f;
    f.update_rate_Hz = 1.0;
    f.valid_to_s = 1.0;
    f.aod_az_deg = 90.0;
    f.tx_heading_deg = 90.0;      // 视轴随航向转到 90°，于是离开角恰在视轴上

    AntennaGain a;
    std::string err;
    REQUIRE(a.configure(Num{{"gain_dBi", 10.0}, {"beamwidth_az_deg", 60.0}, {"beamwidth_el_deg", 60.0}},
                        Txt{{"role", "tx"}, {"pattern", "directional"}, {"pointing", "heading"}}, err));
    Xoshiro256pp rng(1);
    REQUIRE(a.init(rng, err));
    PortMap in, out;
    in["in"] = wrap(const_block(8, 1.0, 1e6));
    PortData sd;
    sd.type = PortType::SceneParamFrame;
    sd.has_data = true;
    sd.scenes.push_back(f);
    in["scene"] = sd;
    REQUIRE(a.process(in, out, err) == Step::Produced);
    CHECK(out["out"].iq.samples[0].real() == doctest::Approx(std::pow(10.0, 10.0 / 20.0)).epsilon(1e-5));
}

// -------------------------------------------------------------- ReceiverFrontEnd

TEST_CASE("接收机前端：噪声底的两个解析锚点，与场景帧的链路读数同一个常数") {
    ReceiverFrontEnd r;
    std::string err;
    REQUIRE(r.configure(Num{{"nf_dB", 6.0}}, Txt{}, err));
    // −174 dBm/Hz + 6 dB
    CHECK(r.noise_psd_dBm_per_Hz() == doctest::Approx(-168.0));
    // 10 MS/s：−174 + 6 + 70 = −98 dBm
    CHECK(r.noise_power_dBm(1e7) == doctest::Approx(-98.0));
    // 500 kS/s：−174 + 6 + 56.99 = −111.01 dBm —— 切片 ② 示例里手兑的正是 −111 dBm，
    // 说明既有示例可以逐值迁移到本组件（D-051 ② 的依据）
    CHECK(r.noise_power_dBm(5e5) == doctest::Approx(-111.01).epsilon(0.001));

    // 温度偏离 290 K 按 10·log10(T/290) 修正
    ReceiverFrontEnd hot;
    REQUIRE(hot.configure(Num{{"nf_dB", 6.0}, {"reference_temperature_K", 580.0}}, Txt{}, err));
    CHECK(hot.noise_psd_dBm_per_Hz() == doctest::Approx(-168.0 + 3.0103).epsilon(1e-4));
}

TEST_CASE("接收机前端：注入噪声的功率与解析值相符，I/Q 等方差且不相关（蒙特卡洛矩校验）") {
    ReceiverFrontEnd r;
    std::string err;
    const double fs = 1e6;
    REQUIRE(r.configure(Num{{"nf_dB", 6.0}}, Txt{}, err));
    Xoshiro256pp rng(20260907);
    REQUIRE(r.init(rng, err));

    std::vector<Complex> all;
    const std::size_t blocks = 16, n = 65536;
    for (std::size_t b = 0; b < blocks; ++b) {
        PortMap in, out;
        in["in"] = wrap(const_block(n, 0.0, fs, b * n));    // 零输入，只看噪声
        REQUIRE(r.process(in, out, err) == Step::Produced);
        const std::vector<Complex>& v = out["out"].iq.samples;
        all.insert(all.end(), v.begin(), v.end());
    }
    REQUIRE(all.size() == blocks * n);

    const double want = std::pow(10.0, r.noise_power_dBm(fs) / 10.0);   // mW
    const double got = mean_power(all);
    CHECK_MESSAGE(std::fabs(got / want - 1.0) < 0.01, "噪声功率相对误差 " << (got / want - 1.0));

    double si = 0.0, sq = 0.0, sc = 0.0;
    for (std::size_t i = 0; i < all.size(); ++i) {
        si += static_cast<double>(all[i].real()) * all[i].real();
        sq += static_cast<double>(all[i].imag()) * all[i].imag();
        sc += static_cast<double>(all[i].real()) * all[i].imag();
    }
    const double nn = static_cast<double>(all.size());
    CHECK(std::sqrt(si / sq) == doctest::Approx(1.0).epsilon(0.02));    // I/Q 标准差比
    CHECK(std::fabs(sc / std::sqrt(si * sq)) < 0.01);                   // I/Q 互相关
}

TEST_CASE("接收机前端：noise_mode = none 不注入噪声；增益按 dB 施加") {
    ReceiverFrontEnd r;
    std::string err;
    REQUIRE(r.configure(Num{{"nf_dB", 6.0}, {"gain_dB", 20.0}}, Txt{{"noise_mode", "none"}}, err));
    Xoshiro256pp rng(1);
    REQUIRE(r.init(rng, err));
    PortMap in, out;
    in["in"] = wrap(const_block(32, 1.0, 1e6));
    REQUIRE(r.process(in, out, err) == Step::Produced);
    CHECK(out["out"].iq.samples[0].real() == doctest::Approx(10.0).epsilon(1e-6));   // 20 dB = ×10
    CHECK(out["out"].iq.samples[0].imag() == doctest::Approx(0.0).epsilon(1e-6));
    CHECK(out["out"].iq.samples.size() == 32);
}

TEST_CASE("接收机前端：IQ 不平衡的镜像抑制比等于 |K1|²/|K2|² 的解析值") {
    ReceiverFrontEnd r;
    std::string err;
    const double gdB = 0.5, pdeg = 5.0;
    REQUIRE(r.configure(Num{{"nf_dB", 0.0}, {"iq_gain_imbalance_dB", gdB},
                            {"iq_phase_imbalance_deg", pdeg}},
                        Txt{{"noise_mode", "none"}}, err));
    Xoshiro256pp rng(1);
    REQUIRE(r.init(rng, err));

    // 单音进，测正频与镜像频的幅度比
    const double fs = 1e6, f0 = 1e5;
    const std::size_t n = 4096;
    Block b(n);
    for (std::size_t i = 0; i < n; ++i) {
        const double ph = 2.0 * 3.14159265358979323846 * f0 * static_cast<double>(i) / fs;
        b.samples[i] = Complex(static_cast<float>(std::cos(ph)), static_cast<float>(std::sin(ph)));
    }
    b.meta.sample_rate_Hz = fs;
    b.meta.center_frequency_Hz = 2.44e9;
    PortMap in, out;
    in["in"] = wrap(b);
    REQUIRE(r.process(in, out, err) == Step::Produced);
    const std::vector<Complex>& y = out["out"].iq.samples;

    // 逐点求 +f0 与 −f0 两个频点的复幅度
    double pr = 0.0, pi = 0.0, mr = 0.0, mi = 0.0;
    for (std::size_t i = 0; i < n; ++i) {
        const double ph = 2.0 * 3.14159265358979323846 * f0 * static_cast<double>(i) / fs;
        const double c = std::cos(ph), s = std::sin(ph);
        pr += y[i].real() * c + y[i].imag() * s;      // 与 e^{-j2πf0t} 内积
        pi += y[i].imag() * c - y[i].real() * s;
        mr += y[i].real() * c - y[i].imag() * s;      // 与 e^{+j2πf0t} 内积
        mi += y[i].imag() * c + y[i].real() * s;
    }
    const double img_rej_dB = 10.0 * std::log10((pr * pr + pi * pi) / (mr * mr + mi * mi));

    const double gi = std::pow(10.0, gdB / 20.0);
    const double ph = pdeg * 3.14159265358979323846 / 180.0;
    const double k1 = 0.25 * ((1.0 + gi * std::cos(ph)) * (1.0 + gi * std::cos(ph)) +
                              gi * gi * std::sin(ph) * std::sin(ph));
    const double k2 = 0.25 * ((1.0 - gi * std::cos(ph)) * (1.0 - gi * std::cos(ph)) +
                              gi * gi * std::sin(ph) * std::sin(ph));
    CHECK(img_rej_dB == doctest::Approx(10.0 * std::log10(k1 / k2)).epsilon(0.01));
}

TEST_CASE("接收机前端：本振相位跨块连续，结果与块长无关") {
    std::string err;
    const double fs = 1e6;
    const std::size_t total = 4096;
    std::vector<Complex> a, b;
    for (int pass = 0; pass < 2; ++pass) {
        ReceiverFrontEnd r;
        REQUIRE(r.configure(Num{{"nf_dB", 0.0}, {"lo_offset_Hz", 1234.0}},
                            Txt{{"noise_mode", "none"}}, err));
        Xoshiro256pp rng(7);
        REQUIRE(r.init(rng, err));
        const std::size_t bs = (pass == 0) ? total : 512;
        std::vector<Complex>& dst = (pass == 0) ? a : b;
        for (std::uint64_t off = 0; off < total; off += bs) {
            PortMap in, out;
            in["in"] = wrap(const_block(bs, 1.0, fs, off));
            REQUIRE(r.process(in, out, err) == Step::Produced);
            const std::vector<Complex>& v = out["out"].iq.samples;
            dst.insert(dst.end(), v.begin(), v.end());
        }
    }
    REQUIRE(a.size() == b.size());
    double worst = 0.0;
    for (std::size_t i = 0; i < a.size(); ++i)
        worst = std::max(worst, static_cast<double>(std::abs(a[i] - b[i])));
    CHECK_MESSAGE(worst < 1e-6, "换块长后最大偏差 " << worst);
}

// ----------------------------------------------------------------- AdcQuantizer

TEST_CASE("ADC：满量程复单音的量化信噪比等于 6.02·bits + 1.76 dB") {
    std::string err;
    const int bits_list[] = {8, 12, 14};
    for (int k = 0; k < 3; ++k) {
        const int bits = bits_list[k];
        AdcQuantizer q;
        REQUIRE(q.configure(Num{{"full_scale_dBm", 0.0}},
                            Txt{{"bits", std::to_string(bits)}}, err));
        Xoshiro256pp rng(1);
        REQUIRE(q.init(rng, err));

        // 幅度取正端最大码对应的幅度 (2^(bits−1) − 1)·q，即满量程减一个码：
        // 二进制补码的正端比负端少一个码，直接取满量程 A 会在正峰上削顶。
        // 这样比理想满量程低 20·log10(1 − 2^(1−bits)) dB，8 位时也只差 0.07 dB。
        const double amp = (std::pow(2.0, bits - 1) - 1.0) * q.lsb();
        const double fs = 1e6, f0 = 12345.0;
        const std::size_t n = 65536;
        Block b(n);
        std::vector<Complex> ref(n);
        for (std::size_t i = 0; i < n; ++i) {
            const double ph = 2.0 * 3.14159265358979323846 * f0 * static_cast<double>(i) / fs;
            ref[i] = Complex(static_cast<float>(amp * std::cos(ph)), static_cast<float>(amp * std::sin(ph)));
            b.samples[i] = ref[i];
        }
        b.meta.sample_rate_Hz = fs;
        b.meta.center_frequency_Hz = 2.44e9;
        PortMap in, out;
        in["in"] = wrap(b);
        REQUIRE(q.process(in, out, err) == Step::Produced);
        const std::vector<Complex>& y = out["out"].iq.samples;

        std::vector<Complex> e(n);
        for (std::size_t i = 0; i < n; ++i) e[i] = y[i] - ref[i];
        const double snr_dB = 10.0 * std::log10(mean_power(ref) / mean_power(e));
        const double want = 6.02 * bits + 1.76;
        CHECK_MESSAGE(std::fabs(snr_dB - want) < 0.5, bits << " 位实测 " << snr_dB << " dB，解析 " << want);
        CHECK(q.clipped() == 0u);
    }
}

TEST_CASE("ADC：过驱削顶被计数、进块元数据与理由，但四态不变（D-051 ③）") {
    AdcQuantizer q;
    std::string err;
    REQUIRE(q.configure(Num{{"full_scale_dBm", -20.0}}, Txt{{"bits", "12"}}, err));
    Xoshiro256pp rng(1);
    REQUIRE(q.init(rng, err));

    // 输入幅度是满量程的 2 倍，整块都削顶
    const double amp = 2.0 * q.full_scale_amplitude();
    PortMap in, out;
    in["in"] = wrap(const_block(1000, amp, 1e6));
    REQUIRE(q.process(in, out, err) == Step::Produced);
    const Block& o = out["out"].iq;
    CHECK(o.meta.clip_count == 1000u);
    CHECK(o.meta.state == State::Valid);                    // 标记不是降级
    REQUIRE(o.meta.state_reasons.size() == 1);
    CHECK(o.meta.state_reasons[0] == "adc_clip:1000");
    // 削顶后的实部恰是正端最大码 × 步长
    const double top = (std::pow(2.0, 12.0) / 2.0 - 1.0) * q.lsb();
    CHECK(o.samples[0].real() == doctest::Approx(top).epsilon(1e-5));

    // 收尾：比例 100% 远超 1%，这时才降级
    PortMap fout;
    CHECK(q.flush(fout, err) == Step::Finished);
    CHECK(q.status().state == State::Degraded);
}

TEST_CASE("ADC：削顶比例低于阈值时收尾不降级，只记一条说明") {
    AdcQuantizer q;
    std::string err;
    REQUIRE(q.configure(Num{{"full_scale_dBm", 0.0}, {"degrade_clip_ratio", 0.05}},
                        Txt{{"bits", "12"}}, err));
    Xoshiro256pp rng(1);
    REQUIRE(q.init(rng, err));

    // 1000 个样点里只有 10 个过驱（1%），低于 5% 的阈值
    Block b(1000);
    for (std::size_t i = 0; i < 1000; ++i)
        b.samples[i] = Complex(static_cast<float>(i < 10 ? 3.0 : 0.1), 0.0f);
    b.meta.sample_rate_Hz = 1e6;
    b.meta.center_frequency_Hz = 2.44e9;
    PortMap in, out;
    in["in"] = wrap(b);
    REQUIRE(q.process(in, out, err) == Step::Produced);
    CHECK(out["out"].iq.meta.clip_count == 10u);
    PortMap fout;
    CHECK(q.flush(fout, err) == Step::Finished);
    CHECK(q.status().state == State::Valid);
    CHECK(q.status().notes.size() == 1);
}

TEST_CASE("ADC：无输入时输出精确为零，不造出假直流") {
    AdcQuantizer q;
    std::string err;
    REQUIRE(q.configure(Num{{"full_scale_dBm", 0.0}}, Txt{{"bits", "14"}}, err));
    Xoshiro256pp rng(1);
    REQUIRE(q.init(rng, err));
    PortMap in, out;
    in["in"] = wrap(const_block(64, 0.0, 1e6));
    REQUIRE(q.process(in, out, err) == Step::Produced);
    for (std::size_t i = 0; i < 64; ++i) {
        CHECK(out["out"].iq.samples[i].real() == 0.0f);
        CHECK(out["out"].iq.samples[i].imag() == 0.0f);
    }
    CHECK(out["out"].iq.meta.clip_count == 0u);
}

// ------------------------------------------------------------------ 串成一条链

TEST_CASE("链路电平：天线 + 前端 + ADC 串起来后，S2 上的信噪比等于解析链路预算") {
    // 一个定电平信号经 6 dBi 天线、噪声系数 6 dB 的前端；
    // 信号功率与噪声功率的比值应等于 (输入功率 + 6 dB) − (−174 + 6 + 10·log10 fs)。
    Registry r = builtin_registry();
    std::string err;
    const double fs = 1e6;
    const double in_dBm = -100.0;
    const double amp = std::pow(10.0, in_dBm / 20.0);

    auto ant = r.create_configured("AntennaGain", Num{{"gain_dBi", 6.0}},
                                   Txt{{"role", "rx"}, {"pattern", "omni"}}, err);
    REQUIRE_MESSAGE(ant, err);
    auto fe = r.create_configured("ReceiverFrontEnd", Num{{"nf_dB", 6.0}}, Txt{}, err);
    REQUIRE_MESSAGE(fe, err);
    Xoshiro256pp rng(20260907);
    REQUIRE(ant->init(rng, err));
    REQUIRE(fe->init(rng, err));

    std::vector<Complex> sig, noisy;
    const std::size_t blocks = 8, n = 65536;
    for (std::size_t b = 0; b < blocks; ++b) {
        PortMap ain, aout;
        ain["in"] = wrap(const_block(n, amp, fs, b * n));
        REQUIRE(ant->process(ain, aout, err) == Step::Produced);
        const std::vector<Complex>& s = aout["out"].iq.samples;
        sig.insert(sig.end(), s.begin(), s.end());

        PortMap fin, fout;
        fin["in"] = aout["out"];
        REQUIRE(fe->process(fin, fout, err) == Step::Produced);
        const std::vector<Complex>& y = fout["out"].iq.samples;
        noisy.insert(noisy.end(), y.begin(), y.end());
    }

    const double sig_dBm = 10.0 * std::log10(mean_power(sig));
    CHECK(sig_dBm == doctest::Approx(in_dBm + 6.0).epsilon(1e-4));

    std::vector<Complex> e(noisy.size());
    for (std::size_t i = 0; i < noisy.size(); ++i) e[i] = noisy[i] - sig[i];
    const double noise_dBm = 10.0 * std::log10(mean_power(e));
    const double want_noise = -174.0 + 6.0 + 10.0 * std::log10(fs);
    CHECK_MESSAGE(std::fabs(noise_dBm - want_noise) < 0.05,
                  "噪声实测 " << noise_dBm << " dBm，解析 " << want_noise);
}

TEST_CASE("链路：可选 scene 口未接时整条链在 Graph 里跑得通（C-1 的可选口在真组件上）") {
    Graph g;
    Registry r = builtin_registry();
    std::string err;

    auto src = r.create_configured("ToneSource",
                                   Num{{"sample_rate_Hz", 1e6}, {"total_samples", 8192},
                                       {"block_samples", 2048}, {"amplitude", 0.001}},
                                   Txt{}, err);
    REQUIRE_MESSAGE(src, err);
    auto ant = r.create_configured("AntennaGain", Num{{"gain_dBi", 3.0}},
                                   Txt{{"role", "rx"}}, err);
    REQUIRE_MESSAGE(ant, err);
    auto fe = r.create_configured("ReceiverFrontEnd", Num{{"nf_dB", 6.0}}, Txt{}, err);
    REQUIRE_MESSAGE(fe, err);
    auto adc = r.create_configured("AdcQuantizer", Num{{"full_scale_dBm", -20.0}},
                                   Txt{{"bits", "14"}}, err);
    REQUIRE_MESSAGE(adc, err);

    NodeId a = g.add(std::move(src), "tone");
    NodeId b = g.add(std::move(ant), "rx_ant");
    NodeId c = g.add(std::move(fe), "rx_fe");
    NodeId d = g.add(std::move(adc), "adc");
    REQUIRE(g.connect(a, "out", b, "in", err));
    REQUIRE(g.connect(b, "out", c, "in", err));
    REQUIRE(g.connect(c, "out", d, "in", err));
    // 天线的 scene 口空着：validate 必须通过（可选口不算悬空）
    CHECK_MESSAGE(g.validate(err), err);

    Xoshiro256pp rng(3);
    RunReport rep = g.run(rng);
    CHECK_MESSAGE(rep.ok, rep.error);
    CHECK(rep.state == State::Valid);
}


// ---------------------------------------------- 两种增益口径必须给出同一个电平（C-2 的核心验收）

TEST_CASE("链路口径等价：拆成天线 + 纯路损信道，与折在一处的链路预算逐值相同") {
    // C-2 把 tx_power + G_t + G_r − L 这一个乘法拆成了三个组件各管一段。
    // 拆得对不对，唯一可信的判据是两条链在同一帧上给出同一个电平。
    const double tx_power_dBm = 27.0, gt = 2.0, gr = 3.0, path_loss = 100.052008;

    SceneParamFrame f;
    f.valid_from_s = 0.0;
    f.valid_to_s = 10.0;
    f.update_rate_Hz = 20.0;
    f.path_loss_dB = path_loss;
    f.aod_az_deg = 45.0;      // 全向天线下角度不影响结果，给非零值正是为了验证这一点
    f.aod_el_deg = 10.0;
    f.aoa_az_deg = 225.0;
    f.aoa_el_deg = -10.0;

    std::string err;
    Xoshiro256pp rng(1);
    const std::size_t n = 4096;

    // 口径一（切片 ②）：信道一件把三项折在一起施加，输入是单位功率波形
    double level_folded = 0.0;
    {
        // 用 FreeSpaceChannel 代替场景绑定信道来表达"折在一处"的口径：
        // 它的公式与 SceneBoundChannel 的 link_budget 分支逐字相同，且不需要场景文件。
        Registry r = builtin_registry();
        // 距离取使 FSPL 恰为 path_loss 的值：L = 20·log10(4πd/λ)
        const double lambda = 299792458.0 / 2.4405e9;
        const double d = std::pow(10.0, path_loss / 20.0) * lambda / (4.0 * 3.14159265358979323846);
        auto ch = r.create_configured("FreeSpaceChannel",
                                      Num{{"distance_m", d}, {"frequency_Hz", 2.4405e9},
                                          {"tx_power_dBm", tx_power_dBm},
                                          {"tx_gain_dBi", gt}, {"rx_gain_dBi", gr}},
                                      Txt{}, err);
        REQUIRE_MESSAGE(ch, err);
        REQUIRE(ch->init(rng, err));
        PortMap in, out;
        in["in"] = wrap(const_block(n, 1.0, 1e6));      // 单位功率
        REQUIRE(ch->process(in, out, err) == Step::Produced);
        level_folded = 10.0 * std::log10(mean_power(out["out"].iq.samples));
    }

    // 口径二（C-2）：辐射源按 tx_power 出电平、两个天线各管自己的增益、信道只施加路损
    double level_split = 0.0;
    {
        Registry r = builtin_registry();
        auto ant_tx = r.create_configured("AntennaGain", Num{{"gain_dBi", gt}},
                                          Txt{{"role", "tx"}, {"pattern", "omni"}}, err);
        REQUIRE_MESSAGE(ant_tx, err);
        auto ant_rx = r.create_configured("AntennaGain", Num{{"gain_dBi", gr}},
                                          Txt{{"role", "rx"}, {"pattern", "omni"}}, err);
        REQUIRE_MESSAGE(ant_rx, err);
        REQUIRE(ant_tx->init(rng, err));
        REQUIRE(ant_rx->init(rng, err));

        // 辐射源按发射功率出电平（emit_at_tx_power 的效果）
        const double amp = std::pow(10.0, tx_power_dBm / 20.0);
        PortData sd;
        sd.type = PortType::SceneParamFrame;
        sd.has_data = true;
        sd.scenes.push_back(f);

        PortMap in1, out1;
        in1["in"] = wrap(const_block(n, amp, 1e6));
        in1["scene"] = sd;
        REQUIRE(ant_tx->process(in1, out1, err) == Step::Produced);

        // 纯路损：手工施加 −L，等价于 SceneBoundChannel 的 path_loss_only 分支
        const float lg = static_cast<float>(std::pow(10.0, -path_loss / 20.0));
        Block afterch = out1["out"].iq;
        for (std::size_t i = 0; i < afterch.samples.size(); ++i)
            afterch.samples[i] = Complex(afterch.samples[i].real() * lg, afterch.samples[i].imag() * lg);

        PortMap in2, out2;
        in2["in"] = wrap(afterch);
        in2["scene"] = sd;
        REQUIRE(ant_rx->process(in2, out2, err) == Step::Produced);
        level_split = 10.0 * std::log10(mean_power(out2["out"].iq.samples));
    }

    const double want = tx_power_dBm + gt + gr - path_loss;
    CHECK_MESSAGE(std::fabs(level_folded - want) < 0.001, "折在一处：" << level_folded << " vs " << want);
    CHECK_MESSAGE(std::fabs(level_split - want) < 0.001, "拆开三件：" << level_split << " vs " << want);
    // 两种口径之差远小于 C-2 的验收线 0.05 dB
    CHECK_MESSAGE(std::fabs(level_split - level_folded) < 0.001,
                  "两种口径差 " << (level_split - level_folded) << " dB");
}


TEST_CASE("观测点索引：削顶累计随 ADC 一路带到索引里（D-051）") {
    // 观测点挂在 ADC 之后，索引里的 clipped_samples 应等于被削顶的样点总数。
    Registry r = builtin_registry();
    std::string err;
    // 用系统临时目录，不污染 data/runs（那是任务产品目录）
    const char* tmp = std::getenv("TMPDIR");
    const std::string dir = std::string(tmp ? tmp : "/tmp/") + "cuav_clip_test";
    REQUIRE(platform::make_dirs(dir + "/s3", err));

    Graph g;
    auto src = r.create_configured("ToneSource",
                                   Num{{"sample_rate_Hz", 1e6}, {"total_samples", 8192},
                                       {"block_samples", 4096}, {"amplitude", 4.0}},
                                   Txt{}, err);
    REQUIRE_MESSAGE(src, err);
    auto adc = r.create_configured("AdcQuantizer",
                                   Num{{"full_scale_dBm", 0.0}, {"degrade_clip_ratio", 1.0}},
                                   Txt{{"bits", "12"}}, err);
    REQUIRE_MESSAGE(adc, err);
    auto tap = r.create_configured("ObservationTap",
                                   Num{{"nfft", 1024}, {"envelope", 0}},
                                   Txt{{"op_id", "s3"}, {"out_dir", dir}}, err);
    REQUIRE_MESSAGE(tap, err);

    NodeId a = g.add(std::move(src), "tone");
    NodeId b = g.add(std::move(adc), "adc");
    NodeId c = g.add(std::move(tap), "op:s3");
    REQUIRE(g.connect(a, "out", b, "in", err));
    REQUIRE(g.connect(b, "out", c, "in", err));
    REQUIRE(g.validate(err));
    Xoshiro256pp rng(1);
    RunReport rep = g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);

    std::ifstream f((dir + "/s3/spectrum.index.json").c_str());
    REQUIRE(f.good());
    nlohmann::json idx;
    f >> idx;
    // 幅度 4 远超满量程 1，8192 个样点全部削顶
    CHECK(idx["clipped_samples"].get<std::uint64_t>() == 8192u);
}
