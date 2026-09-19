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

#include "cuav/scenario_json.h"
#include "cuav_geo/geodesy.h"
#include "cuav_geo/link_budget.h"
#include "cuav_geo/map.h"
#include "cuav_geo/scenario.h"
#include "cuav_geo/legacy_frames.h"
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
    const legacy::LocalFrame fr = legacy::local_frame_occlusion(lat0);

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

// ---------------------------------------------------------------------------
// D3-5：接进帧生产端。上面那批测的是遮挡本身，这批测的是「它怎么进链路预算」。
// 全部自造几何，不依赖观测区域数据包（buildings.geojson 不入 git）。
// ---------------------------------------------------------------------------

namespace {

// 站在原点、目标在正东 d 米处的一条链路，中间按需摆一栋楼。
struct E3Fixture {
    Lla origin;
    SceneFrame frame;
    Lla site;
    Lla emitter;
    LocalSceneAdapter map;

    E3Fixture() : origin(116.405, 39.99, 0.0) {
        frame = SceneFrame(origin);
        site = Lla(116.405, 39.99, 30.0);          // 站点天线 30 m，与 golden-01 同
    }

    // 把目标放到正东约 d 米处、离地 h 米。返回实际投影出来的东向距离。
    double put_emitter_east(double d_m, double h_m) {
        // 粗算一个经度增量再用帧本身核实：不假设换算常数（铁律 1，投影只有一个真理源）
        const double deg = d_m / 85000.0;          // 39.99°N 上 1 度经度约 85 km
        emitter = Lla(origin.lon_deg + deg, origin.lat_deg, h_m);
        double x = 0.0, y = 0.0;
        frame.to_plane(emitter.lon_deg, emitter.lat_deg, x, y);
        return x;
    }

    // 一栋跨在视线上的楼：东向 [x0, x1]、南北 ±80 m、高 height_m。
    void put_wall(double x0, double x1, double height_m) {
        Building b;
        b.id = "WALL";
        b.base_m = 0.0;
        b.height_m = height_m;
        const double xs[4] = {x0, x1, x1, x0};
        const double ys[4] = {-80.0, -80.0, 80.0, 80.0};
        for (int i = 0; i < 4; ++i) { b.ring_x.push_back(xs[i]); b.ring_y.push_back(ys[i]); }
        std::vector<Building> v;
        v.push_back(b);
        map.set_buildings(v);
    }

    OcclusionQuery query(double f_Hz) const {
        OcclusionQuery q;
        q.map = &map;
        q.frame = frame;
        q.frequency_Hz = f_Hz;
        return q;
    }
};

}  // namespace

TEST_CASE("D3-5：link_geometry 按建筑几何给 line_of_sight 与刀口损耗") {
    E3Fixture fx;
    const double east = fx.put_emitter_east(800.0, 50.0);
    CHECK(east == doctest::Approx(800.0).epsilon(0.02));   // 帧自己说了算，不靠我猜的常数
    fx.put_wall(380.0, 420.0, 90.0);                       // 90 m 的墙，挡得死死的
    const Ecef v;                                          // 静止，多普勒与本条无关

    const OcclusionQuery q = fx.query(2.44e9);
    const LinkGeometry blocked = link_geometry(fx.site, fx.emitter, v, 0.0, &q);
    CHECK_FALSE(blocked.line_of_sight);
    CHECK(blocked.diffraction_dB > 6.0);
    CHECK(blocked.intrusion_m > 0.0);

    // 同一条链路，不给地图 → 与 D3-5 之前逐字相同的那条路径
    const LinkGeometry bare = link_geometry(fx.site, fx.emitter, v, 0.0);
    CHECK(bare.line_of_sight);
    CHECK(bare.diffraction_dB == 0.0);
    CHECK(bare.distance_m == doctest::Approx(blocked.distance_m).epsilon(1e-12));
    CHECK(bare.azimuth_deg == doctest::Approx(blocked.azimuth_deg).epsilon(1e-12));

    // 目标升到楼顶之上 → 视距恢复、损耗归零
    fx.put_emitter_east(800.0, 300.0);
    const LinkGeometry clear = link_geometry(fx.site, fx.emitter, v, 0.0, &q);
    CHECK(clear.line_of_sight);
    CHECK(clear.diffraction_dB == 0.0);

    // **单程 ×1 不乘 2**：与直接调 segment_occlusion 的结果逐位相同
    fx.put_emitter_east(800.0, 50.0);
    const MapPoint tx = fx.frame.point(fx.emitter.lon_deg, fx.emitter.lat_deg, 50.0);
    const MapPoint rx = fx.frame.point(fx.site.lon_deg, fx.site.lat_deg, 30.0);
    const OcclusionResult direct = segment_occlusion(fx.map, tx, rx, 2.44e9);
    const LinkGeometry again = link_geometry(fx.site, fx.emitter, v, 0.0, &q);
    CHECK(again.diffraction_dB == direct.obstruction_loss_dB);
    CHECK(again.diffraction_dB < 2.0 * direct.obstruction_loss_dB);
}

TEST_CASE("D3-5：line_of_sight = !blocked，与损耗大小无关") {
    // 07 §5.1 的口径：掠射只损几分贝也算非视距。这个布尔量的含义是「楼挡没挡住」，
    // 不是「损耗够不够大」——界面据它给链路线上色，颜色要摆事实不摆实施方挑的门限（D-039）。
    E3Fixture fx;
    fx.put_emitter_east(800.0, 50.0);
    const Ecef v;
    const OcclusionQuery q = fx.query(2.44e9);

    // 把墙压到刚好擦着视线：站 30 m、目标 50 m、墙在中点，视线在那里约 40 m 高
    bool found_grazing = false;
    for (double h = 40.0; h <= 41.0; h += 0.02) {
        fx.put_wall(380.0, 420.0, h);
        const LinkGeometry g = link_geometry(fx.site, fx.emitter, v, 0.0, &q);
        if (g.line_of_sight) continue;
        if (g.diffraction_dB > 0.0 && g.diffraction_dB < 8.0) {
            // 损耗才几分贝，但几何上确实被切断了 → 仍判非视距
            CHECK_FALSE(g.line_of_sight);
            found_grazing = true;
            MESSAGE("掠射：墙高 " << h << " m，刀口损耗 " << g.diffraction_dB
                                 << " dB，仍判非视距");
            break;
        }
    }
    CHECK(found_grazing);
}

