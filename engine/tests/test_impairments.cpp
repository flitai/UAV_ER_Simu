// Q-4（D-091）：发射机载频偏差、接收机本振相位噪声、小尺度衰落。
//
// 三项都缺省关；这里验的是「开了之后对解析量」与「关着时逐位不变」两面。
// 验收口径见 14 报告 §4.2：载频平移对 cfo_ppm·f、相噪积分对闭式、莱斯经验 K 对设定值。

#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "cuav/components/receiver.h"
#include "cuav/fading.h"
#include "cuav/components/scenario.h"
#include "cuav/platform.h"
#include "cuav/random.h"
#include "cuav/scenario_json.h"
#include "cuav/sha256.h"
#include "cuav_geo/activity.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"
#include "tmpdir.h"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif
std::string repo(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

const double kTwoPi = 6.283185307179586476925286766559;

std::string fmt(double v) {
    std::ostringstream o;
    o.precision(12);
    o << v;
    return o.str();
}

nlohmann::json read_json(const std::string& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    REQUIRE_MESSAGE(f.good(), path);
    std::stringstream ss;
    ss << f.rdbuf();
    return nlohmann::json::parse(ss.str());
}

// 改一处字段另存一份场景（文件名不参与校验，场景标识不变）
std::string write_variant(const std::string& fixture, const std::string& tag,
                          const std::function<void(nlohmann::json&)>& edit) {
    nlohmann::json j = read_json(repo(fixture));
    edit(j);
    const std::string dir = cuav_test::temp_root("cuav_q4");
    std::string err;
    REQUIRE_MESSAGE(platform::make_dirs(dir, err), err);
    const std::string path = dir + "/" + tag + ".scenario.json";
    std::ofstream o(path.c_str(), std::ios::binary);
    o << j.dump(2) << "\n";
    return path;
}

std::unique_ptr<SceneEmitterSource> make_src(const std::string& path, const std::string& scenario_id,
                                             const std::string& entity, double fs, double fc,
                                             std::uint64_t total, std::size_t block) {
    std::unique_ptr<SceneEmitterSource> s(new SceneEmitterSource());
    std::map<std::string, double> num;
    num["sample_rate_Hz"] = fs;
    num["total_samples"] = static_cast<double>(total);
    num["block_samples"] = static_cast<double>(block);
    num["center_frequency_Hz"] = fc;
    std::map<std::string, std::string> txt;
    txt["scenario_path"] = path;
    txt["scenario_id"] = scenario_id;
    txt["entity_id"] = entity;
    std::string err;
    REQUIRE_MESSAGE(s->configure(num, txt, err), err);
    Xoshiro256pp rng(11);
    REQUIRE_MESSAGE(s->init(rng, err), err);
    return s;
}

std::vector<Complex> run_all(SceneEmitterSource& s) {
    std::vector<Complex> all;
    std::string err;
    for (;;) {
        PortMap in, out;
        const Step st = s.process(in, out, err);
        REQUIRE_MESSAGE(st != Step::Error, err);
        if (st != Step::Produced) break;
        const std::vector<Complex>& x = out["out"].iq.samples;
        all.insert(all.end(), x.begin(), x.end());
    }
    return all;
}

void set_cfo(nlohmann::json& j, const std::string& entity, double ppm) {
    for (auto& e : j["emitters"])
        if (e["id"] == entity) e["emission"]["cfo_ppm"] = ppm;
}

const char* kGolden01 = "data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json";
const char* kHop = "engine/tests/fixtures/hop-emitter.scenario.json";
const char* kOfdm = "engine/tests/fixtures/ofdm-emitter.scenario.json";
const char* kGfsk = "engine/tests/fixtures/gfsk-emitter.scenario.json";
}  // namespace

// ================================================================= A. 载频偏差

TEST_CASE("载频偏差：可缺省、显式值收下、越界与非数值拒，报文点名字段（Q-4）") {
    geo::Scenario s;
    std::string err;
    nlohmann::json a = read_json(repo(kGolden01));
    REQUIRE_MESSAGE(parse_scenario(a, s, err), err);
    CHECK(s.emitters[0].emission.cfo_ppm == 0.0);

    nlohmann::json b = a;
    set_cfo(b, "uav-1", -22.4);
    REQUIRE_MESSAGE(parse_scenario(b, s, err), err);
    CHECK(s.emitters[0].emission.cfo_ppm == -22.4);

    for (double bad : {100.5, -150.0}) {
        nlohmann::json c = a;
        set_cfo(c, "uav-1", bad);
        CHECK_FALSE(parse_scenario(c, s, err));
        CHECK(err.find("cfo_ppm") != std::string::npos);
    }
    nlohmann::json d = a;
    d["emitters"][0]["emission"]["cfo_ppm"] = "seed";   // 只收显式值（D-091）
    CHECK_FALSE(parse_scenario(d, s, err));
    CHECK(err.find("cfo_ppm") != std::string::npos);
}

