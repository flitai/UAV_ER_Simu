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

#include "cuav/components/scenario.h"
#include "cuav/platform.h"
#include "cuav/random.h"
#include "cuav/scenario_json.h"
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
