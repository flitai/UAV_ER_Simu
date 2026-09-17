// 建筑遮挡：桶网格线段遍历 + ITU-R P.526 单刀口衍射（EM-P-04；决策 D-005、D-074，步骤 D3-3）。
//
// geo/ 的 doctest 单测按既有惯例寄放在 engine/tests/（同 test_geo.cpp、test_propagation.cpp）。
//
// 本文件覆盖切片 ⑤ 的两条收口判据（06 §9E）：
//   · 148 例黄金基准 rel ≤ 1e-9；
//   · 解析锚点：掠射 v = 0 时刀口损耗 6.03 dB。
// 外加 fresnel_v 108 例、knife_edge_loss_dB 14 例（自 emcore propagation.json 启用，D3-3）。

#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav_geo/geodesy.h"
#include "cuav_geo/map.h"
#include "cuav_geo/occlusion.h"
#include "cuav_geo/propagation.h"

using namespace cuav;
using namespace cuav::geo;

namespace {

const double kTol = 1e-9;

std::string repo_path(const char* rel) {
    return std::string(CUAV_SOURCE_DIR) + "/../" + rel;
}

nlohmann::json load_golden(const char* rel) {
    const std::string path = repo_path(rel);
    std::ifstream f(path.c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << path);
    std::stringstream ss;
    ss << f.rdbuf();
    return nlohmann::json::parse(ss.str());
}

void check_rel(double got, double want, const char* what) {
    const double denom = std::fabs(want) > 1e-12 ? std::fabs(want) : 1.0;
    const double rel = std::fabs(got - want) / denom;
    CHECK_MESSAGE((rel <= kTol || std::fabs(got - want) <= 1e-12),
                  what << "：得 " << got << "，基准 " << want << "，相对误差 " << rel);
}

}  // namespace

TEST_CASE("刀口衍射：对 emcore 黄金基准 fresnel_v 108 例 + knife_edge_loss_dB 14 例") {
    const nlohmann::json g = load_golden("tests/golden/propagation.json");

    REQUIRE(g.contains("fresnelV"));
    REQUIRE(g["fresnelV"].size() == 108);
    for (const auto& c : g["fresnelV"]) {
        const double h = c["in"][0].get<double>();
        const double d1 = c["in"][1].get<double>();
        const double d2 = c["in"][2].get<double>();
        const double f = c["in"][3].get<double>();
        check_rel(legacy::fresnel_v(h, d1, d2, f), c["out"].get<double>(), "fresnel_v");
    }

    REQUIRE(g.contains("knifeEdgeLoss_dB"));
    REQUIRE(g["knifeEdgeLoss_dB"].size() == 14);
    for (const auto& c : g["knifeEdgeLoss_dB"]) {
        check_rel(legacy::knife_edge_loss_dB(c["in"][0].get<double>()),
                  c["out"].get<double>(), "knife_edge_loss_dB");
    }
}