TEST_CASE("载频偏差：折赫兹的唯一定义按瞬时射频成比例，含基带偏移") {
    geo::Emission em;
    em.cfo_ppm = -22.4;
    em.waveform.offset_Hz = 48828.125;
    CHECK(geo::cfo_Hz(em, 2.4405e9) == doctest::Approx(-22.4e-6 * (2.4405e9 + 48828.125)).epsilon(1e-15));
    CHECK(geo::cfo_Hz(-22.4, 2.44e9) == doctest::Approx(-54656.0).epsilon(1e-12));   // X20 量级
}

TEST_CASE("载频偏差：铁律 4 的闸按实际载频判，偏向带边即拒、偏向中心照过") {
    // golden-01：|Δf| + B/2 = 48828.125 + 200000，比 Fs/2 = 250000 只余 1171.875 Hz。
    // +1 ppm ≈ +2440.5 Hz 把它推出界；−1 ppm 往中心拉，照过。
    const std::string up = write_variant(kGolden01, "cfo-up", [](nlohmann::json& j) { set_cfo(j, "uav-1", 1.0); });
    LoadedScenario ls;
    std::string err;
    CHECK_FALSE(load_scenario_file(up, ls, err));
    CHECK(err.find("铁律 4") != std::string::npos);

    const std::string down = write_variant(kGolden01, "cfo-down", [](nlohmann::json& j) { set_cfo(j, "uav-1", -1.0); });
    CHECK_MESSAGE(load_scenario_file(down, ls, err), err);
}

TEST_CASE("载频偏差：单音的基带频率 = 名义频偏 + cfo_ppm·f；为零时与不写逐位相同") {
    const double fs = 500e3, fc = 2.4405e9, ppm = -10.0;
    const std::uint64_t N = 1800000;   // golden-01 的 uav-1 在 t ≈ 3.01 s 才开，取到 3.6 s
    const std::string p0 = write_variant(kGolden01, "cfo0", [](nlohmann::json& j) { set_cfo(j, "uav-1", 0.0); });
    const std::string p1 = write_variant(kGolden01, "cfo1", [&](nlohmann::json& j) { set_cfo(j, "uav-1", ppm); });
    const std::vector<Complex> ref = run_all(*make_src(repo(kGolden01), "golden-01", "uav-1", fs, fc, N, 65536));
    const std::vector<Complex> y0 = run_all(*make_src(p0, "golden-01", "uav-1", fs, fc, N, 65536));
    const std::vector<Complex> y1 = run_all(*make_src(p1, "golden-01", "uav-1", fs, fc, N, 65536));
    REQUIRE(ref.size() == N);
    std::size_t diff = 0;
    for (std::size_t i = 0; i < N; ++i)
        if (!(ref[i].real() == y0[i].real() && ref[i].imag() == y0[i].imag())) ++diff;
    CHECK_MESSAGE(diff == 0u, "显式写 cfo_ppm = 0 与不写应逐位相同，差 " << diff << " 个样点");

    // 逐样点相位增量的均值：只取两端都在发射的样点对
    double acc = 0.0;
    std::size_t n = 0;
    for (std::size_t i = 0; i + 1 < N; ++i) {
        const std::complex<double> a(y1[i].real(), y1[i].imag()), b(y1[i + 1].real(), y1[i + 1].imag());
        if (std::abs(a) < 0.5 || std::abs(b) < 0.5) continue;
        acc += std::arg(b * std::conj(a));
        ++n;
    }
    REQUIRE(n > 100000u);
    const double f_est = acc / static_cast<double>(n) * fs / kTwoPi;
    const double f_want = 48828.125 + ppm * 1e-6 * (2.4405e9 + 48828.125);
    MESSAGE("单音基带频率 " << fmt(f_est) << " Hz，期望 " << fmt(f_want) << " Hz（其中载频偏差 "
                          << fmt(ppm * 1e-6 * (2.4405e9 + 48828.125)) << " Hz）");
    CHECK(std::fabs(f_est - f_want) < 0.01);
}

