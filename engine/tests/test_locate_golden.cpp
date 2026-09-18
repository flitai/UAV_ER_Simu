// 移植自 emcore 的定位几何与 AOA 交汇：对拍原黄金基准（D-053 §7.1、§7.3；铁律 13）。
//
// 基准文件 `tests/golden/{geo_fix,aoa_location}.json` 拷自
// `C-UAV Model Demo/emcore/tests/golden/`，`_meta` 里记了来源与去处。
// 求解器已改成平面坐标接口，因此这里走 `geo::legacy` 的 111320 投影回放——
// 那条路径存在的唯一理由就是守住这份基准（D-009：移植模块保留原常数，新代码用严格 ENU）。

#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav_geo/fix_geometry.h"
#include "cuav_geo/locate_aoa.h"
#include "cuav_geo/locate_tdoa.h"
#include "cuav_geo/legacy_frames.h"

using namespace cuav;

namespace {

std::string repo_path(const char* rel) {
    // 与 test_scenario.cpp 同法：仓库根由编译期宏 CUAV_SOURCE_DIR（= engine/）上溯一级
    return std::string(CUAV_SOURCE_DIR) + "/../" + rel;
}

nlohmann::json load_golden(const char* rel) {
    std::ifstream f(repo_path(rel).c_str(), std::ios::binary);
    REQUIRE_MESSAGE(f.good(), "读不到 " << rel);
    std::stringstream ss;
    ss << f.rdbuf();
    return nlohmann::json::parse(ss.str());
}

/** 相对误差判据：两侧都接近 0 时退回绝对误差，否则被除数是 0 会永远不过。 */
void check_rel(double got, double want, double tol, const char* what) {
    const double denom = std::fmax(std::fabs(want), 1e-12);
    const double rel = std::fabs(got - want) / denom;
    CHECK_MESSAGE((rel <= tol || std::fabs(got - want) <= 1e-12),
                  what << "：得 " << got << "，基准 " << want << "，相对误差 " << rel);
}

const double kTol = 1e-9;

}  // namespace

TEST_CASE("黄金基准：定位几何四个函数与 emcore 逐值相符（相对误差 ≤ 1e-9）") {
    const nlohmann::json g = load_golden("tests/golden/geo_fix.json");
    CHECK(g["_meta"]["tolerance_rel"].get<double>() == doctest::Approx(kTol));

    std::size_t n = 0;
    for (const auto& c : g["localFrame"]) {
        const geo::legacy::LocalFrame f = geo::legacy::local_frame_locate(c["in"][0].get<double>());
        check_rel(f.m_per_deg_lat, c["out"]["mPerDegLat"].get<double>(), kTol, "mPerDegLat");
        check_rel(f.m_per_deg_lon, c["out"]["mPerDegLon"].get<double>(), kTol, "mPerDegLon");
        ++n;
    }
    for (const auto& c : g["covarianceToEllipse"]) {
        const geo::EllipseStats s = geo::covariance_to_ellipse(
            c["in"][0].get<double>(), c["in"][1].get<double>(), c["in"][2].get<double>(),
            c["in"][3].get<int>());
        check_rel(s.cep_m, c["out"]["cep_m"].get<double>(), kTol, "cep_m");
        check_rel(s.rms_trace_m, c["out"]["rmsTrace_m"].get<double>(), kTol, "rmsTrace_m");
        check_rel(s.ellipse.semi_major_m, c["out"]["ellipse"]["semiMajor_m"].get<double>(), kTol, "semiMajor_m");
        check_rel(s.ellipse.semi_minor_m, c["out"]["ellipse"]["semiMinor_m"].get<double>(), kTol, "semiMinor_m");
        check_rel(s.ellipse.rotation_deg, c["out"]["ellipse"]["rotation_deg"].get<double>(), kTol, "rotation_deg");
        ++n;
    }
    for (const auto& c : g["invSym2x2"]) {
        geo::Sym2x2Inv inv;
        const bool ok = geo::inv_sym2x2(c["in"][0].get<double>(), c["in"][1].get<double>(),
                                        c["in"][2].get<double>(), inv);
        if (c["out"].is_null() || c["out"].contains("ok")) {
            CHECK_FALSE(ok);
        } else {
            REQUIRE(ok);
            check_rel(inv.i00, c["out"]["i00"].get<double>(), kTol, "i00");
            check_rel(inv.i01, c["out"]["i01"].get<double>(), kTol, "i01");
            check_rel(inv.i11, c["out"]["i11"].get<double>(), kTol, "i11");
            check_rel(inv.det, c["out"]["det"].get<double>(), kTol, "det");
        }
        ++n;
    }
    MESSAGE("定位几何黄金基准对拍 " << n << " 组（含 localToGeo 由 AOA 那一组间接覆盖）");
}

