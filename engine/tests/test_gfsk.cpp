// GFSK 族波形的单测（Q-3，14 号报告 §3，决策 D-089）。
//
// 分组：
//   ① 预设表：geo/src/gfsk_presets.cpp 与 models/radiator/gfsk-presets-v1.json 逐项相同，
//      且表文件的 sha256 与生成时记下的一致（防「改了 JSON 忘了重生成」）。
//   ② 调制核（engine/src/gfsk.cpp）：比特对 Python 逐位、相位与瞬时频率对 mpmath 不截断全和
//      （黄金基准 engine/tests/golden/gfsk.json，算法核尺度 1e-9）、对 MATLAB 一方（gfsk.matlab.json，可选）、
//      长游程斜率 = h/2、2-FSK 相位分段线性、瞬时频率是相位的导数。
//   ③ 帧排布（geo/src/gfsk_frame.cpp）：整张包表对 Python 复刻逐位（黄金基准 gfsk_frame.json）。
//   ④ 源的生成路径（SceneEmitterSource 的 gfsk）：对 Python 全路径复刻（组件尺度 1e-6，scene_gfsk.json）、
//      块长无关、前缀性质、重新 init 复现、包内恒包络 |x| = 1、包外恰为零、整包开关、逐包频点、溯源。

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "cuav/components/scenario.h"
#include "cuav/gfsk.h"
#include "cuav/random.h"
#include "cuav/scenario_json.h"
#include "cuav/sha256.h"
#include "cuav_geo/gfsk_frame.h"
#include "cuav_geo/ofdm_frame.h"
#include "cuav_geo/gfsk_presets.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif

std::string repo_path(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

std::string read_bytes(const std::string& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    REQUIRE_MESSAGE(f.good(), "读不到 " << path);
    return std::string(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
}
}  // namespace

TEST_CASE("GFSK 预设表：生成的 C++ 与 models/radiator/gfsk-presets-v1.json 逐项相同") {
    const std::string raw = read_bytes(repo_path("models/radiator/gfsk-presets-v1.json"));
    CHECK_MESSAGE(sha256_hex(raw) == std::string(geo::gfsk_presets_v1_sha256()),
                  "表文件变了而 C++ 没重生成：uv run --quiet python scripts/gen_gfsk_presets.py");
    const nlohmann::json j = nlohmann::json::parse(raw);
    CHECK(j.at("schema").get<std::string>() == "cuav-gfsk-presets/1");

    const auto& ps = j.at("presets");
    REQUIRE(ps.size() == geo::gfsk_preset_v1_count());
    for (std::size_t i = 0; i < ps.size(); ++i) {
        const auto& p = ps[i];
        const std::string id = p.at("id").get<std::string>();
        CAPTURE(id);
        const geo::GfskPreset* c = geo::gfsk_preset_v1(id);
        REQUIRE(c != 0);
        CHECK(c == &geo::gfsk_preset_v1_at(i));  // 顺序与 JSON 相同
        CHECK(std::string(c->type) == p.at("type").get<std::string>());
        CHECK(std::string(c->role) == p.at("role").get<std::string>());
        CHECK(std::string(c->credibility) == p.at("credibility").get<std::string>());
        const std::string mod = p.at("modulation").get<std::string>();
        CHECK(c->gaussian == (mod == "gfsk" ? 1 : 0));
        if (c->gaussian) CHECK(c->bt == p.at("bt").get<double>());
        else CHECK(p.at("bt").is_null());
        CHECK(c->symbol_rate_Hz == p.at("symbol_rate_Hz").get<double>());
        CHECK(c->deviation_Hz == p.at("deviation_Hz").get<double>());
        CHECK(c->occupied_bw_Hz == p.at("occupied_bw_Hz").get<double>());
        CHECK(c->occupied_bw_Hz == 2.0 * (c->deviation_Hz + c->symbol_rate_Hz / 2.0));   // Carson，逐位
        CHECK(c->preamble_bits == 8 * p.at("preamble_bytes").get<int>());
        const std::string sw = p.at("sync_word").get<std::string>();
        CHECK(c->sync_word == static_cast<std::uint32_t>(std::stoul(sw.substr(2), 0, 16)));
        CHECK(c->sync_bits == 4 * static_cast<int>(sw.size() - 2));

        const auto& fr = p.at("frame");
        CHECK(c->period_s == fr.at("period_s").get<double>());
        const auto& pk = fr.at("packets");
        REQUIRE(c->n_packets == static_cast<int>(pk.size()));
        for (int k = 0; k < c->n_packets; ++k) {
            CHECK(c->packets[k].offset_s == pk[static_cast<std::size_t>(k)].at("offset_s").get<double>());
            CHECK(c->packets[k].n_bits == pk[static_cast<std::size_t>(k)].at("n_bits").get<int>());
        }
        CHECK(c->hop_dwell_s == p.at("hop").at("dwell_s").get<double>());
        CHECK(c->hop_dwell_s == c->period_s);
    }
    CHECK(geo::gfsk_preset_v1("no-such-preset") == 0);
}

TEST_CASE("GFSK 预设表：S 档数字对开源实现的寄存器注释与数据手册") {
    // MPM Futaba_cc2500.ino 注释：Data rate = 128143bps、Deviation = 38085.9Hz；每包 23 字节
    const geo::GfskPreset* s = geo::gfsk_preset_v1("futaba-sfhss");
    REQUIRE(s != 0);
    CHECK(s->gaussian == 0);
    CHECK(static_cast<long>(s->symbol_rate_Hz + 0.5) == 128143);
    CHECK(s->deviation_Hz == doctest::Approx(38085.9).epsilon(2e-6));
    CHECK(s->n_packets == 2);
    CHECK(s->packets[0].n_bits == (4 + 4 + 13 + 2) * 8);
    CHECK(s->packets[1].offset_s == 1625e-6);   // SFHSS_DATA2_TIMING
    CHECK(s->period_s == 6800e-6);              // SFHSS_PACKET_PERIOD
    // CC2500 SWRS040C §16.1：GFSK 是 BT = 1
    const geo::GfskPreset* f = geo::gfsk_preset_v1("frsky-d16v2-fcc");
    REQUIRE(f != 0);
    CHECK(f->gaussian == 1);
    CHECK(f->bt == 1.0);
    CHECK(f->sync_word == 0xD391D391u);
}

TEST_CASE("GFSK 调制核：对 mpmath 不截断全和（黄金基准 gfsk.json，1e-9 圈）") {
    const std::string raw = read_bytes(repo_path("engine/tests/golden/gfsk.json"));
    const nlohmann::json j = nlohmann::json::parse(raw);
    CHECK(j.at("presets").at("sha256").get<std::string>() == std::string(geo::gfsk_presets_v1_sha256()));
    const double tol_ph = j.at("tolerance").at("phase_cycles_abs").get<double>();
    const double tol_f = j.at("tolerance").at("inst_freq_abs_over_deviation").get<double>();
    REQUIRE(j.at("cases").size() == 3);
    for (const auto& c : j.at("cases")) {
        const std::string name = c.at("name").get<std::string>();
        CAPTURE(name);
        const geo::GfskPreset* p = geo::gfsk_preset_v1(c.at("preset").get<std::string>());
        REQUIRE(p != 0);
        // 比特逐位（整数随机源）
        std::vector<signed char> a;
        gfsk::packet_bits(*p, c.at("n_bits").get<int>(), c.at("seed").get<std::uint64_t>(), a);
        const std::string bits = c.at("bits").get<std::string>();
        REQUIRE(a.size() == bits.size());
        for (std::size_t i = 0; i < a.size(); ++i) CHECK(a[i] == (bits[i] == '1' ? 1 : -1));

        gfsk::Modulator m;
        std::string err;
        REQUIRE(m.init(c.at("gaussian").get<int>(), c.at("bt").get<double>(), c.at("symbol_rate_Hz").get<double>(),
                       c.at("deviation_Hz").get<double>(), err));
        gfsk::Packet pk;
        gfsk::Modulator::prepare(a, pk);
        const auto& taus = c.at("tau_s");
        const auto& ph = c.at("phase_cycles");
        const auto& fq = c.at("inst_freq_Hz");
        double worst_ph = 0.0, worst_f = 0.0;
        for (std::size_t i = 0; i < taus.size(); ++i) {
            const double t = taus[i].get<double>();
            worst_ph = std::max(worst_ph, std::fabs(m.phase_cycles(pk, t) - ph[i].get<double>()));
            if (!fq[i].is_null())
                worst_f = std::max(worst_f, std::fabs(m.inst_freq_Hz(pk, t) - fq[i].get<double>()));
        }
        MESSAGE(name << "：相位最坏 " << worst_ph << " 圈，瞬时频率最坏 " << worst_f << " Hz，窗口 K = " << m.window());
        CHECK(worst_ph <= tol_ph);
        CHECK(worst_f <= tol_f * m.deviation_Hz());
    }
}

TEST_CASE("GFSK 调制核：对 MATLAB 一方（gfsk.matlab.json，可选）") {
    std::ifstream f(repo_path("engine/tests/golden/gfsk.matlab.json").c_str(), std::ios::binary);
    if (!f.good()) {
        MESSAGE("gfsk.matlab.json 不在：MATLAB 一方是可选的（matlab/run_matlab.sh），跳过，不当作通过");
        return;
    }
    const nlohmann::json mj = nlohmann::json::parse(std::string(std::istreambuf_iterator<char>(f),
                                                                std::istreambuf_iterator<char>()));
    const nlohmann::json j = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/gfsk.json")));
    // MATLAB 用的是与 gfsk.json 同一份比特与时刻：核对输入指纹，免得两份文件各说各话
    CHECK(mj.at("input_sha256").get<std::string>() == sha256_hex(read_bytes(repo_path("engine/tests/golden/gfsk.json"))));
    const double tol = mj.at("tolerance").at("phase_cycles_abs").get<double>();
    const auto& mc = mj.at("closed_form");
    REQUIRE(mc.size() == j.at("cases").size());
    for (std::size_t ci = 0; ci < mc.size(); ++ci) {
        const auto& c = j.at("cases")[ci];
        CAPTURE(c.at("name").get<std::string>());
        gfsk::Modulator m;
        std::string err;
        REQUIRE(m.init(c.at("gaussian").get<int>(), c.at("bt").get<double>(), c.at("symbol_rate_Hz").get<double>(),
                       c.at("deviation_Hz").get<double>(), err));
        std::vector<signed char> a;
        for (char b : c.at("bits").get<std::string>()) a.push_back(b == '1' ? 1 : -1);
        gfsk::Packet pk;
        gfsk::Modulator::prepare(a, pk);
        const auto& taus = c.at("tau_s");
        const auto& ph = mc[ci].at("phase_cycles");
        REQUIRE(ph.size() == taus.size());
        double worst = 0.0;
        for (std::size_t i = 0; i < taus.size(); ++i)
            worst = std::max(worst, std::fabs(m.phase_cycles(pk, taus[i].get<double>()) - ph[i].get<double>()));
        CHECK(worst <= tol);
    }
    // 2-FSK 对 comm.CPFSKModulator：按整数每符号样点数取的相位（去掉 MATLAB 的整圈卷绕）
    const auto& cp = mj.at("cpfsk");
    const auto& c = j.at("cases")[1];
    REQUIRE(c.at("gaussian").get<int>() == 0);
    gfsk::Modulator m;
    std::string err;
    REQUIRE(m.init(0, 0.0, c.at("symbol_rate_Hz").get<double>(), c.at("deviation_Hz").get<double>(), err));
    std::vector<signed char> a;
    for (char b : c.at("bits").get<std::string>()) a.push_back(b == '1' ? 1 : -1);
    gfsk::Packet pk;
    gfsk::Modulator::prepare(a, pk);
    const int sps = cp.at("samples_per_symbol").get<int>();
    const auto& mp = cp.at("phase_cycles");
    double worst = 0.0;
    for (std::size_t n = 0; n < mp.size(); ++n) {
        const double tau = static_cast<double>(n) / (sps * m.symbol_rate_Hz());
        worst = std::max(worst, std::fabs(m.phase_cycles(pk, tau) - mp[n].get<double>()));
    }
    MESSAGE("2-FSK 对 comm.CPFSKModulator：最坏 " << worst << " 圈（" << mp.size() << " 个样点）");
    CHECK(worst <= tol);
}

TEST_CASE("GFSK 调制核：结构性质") {
    const geo::GfskPreset* f = geo::gfsk_preset_v1("frsky-d16v2-fcc");
    const geo::GfskPreset* s = geo::gfsk_preset_v1("futaba-sfhss");
    REQUIRE(f != 0);
    REQUIRE(s != 0);
    std::string err;

    SUBCASE("窗口：BT = 1 时 K = 3（σ̃ = 0.1325 符号），2-FSK 时 K = 0") {
        gfsk::Modulator m;
        REQUIRE(m.init(*f, err));
        CHECK(m.window() == 3);
        CHECK(m.sigma_symbols() == doctest::Approx(0.13250).epsilon(1e-4));
        gfsk::Modulator m2;
        REQUIRE(m2.init(*s, err));
        CHECK(m2.window() == 0);
    }
    SUBCASE("长游程中段每符号相位增量恰为 h/2") {
        for (int which = 0; which < 2; ++which) {
            const geo::GfskPreset& p = which ? *s : *f;
            gfsk::Modulator m;
            REQUIRE(m.init(p, err));
            gfsk::Packet pk;
            gfsk::Modulator::prepare(std::vector<signed char>(16, -1), pk);
            const double T = 1.0 / p.symbol_rate_Hz;
            const double d = m.phase_cycles(pk, 9.37 * T) - m.phase_cycles(pk, 8.37 * T);
            CHECK(d == doctest::Approx(-p.deviation_Hz / p.symbol_rate_Hz).epsilon(1e-13));
            // 长游程中段的瞬时频率 = −f_dev
            CHECK(m.inst_freq_Hz(pk, 8.5 * T) == doctest::Approx(-p.deviation_Hz).epsilon(1e-13));
        }
    }
    SUBCASE("包前相位为零、包后恒为 (h/2)·Σa，频率回到载波") {
        gfsk::Modulator m;
        REQUIRE(m.init(*f, err));
        std::vector<signed char> a;
        gfsk::packet_bits(*f, 219, 1234, a);
        gfsk::Packet pk;
        gfsk::Modulator::prepare(a, pk);
        const double T = 1.0 / f->symbol_rate_Hz;
        CHECK(std::fabs(m.phase_cycles(pk, -10.0 * T)) == 0.0);
        const double end = (f->deviation_Hz / f->symbol_rate_Hz) * pk.prefix.back();
        CHECK(m.phase_cycles(pk, 230.0 * T) == doctest::Approx(end).epsilon(1e-14));
        CHECK(std::fabs(m.inst_freq_Hz(pk, 240.0 * T)) < 1e-9);
        // 开头从载波起步：第一个符号起点的频率是半个频偏（高斯脉冲的一半）
        CHECK(m.inst_freq_Hz(pk, 0.0) == doctest::Approx(0.5 * f->deviation_Hz * a[0]).epsilon(1e-6));
    }
    SUBCASE("瞬时频率是相位的导数（中心差分，误差按三阶导数界）") {
        gfsk::Modulator m;
        REQUIRE(m.init(*f, err));
        std::vector<signed char> a;
        gfsk::packet_bits(*f, 219, 99, a);
        gfsk::Packet pk;
        gfsk::Modulator::prepare(a, pk);
        const double T = 1.0 / f->symbol_rate_Hz;
        const double h = T * 1e-3;
        double worst = 0.0;
        for (int k = 0; k < 200; ++k) {
            const double t = (40.0 + 0.137 * k) * T;
            const double fd = (m.phase_cycles(pk, t + h) - m.phase_cycles(pk, t - h)) / (2.0 * h);
            worst = std::max(worst, std::fabs(fd - m.inst_freq_Hz(pk, t)));
        }
        // 中心差分的截断误差 ≤ h²/6·max|f''|。单个高斯频率脉冲 max|g̃''| = 2/(σ̃²·√(2πe))（以符号计），
        // 相邻两个脉冲可能叠加故再乘 2：f'' ≤ f_dev·R²·4/(σ̃²·√(2πe))。舍入误差 eps·|ψ|/h 小四个量级。
        const double kPi = 3.14159265358979323846;
        const double sg = m.sigma_symbols();
        const double fpp = f->deviation_Hz * f->symbol_rate_Hz * f->symbol_rate_Hz * 4.0 /
                           (sg * sg * std::sqrt(2.0 * kPi * std::exp(1.0)));
        const double bound = h * h / 6.0 * fpp;
        MESSAGE("瞬时频率 对 相位的中心差分：最坏 " << worst << " Hz，截断误差界 " << bound << " Hz");
        CHECK(worst <= bound);
    }
    SUBCASE("2-FSK 相位分段线性、跨符号连续") {
        gfsk::Modulator m;
        REQUIRE(m.init(*s, err));
        std::vector<signed char> a;
        gfsk::packet_bits(*s, 184, 5, a);
        gfsk::Packet pk;
        gfsk::Modulator::prepare(a, pk);
        const double T = 1.0 / s->symbol_rate_Hz;
        const double hh = s->deviation_Hz / s->symbol_rate_Hz;
        for (int k = 0; k < 184; ++k) {
            CHECK(m.phase_cycles(pk, (k + 0.25) * T) ==
                  doctest::Approx(hh * (pk.prefix[static_cast<std::size_t>(k)] + 0.25 * a[static_cast<std::size_t>(k)]))
                      .epsilon(1e-12));
        }
    }
    SUBCASE("前导与同步：1010… 起于 1，同步字高位先发；载荷随种子变") {
        std::vector<signed char> a, b;
        gfsk::packet_bits(*s, 184, 1, a);
        gfsk::packet_bits(*s, 184, 2, b);
        for (int i = 0; i < 32; ++i) CHECK(a[static_cast<std::size_t>(i)] == (i % 2 == 0 ? 1 : -1));
        for (int i = 0; i < 32; ++i)
            CHECK(a[static_cast<std::size_t>(32 + i)] == (((0xD391D391u >> (31 - i)) & 1u) ? 1 : -1));
        bool differ = false;
        for (std::size_t i = 64; i < a.size(); ++i) differ = differ || a[i] != b[i];
        CHECK(differ);
        for (std::size_t i = 0; i < 64; ++i) CHECK(a[i] == b[i]);
    }
}

TEST_CASE("GFSK 帧排布：整张包表对 Python 复刻逐位（gfsk_frame.json）") {
    const nlohmann::json j = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/gfsk_frame.json")));
    CHECK(j.at("presets").at("sha256").get<std::string>() == std::string(geo::gfsk_presets_v1_sha256()));
    REQUIRE(j.at("cases").size() == 2);
    for (const auto& c : j.at("cases")) {
        const std::string pid = c.at("preset").get<std::string>();
        CAPTURE(pid);
        const geo::GfskPreset* p = geo::gfsk_preset_v1(pid);
        REQUIRE(p != 0);
        geo::GfskSchedule s;
        s.build(*p, c.at("frame_offset_s").get<double>(), c.at("end_s").get<double>());
        const std::vector<geo::GfskBurst>& bs = s.bursts();
        REQUIRE(bs.size() == c.at("n_bursts").get<std::size_t>());
        // struct.pack('<qidd', k, q, t0, t1)：小端、无对齐填充
        std::string buf;
        buf.reserve(bs.size() * 28);
        auto put = [&buf](const void* v, std::size_t n) {
            const unsigned char* b = static_cast<const unsigned char*>(v);
            for (std::size_t i = 0; i < n; ++i) buf.push_back(static_cast<char>(b[i]));   // 开发机与目标机都是小端
        };
        for (std::size_t i = 0; i < bs.size(); ++i) {
            const std::int64_t k = bs[i].frame;
            const std::int32_t q = bs[i].packet;
            put(&k, 8);
            put(&q, 4);
            put(&bs[i].t0_s, 8);
            put(&bs[i].t1_s, 8);
        }
        CHECK(sha256_hex(buf) == c.at("table_sha256").get<std::string>());
        const auto& last = c.at("last");
        CHECK(bs.back().t0_s == last.at("t0_s").get<double>());
        CHECK(bs.back().t1_s == last.at("t1_s").get<double>());
        CHECK(bs.back().index == last.at("index").get<std::int64_t>());
        // 包内不重叠、相邻包之间有空档
        for (std::size_t i = 1; i < bs.size(); ++i) CHECK(bs[i - 1].t1_s < bs[i].t0_s);
    }
}

// ---------------------------------------------------------------- ④ 源的生成路径

namespace {
const char* kGfskFixture = "engine/tests/fixtures/gfsk-emitter.scenario.json";
const double kFs = 80e6, kFc = 2.44e9;

std::unique_ptr<SceneEmitterSource> make_gfsk_source(const std::string& entity, std::uint64_t total,
                                                     std::size_t block, std::uint64_t shared_seed = 7) {
    std::unique_ptr<SceneEmitterSource> s(new SceneEmitterSource());
    std::map<std::string, double> num;
    num["sample_rate_Hz"] = kFs;
    num["total_samples"] = static_cast<double>(total);
    num["block_samples"] = static_cast<double>(block);
    num["center_frequency_Hz"] = kFc;
    std::map<std::string, std::string> txt;
    txt["scenario_path"] = repo_path(kGfskFixture);
    txt["scenario_id"] = "gfsk-emitter";
    txt["entity_id"] = entity;
    std::string err;
    REQUIRE_MESSAGE(s->configure(num, txt, err), err);
    Xoshiro256pp rng(shared_seed);
    REQUIRE_MESSAGE(s->init(rng, err), err);
    return s;
}

std::vector<Complex> run_gfsk(SceneEmitterSource& s, std::vector<BlockMeta>* metas = 0) {
    std::vector<Complex> all;
    std::string err;
    for (;;) {
        PortMap in, out;
        const Step st = s.process(in, out, err);
        REQUIRE_MESSAGE(st != Step::Error, err);
        if (st != Step::Produced) break;
        const std::vector<Complex>& x = out["out"].iq.samples;
        all.insert(all.end(), x.begin(), x.end());
        if (metas) metas->push_back(out["out"].iq.meta);
    }
    return all;
}

bool same_bits_g(const std::vector<Complex>& a, const std::vector<Complex>& b, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i)
        if (!(a[i].real() == b[i].real() && a[i].imag() == b[i].imag())) return false;
    return true;
}

// 该辐射源的包表与站点样点支撑（与源同一口径：GfskSchedule + sample_at）
std::vector<geo::GfskBurst> fixture_bursts(const std::string& entity, double end_s) {
    LoadedScenario ls;
    std::string err;
    REQUIRE(load_scenario_file(repo_path(kGfskFixture), ls, err));
    const geo::Emitter* e = ls.scenario.find_emitter(entity);
    REQUIRE(e != 0);
    const geo::GfskPreset* p = geo::gfsk_preset_v1(e->emission.waveform.preset_id);
    REQUIRE(p != 0);
    geo::GfskSchedule gs;
    gs.build(*p, e->emission.waveform.frame_offset_s, end_s);
    return gs.bursts();
}
}  // namespace