TEST_CASE("载频偏差：跳频逐跳按瞬时射频成比例（晶振偏差乘在每个频点上）") {
    const double fs = 500e3, fc = 2.4405e9, ppm = 20.0;
    const std::uint64_t N = 700000;   // 1.4 s：t = 1 s 起发射
    const std::string p = write_variant(kHop, "hop-cfo", [&](nlohmann::json& j) { set_cfo(j, "uav-1", ppm); });
    const std::vector<Complex> y = run_all(*make_src(p, "hop-emitter", "uav-1", fs, fc, N, 4096));
    REQUIRE(y.size() == N);
    LoadedScenario ls;
    std::string err;
    REQUIRE(load_scenario_file(p, ls, err));
    geo::ActivitySchedule sched;
    REQUIRE_MESSAGE(sched.build(ls.scenario, "uav-1", fs, err), err);

    std::map<double, std::pair<double, std::size_t> > per;   // 跳频点 → (增量和, 对数)
    for (std::size_t i = 0; i + 1 < N; ++i) {
        const geo::ActivitySchedule::Segment s0 = sched.segment_at(i), s1 = sched.segment_at(i + 1);
        if (s0.center_Hz != s1.center_Hz) continue;
        const std::complex<double> a(y[i].real(), y[i].imag()), b(y[i + 1].real(), y[i + 1].imag());
        if (std::abs(a) < 0.5 || std::abs(b) < 0.5) continue;
        per[s0.center_Hz].first += std::arg(b * std::conj(a));
        per[s0.center_Hz].second += 1;
    }
    REQUIRE(per.size() == 3u);
    for (std::map<double, std::pair<double, std::size_t> >::const_iterator it = per.begin(); it != per.end(); ++it) {
        const double f_est = it->second.first / static_cast<double>(it->second.second) * fs / kTwoPi;
        const double f_want = it->first - fc + ppm * 1e-6 * it->first;
        MESSAGE("跳频点 " << fmt(it->first) << " Hz：基带 " << fmt(f_est) << " Hz，期望 " << fmt(f_want) << " Hz");
        CHECK(std::fabs(f_est - f_want) < 0.01);
    }
}

TEST_CASE("载频偏差：OFDM 与 GFSK 的突发与空档一起偏——y_cfo[n] = y[n]·exp(j2π·Δf·n/fs)") {
    // 无跳频时载频偏差是常数；突发内的相位增量（逐突发的 dphi）与空档里的增量（子段的 dphi）
    // 都要带上它，漏了空档那一处，第二个突发起就对不上。
    struct Case { const char* fixture; const char* id; const char* entity; double f_nominal; };
    const Case cases[] = {
        {kOfdm, "ofdm-emitter", "video", 2.4413e9},
        {kGfsk, "gfsk-emitter", "frsky", 2.4413e9},
    };
    const double fs = 80e6, fc = 2.44e9, ppm = -15.0;
    const std::uint64_t N = 800000;   // 10 ms，够跨好几个突发
    for (const Case& c : cases) {
        const std::string ent(c.entity);
        CAPTURE(ent);
        const std::string p = write_variant(c.fixture, std::string("burst-cfo-") + c.entity,
                                            [&](nlohmann::json& j) { set_cfo(j, c.entity, ppm); });
        const std::vector<Complex> y0 = run_all(*make_src(repo(c.fixture), c.id, c.entity, fs, fc, N, 65536));
        const std::vector<Complex> y1 = run_all(*make_src(p, c.id, c.entity, fs, fc, N, 65536));
        REQUIRE(y0.size() == N);
        const double df = ppm * 1e-6 * c.f_nominal;
        double worst = 0.0;
        std::size_t live = 0;
        for (std::size_t i = 0; i < N; ++i) {
            const std::complex<double> a(y0[i].real(), y0[i].imag()), b(y1[i].real(), y1[i].imag());
            const double ang = std::fmod(kTwoPi * df * static_cast<double>(i) / fs, kTwoPi);
            const std::complex<double> want = a * std::complex<double>(std::cos(ang), std::sin(ang));
            worst = std::max(worst, std::abs(b - want) / std::max(1.0, std::abs(a)));
            if (std::abs(a) > 0.0) ++live;
        }
        MESSAGE(ent << "：发射样点 " << live << "，最大相对偏差 " << fmt(worst));
        CHECK(live > 100000u);
        CHECK(worst < 1e-5);
    }
}

// ================================================================= B. 本振相位噪声

