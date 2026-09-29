// GFSK 族波形的单测（Q-3，14 号报告 §3，决策 D-089）。
//
// 分组：
//   ① 预设表：geo/src/gfsk_presets.cpp 与 models/radiator/gfsk-presets-v1.json 逐项相同，
//      且表文件的 sha256 与生成时记下的一致（防「改了 JSON 忘了重生成」）。

#include <fstream>
#include <iterator>
#include <string>

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