TEST_CASE("GFSK 源：对 Python 全路径复刻的组件尺度黄金基准（complex64，1e-6）") {
    const nlohmann::json g = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/scene_gfsk.json")));
    const std::uint64_t N = g.at("total_samples").get<std::uint64_t>();
    const double tol = g.at("tolerance").at("sample_abs").get<double>();
    for (const auto& c : g.at("cases")) {
        const std::string ent = c.at("entity_id").get<std::string>();
        CAPTURE(ent);
        std::unique_ptr<SceneEmitterSource> s = make_gfsk_source(ent, N, 65536, g.at("shared_seed").get<std::uint64_t>());
        const std::vector<Complex> y = run_gfsk(*s);
        REQUIRE(y.size() == N);
        double worst = 0.0;
        for (const auto& seg : c.at("segments")) {
            const std::size_t st = seg.at("start").get<std::size_t>();
            const auto& js = seg.at("samples");
            for (std::size_t i = 0; i < js.size(); ++i) {
                const std::complex<double> want(js[i][0].get<double>(), js[i][1].get<double>());
                worst = std::max(worst, std::abs(std::complex<double>(y[st + i].real(), y[st + i].imag()) - want));
            }
        }
        CHECK(worst <= tol);
        double energy = 0.0;
        for (std::size_t i = 0; i < y.size(); ++i) energy += std::norm(std::complex<double>(y[i].real(), y[i].imag()));
        const double er = std::fabs(energy - c.at("energy").get<double>()) / c.at("energy").get<double>();
        CHECK(er <= g.at("tolerance").at("energy_rel").get<double>());
        MESSAGE(ent << " 对 Python：样点最差 " << worst << "、能量相对差 " << er);
        // 支撑之外恰为零，支撑之内恒包络
        const auto& sup = c.at("supports");
        std::size_t outside_nonzero = 0, k = 0;
        double env = 0.0;
        for (std::int64_t m = 0; m < static_cast<std::int64_t>(y.size()); ++m) {
            while (k < sup.size() && sup[k][1].get<std::int64_t>() <= m) ++k;
            const bool in = k < sup.size() && sup[k][0].get<std::int64_t>() <= m;
            const std::size_t u = static_cast<std::size_t>(m);
            if (!in && (y[u].real() != 0.0f || y[u].imag() != 0.0f)) ++outside_nonzero;
            if (in) env = std::max(env, std::fabs(std::abs(std::complex<double>(y[u].real(), y[u].imag())) - 1.0));
        }
        CHECK(outside_nonzero == 0u);
        CHECK(env < 1e-6);
    }
}