namespace {

std::unique_ptr<ReceiverFrontEnd> make_fe(const std::string& noise_mode, const std::string& pn, double level,
                                          double corner, std::uint64_t shared_seed, double lo_offset = 0.0) {
    std::unique_ptr<ReceiverFrontEnd> fe(new ReceiverFrontEnd());
    std::map<std::string, double> num;
    num["nf_dB"] = 6.0;
    num["pn_level_dBc_Hz"] = level;
    num["pn_corner_Hz"] = corner;
    num["lo_offset_Hz"] = lo_offset;
    std::map<std::string, std::string> txt;
    txt["noise_mode"] = noise_mode;
    txt["phase_noise"] = pn;
    std::string err;
    REQUIRE_MESSAGE(fe->configure(num, txt, err), err);
    Xoshiro256pp rng(shared_seed);
    REQUIRE_MESSAGE(fe->init(rng, err), err);
    return fe;
}

// 常数输入 x 过前端，按 block 切块；返回全部输出
std::vector<Complex> run_fe(ReceiverFrontEnd& fe, double fs, std::size_t n, std::size_t block, Complex x) {
    std::vector<Complex> all;
    all.reserve(n);
    std::string err;
    for (std::size_t s0 = 0; s0 < n; s0 += block) {
        const std::size_t m = std::min(block, n - s0);
        PortMap in, out;
        PortData d;
        d.type = PortType::IQStream;
        d.has_data = true;
        d.iq.samples.assign(m, x);
        d.iq.meta.sample_rate_Hz = fs;
        d.iq.meta.start_sample = s0;
        in["in"] = d;
        const Step st = fe.process(in, out, err);
        REQUIRE_MESSAGE(st == Step::Produced, err);
        const std::vector<Complex>& y = out["out"].iq.samples;
        all.insert(all.end(), y.begin(), y.end());
    }
    return all;
}

nlohmann::json pn_golden() { return read_json(repo("engine/tests/golden/phase_noise.json")); }

}  // namespace

TEST_CASE("相位噪声 · 算法核：离散化系数与 φ 序列对 Python 参考（rel 1e-9；φ 按自身尺度 1e-9·σφ）") {
    const nlohmann::json g = pn_golden();
    const double coeff_rel = g["tolerance"]["coeff_rel"].get<double>();
    const double phi_tol = g["tolerance"]["phi_abs_over_sigma"].get<double>();
    for (const auto& c : g["cases"]) {
        const std::string name = c["name"].get<std::string>();
        CAPTURE(name);
        const double fs = c["fs_Hz"], fc = c["corner_Hz"], level = c["level_dBc_Hz"];
        const ReceiverFrontEnd::PhaseNoiseCoeffs k = ReceiverFrontEnd::phase_noise_coeffs(fs, fc, level);
        CHECK(std::fabs(k.a - c["a"].get<double>()) <= coeff_rel * std::fabs(c["a"].get<double>()));
        CHECK(std::fabs(k.sigma_w - c["sigma_w"].get<double>()) <= coeff_rel * c["sigma_w"].get<double>());
        CHECK(std::fabs(k.sigma_phi - c["sigma_phi"].get<double>()) <= coeff_rel * c["sigma_phi"].get<double>());
        // 闭式锚点：σφ² = π·fc·L0，与采样率无关
        CHECK(k.sigma_phi * k.sigma_phi == doctest::Approx(3.14159265358979323846 * fc * std::pow(10.0, level / 10.0)).epsilon(1e-12));

        Xoshiro256pp rng(c["seed"].get<std::uint64_t>());
        const std::size_t n = c["n"].get<std::size_t>();
        std::vector<double> phi(n);
        double p = k.sigma_phi * rng.normal();
        for (std::size_t i = 0; i < n; ++i) { p = k.a * p + k.sigma_w * rng.normal(); phi[i] = p; }
        double worst = 0.0;
        const auto& idx = c["idx"];
        const auto& want = c["phi"];
        for (std::size_t j = 0; j < idx.size(); ++j)
            worst = std::max(worst, std::fabs(phi[idx[j].get<std::size_t>()] - want[j].get<double>()));
        MESSAGE(name << "：a = " << fmt(k.a) << "，σφ = " << fmt(k.sigma_phi * 180.0 / 3.14159265358979323846)
                     << " deg，φ 最大绝对差 " << fmt(worst) << "（" << fmt(worst / k.sigma_phi) << "·σφ）");
        CHECK(worst <= phi_tol * k.sigma_phi);
    }
}