TEST_CASE("刀口衍射：解析锚点与边界") {
    // 掠射：视线正好擦过刀口顶。6.9 + 20·log10(√(0.01+1) − 0.1) = 6.0329 dB
    const double grazing = legacy::knife_edge_loss_dB(0.0);
    CHECK(std::fabs(grazing - 6.0329) < 1e-3);

    // 模型的截止：v ≤ −0.78 判为无遮挡
    CHECK(legacy::knife_edge_loss_dB(-0.78) == 0.0);
    CHECK(legacy::knife_edge_loss_dB(-2.0) == 0.0);
    CHECK(legacy::knife_edge_loss_dB(-0.7) > 0.0);

    // 单调：v 越大遮得越深
    double prev = legacy::knife_edge_loss_dB(0.0);
    for (double v = 0.5; v <= 20.0; v += 0.5) {
        const double cur = legacy::knife_edge_loss_dB(v);
        CHECK(cur > prev);
        prev = cur;
    }

    // 光速守的是黄金基准那份 3e8，不是 299792458（D-009）。拿同一组几何按两个光速各算一次。
    //
    // **量级是 3e-3 dB，不是 1e-5 dB**——07 报告 §6.4 与 §8 原写「1e-5 dB 量级」，
    // 是把两个光速的相对差看成了 6.9e-7，实际是 **6.9e-4**（3e8 比 299792458 大 0.069%），
    // 差三个数量级。推导：v ∝ 1/√λ ∝ 1/√c 故 δv/v = 3.46e-4；
    // 大 v 时 L ≈ 6.9 + 20·log10(2v)，dL/dv = 8.686/v，于是 δL ≈ 8.686 × 3.46e-4 = 3.0e-3 dB。
    // 这条断言当场逮住了那个错（写成注释就逮不住），修正记进 07 报告 §14.3。
    //
    // 3e-3 dB 物理上仍然无关紧要，但在 1e-9 的黄金基准上是硬伤——这正是它留在 legacy 里的理由。
    const double v_golden = legacy::fresnel_v(20.0, 500.0, 1500.0, 2.44e9);
    const double lambda_exact = speed_of_light_mps() / 2.44e9;
    const double v_exact = 20.0 * std::sqrt((2.0 * (500.0 + 1500.0)) / (lambda_exact * 500.0 * 1500.0));
    const double d_dB = std::fabs(legacy::knife_edge_loss_dB(v_golden) -
                                  legacy::knife_edge_loss_dB(v_exact));
    CHECK(d_dB < 1e-2);          // 物理上无关紧要
    CHECK(d_dB > 1e-4);          // 但远大于黄金基准的 1e-9，不能「顺手统一」
    CHECK(std::fabs(d_dB - 3.0e-3) < 1e-3);   // 与上面的推导对得上
    MESSAGE("两个光速常数在刀口损耗上的差：" << d_dB << " dB");
}

TEST_CASE("建筑遮挡：对 emcore 黄金基准 148 例") {
    const nlohmann::json g = load_golden("tests/golden/occlusion.json");
    REQUIRE(g.contains("segment_occlusion"));
    REQUIRE(g["segment_occlusion"].size() == 148);
    REQUIRE(g["_buildings"].size() == 12);

    const double lon0 = g["_meta"]["origin_point"]["lon"].get<double>();
    const double lat0 = g["_meta"]["origin_point"]["lat"].get<double>();
    // 黄金基准回放走旧常数投影；引擎实际运行走严格站心地平（铁律 1，见 map.h 头注）。
    const legacy::LocalFrame2 fr = legacy::local_frame_occlusion(lat0);

    std::vector<Building> bs;
    for (const auto& jb : g["_buildings"]) {
        Building b;
        b.id = jb["id"].get<std::string>();
        b.base_m = jb["base_m"].get<double>();
        b.height_m = jb["height_m"].get<double>();
        const auto& lons = jb["footprintLon"];
        const auto& lats = jb["footprintLat"];
        REQUIRE(lons.size() == lats.size());
        for (std::size_t i = 0; i < lons.size(); ++i) {
            b.ring_x.push_back((lons[i].get<double>() - lon0) * fr.m_per_deg_lon);
            b.ring_y.push_back((lats[i].get<double>() - lat0) * fr.m_per_deg_lat);
        }
        bs.push_back(b);
    }

    LocalSceneAdapter map;
    map.set_buildings(bs);
    CHECK(map.building_count() == 12);
    CHECK(map.dropped_count() == 0);

    int blocked = 0;
    for (const auto& c : g["segment_occlusion"]) {
        const MapPoint tx((c["tx"]["lon"].get<double>() - lon0) * fr.m_per_deg_lon,
                          (c["tx"]["lat"].get<double>() - lat0) * fr.m_per_deg_lat,
                          c["tx"]["alt"].get<double>());
        const MapPoint rx((c["rx"]["lon"].get<double>() - lon0) * fr.m_per_deg_lon,
                          (c["rx"]["lat"].get<double>() - lat0) * fr.m_per_deg_lat,
                          c["rx"]["alt"].get<double>());
        const OcclusionResult got =
            segment_occlusion(map, tx, rx, c["frequency_Hz"].get<double>());
        check_rel(got.obstruction_loss_dB, c["out"]["obstructionLoss_dB"].get<double>(),
                  "obstruction_loss_dB");
        check_rel(got.intrusion_m, c["out"]["intrusion_m"].get<double>(), "intrusion_m");
        CHECK(got.blocked == c["out"]["blocked"].get<bool>());
        if (got.blocked) ++blocked;
    }
    MESSAGE("148 例中判为非视距的有 " << blocked << " 例");
}

