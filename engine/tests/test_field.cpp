// 覆盖场（cuav_run --field，D-080）。
//
// 1. Pd 公式 pd_random 守 tests/golden/analytic-pd.json（Python 参考为真理源，rel ≤ 1e-9）；
// 2. 阴影平均对蒙特卡洛（且必须落在 Pd 的陡坡上、平均真的改变了结果）；不开阴影与单点公式逐位相同；
// 3. 逐点求值 = 引擎链路预算（E1 / E2 双径 + 天气）：路损就是 link_budget 那个数；
// 4. 频段外 → 虚警率；请求校验（未知键、E1 却开效应、缺站的检测器）。
// 用 golden-01 / golden-03 场景与观测区域清单（都在 git 里）；E3 的逐点对拍在
// tests/regression/coverage_field.py（要建筑集，不入 git）。

#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <random>
#include <string>

#include "nlohmann/json.hpp"
#include "cuav/dsp.h"
#include "cuav/field.h"
#include "cuav/propagation_params.h"
#include "cuav/scenario_json.h"
#include "cuav_geo/link_budget.h"

using namespace cuav;

namespace {

std::string repo(const char* rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

geo::Scenario load(const char* id) {
    LoadedScenario l;
    std::string err;
    const std::string p = repo((std::string("data/scene/beijing-yayuncun/scenarios/") + id + ".scenario.json").c_str());
    REQUIRE_MESSAGE(load_scenario_file(p, l, err), err);
    return l.scenario;
}

nlohmann::json base_request(const geo::Scenario& sc) {
    nlohmann::json d = nlohmann::json::object();
    for (const auto& s : sc.sites) {
        const double half = 0.45 * s.receiver.fs_Hz;
        d[s.id] = {{"nfft", 1024}, {"pfa", 1e-3}, {"band_lo_Hz", -half}, {"band_hi_Hz", half}};
    }
    return {{"schema_version", "cuav-field-request/1"}, {"emitter_id", sc.emitters[0].id},
            {"height_agl_m", 100.0}, {"res_m", 1000.0}, {"propagation", nlohmann::json::object()}, {"detectors", d}};
}

double rel_err(double a, double b) {
    const double s = std::max(std::fabs(a), std::fabs(b));
    return s > 0.0 ? std::fabs(a - b) / s : std::fabs(a - b);
}

}  // namespace

TEST_CASE("覆盖场：pd_random 守 analytic-pd.json 的随机型那一列（rel <= 1e-9）") {
    std::ifstream f(repo("tests/golden/analytic-pd.json").c_str());
    REQUIRE(f.good());
    nlohmann::json j;
    f >> j;
    int n = 0;
    for (const auto& c : j["pd_random"]) {
        const double s = std::pow(10.0, c["snr_dB"].get<double>() / 10.0);
        CHECK(rel_err(dsp::pd_random(c["m_bins"].get<int>(), c["eta"].get<double>(), s), c["pd"].get<double>()) <= 1e-9);
        ++n;
    }
    CHECK(n == 27);
}

TEST_CASE("覆盖场：逐点路损 = 引擎链路预算（E1 与 E2 双径 + 天气），Pd 按 S − N 代入") {
    const geo::Scenario sc = load("golden-01");
    for (int variant = 0; variant < 2; ++variant) {
        nlohmann::json rj = base_request(sc);
        if (variant == 1) rj["propagation"] = {{"prop_level", "E2"}, {"prop_primary", "two_ray"}, {"prop_weather", true}, {"rain_rate_mmh", 25.0}};
        rj["points"] = nlohmann::json::array({{116.41, 39.995}, {116.39, 39.98, 30.0}});
        FieldRequest req;
        std::string err;
        REQUIRE_MESSAGE(parse_field_request(rj, req, err), err);
        FieldResult r;
        REQUIRE_MESSAGE(compute_field(sc, req, repo("data/scene"), r, err), err);
        geo::PropagationConfig cfg;
        REQUIRE(propagation_from_params(req.prop_num, req.prop_txt, cfg, err));
        const geo::Site& site = sc.sites[0];
        const geo::Emitter& em = sc.emitters[0];
        for (const auto& p : r.points) {
            const geo::Lla t(p.lon, p.lat, sc.coordinate.terrainHeight_m + p.height_agl_m);
            const geo::LinkGeometry g = geo::link_geometry(site.position, t, geo::Ecef(), sc.coordinate.terrainHeight_m);
            const geo::LinkBudget b = geo::link_budget(g, em.emission.center_Hz, site.receiver.nf_dB, cfg, 0.0, em.emission.polarization);
            const FieldPointSite& ps = p.sites.at(site.id);
            CHECK(ps.path_loss_dB == b.path_loss_dB);
            const FieldSite& fs = r.sites[0];
            const double snr = em.emission.tx_power_dBm + em.emission.antenna_gain_dBi + site.antenna.gain_dBi - b.path_loss_dB
                               - (b.noise_floor_dBm_per_Hz + 10.0 * std::log10(fs.noise_bw_Hz));
            CHECK(ps.snr_dB == doctest::Approx(snr).epsilon(1e-12));
            CHECK(ps.pd == dsp::pd_random(fs.m_bins, fs.eta, std::pow(10.0, snr / 10.0)));
        }
        if (variant == 1) {
            CHECK(r.included_loss_terms.size() >= 2);   // free_space 之外至少还有双径或天气
            CHECK(r.prop_level == std::string("E2"));
        }
        CHECK(r.sites[0].m_bins == 921);   // golden-01：500 kS/s、nfft 1024、±0.45·fs
    }
}

TEST_CASE("覆盖场：阴影平均 = E[Pd(snr − X)]，对蒙特卡洛；σ 与链路帧同取视距那一档") {
    const geo::Scenario sc = load("golden-01");
    std::string err;
    FieldRequest req;
    nlohmann::json rj = base_request(sc);
    rj["tx_power_dBm_unused"] = 0;   // 未知键必须被拒
    CHECK_FALSE(parse_field_request(rj, req, err));
    rj.erase("tx_power_dBm_unused");
    // 城市经验主模型（按均值，不带裕度，才允许同开统计阴影）让 Pd 在观测区域里走完 1 → 0 的陡坡；
    // 在自由空间下 27 dBm 的目标处处 Pd = 1，平均与否都是 1，那样的对拍什么也没测（第一版就是这样）。
    rj["propagation"] = {{"prop_level", "E2"}, {"prop_primary", "urban_empirical"}, {"urban_loss_mode", "mean"},
                         {"env_class", "dense_urban"}, {"prop_shadow", true}};
    rj["res_m"] = 500.0;
    REQUIRE_MESSAGE(parse_field_request(rj, req, err), err);
    FieldResult grid;
    REQUIRE_MESSAGE(compute_field(sc, req, repo("data/scene"), grid, err), err);
    geo::PropagationConfig cfg;
    REQUIRE(propagation_from_params(req.prop_num, req.prop_txt, cfg, err));
    const double sigma = geo::shadow_sigma_dB(cfg, true);
    CHECK(grid.sites[0].shadow_sigma_dB == sigma);
    REQUIRE(sigma > 0.0);

    // 在网格上找一格「不平均时 Pd 在陡坡上」的：逐格求一次单点，取第一个 0.2 < Pd < 0.8 的
    const FieldSite& fs = grid.sites[0];
    const double dlon = (grid.bbox[2] - grid.bbox[0]) / grid.nx, dlat = (grid.bbox[3] - grid.bbox[1]) / grid.ny;
    rj["points"] = nlohmann::json::array();
    for (int j = 0; j < grid.ny; ++j)
        for (int i = 0; i < grid.nx; ++i)
            rj["points"].push_back({grid.bbox[0] + (i + 0.5) * dlon, grid.bbox[3] - (j + 0.5) * dlat});
    REQUIRE(parse_field_request(rj, req, err));
    FieldResult r;
    REQUIRE_MESSAGE(compute_field(sc, req, repo("data/scene"), r, err), err);
    const FieldPointSite* slope = 0;
    for (const auto& p : r.points) {
        const FieldPointSite& ps = p.sites.at(sc.sites[0].id);
        const double bare = dsp::pd_random(fs.m_bins, fs.eta, std::pow(10.0, ps.snr_dB / 10.0));
        if (ps.valid && bare > 0.2 && bare < 0.8) { slope = &ps; break; }
    }
    REQUIRE_MESSAGE(slope != 0, "网格上没有一格落在 Pd 的陡坡上，本用例测不到阴影平均");
    const double bare = dsp::pd_random(fs.m_bins, fs.eta, std::pow(10.0, slope->snr_dB / 10.0));
    std::mt19937_64 rng(20260927);
    std::normal_distribution<double> nd(0.0, sigma);
    double acc = 0.0;
    const int n = 200000;
    for (int i = 0; i < n; ++i) acc += dsp::pd_random(fs.m_bins, fs.eta, std::pow(10.0, (slope->snr_dB - nd(rng)) / 10.0));
    const double mc = acc / n;
    MESSAGE("snr " << slope->snr_dB << " dB，σ " << sigma << " dB：不平均 " << bare << "，查表 " << slope->pd << "，蒙特卡洛 " << mc);
    CHECK(std::fabs(slope->pd - mc) < 3e-3);          // 蒙特卡洛标准误 ≈ 0.5/√n ≈ 1.1e-3
    CHECK(std::fabs(slope->pd - bare) > 0.02);        // 平均真的改变了结果，否则这条对拍没测到东西
}

TEST_CASE("覆盖场：目标在站的检测频段外 → 逐格 Pd = 虚警率并标出") {
    const geo::Scenario sc = load("golden-01");
    nlohmann::json rj = base_request(sc);
    rj["detectors"][sc.sites[0].id]["band_lo_Hz"] = 1e6;   // 频段整个挪到 +1…+1.225 MHz
    rj["detectors"][sc.sites[0].id]["band_hi_Hz"] = 1.225e6;
    FieldRequest req;
    std::string err;
    REQUIRE_MESSAGE(parse_field_request(rj, req, err), err);
    FieldResult r;
    // 频段挪出去之后在 500 kS/s 下频段内没有频点：照实报错，不编
    CHECK_FALSE(compute_field(sc, req, repo("data/scene"), r, err));
    CHECK(err.find("没有频点") != std::string::npos);
    rj["detectors"][sc.sites[0].id]["band_lo_Hz"] = 200000.0;
    rj["detectors"][sc.sites[0].id]["band_hi_Hz"] = 225000.0;
    REQUIRE(parse_field_request(rj, req, err));
    REQUIRE_MESSAGE(compute_field(sc, req, repo("data/scene"), r, err), err);
    CHECK(r.sites[0].out_of_band);
    for (float v : r.sites[0].pd) CHECK(v == doctest::Approx(1e-3).epsilon(1e-6));
}

TEST_CASE("覆盖场：请求校验与网格") {
    const geo::Scenario sc = load("golden-03");
    std::string err;
    FieldRequest req;
    nlohmann::json rj = base_request(sc);
    rj["propagation"] = {{"prop_shadow", true}};   // E1 却开效应：与框图同一道闸
    REQUIRE(parse_field_request(rj, req, err));
    FieldResult r;
    CHECK_FALSE(compute_field(sc, req, repo("data/scene"), r, err));
    rj["propagation"] = {{"sample_rate_Hz", 500000}};   // 不是传播参数
    CHECK_FALSE(parse_field_request(rj, req, err));
    rj = base_request(sc);
    rj["detectors"].erase(sc.sites[1].id);
    REQUIRE(parse_field_request(rj, req, err));
    CHECK_FALSE(compute_field(sc, req, repo("data/scene"), r, err));
    CHECK(err.find(sc.sites[1].id) != std::string::npos);

    const double bbox[4] = {116.288, 39.900, 116.522, 40.080};
    int nx = 0, ny = 0;
    field_grid(bbox, 100.0, nx, ny);
    CHECK(nx == 200);
    CHECK(ny == 200);
    rj = base_request(sc);
    REQUIRE(parse_field_request(rj, req, err));
    REQUIRE_MESSAGE(compute_field(sc, req, repo("data/scene"), r, err), err);
    CHECK(r.nx == 20);
    CHECK(r.ny == 20);
    CHECK(r.sites.size() == 3);
    for (std::size_t k = 0; k < r.combined.size(); ++k) {
        double miss = 1.0;
        for (const auto& s : r.sites) miss *= 1.0 - s.pd[k];
        CHECK(r.combined[k] == doctest::Approx(1.0 - miss).epsilon(1e-6));
    }
}
