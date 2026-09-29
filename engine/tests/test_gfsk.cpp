// GFSK 族波形的单测（Q-3，14 号报告 §3，决策 D-089）。
//
// 分组：
//   ① 预设表：geo/src/gfsk_presets.cpp 与 models/radiator/gfsk-presets-v1.json 逐项相同，
//      且表文件的 sha256 与生成时记下的一致（防「改了 JSON 忘了重生成」）。
//   ② 调制核（engine/src/gfsk.cpp）：比特对 Python 逐位、相位与瞬时频率对 mpmath 不截断全和
//      （黄金基准 engine/tests/golden/gfsk.json，算法核尺度 1e-9）、对 MATLAB 一方（gfsk.matlab.json，可选）、
//      长游程斜率 = h/2、2-FSK 相位分段线性、瞬时频率是相位的导数。

#include <cmath>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "cuav/gfsk.h"
#include "cuav/sha256.h"
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