TEST_CASE("D3-5：刀口损耗只进 extra_loss_dB，且只在 E3 档计入") {
    E3Fixture fx;
    fx.put_emitter_east(800.0, 50.0);
    fx.put_wall(380.0, 420.0, 90.0);
    const Ecef v;
    const OcclusionQuery q = fx.query(2.44e9);
    const LinkGeometry g = link_geometry(fx.site, fx.emitter, v, 0.0, &q);
    REQUIRE_FALSE(g.line_of_sight);
    REQUIRE(g.diffraction_dB > 6.0);

    {   // E1：算过遮挡也不计入——档位说了算，与帧里带没带这个数无关
        PropagationConfig cfg;   // 缺省 E1
        const LinkBudget b = link_budget(g, 2.44e9, 6.0, cfg);
        CHECK(b.extra_loss_dB == 0.0);
        CHECK(b.terms.diffraction_dB == 0.0);
        CHECK(b.path_loss_dB == doctest::Approx(b.free_space_dB).epsilon(1e-12));
        CHECK(b.terms.included.size() == 1);
        CHECK(b.terms.included[0] == std::string(kTermFreeSpace));
        // line_of_sight 照旧透传：它是几何事实，不随档位变
        CHECK_FALSE(b.line_of_sight);
    }
    {   // E3：计入，且恒等式照旧
        PropagationConfig cfg;
        cfg.level = PropLevel::E3;
        const LinkBudget b = link_budget(g, 2.44e9, 6.0, cfg);
        CHECK(b.terms.diffraction_dB == g.diffraction_dB);
        CHECK(b.extra_loss_dB == doctest::Approx(g.diffraction_dB).epsilon(1e-12));
        CHECK(b.path_loss_dB ==
              doctest::Approx(b.free_space_dB + b.extra_loss_dB).epsilon(1e-12));
        REQUIRE(b.terms.included.size() == 2);
        CHECK(b.terms.included[0] == std::string(kTermFreeSpace));
        CHECK(b.terms.included[1] == std::string(kTermDiffraction));
    }
    {   // E3 + 天气：加项各自独立，顺序固定 free_space → diffraction → weather
        PropagationConfig cfg;
        cfg.level = PropLevel::E3;
        cfg.weather = true;
        cfg.rain_rate_mmh = 25.0;
        const LinkBudget b = link_budget(g, 2.44e9, 6.0, cfg);
        CHECK(b.extra_loss_dB ==
              doctest::Approx(b.terms.diffraction_dB + b.terms.weather_dB).epsilon(1e-12));
        REQUIRE(b.terms.included.size() == 3);
        CHECK(b.terms.included[1] == std::string(kTermDiffraction));
        CHECK(b.terms.included[2] == std::string(kTermWeather));
    }
    {   // E3 视距时损耗为零，但 included 照样声明 diffraction——下游问的是
        // 「这条路损里算没算过建筑遮挡」，答案与这一帧恰好挡没挡住无关（EM-P-13 §10.9）
        fx.put_emitter_east(800.0, 300.0);
        const LinkGeometry clear = link_geometry(fx.site, fx.emitter, v, 0.0, &q);
        REQUIRE(clear.line_of_sight);
        PropagationConfig cfg;
        cfg.level = PropLevel::E3;
        const LinkBudget b = link_budget(clear, 2.44e9, 6.0, cfg);
        CHECK(b.extra_loss_dB == 0.0);
        REQUIRE(b.terms.included.size() == 2);
        CHECK(b.terms.included[1] == std::string(kTermDiffraction));
    }
}

TEST_CASE("D3-5：E3 而没有地图 → needs_scene_map 为真，不静默按自由空间算") {
    Scenario s;
    std::string err;
    // 借 golden-01 来搭一条真链路；缺数据包时跳过（场景文件在 data/ 下，不入 git）
    const std::string path = repo_path("data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json");
    std::ifstream probe(path.c_str());
    if (!probe.good()) {
        MESSAGE("跳过：示例场景不在盘上");
        return;
    }
    probe.close();

    LoadedScenario ls;
    REQUIRE_MESSAGE(load_scenario_file(path, ls, err), err);

    PropagationConfig cfg;
    cfg.level = PropLevel::E3;
    LinkFrameSource lf;
    REQUIRE_MESSAGE(lf.build(ls.scenario, "site-1", "uav-1", 20.0, err, cfg), err);
    // build 本身不拒——地图是懒加载的，要到 init() 才拿得到（07 §7.4）。
    // 但「还缺地图」这件事必须问得出来，由调用方在产帧之前拦下。
    CHECK(lf.needs_scene_map());

    E3Fixture fx;
    fx.put_wall(380.0, 420.0, 90.0);
    lf.set_scene_map(&fx.map, fx.frame);
    CHECK_FALSE(lf.needs_scene_map());

    // E1 / E2 从来不缺地图
    PropagationConfig e1;
    LinkFrameSource lf1;
    REQUIRE_MESSAGE(lf1.build(ls.scenario, "site-1", "uav-1", 20.0, err, e1), err);
    CHECK_FALSE(lf1.needs_scene_map());
}
