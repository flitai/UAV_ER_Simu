// OFDM 族波形的单测（Q-2，14 号报告 §2，决策 D-088）。
//
// 这一份先只有一组：
//   ① 预设表：geo/src/radiator_presets.cpp 与 models/radiator/presets-v1.json 逐项相同，
//      且表文件的 sha256 与生成时记下的一致（防「改了 JSON 忘了重生成」）。
// 调制器、重采样、帧排布、源的生成路径各自的用例随后续步骤加在这里。

#include <cstdint>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "cuav/sha256.h"
#include "cuav_geo/radiator_presets.h"
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

int bits_per_axis(const std::string& c) {
    if (c == "qpsk") return 1;
    if (c == "16qam") return 2;
    if (c == "64qam") return 3;
    return -1;
}
}  // namespace

TEST_CASE("预设表：生成的 C++ 与 models/radiator/presets-v1.json 逐项相同") {
    const std::string raw = read_bytes(repo_path("models/radiator/presets-v1.json"));
    CHECK_MESSAGE(sha256_hex(raw) == std::string(geo::radiator_presets_v1_sha256()),
                  "表文件变了而 C++ 没重生成：uv run --quiet python scripts/gen_radiator_presets.py");
    const nlohmann::json j = nlohmann::json::parse(raw);
    CHECK(j.at("schema").get<std::string>() == "cuav-radiator-presets/1");

    std::vector<nlohmann::json> nums;
    for (const auto& n : j.at("numerologies")) nums.push_back(n);
    auto find_num = [&](const std::string& id) -> const nlohmann::json& {
        for (const auto& n : nums)
            if (n.at("id").get<std::string>() == id) return n;
        FAIL("未知数值结构 " << id);
        return nums.front();
    };

    const auto& ps = j.at("presets");
    REQUIRE(ps.size() == geo::radiator_preset_v1_count());
    for (std::size_t i = 0; i < ps.size(); ++i) {
        const auto& p = ps[i];
        const std::string id = p.at("id").get<std::string>();
        CAPTURE(id);
        const geo::RadiatorPreset* c = geo::radiator_preset_v1(id);
        REQUIRE(c != 0);
        CHECK(c == &geo::radiator_preset_v1_at(i));  // 顺序与 JSON 相同
        CHECK(std::string(c->type) == p.at("type").get<std::string>());
        CHECK(std::string(c->role) == p.at("role").get<std::string>());
        CHECK(std::string(c->credibility) == p.at("credibility").get<std::string>());
        const auto& n = find_num(p.at("numerology").get<std::string>());
        CHECK(c->fft_size == n.at("fft_size").get<int>());
        CHECK(c->fs_native_Hz == n.at("fs_native_Hz").get<double>());
        CHECK(c->subcarrier_spacing_Hz == n.at("subcarrier_spacing_Hz").get<double>());
        CHECK(c->half_subcarriers == p.at("half_subcarriers").get<int>());
        CHECK(c->occupied_bw_Hz == p.at("occupied_bw_Hz").get<double>());
        CHECK(c->occupied_bw_Hz == (2 * c->half_subcarriers + 1) * c->subcarrier_spacing_Hz);
        CHECK(c->bits_per_axis == bits_per_axis(p.at("constellation").get<std::string>()));

        const auto& bs = p.at("bursts");
        REQUIRE(c->n_bursts == static_cast<int>(bs.size()));
        for (int b = 0; b < c->n_bursts; ++b) {
            const auto& jb = bs[static_cast<std::size_t>(b)];
            const geo::RadiatorBurst& cb = c->bursts[b];
            REQUIRE(cb.n_symbols == jb.at("n_symbols").get<int>());
            const int cs = jb.count("cp_short") ? jb.at("cp_short").get<int>() : n.at("cp_short").get<int>();
            const int cl = jb.count("cp_long") ? jb.at("cp_long").get<int>() : n.at("cp_long").get<int>();
            std::vector<int> want_cp(static_cast<std::size_t>(cb.n_symbols), cs);
            for (const auto& li : jb.at("cp_long_at")) want_cp[li.get<std::size_t>()] = cl;
            std::vector<int> want_zc(static_cast<std::size_t>(cb.n_symbols), 0);
            for (const auto& z : jb.at("zc")) want_zc[z.at(0).get<std::size_t>()] = z.at(1).get<int>();
            std::int64_t len = 0;
            for (int s = 0; s < cb.n_symbols; ++s) {
                CHECK(cb.cp[s] == want_cp[static_cast<std::size_t>(s)]);
                CHECK(cb.zc_root[s] == want_zc[static_cast<std::size_t>(s)]);
                len += c->fft_size + cb.cp[s];
            }
            CHECK(cb.length_n == len);
        }

        const double slot = p.at("frame").at("slot_s").get<double>() * c->fs_native_Hz;
        CHECK(static_cast<double>(c->slot_n) == slot);  // 整数个原生样点，逐位
        const auto& cyc = p.at("frame").at("cycle");
        REQUIRE(c->cycle_len == static_cast<int>(cyc.size()));
        for (int r = 0; r < c->cycle_len; ++r) {
            const auto& row = cyc[static_cast<std::size_t>(r)];
            REQUIRE(row.size() == static_cast<std::size_t>(c->n_bursts + 1));
            for (int k = 0; k <= c->n_bursts; ++k)
                CHECK(c->cycle[r * (c->n_bursts + 1) + k] == row[static_cast<std::size_t>(k)].get<double>());
        }
    }
    CHECK(geo::radiator_preset_v1("no-such-preset") == 0);
}

TEST_CASE("预设表：DroneID 的结构逐项对 NDSS 2023 §III-B") {
    const geo::RadiatorPreset* d = geo::radiator_preset_v1("dji-droneid");
    REQUIRE(d != 0);
    CHECK(std::string(d->type) == "droneid");
    CHECK(d->fft_size == 1024);
    CHECK(d->fs_native_Hz == 15360000.0);
    CHECK(d->half_subcarriers == 300);           // 600 数据 + 1 直流
    REQUIRE(d->n_bursts == 1);
    const geo::RadiatorBurst& b = d->bursts[0];
    REQUIRE(b.n_symbols == 9);
    const int cp[9] = {80, 72, 72, 72, 72, 72, 72, 72, 80};
    const int zc[9] = {0, 0, 0, 600, 0, 147, 0, 0, 0};
    for (int s = 0; s < 9; ++s) {
        CHECK(b.cp[s] == cp[s]);
        CHECK(b.zc_root[s] == zc[s]);
    }
    CHECK(b.length_n == 9880);                   // 643.23 µs
    CHECK(d->slot_n == 9830400);                 // 640 ms
}