TEST_CASE("黄金基准：AOA 交叉定位与 emcore 逐值相符（经 legacy 的 111320 投影回放）") {
    const nlohmann::json g = load_golden("tests/golden/aoa_location.json");
    std::size_t n = 0;
    for (const auto& c : g["aoaLocalization"]) {
        std::vector<geo::legacy::AoaLonLatObs> obs;
        for (const auto& s : c["in"][0]) {
            geo::legacy::AoaLonLatObs o;
            o.lon = s["position"]["lon"].get<double>();
            o.lat = s["position"]["lat"].get<double>();
            o.bearing_deg = s["bearing_deg"].get<double>();
            o.bearing_error_deg = s["bearingError_deg"].get<double>();
            obs.push_back(o);
        }
        const geo::legacy::AoaLonLatSolution r = geo::legacy::aoa_localization_lonlat(obs);
        if (c["out"].is_null() || c["out"].is_boolean()) {
            CHECK_FALSE(r.ok);
            ++n;
            continue;
        }
        REQUIRE_MESSAGE(r.ok, "第 " << n << " 组本应有解");
        check_rel(r.lon, c["out"]["lon"].get<double>(), kTol, "lon");
        check_rel(r.lat, c["out"]["lat"].get<double>(), kTol, "lat");
        check_rel(r.cep_m, c["out"]["cep_m"].get<double>(), kTol, "cep_m");
        check_rel(r.gdop, c["out"]["gdop"].get<double>(), kTol, "gdop");
        check_rel(r.ellipse.semi_major_m, c["out"]["ellipse"]["semiMajor_m"].get<double>(), kTol, "semiMajor_m");
        check_rel(r.ellipse.semi_minor_m, c["out"]["ellipse"]["semiMinor_m"].get<double>(), kTol, "semiMinor_m");
        check_rel(r.ellipse.rotation_deg, c["out"]["ellipse"]["rotation_deg"].get<double>(), kTol, "rotation_deg");
        ++n;
    }
    MESSAGE("AOA 交汇黄金基准对拍 " << n << " 组");
}