TEST_CASE("建筑遮挡：适配器的几条行为约定") {
    // 一栋 100 m 见方、40 m 高的楼，中心在原点
    Building b;
    b.id = "B";
    b.base_m = 0.0;
    b.height_m = 40.0;
    const double h = 50.0;
    b.ring_x.push_back(-h); b.ring_y.push_back(-h);
    b.ring_x.push_back(h);  b.ring_y.push_back(-h);
    b.ring_x.push_back(h);  b.ring_y.push_back(h);
    b.ring_x.push_back(-h); b.ring_y.push_back(h);

    LocalSceneAdapter map;
    std::vector<Building> bs;
    bs.push_back(b);
    map.set_buildings(bs);

    SUBCASE("楼下穿过：视线低于楼顶即被切断") {
        RaycastHit hit;
        CHECK(map.raycast(MapPoint(-500.0, 0.0, 10.0), MapPoint(500.0, 0.0, 10.0), hit));
        CHECK(hit.hit);
        CHECK(hit.object_id == "B");
        CHECK(hit.intrusion_m == doctest::Approx(30.0));   // 40 − 10
        CHECK(hit.point.z == doctest::Approx(40.0));       // 命中点 z 取等效刀口顶高
    }
    SUBCASE("楼顶掠过：视线高于楼顶即不算命中") {
        RaycastHit hit;
        CHECK_FALSE(map.raycast(MapPoint(-500.0, 0.0, 60.0), MapPoint(500.0, 0.0, 60.0), hit));
    }
    SUBCASE("端点落在楼的投影内即排除该楼（自遮挡）") {
        RaycastHit hit;
        CHECK_FALSE(map.raycast(MapPoint(0.0, 0.0, 45.0), MapPoint(500.0, 0.0, 10.0), hit));
    }
    SUBCASE("无效要素被剔除且计数，不静默丢（铁律 15）") {
        std::vector<Building> bad;
        Building z = b; z.height_m = 0.0;            // 高度非正
        Building t = b; t.ring_x.resize(2); t.ring_y.resize(2);   // 顶点不足
        bad.push_back(z); bad.push_back(t); bad.push_back(b);
        LocalSceneAdapter m2;
        m2.set_buildings(bad);
        CHECK(m2.building_count() == 1);
        CHECK(m2.dropped_count() == 2);
    }
    SUBCASE("空场景优雅降级，不是错误") {
        LocalSceneAdapter empty;
        RaycastHit hit;
        CHECK_FALSE(empty.raycast(MapPoint(-500.0, 0.0, 10.0), MapPoint(500.0, 0.0, 10.0), hit));
        const OcclusionResult r =
            segment_occlusion(empty, MapPoint(-500.0, 0.0, 10.0), MapPoint(500.0, 0.0, 10.0), 2.44e9);
        CHECK(r.obstruction_loss_dB == 0.0);
        CHECK_FALSE(r.blocked);
    }
    SUBCASE("单程取一份，不乘 2") {
        // 同一条几何，损耗应等于 knife_edge_loss_dB(fresnel_v(...))，不是它的两倍。
        const OcclusionResult r =
            segment_occlusion(map, MapPoint(-500.0, 0.0, 10.0), MapPoint(500.0, 0.0, 10.0), 2.44e9);
        const double v = legacy::fresnel_v(30.0, 450.0, 550.0, 2.44e9);
        CHECK(r.obstruction_loss_dB == doctest::Approx(legacy::knife_edge_loss_dB(v)).epsilon(1e-12));
    }
}