TEST_CASE("GFSK 源：块长无关、前缀性质、重新 init 逐位复现") {
    const std::uint64_t N = 800000;                          // 10 ms
    for (const char* ent : {"frsky", "sfhss", "frsky-hop"}) {
        CAPTURE(ent);
        std::unique_ptr<SceneEmitterSource> a = make_gfsk_source(ent, N, 65536);
        const std::vector<Complex> ref = run_gfsk(*a);
        REQUIRE(ref.size() == N);
        for (std::size_t blk : {std::size_t(7), std::size_t(997), std::size_t(125), std::size_t(N)}) {
            const std::vector<Complex> got = run_gfsk(*make_gfsk_source(ent, N, blk));
            REQUIRE(got.size() == N);
            CHECK_MESSAGE(same_bits_g(got, ref, N), "块长 " << blk);
        }
        const std::vector<Complex> half = run_gfsk(*make_gfsk_source(ent, N / 2, 65536));
        CHECK(same_bits_g(half, ref, N / 2));
        std::string err;
        Xoshiro256pp rng(7);
        REQUIRE(a->init(rng, err));
        CHECK(same_bits_g(run_gfsk(*a), ref, N));
    }
    // 块长 1（S-FHSS 头两包）
    const std::uint64_t n1 = 450000;
    const std::vector<Complex> r1 = run_gfsk(*make_gfsk_source("sfhss", n1, 65536));
    CHECK(same_bits_g(run_gfsk(*make_gfsk_source("sfhss", n1, 1)), r1, n1));
}