TEST_CASE("黄金基准：AOA 的几何质量分级与方位残差口径与 emcore 一致") {
    const nlohmann::json g = load_golden("tests/golden/aoa_location.json");
    const nlohmann::json& cfg = g["_configs"];
    std::size_t n = 0;
    for (const auto& c : g["computeAOAFix"]) {
        std::vector<geo::legacy::AoaLonLatObs> obs;
        for (const auto& s : c["in"][0]) {
            const nlohmann::json& sc = cfg[s["sensorId"].get<std::string>()];
            geo::legacy::AoaLonLatObs o;
            o.lon = sc["position"]["lon"].get<double>();
            o.lat = sc["position"]["lat"].get<double>();
            o.bearing_deg = s["bearing_deg"].get<double>();
            o.bearing_error_deg = s["bearingError_deg"].get<double>();
            obs.push_back(o);
        }
        const geo::legacy::AoaLonLatSolution r = geo::legacy::aoa_localization_lonlat(obs);
        const bool want_valid = c["out"].contains("position") && !c["out"]["position"].is_null()
                                && c["out"].value("valid", true);
        if (!want_valid && !r.ok) { ++n; continue; }
        REQUIRE(r.ok);
        check_rel(r.lon, c["out"]["position"]["lon"].get<double>(), kTol, "lon");
        check_rel(r.lat, c["out"]["position"]["lat"].get<double>(), kTol, "lat");
        check_rel(r.cep_m, c["out"]["cep_m"].get<double>(), kTol, "cep_m");

        // 几何质量：最大张角分级
        double spread = 0.0;
        for (std::size_t i = 0; i < obs.size(); ++i) {
            for (std::size_t j = i + 1; j < obs.size(); ++j) {
                double d = std::fabs(obs[i].bearing_deg - obs[j].bearing_deg);
                if (d > 180.0) d = 360.0 - d;
                spread = std::fmax(spread, d);
            }
        }
        CHECK(std::string(geo::to_string(geo::aoa_geometry_grade(spread)))
              == c["out"]["geometryQuality"].get<std::string>());

        const std::vector<double> res = geo::legacy::aoa_residuals_lonlat(obs, r.lon, r.lat);
        REQUIRE(res.size() == c["out"]["residuals_deg"].size());
        for (std::size_t i = 0; i < res.size(); ++i) {
            const double want = c["out"]["residuals_deg"][i].get<double>();
            // 残差本身接近 0，比相对误差没意义，用绝对
            CHECK(std::fabs(res[i] - want) < 1e-9);
        }
        ++n;
    }
    MESSAGE("AOA 定位裁决黄金基准对拍 " << n << " 组");
}

TEST_CASE("黄金基准：到达时间 σ 与 emcore 逐值相符（legacy 的 10 MHz 标称带宽口径）") {
    const nlohmann::json g = load_golden("tests/golden/tdoa_location.json");
    std::size_t n = 0;
    for (const auto& c : g["toaSigma_s"]) {
        const double got = geo::legacy::toa_sigma_s(c["in"][0].get<double>(), c["in"][1].get<double>());
        check_rel(got, c["out"].get<double>(), kTol, "toa_sigma_s");
        ++n;
    }
    MESSAGE("到达时间 σ 黄金基准对拍 " << n << " 组");
}

