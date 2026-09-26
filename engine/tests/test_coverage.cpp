// 覆盖场单格链路预算（D-079）：geo::coverage_cell。
//
// 三件事：① 它与引擎链路预算是同一个数（E3、主模型自由空间时 path_loss = fspl + 刀口损耗）；
// ② 它守住自己生成的黄金基准 tests/golden/coverage-cells.json（浏览器侧读同一份对拍）；
// ③ 边界：没有地图不算遮挡、距离为零给 invalid、调用方填在 occ 里的频率不读。

#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"
#include "cuav_geo/coverage.h"
#include "cuav_geo/link_budget.h"
#include "cuav_geo/map.h"
#include "cuav_geo/propagation.h"

using namespace cuav::geo;

namespace {

std::string repo(const char* rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

double rel_err(double a, double b) {
    const double d = std::fabs(a - b);
    const double s = std::max(std::fabs(a), std::fabs(b));
    return s > 0.0 ? d / s : d;
}

// 站在原点、目标在正东，中间一堵墙（与 test_occlusion.cpp 的 E3Fixture 同构，自造几何不依赖数据包）
struct Wall {
    Lla origin{116.405, 39.99, 0.0};
    SceneFrame frame{origin};
    LocalSceneAdapter map;
    Wall() {
        Building b;
        b.id = "WALL";
        b.base_m = 0.0;
        b.height_m = 90.0;
        b.ring_x = {380.0, 420.0, 420.0, 380.0};
        b.ring_y = {-80.0, -80.0, 80.0, 80.0};
        map.set_buildings(std::vector<Building>{b});
    }
    OcclusionQuery query(double f) const {
        OcclusionQuery q;
        q.map = &map;
        q.frame = frame;
        q.frequency_Hz = f;
        return q;
    }
};

CoverageLink default_link(double f) {
    CoverageLink l;
    l.tx_power_dBm = 27.0;
    l.tx_gain_dBi = 2.0;
    l.rx_gain_dBi = 3.0;
    l.nf_dB = 6.0;
    l.noise_bw_Hz = 921.0 * 500000.0 / 1024.0;
    l.frequency_Hz = f;
    return l;
}

}  // namespace

TEST_CASE("覆盖场：单格路损 = 引擎 E3 链路预算的 path_loss（被挡与未被挡各一）") {
    Wall w;
    const Lla site(116.405, 39.99, 30.0);
    const double f = 2.44e9;
    const OcclusionQuery q = w.query(f);
    PropagationConfig cfg;
    cfg.level = PropLevel::E3;   // 主模型缺省自由空间、阴影与天气缺省关
    for (double h : {1.5, 50.0, 200.0}) {
        const Lla target(116.405 + 800.0 / 85000.0, 39.99, h);
        const CoverageCell c = coverage_cell(site, target, 0.0, &q, default_link(f));
        const LinkGeometry g = link_geometry(site, target, Ecef(), 0.0, &q);
        const LinkBudget b = link_budget(g, f, 6.0, cfg);
        REQUIRE(c.valid);
        CHECK(c.blocked == !g.line_of_sight);
        CHECK(c.fspl_dB + c.diffraction_dB == doctest::Approx(b.path_loss_dB).epsilon(1e-12));
        CHECK(c.signal_dBm == doctest::Approx(27.0 + 2.0 + 3.0 - b.path_loss_dB).epsilon(1e-12));
    }
    // 1.5 m 的目标在 90 m 墙后必被挡；200 m 的目标从墙顶越过
    CHECK(coverage_cell(site, Lla(116.405 + 800.0 / 85000.0, 39.99, 1.5), 0.0, &q, default_link(f)).blocked);
    CHECK_FALSE(coverage_cell(site, Lla(116.405 + 800.0 / 85000.0, 39.99, 200.0), 0.0, &q, default_link(f)).blocked);
}

TEST_CASE("覆盖场：噪声 = -174 + nf + 10 log10(M fs / nfft)，没有地图不算遮挡") {
    const Lla site(116.405, 39.99, 30.0);
    const Lla target(116.405 + 1000.0 / 85000.0, 39.99, 30.0);
    const CoverageCell c = coverage_cell(site, target, 0.0, 0, default_link(2.4e9));
    REQUIRE(c.valid);
    CHECK(c.diffraction_dB == 0.0);
    CHECK_FALSE(c.blocked);
    CHECK(c.noise_dBm == doctest::Approx(-174.0 + 6.0 + 10.0 * std::log10(921.0 * 500000.0 / 1024.0)).epsilon(1e-12));
    CHECK(c.snr_dB == doctest::Approx(c.signal_dBm - c.noise_dBm).epsilon(1e-12));
    // 同高、东向约 1 km：自由空间 ≈ 100.05 dB（2.4 GHz / 1 km 的解析锚点，距离按帧实际投影略有出入）
    CHECK(c.fspl_dB == doctest::Approx(fspl_dB(c.distance_m, 2.4e9)).epsilon(1e-15));
    CHECK(std::fabs(c.fspl_dB - 100.05) < 0.2);
}

TEST_CASE("覆盖场：距离为零给 invalid；occ 里的频率不读，一律按 link 的频率") {
    Wall w;
    const Lla site(116.405, 39.99, 30.0);
    const OcclusionQuery q = w.query(2.44e9);
    CHECK_FALSE(coverage_cell(site, site, 0.0, &q, default_link(2.44e9)).valid);
    CoverageLink bad = default_link(2.44e9);
    bad.noise_bw_Hz = 0.0;
    CHECK_FALSE(coverage_cell(site, Lla(116.41, 39.99, 50.0), 0.0, &q, bad).valid);

    const Lla target(116.405 + 800.0 / 85000.0, 39.99, 1.5);
    OcclusionQuery q0 = w.query(0.0);   // 调用方漏填频率
    const CoverageCell a = coverage_cell(site, target, 0.0, &q0, default_link(5.8e9));
    const CoverageCell b = coverage_cell(site, target, 0.0, &q, default_link(5.8e9));
    CHECK(a.blocked);
    CHECK(a.diffraction_dB == b.diffraction_dB);   // 两个都按 5.8 GHz
}

TEST_CASE("覆盖场：守住黄金基准 tests/golden/coverage-cells.json（距离 rel <= 1e-9，dB 量 abs <= 1e-8）") {
    std::ifstream f(repo("tests/golden/coverage-cells.json").c_str());
    REQUIRE_MESSAGE(f.good(), "打不开 tests/golden/coverage-cells.json");
    nlohmann::json j;
    f >> j;
    std::vector<Building> bs;
    for (const auto& x : j["buildings"]) {
        Building b;
        b.id = x["id"].get<std::string>();
        b.ring_x = x["ring_x"].get<std::vector<double>>();
        b.ring_y = x["ring_y"].get<std::vector<double>>();
        b.base_m = x["base_m"].get<double>();
        b.height_m = x["height_m"].get<double>();
        bs.push_back(b);
    }
    LocalSceneAdapter map;
    map.set_buildings(bs);
    OcclusionQuery q;
    q.map = &map;
    q.frame = SceneFrame(Lla(j["origin"]["lon"].get<double>(), j["origin"]["lat"].get<double>(), 0.0));
    const double terrain = j["terrain_height_m"].get<double>();
    CoverageLink base;
    base.tx_power_dBm = j["link"]["tx_power_dBm"].get<double>();
    base.tx_gain_dBi = j["link"]["tx_gain_dBi"].get<double>();
    base.rx_gain_dBi = j["link"]["rx_gain_dBi"].get<double>();
    base.nf_dB = j["link"]["nf_dB"].get<double>();
    base.noise_bw_Hz = j["link"]["noise_bw_Hz"].get<double>();

    int n = 0, blocked = 0;
    double worst = 0.0;
    for (const auto& c : j["cases"]) {
        const auto s = c["site"];
        const auto t = c["target"];
        CoverageLink l = base;
        l.frequency_Hz = c["frequency_Hz"].get<double>();
        const CoverageCell got = coverage_cell(Lla(s[0], s[1], s[2]), Lla(t[0], t[1], t[2]), terrain, &q, l);
        const auto& o = c["out"];
        CHECK(got.valid == o["valid"].get<bool>());
        CHECK(got.blocked == o["blocked"].get<bool>());
        // 判据两种形状（基准 _meta.tolerance）：距离与自由空间路损是大正数，用相对差；
        // 信噪比、刀口损耗等 dB 量会落在 0 附近，那里相对差没有意义，用绝对差
        CHECK(rel_err(got.distance_m, o["distance_m"].get<double>()) <= 1e-9);
        CHECK(rel_err(got.fspl_dB, o["fspl_dB"].get<double>()) <= 1e-9);
        const char* keys[] = {"diffraction_dB", "signal_dBm", "noise_dBm", "snr_dB"};
        const double vals[] = {got.diffraction_dB, got.signal_dBm, got.noise_dBm, got.snr_dB};
        for (int k = 0; k < 4; ++k) {
            const double e = std::fabs(vals[k] - o[keys[k]].get<double>());
            if (e > worst) worst = e;
            CHECK(e <= 1e-8);
        }
        ++n;
        if (got.blocked) ++blocked;
    }
    CHECK(n == 85);
    CHECK(blocked == 20);   // 基准里判非视距的例数；变了就是发现（铁律 10）
    MESSAGE("coverage-cells：" << n << " 例，dB 量最差绝对差 " << worst);
}