TEST_CASE("GFSK 源：整包开关——1.5 ms 开、7 ms 关，包起点开着就整包发完") {
    const std::uint64_t N = 800000;                          // 10 ms
    const std::vector<Complex> y = run_gfsk(*make_gfsk_source("sfhss-gated", N, 65536));
    const std::vector<geo::GfskBurst> bs = fixture_bursts("sfhss-gated", N / kFs);
    REQUIRE(bs.size() == 4);                                  // 0 / 1.625 / 6.8 / 8.425 ms
    const bool want[4] = {false, true, true, false};
    for (std::size_t i = 0; i < bs.size(); ++i) {
        const std::size_t lo = static_cast<std::size_t>(geo::sample_at(bs[i].t0_s, kFs));
        const std::size_t hi = static_cast<std::size_t>(geo::sample_at(bs[i].t1_s, kFs));
        std::size_t nonzero = 0;
        for (std::size_t m = lo; m < hi; ++m) nonzero += (y[m].real() != 0.0f || y[m].imag() != 0.0f) ? 1u : 0u;
        CAPTURE(i);
        CHECK(nonzero == (want[i] ? hi - lo : 0u));
    }
    // 第 3 个包（6.8 ms 起）终点 8.236 ms 已过 7 ms 的关断时刻，仍整包发完
    CHECK(bs[2].t1_s > 0.007);
}