TEST_CASE("黄金基准：TDOA 双曲定位与 emcore 逐值相符（independent_pairs 加权 + legacy 投影）") {
    const nlohmann::json g = load_golden("tests/golden/tdoa_location.json");
    const nlohmann::json& cfg = g["_configs"];
    std::size_t n = 0;
    for (const auto& c : g["computeTDOAFix"]) {
        // emcore 的输入是经纬度 + 信噪比；σ 由 legacy::toa_sigma_s 算，投影用 111320
        struct Row { double lon, lat, toa, snr, sync_ns; std::string id; };
        std::vector<Row> rows;
        for (const auto& s : c["in"][0]) {
            const std::string sid = s["sensorId"].get<std::string>();
            const nlohmann::json& sc = cfg[sid];
            Row r;
            r.lon = sc["position"]["lon"].get<double>();
            r.lat = sc["position"]["lat"].get<double>();
            r.toa = s["toa_s"].get<double>();
            r.snr = s["snr_dB"].get<double>();
            // 站钟 σ 在**站点配置**里（SensorConfig.syncAccuracy_ns），缺省 3.0（kDefaultSyncSigma_ns）。
            // 第一版从量测行里找，于是三站都取了缺省值——位置照样对得上（它不依赖权重的绝对大小），
            // 只有椭圆与 CEP 差了两成，正好把「权重口径错了」暴露出来。
            r.sync_ns = sc.contains("syncAccuracy_ns") ? sc["syncAccuracy_ns"].get<double>() : 3.0;
            r.id = sid;
            rows.push_back(r);
        }
        if (rows.size() < 3) { ++n; continue; }

        // 参考站 = 最高信噪比（EM-S-07 §10.5）
        std::size_t ref = 0;
        for (std::size_t i = 1; i < rows.size(); ++i) if (rows[i].snr > rows[ref].snr) ref = i;

        const geo::legacy::LocalFrame f = geo::legacy::local_frame_locate(rows[ref].lat);
        std::vector<geo::ToaPlaneObs> obs;
        for (std::size_t i = 0; i < rows.size(); ++i) {
            geo::ToaPlaneObs o;
            o.x_m = (rows[i].lon - rows[ref].lon) * f.m_per_deg_lon;
            o.y_m = (rows[i].lat - rows[ref].lat) * f.m_per_deg_lat;
            o.toa_s = rows[i].toa;
            // emcore 的 σ_pick 不含同步项，同步项单列（见 locate_tdoa.cpp 的 var_dt）
            const double total = geo::legacy::toa_sigma_s(rows[i].snr, 0.0);
            o.sigma_pick_s = total;
            o.sigma_sync_s = rows[i].sync_ns * 1e-9;
            obs.push_back(o);
        }
        // 第二个入参是同帧 AOA 解作初值（`in[1]`，一半的用例给了）。
        // 第一版一律传空，于是给不给初值算出来一样——奇数组的椭圆差 5e-6，正好把这个漏掉的入参照出来。
        double ix = 0.0, iy = 0.0;
        const bool has_init = c["in"].size() > 1 && c["in"][1].is_object();
        if (has_init) {
            ix = (c["in"][1]["lon"].get<double>() - rows[ref].lon) * f.m_per_deg_lon;
            iy = (c["in"][1]["lat"].get<double>() - rows[ref].lat) * f.m_per_deg_lat;
        }
        const geo::TdoaPlaneSolution s = geo::tdoa_solve_plane(
            obs, ref, geo::TdoaWeighting::IndependentPairs,
            has_init ? &ix : 0, has_init ? &iy : 0);
        const bool want_valid = c["out"].contains("position") && !c["out"]["position"].is_null();
        if (!want_valid) { CHECK_FALSE(s.ok); ++n; continue; }
        REQUIRE_MESSAGE(s.ok, "第 " << n << " 组本应有解");

        const double lon = rows[ref].lon + s.x_m / f.m_per_deg_lon;
        const double lat = rows[ref].lat + s.y_m / f.m_per_deg_lat;
        check_rel(lon, c["out"]["position"]["lon"].get<double>(), kTol, "lon");
        check_rel(lat, c["out"]["position"]["lat"].get<double>(), kTol, "lat");
        check_rel(s.stats.cep_m, c["out"]["cep_m"].get<double>(), kTol, "cep_m");
        check_rel(s.gdop, c["out"]["gdop"].get<double>(), kTol, "gdop");
        check_rel(s.stats.ellipse.semi_major_m, c["out"]["errorEllipse"]["semiMajor_m"].get<double>(), kTol, "semiMajor_m");
        check_rel(s.stats.ellipse.semi_minor_m, c["out"]["errorEllipse"]["semiMinor_m"].get<double>(), kTol, "semiMinor_m");
        check_rel(s.stats.ellipse.rotation_deg, c["out"]["errorEllipse"]["rotation_deg"].get<double>(), kTol, "rotation_deg");
        CHECK(rows[s.ref_index].id == c["out"]["refStationId"].get<std::string>());
        CHECK(std::string(geo::to_string(s.geometry_quality)) == c["out"]["geometryQuality"].get<std::string>());
        CHECK(std::string(geo::to_string(s.time_quality)) == c["out"]["timeQuality"].get<std::string>());
        check_rel(s.avg_sync_ns, c["out"]["syncSigma_ns"].get<double>(), kTol, "syncSigma_ns");
        ++n;
    }
    MESSAGE("TDOA 双曲定位黄金基准对拍 " << n << " 组");
}