TEST_CASE("相位噪声 · 组件：单位直流过前端，输出相角 = 参考 φ[n]（complex64，1e-6 rad）；种子由子种子派生") {
    const nlohmann::json g = pn_golden();
    const nlohmann::json& c = g["component"];
    const std::uint64_t shared = c["shared_seed"].get<std::uint64_t>();
    CHECK(Xoshiro256pp(shared).next_u64() == c["sub_seed"].get<std::uint64_t>());
    CHECK(ReceiverFrontEnd::phase_noise_seed(c["sub_seed"].get<std::uint64_t>()) == c["pn_seed"].get<std::uint64_t>());
    const double fs = c["fs_Hz"];
    std::unique_ptr<ReceiverFrontEnd> fe = make_fe("none", "pll", c["level_dBc_Hz"], c["corner_Hz"], shared);
    const std::vector<Complex> y = run_fe(*fe, fs, c["n"].get<std::size_t>(), 4096, Complex(1.0f, 0.0f));
    double worst = 0.0;
    for (std::size_t j = 0; j < c["idx"].size(); ++j) {
        const std::size_t i = c["idx"][j].get<std::size_t>();
        const double ang = std::atan2(static_cast<double>(y[i].imag()), static_cast<double>(y[i].real()));
        worst = std::max(worst, std::fabs(ang - c["phase_rad"][j].get<double>()));
    }
    MESSAGE("组件相角最大差 " << fmt(worst) << " rad");
    CHECK(worst <= g["tolerance"]["component_phase_abs_rad"].get<double>());
    // 相噪参数与均方根相位写进 note（产品索引里 trace 会被后级覆写，D-091）
    bool noted = false;
    for (const std::string& s : fe->status().notes) noted = noted || s.find("本振相位噪声") != std::string::npos;
    CHECK(noted);
}

TEST_CASE("相位噪声：长序列的经验方差对闭式 π·fc·L0（容差按 AR(1) 有效样本数算）；单音过前端的均方根相位同一个数") {
    const double fs = 20e6, fc = 2e5, level = -90.0;
    const std::size_t n = 2000000;
    std::unique_ptr<ReceiverFrontEnd> fe = make_fe("none", "pll", level, fc, 77);
    const std::vector<Complex> y = run_fe(*fe, fs, n, 65536, Complex(1.0f, 0.0f));
    double acc = 0.0;
    for (std::size_t i = 0; i < n; ++i) {
        const double ang = std::atan2(static_cast<double>(y[i].imag()), static_cast<double>(y[i].real()));
        acc += ang * ang;
    }
    const ReceiverFrontEnd::PhaseNoiseCoeffs k = ReceiverFrontEnd::phase_noise_coeffs(fs, fc, level);
    const double var = acc / static_cast<double>(n);
    const double want = k.sigma_phi * k.sigma_phi;
    const double sd = want * std::sqrt(2.0 * (1.0 + k.a * k.a) / ((1.0 - k.a * k.a) * static_cast<double>(n)));
    MESSAGE("均方根相位误差 " << fmt(std::sqrt(var) * 180.0 / 3.14159265358979323846) << " deg，闭式 "
                             << fmt(k.sigma_phi * 180.0 / 3.14159265358979323846) << " deg；差 "
                             << fmt((var - want) / sd) << " 个标准差");
    CHECK(std::fabs(var - want) < 5.0 * sd);
}

TEST_CASE("相位噪声：五种块长逐位相同；开相噪不改热噪声的样本实现（y_on·e^{−jφ} = y_off）") {
    const double fs = 20e6, fc = 2e5, level = -85.0;
    const std::size_t n = 300000;
    const Complex x(0.3f, -0.2f);
    std::unique_ptr<ReceiverFrontEnd> r = make_fe("thermal", "pll", level, fc, 5);
    const std::vector<Complex> ref = run_fe(*r, fs, n, 65536, x);
    for (std::size_t block : {4096u, 1000u, 4096u * 10u + 123u, 250000u, 1u << 20}) {
        CAPTURE(block);
        std::unique_ptr<ReceiverFrontEnd> f = make_fe("thermal", "pll", level, fc, 5);
        const std::vector<Complex> y = run_fe(*f, fs, n, block, x);
        std::size_t diffs = 0;
        for (std::size_t i = 0; i < n; ++i)
            if (!(y[i].real() == ref[i].real() && y[i].imag() == ref[i].imag())) ++diffs;
        CHECK_MESSAGE(diffs == 0u, "块长 " << block << " 与 65536 差 " << diffs << " 个样点");
    }
    // 关相噪的同种子前端：热噪声实现相同，差的只是一个旋转
    std::unique_ptr<ReceiverFrontEnd> off = make_fe("thermal", "off", level, fc, 5);
    const std::vector<Complex> y0 = run_fe(*off, fs, n, 65536, x);
    const std::uint64_t sub = Xoshiro256pp(5).next_u64();
    Xoshiro256pp prng(ReceiverFrontEnd::phase_noise_seed(sub));
    const ReceiverFrontEnd::PhaseNoiseCoeffs k = ReceiverFrontEnd::phase_noise_coeffs(fs, fc, level);
    double p = k.sigma_phi * prng.normal(), worst = 0.0;
    for (std::size_t i = 0; i < n; ++i) {
        p = k.a * p + k.sigma_w * prng.normal();
        const std::complex<double> on(ref[i].real(), ref[i].imag()), o(y0[i].real(), y0[i].imag());
        worst = std::max(worst, std::abs(on * std::polar(1.0, -p) - o) / std::max(1e-3, std::abs(o)));
    }
    MESSAGE("去掉相噪旋转后与关相噪的输出最大相对差 " << fmt(worst));
    CHECK(worst < 1e-5);
}