TEST_CASE("GFSK 源：逐包频点取包中点时刻的 hop 值（去掉调制后量载波频率）") {
    const std::uint64_t N = 1680000;                         // 21 ms：三帧，恰好走完一轮三点跳频
    std::unique_ptr<SceneEmitterSource> s = make_gfsk_source("frsky-hop", N, 65536);
    const std::vector<Complex> y = run_gfsk(*s);
    const std::vector<geo::GfskBurst> bs = fixture_bursts("frsky-hop", N / kFs);
    REQUIRE(bs.size() == 3);
    const geo::GfskPreset* p = geo::gfsk_preset_v1("frsky-d16v2-fcc");
    gfsk::Modulator mod;
    std::string err;
    REQUIRE(mod.init(*p, err));
    // 载荷键：与源同法从共享种子 7 派生
    Xoshiro256pp shared(7);
    Xoshiro256pp sub(shared.next_u64());
    const std::uint64_t key = sub.next_u64();
    const double want[3] = {2410e6, 2470e6, 2425e6};
    for (std::size_t i = 0; i < bs.size(); ++i) {
        std::vector<signed char> a;
        gfsk::packet_bits(*p, bs[i].n_bits, geo::mix64(key ^ geo::mix64(static_cast<std::uint64_t>(bs[i].index))), a);
        gfsk::Packet pk;
        gfsk::Modulator::prepare(a, pk);
        const std::size_t lo = static_cast<std::size_t>(geo::sample_at(bs[i].t0_s, kFs));
        const std::size_t hi = static_cast<std::size_t>(geo::sample_at(bs[i].t1_s, kFs));
        // 去调制：乘 exp(−j2πψ)，剩下的是载波；相邻样点相位差的均值即载波频率
        std::complex<double> prev(0.0, 0.0), acc(0.0, 0.0);
        for (std::size_t m = lo; m < hi; ++m) {
            const double psi = mod.phase_cycles(pk, static_cast<double>(m) / kFs - bs[i].t0_s);
            const std::complex<double> c = std::complex<double>(y[m].real(), y[m].imag()) *
                                           std::polar(1.0, -2.0 * 3.14159265358979323846 * (psi - std::floor(psi)));
            if (m > lo) acc += c * std::conj(prev);
            prev = c;
        }
        const double f = std::arg(acc) * kFs / (2.0 * 3.14159265358979323846);
        CAPTURE(i);
        CHECK(std::fabs(f - (want[i] - kFc)) < 1.0);          // 1 Hz：float32 样点的相位噪声远小于它
    }
}

TEST_CASE("GFSK 源：溯源写预设与可信度，状态记一条说明") {
    std::vector<BlockMeta> metas;
    std::unique_ptr<SceneEmitterSource> s = make_gfsk_source("sfhss", 200000, 65536);
    run_gfsk(*s, &metas);
    REQUIRE(!metas.empty());
    CHECK(metas[0].trace.parameter_version == "gfsk-futaba-sfhss");
    CHECK(metas[0].trace.credibility == "V2");
    bool noted = false;
    for (const std::string& n : s->status().notes) noted = noted || n.find("GFSK 族：预设 futaba-sfhss") != std::string::npos;
    CHECK(noted);
}