TEST_CASE("相位噪声：转角不小于采样率的一半即报错、不钳位；关着时与改动前的前端逐位相同") {
    std::unique_ptr<ReceiverFrontEnd> fe = make_fe("none", "pll", -90.0, 300e3, 1);
    PortMap in, out;
    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.samples.assign(16, Complex(1.0f, 0.0f));
    d.iq.meta.sample_rate_Hz = 500e3;
    in["in"] = d;
    std::string err;
    CHECK(fe->process(in, out, err) == Step::Error);
    CHECK(err.find("pn_corner_Hz") != std::string::npos);

    // off：本振频偏为零时旋转分支整个不进，输出就是输入（×增益 0 dB），逐位
    std::unique_ptr<ReceiverFrontEnd> a = make_fe("none", "off", -90.0, 300e3, 1);
    const std::vector<Complex> y = run_fe(*a, 500e3, 1000, 256, Complex(0.25f, -0.5f));
    for (std::size_t i = 0; i < y.size(); ++i) {
        CHECK(y[i].real() == 0.25f);
        CHECK(y[i].imag() == -0.5f);
    }
}

TEST_CASE("相位噪声 · MATLAB 一方：同一串驱动正态，引擎递推对 phase_noise.matlab.json（1e-9·σφ）") {
    const std::string in_path = repo("engine/tests/golden/phase_noise.json");
    const nlohmann::json g = read_json(in_path);
    const nlohmann::json m = read_json(repo("engine/tests/golden/phase_noise.matlab.json"));
    // 输入被改过而没重跑 MATLAB，当场红
    std::ifstream f(in_path.c_str(), std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    CHECK(m["input_sha256"].get<std::string>() == sha256_hex(ss.str()));
    const double tol = m["tolerance"]["kernel_rel"].get<double>();
    CHECK_MESSAGE(tol <= 1e-9, "判据被放宽了");

    const nlohmann::json& c = g["cases"][0];
    const ReceiverFrontEnd::PhaseNoiseCoeffs k =
        ReceiverFrontEnd::phase_noise_coeffs(c["fs_Hz"], c["corner_Hz"], c["level_dBc_Hz"]);
    CHECK(std::fabs(k.a - m["a"].get<double>()) <= tol * k.a);
    CHECK(std::fabs(k.sigma_w - m["sigma_w"].get<double>()) <= tol * k.sigma_w);
    const nlohmann::json& w = c["drive"]["w"];
    const nlohmann::json& phi = m["phi"];
    REQUIRE(w.size() == phi.size() + 1);
    double p = k.sigma_phi * w[0].get<double>(), worst = 0.0;
    for (std::size_t i = 0; i < phi.size(); ++i) {
        p = k.a * p + k.sigma_w * w[i + 1].get<double>();
        worst = std::max(worst, std::fabs(p - phi[i].get<double>()));
    }
    MESSAGE("引擎对 MATLAB：φ 最大差 " << fmt(worst / k.sigma_phi) << "·σφ（" << phi.size() << " 个样点）");
    CHECK(worst <= tol * k.sigma_phi);
}

// ================================================================= C. 小尺度衰落 · 生成核

TEST_CASE("衰落生成核：取数顺序、抽头布局与散射复增益对 Python 参考（fading.json）") {
    const nlohmann::json g = read_json(repo("engine/tests/golden/fading.json"));
    CHECK(fading::rms_ratio() == doctest::Approx(g["rms_ratio"].get<double>()).epsilon(1e-12));
    for (int l = 0; l < fading::kTaps; ++l)
        CHECK(fading::tap_power(l) == doctest::Approx(g["tap_power"][l].get<double>()).epsilon(1e-12));

    // ① 取数顺序：抽头 0…7 各 θ 与 16 个 φ，最后 θ0；均匀数逐位
    Xoshiro256pp rng(g["seed"].get<std::uint64_t>());
    fading::Draws d;
    fading::draw(rng, d);
    const nlohmann::json& gd = g["draws"];
    std::size_t bad = 0;
    double worst_ca = 0.0;
    for (int l = 0; l < fading::kTaps; ++l) {
        if (d.theta[l] != gd["theta"][l].get<double>()) ++bad;
        for (int n = 0; n < fading::kSinusoids; ++n) {
            if (d.phi[l][n] != gd["phi"][l][n].get<double>()) ++bad;
            worst_ca = std::max(worst_ca, std::fabs(d.cos_alpha[l][n] - gd["cos_alpha"][l][n].get<double>()));
        }
    }
    if (d.los_phase != gd["los_phase"].get<double>()) ++bad;
    CHECK_MESSAGE(bad == 0u, "取数顺序或取值与 Python 参考不一致：" << bad << " 处");
    CHECK(worst_ca <= 1e-12);

    // ② 抽头布局
    for (const auto& L : g["layouts"]) {
        fading::Layout lay;
        std::string err;
        const double spread = L["delay_spread_ns"].get<double>() * 1e-9, fs = L["fs_Hz"];
        REQUIRE_MESSAGE(fading::layout(spread, fs, lay, err), err);
        CAPTURE(spread);
        CAPTURE(fs);
        REQUIRE(lay.delay.size() == L["delay"].size());
        for (std::size_t k = 0; k < lay.delay.size(); ++k) {
            CHECK(lay.delay[k] == L["delay"][k].get<std::uint64_t>());
            CHECK(lay.members[k] == L["members"][k].get<std::vector<int> >());
            CHECK(lay.power[k] == doctest::Approx(L["power"][k].get<double>()).epsilon(1e-12));
        }
        CHECK(lay.rms_delay_spread_s == doctest::Approx(L["rms_delay_spread_s"].get<double>()).epsilon(1e-12));
    }

    // ③ 散射复增益（含 1e5 量级的大相位）
    fading::Layout lay;
    std::string err;
    REQUIRE(fading::layout(g["diffuse"]["delay_spread_ns"].get<double>() * 1e-9, g["diffuse"]["fs_Hz"], lay, err));
    double worst = 0.0;
    std::vector<std::complex<double> > v;
    for (std::size_t j = 0; j < g["diffuse"]["Phi"].size(); ++j) {
        fading::diffuse_at(d, lay, g["diffuse"]["Phi"][j].get<double>(), v);
        const auto& want = g["diffuse"]["values"][j];
        REQUIRE(v.size() == want.size());
        for (std::size_t k = 0; k < v.size(); ++k)
            worst = std::max(worst, std::abs(v[k] - std::complex<double>(want[k][0].get<double>(), want[k][1].get<double>())));
    }
    MESSAGE("散射复增益对 Python 参考最大绝对差 " << fmt(worst));
    CHECK(worst <= g["tolerance"]["diffuse_abs"].get<double>());
}

namespace {
double bessel_j0(double x) {
    double s = 1.0, term = 1.0;
    for (int k = 1; k < 80; ++k) {
        term *= -(x * x / 4.0) / (static_cast<double>(k) * k);
        s += term;
        if (std::fabs(term) < 1e-17) break;
    }
    return s;
}
}  // namespace

TEST_CASE("衰落生成核：系综功率为 1、自相关 = J0(Δ)、莱斯 K 的矩法估计对设定值、多抽头的频率相关对离散时延谱") {
    const std::size_t ns = 4000;
    const double Phi0 = 12.345;
    const double deltas[] = {0.0, 1.0, 2.405, 4.0};
    std::vector<fading::Draws> ds(ns);
    for (std::size_t s = 0; s < ns; ++s) {
        Xoshiro256pp r(1000 + s);
        fading::draw(r, ds[s]);
    }
    const double se = std::sqrt(1.0 / static_cast<double>(ns));
    // 自相关：对 θ 取系综平均时 α 在 [0, 2π) 上恰好均匀，E[g(Φ+Δ)g*(Φ)] = J0(Δ) 是精确等式
    for (double dd : deltas) {
        std::complex<double> acc(0.0, 0.0);
        for (std::size_t s = 0; s < ns; ++s)
            acc += fading::diffuse(ds[s], 0, Phi0 + dd) * std::conj(fading::diffuse(ds[s], 0, Phi0));
        acc /= static_cast<double>(ns);
        MESSAGE("自相关 Δ = " << fmt(dd) << "：" << fmt(acc.real()) << "，J0 = " << fmt(bessel_j0(dd)));
        CHECK(std::abs(acc - bessel_j0(dd)) < 5.0 * se);
    }
    // 莱斯 K：平坦（8 抽头合并）加视距分量，矩法 K̂ = sqrt(1−γ)/(1−sqrt(1−γ))，γ = Var|h|²/E²|h|²
    fading::Layout flat;
    std::string err;
    REQUIRE(fading::layout(0.0, 1e6, flat, err));
    std::vector<std::complex<double> > v;
    for (double k_dB : {6.0, 9.0, 12.0}) {
        const double K = std::pow(10.0, k_dB / 10.0);
        double m1 = 0.0, m2 = 0.0;
        for (std::size_t s = 0; s < ns; ++s) {
            fading::diffuse_at(ds[s], flat, Phi0, v);
            const std::complex<double> h = std::sqrt(K / (K + 1.0)) * std::polar(1.0, ds[s].los_phase) +
                                           std::sqrt(1.0 / (K + 1.0)) * v[0];
            const double p = std::norm(h);
            m1 += p;
            m2 += p * p;
        }
        m1 /= ns;
        m2 /= ns;
        const double gam = (m2 - m1 * m1) / (m1 * m1);
        const double kh = std::sqrt(1.0 - gam) / (1.0 - std::sqrt(1.0 - gam));
        MESSAGE("莱斯 K 设定 " << fmt(k_dB) << " dB：矩法估计 " << fmt(10.0 * std::log10(kh)) << " dB，E|h|² = " << fmt(m1));
        CHECK(std::fabs(10.0 * std::log10(kh) - k_dB) < 1.0);
        CHECK(std::fabs(m1 - 1.0) < 5.0 * se);
    }
    // 频率相关：H(f) = Σ_d D_d·e^{−j2π·f·τ_d}，E[H(f+Δf)H*(f)] = Σ_d P_d·e^{−j2π·Δf·τ_d}
    fading::Layout lay;
    const double fs = 80e6;
    REQUIRE(fading::layout(100e-9, fs, lay, err));
    for (double df : {1e6, 2e6, 5e6}) {
        std::complex<double> acc(0.0, 0.0), want(0.0, 0.0);
        for (std::size_t k = 0; k < lay.delay.size(); ++k)
            want += lay.power[k] * std::polar(1.0, -kTwoPi * df * static_cast<double>(lay.delay[k]) / fs);
        for (std::size_t s = 0; s < ns; ++s) {
            fading::diffuse_at(ds[s], lay, Phi0, v);
            std::complex<double> h1(0.0, 0.0), h0(0.0, 0.0);
            for (std::size_t k = 0; k < v.size(); ++k) {
                h1 += v[k] * std::polar(1.0, -kTwoPi * df * static_cast<double>(lay.delay[k]) / fs);
                h0 += v[k];
            }
            acc += h1 * std::conj(h0);
        }
        acc /= static_cast<double>(ns);
        MESSAGE("频率相关 Δf = " << fmt(df) << " Hz：|R| = " << fmt(std::abs(acc)) << "，离散时延谱 " << fmt(std::abs(want)));
        CHECK(std::abs(acc - want) < 5.0 * se);
    }
}

TEST_CASE("衰落生成核 · MATLAB 一方：同一组随机量，引擎散射复增益对 fading.matlab.json（1e-9）") {
    const std::string in_path = repo("engine/tests/golden/fading.json");
    const nlohmann::json g = read_json(in_path);
    const nlohmann::json m = read_json(repo("engine/tests/golden/fading.matlab.json"));
    std::ifstream f(in_path.c_str(), std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    CHECK(m["input_sha256"].get<std::string>() == sha256_hex(ss.str()));
    const double tol = m["tolerance"]["kernel_abs"].get<double>();
    CHECK_MESSAGE(tol <= 1e-9, "判据被放宽了");
    CHECK(fading::rms_ratio() == doctest::Approx(m["rms_ratio"].get<double>()).epsilon(1e-12));

    Xoshiro256pp rng(g["seed"].get<std::uint64_t>());
    fading::Draws d;
    fading::draw(rng, d);
    fading::Layout lay;
    std::string err;
    REQUIRE(fading::layout(g["diffuse"]["delay_spread_ns"].get<double>() * 1e-9, g["diffuse"]["fs_Hz"], lay, err));
    REQUIRE(lay.delay.size() == m["delays"].size());
    for (std::size_t k = 0; k < lay.delay.size(); ++k) CHECK(lay.delay[k] == m["delays"][k].get<std::uint64_t>());
    double worst = 0.0;
    std::vector<std::complex<double> > v;
    for (std::size_t j = 0; j < m["Phi"].size(); ++j) {
        fading::diffuse_at(d, lay, m["Phi"][j].get<double>(), v);
        for (std::size_t k = 0; k < v.size(); ++k)
            worst = std::max(worst, std::abs(v[k] - std::complex<double>(m["values_re"][j][k].get<double>(),
                                                                         m["values_im"][j][k].get<double>())));
    }
    MESSAGE("引擎对 MATLAB：散射复增益最大绝对差 " << fmt(worst));
    CHECK(worst <= tol);
}
