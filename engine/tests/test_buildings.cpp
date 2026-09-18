// 建筑几何进引擎（步骤 D3-4，决策 D-074）：buildings.geojson → 平面米的 geo::Building。
//
// 本文件覆盖三件事：
//   · 平面帧 SceneFrame 的换算，对**独立闭式**（子午圈与卯酉圈曲率半径）而不是对自己；
//   · 解析规则：闭合环去重复末点、MultiPolygon 按外环拆、孔忽略并计数、退化件剔除并计数；
//   · 真实建筑集（47582 要素）的加载与共享缓存——**数据不在盘上就明说跳过，不当作通过**
//     （07 报告 §7.2，先例 D-073 ③）。

#include "doctest/doctest.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>

#include <fstream>
#include <sstream>

#include "cuav/buildings_json.h"
#include "cuav/components/scenario.h"
#include "cuav/diagram_json.h"
#include "cuav/random.h"
#include "cuav/registry.h"
#include "nlohmann/json.hpp"

#include "cuav_geo/geodesy.h"
#include "cuav_geo/occlusion.h"

using namespace cuav;

namespace {

std::string repo(const char* rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

bool file_exists(const std::string& p) {
    std::FILE* f = std::fopen(p.c_str(), "rb");
    if (f == 0) return false;
    std::fclose(f);
    return true;
}

const char* kAoiRoot = "data/scene";
const char* kAoiId = "beijing-yayuncun";

// 一栋矩形楼的 GeoJSON 要素。ring 按 GeoJSON 的约定**闭合**（首点 == 末点）。
nlohmann::json rect_feature(const char* id, double lon0, double lat0, double d,
                            double height_m, bool with_hole) {
    nlohmann::json ring = nlohmann::json::array();
    ring.push_back({lon0, lat0});
    ring.push_back({lon0 + d, lat0});
    ring.push_back({lon0 + d, lat0 + d});
    ring.push_back({lon0, lat0 + d});
    ring.push_back({lon0, lat0});          // 闭合点，解析后应当被去掉
    nlohmann::json rings = nlohmann::json::array();
    rings.push_back(ring);
    if (with_hole) {
        nlohmann::json hole = nlohmann::json::array();
        hole.push_back({lon0 + 0.2 * d, lat0 + 0.2 * d});
        hole.push_back({lon0 + 0.4 * d, lat0 + 0.2 * d});
        hole.push_back({lon0 + 0.4 * d, lat0 + 0.4 * d});
        hole.push_back({lon0 + 0.2 * d, lat0 + 0.2 * d});
        rings.push_back(hole);
    }
    return nlohmann::json{
        {"type", "Feature"},
        {"properties", {{"id", id}, {"base_m", 0.0}, {"height_m", height_m}, {"src", "est:area"}}},
        {"geometry", {{"type", "Polygon"}, {"coordinates", rings}}}};
}

nlohmann::json collection(nlohmann::json features) {
    return nlohmann::json{{"type", "FeatureCollection"}, {"features", features}};
}

}  // namespace

TEST_CASE("SceneFrame：平面帧对独立闭式的锚点") {
    const geo::Lla origin(116.405, 39.99, 0.0);
    const geo::SceneFrame frame(origin);

    double x = 0.0, y = 0.0;
    frame.to_plane(origin.lon_deg, origin.lat_deg, x, y);
    CHECK(std::fabs(x) < 1e-9);
    CHECK(std::fabs(y) < 1e-9);

    // 独立闭式：正北位移 ≈ 子午圈曲率半径 M·Δφ；正东位移 ≈ 卯酉圈 N·cosφ·Δλ。
    // 与站心地平的差是切平面与弧长之差，1 km 上是 1e-5 m 量级，故 1e-3 m 的线宽松而结实。
    const double a = geo::wgs84_a();
    const double e2 = geo::wgs84_e2();
    const double phi = origin.lat_deg * 3.14159265358979323846 / 180.0;
    const double s = std::sin(phi);
    const double N = a / std::sqrt(1.0 - e2 * s * s);
    const double M = a * (1.0 - e2) / std::pow(1.0 - e2 * s * s, 1.5);
    const double d2r = 3.14159265358979323846 / 180.0;

    frame.to_plane(origin.lon_deg, origin.lat_deg + 0.009, x, y);
    CHECK(std::fabs(x) < 1e-6);
    CHECK(std::fabs(y - M * 0.009 * d2r) < 1e-3);

    frame.to_plane(origin.lon_deg + 0.012, origin.lat_deg, x, y);
    const double east = N * std::cos(phi) * 0.012 * d2r;
    CHECK(std::fabs(x - east) < 1e-3);
    // 正东走一段，北向坐标**不是零**：纬线圈朝极点弯，切平面上它偏北 d²·tanφ/(2N)。
    // 1.02 km 上是 69 mm。这条断言正是「本帧是真的站心切平面，不是等距圆柱投影」的分界线
    // ——geo::legacy 那两套（110540 / 111320·cosφ）在这里会给出恒零，差的就是这 69 mm。
    const double curl = east * east * std::tan(phi) / (2.0 * N);
    CHECK(curl == doctest::Approx(0.0689).epsilon(0.01));
    CHECK(std::fabs(y - curl) < 1e-3);

    // point() 把离地高差原样放进 z——**不是** ENU 的 up：10 km 外 up 已被地球曲率压低约 7.8 m，
    // 而 base_m / height_m 是离地高差（铁律 2）。这条断言就是钉住这件事的。
    const geo::MapPoint p = frame.point(origin.lon_deg + 0.117, origin.lat_deg, 30.0);
    CHECK(p.z == doctest::Approx(30.0));
    CHECK(p.x > 9000.0);
    const geo::IGeodesy& g = geo::default_geodesy();
    const geo::Enu enu = g.to_enu(g.to_ecef(geo::Lla(origin.lon_deg + 0.117, origin.lat_deg, 0.0)),
                                  origin);
    CHECK(enu.u < -7.0);          // 曲率下沉，确实是负的好几米
    CHECK(p.z != doctest::Approx(enu.u));
}

TEST_CASE("解析规则：闭合环去末点、孔忽略、退化与非正高度剔除") {
    const geo::SceneFrame frame(geo::Lla(116.405, 39.99, 0.0));

    nlohmann::json feats = nlohmann::json::array();
    feats.push_back(rect_feature("ok", 116.40, 39.99, 0.001, 20.0, false));
    feats.push_back(rect_feature("holed", 116.41, 39.99, 0.001, 30.0, true));
    feats.push_back(rect_feature("flat", 116.42, 39.99, 0.001, 0.0, false));    // 高度非正
    // 顶点不足：闭合去重后只剩两个点
    nlohmann::json thin = rect_feature("thin", 116.43, 39.99, 0.001, 10.0, false);
    nlohmann::json two = nlohmann::json::array();
    two.push_back({116.43, 39.99});
    two.push_back({116.431, 39.99});
    two.push_back({116.43, 39.99});
    thin["geometry"]["coordinates"] = nlohmann::json::array({two});
    feats.push_back(thin);

    std::vector<geo::Building> out;
    BuildingsStats st;
    std::string err;
    REQUIRE_MESSAGE(parse_buildings(collection(feats), frame, out, st, err), err);

    CHECK(st.features == 4);
    CHECK(st.polygons == 4);
    CHECK(st.multipolygons == 0);
    CHECK(st.holes_ignored == 1);
    CHECK(st.dropped_height == 1);
    CHECK(st.dropped_degenerate == 1);
    CHECK(st.buildings == 2);
    REQUIRE(out.size() == 2);

    // 闭合点去掉：GeoJSON 的五点环 → 四个顶点（geo::Building 约定首尾不闭合）
    CHECK(out[0].id == "ok");
    CHECK(out[0].ring_x.size() == 4);
    CHECK(out[0].ring_y.size() == 4);
    CHECK(out[0].height_m == doctest::Approx(20.0));
    CHECK(out[1].id == "holed");
    CHECK(out[1].ring_x.size() == 4);
    // 首尾不重合，否则遍历会多出一条零长边。（矩形的首末两角同经度，差在北向上，所以量 y）
    CHECK(std::fabs(out[0].ring_y.front() - out[0].ring_y.back()) > 100.0);
}

TEST_CASE("MultiPolygon 按外环拆，id 加序号后缀") {
    const geo::SceneFrame frame(geo::Lla(116.405, 39.99, 0.0));
    nlohmann::json polys = nlohmann::json::array();
    for (int k = 0; k < 3; ++k) {
        nlohmann::json ring = nlohmann::json::array();
        const double lon = 116.40 + 0.002 * k;
        ring.push_back({lon, 39.99});
        ring.push_back({lon + 0.001, 39.99});
        ring.push_back({lon + 0.001, 39.991});
        ring.push_back({lon, 39.991});
        ring.push_back({lon, 39.99});
        nlohmann::json one = nlohmann::json::array();
        one.push_back(ring);
        if (k == 1) one.push_back(ring);   // 第二件带一个孔
        polys.push_back(one);
    }
    nlohmann::json f{{"type", "Feature"},
                     {"properties", {{"id", 12345}, {"base_m", 0.0}, {"height_m", 15.0}}},
                     {"geometry", {{"type", "MultiPolygon"}, {"coordinates", polys}}}};

    std::vector<geo::Building> out;
    BuildingsStats st;
    std::string err;
    REQUIRE_MESSAGE(parse_buildings(collection(nlohmann::json::array({f})), frame, out, st, err), err);
    CHECK(st.features == 1);
    CHECK(st.multipolygons == 1);
    CHECK(st.parts == 3);
    CHECK(st.holes_ignored == 1);
    REQUIRE(out.size() == 3);
    CHECK(out[0].id == "12345#0");
    CHECK(out[1].id == "12345#1");
    CHECK(out[2].id == "12345#2");
}

TEST_CASE("几何类型不认识就报错，不静默跳过") {
    const geo::SceneFrame frame(geo::Lla(116.405, 39.99, 0.0));
    nlohmann::json f{{"type", "Feature"},
                     {"properties", {{"id", "p"}, {"height_m", 10.0}}},
                     {"geometry", {{"type", "Point"}, {"coordinates", {116.4, 39.99}}}}};
    std::vector<geo::Building> out;
    BuildingsStats st;
    std::string err;
    CHECK_FALSE(parse_buildings(collection(nlohmann::json::array({f})), frame, out, st, err));
    CHECK(err.find("Point") != std::string::npos);
}

TEST_CASE("哈希不符即失败，报文说得出是哪两个哈希") {
    const std::string path = repo("data/scene/beijing-yayuncun/buildings.geojson");
    if (!file_exists(path)) {
        MESSAGE("跳过：建筑集不在盘上（data/** 不入 git），本条要真实文件");
        return;
    }
    LoadedBuildings lb;
    std::string err;
    const geo::SceneFrame frame(geo::Lla(116.405, 39.99, 0.0));
    CHECK_FALSE(load_buildings_file(path, std::string(64, 'a'), frame, lb, err));
    CHECK(err.find("aaaaaaaa") != std::string::npos);
    CHECK(err.find("269a8674") != std::string::npos);
}

TEST_CASE("真实建筑集：清单解析、计数、代价与共享缓存") {
    const std::string manifest = repo("data/scene/beijing-yayuncun/manifest.json");
    if (!file_exists(manifest)) {
        MESSAGE("跳过：观测区域数据包不在盘上（data/** 不入 git），本条要真实文件");
        return;
    }

    std::string err;
    AoiBuildingsRef ref;
    REQUIRE_MESSAGE(aoi_buildings_ref(repo(kAoiRoot), kAoiId, ref, err), err);
    CHECK(ref.sha256 == "269a8674706766e033f05f008b1f751b0ee9b90fab95a608f5f9680aa6077258");
    // 平面帧的原点 = 观测区域中心（D-021 用户定的那个点），与场景、与站点无关
    CHECK(ref.frame.origin().lon_deg == doctest::Approx(116.405));
    CHECK(ref.frame.origin().lat_deg == doctest::Approx(39.99));

    if (!file_exists(ref.buildings_path)) {
        MESSAGE("跳过：buildings.geojson 不在盘上");
        return;
    }

    const std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
    BuildingsStats st;
    geo::SceneFrame mframe;
    const geo::LocalSceneAdapter* map = shared_scene_map(repo(kAoiRoot), kAoiId, st, mframe, err);
    REQUIRE_MESSAGE(map != 0, err);
    // 帧与地图同源：调用方拿不到「另一个原点」的机会（D3-4 的口径，D3-5 靠它）
    CHECK(mframe.origin().lon_deg == doctest::Approx(116.405));
    CHECK(mframe.origin().lat_deg == doctest::Approx(39.99));
    const double ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    // 实测计数（2026-09-18，数据包 sha256 269a8674…）。这些数不是"大概"，对不上就是上游变了。
    CHECK(st.features == 47582);
    CHECK(st.polygons == 47546);
    CHECK(st.multipolygons == 36);
    CHECK(st.parts == 116);
    CHECK(st.holes_ignored == 345);
    CHECK(st.dropped_height == 0);
    CHECK(st.dropped_degenerate == 0);
    CHECK(st.buildings == 47662);          // 47546 + 116 件 MultiPolygon 子多边形
    CHECK(map->building_count() == 47662);
    CHECK(map->dropped_count() == 0);
    MESSAGE("建筑加载（读盘 + 核哈希 + 解析 + 投影 + 桶网格）" << ms << " ms：" << st.summary());
    // 07 报告 §10 写的线是 200 ms，实测约 240 ms——**那条线漏算了读盘与核哈希**
    // （§1.4 的调研只量了 nlohmann 解析 144 ms 与桶网格 10.5 ms，而 §7.1 自己要求核对 sha256）。
    // 逐段实测见 §14.4：读盘 ≈ 45 / sha256 ≈ 40 / JSON ≈ 105 / 投影 ≈ 30 / 桶网格 ≈ 14 ms。
    // 这里的守卫只拦数量级的回归（比如哪天投影退化成逐点建矩阵），不拦机器忙时的抖动。
    CHECK(ms < 900.0);

    // 第二次必须命中缓存：K 个站共用一份桶网格，不是 K 份（07 报告 §7.1）
    BuildingsStats st2;
    geo::SceneFrame frame2;
    const geo::LocalSceneAdapter* again =
        shared_scene_map(repo(kAoiRoot), kAoiId, st2, frame2, err);
    CHECK(again == map);
    CHECK(st2.buildings == st.buildings);

    // 建筑落在观测区域内：平面帧原点在中心，20 × 20 km 的半边是 10 km，留 2 km 余量给覆盖框
    geo::MapBox box;
    box.min_x = -12000.0; box.min_y = -12000.0; box.max_x = 12000.0; box.max_y = 12000.0;
    CHECK(map->query_buildings(box).size() == 47662);

    // 遮挡确实用得上它：观测区域中心附近拉一条 2 km 的贴地视线，必然被楼切断。
    geo::MapPoint tx(-1000.0, 0.0, 1.5), rx(1000.0, 0.0, 1.5);
    const geo::OcclusionResult occ = geo::segment_occlusion(*map, tx, rx, 2.44e9);
    CHECK(occ.blocked);
    CHECK(occ.obstruction_loss_dB > 6.0);
    MESSAGE("中心 2 km 贴地视线：遮挡 " << occ.obstruction_loss_dB << " dB，侵入 "
                                       << occ.intrusion_m << " m");
}

TEST_CASE("真实建筑集上的五条射线：本侧是真理源，浏览器 TS 复算对拍同一份表（D3-6）") {
    // tests/golden/occlusion.json 的 148 例用的是 12 栋合成楼加 legacy 投影，**测不到**
    // GeoJSON 的解析规则、严格站心地平的平面帧、四万多栋楼上的桶网格。这一条补上那一段：
    // 与 web/src/scene/occlusion/occlusion.test.ts 读同一份 tests/golden/occlusion-aoi.json。
    // **判跳过要判它真正读的那个文件**。原先这里判的是 `manifest.json`——而清单**入 git**、
    // 建筑集不入，于是在任何没有建筑集的机器上这条不跳过、直接硬失败（D3-8 在 CI 上当场红）。
    // 上面那条「真实建筑集：清单解析、计数、代价与共享缓存」判了两道（清单一道、建筑集一道），
    // 这条是后写的，漏了第二道。缺数据要**明说跳过、不当作通过**（D-073 ③）。
    std::string err;
    AoiBuildingsRef ref;
    if (!file_exists(repo("data/scene/beijing-yayuncun/manifest.json"))
        || !aoi_buildings_ref(repo(kAoiRoot), kAoiId, ref, err)
        || !file_exists(ref.buildings_path)) {
        MESSAGE("跳过：buildings.geojson 不在盘上（data/** 不入 git），本条要真实建筑集");
        return;
    }
    BuildingsStats st;
    geo::SceneFrame frame;
    const geo::LocalSceneAdapter* map = shared_scene_map(repo(kAoiRoot), kAoiId, st, frame, err);
    REQUIRE_MESSAGE(map != 0, err);

    std::ifstream f(repo("tests/golden/occlusion-aoi.json").c_str());
    REQUIRE_MESSAGE(f.good(), "打不开 tests/golden/occlusion-aoi.json");
    std::stringstream ss;
    ss << f.rdbuf();
    const nlohmann::json g = nlohmann::json::parse(ss.str());

    // 输入必须是同一份数据：建筑数与平面帧原点都钉住，否则这张表说的不是同一件事
    CHECK(st.buildings == g["_meta"]["input"]["buildings_count"].get<std::size_t>());
    CHECK(frame.origin().lon_deg == doctest::Approx(116.405));
    CHECK(frame.origin().lat_deg == doctest::Approx(39.99));

    const double f_Hz = g["_meta"]["input"]["frequency_Hz"].get<double>();
    const double tol = g["_meta"]["tolerance_rel"].get<double>();
    REQUIRE(g["segment_occlusion_aoi"].size() == 5);
    for (const auto& c : g["segment_occlusion_aoi"]) {
        const auto& r = c["ray"];
        const geo::OcclusionResult got = geo::segment_occlusion(
            *map, geo::MapPoint(r[0].get<double>(), r[1].get<double>(), r[2].get<double>()),
            geo::MapPoint(r[3].get<double>(), r[4].get<double>(), r[5].get<double>()), f_Hz);
        CHECK(got.blocked == c["out"]["blocked"].get<bool>());
        const double want_l = c["out"]["obstructionLoss_dB"].get<double>();
        const double want_i = c["out"]["intrusion_m"].get<double>();
        CHECK_MESSAGE(std::fabs(got.obstruction_loss_dB - want_l) <= tol * std::fabs(want_l),
                      "obstructionLoss_dB 得 " << got.obstruction_loss_dB << " 基准 " << want_l);
        CHECK_MESSAGE(std::fabs(got.intrusion_m - want_i) <= tol * std::fabs(want_i),
                      "intrusion_m 得 " << got.intrusion_m << " 基准 " << want_i);
    }
}

TEST_CASE("装载器注入 scene_root，且 E1 档下一个字节也不读建筑") {
    const std::string diag = repo("engine/tests/diagrams/slice2_scenario_link.json");
    const std::string scen = repo("data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json");
    if (!file_exists(diag) || !file_exists(scen)) {
        MESSAGE("跳过：夹具或示例场景不在盘上");
        return;
    }

    Registry reg = builtin_registry();
    FileScenarioResolver res;
    std::string e;
    REQUIRE_MESSAGE(res.add_file(scen, e), e);
    LoadOptions lo;
    lo.scenarios = &res;
    lo.scene_root = repo(kAoiRoot);

    LoadedDiagram d;
    DiagramError err;
    REQUIRE_MESSAGE(load_diagram_file(diag, reg, 0, lo, d, err), err.message);

    // 找到那个 ScenarioSource：装载器该把 scene_root 注进去。
    // 这一条钉的是**注入这一环**——describe() 里的参数名与 configure() 里的取值键
    // 拼错任何一处都是静默失效，等到 D3-5 打开 E3 才炸就晚了。
    ScenarioSource* src = 0;
    for (std::map<std::string, NodeId>::const_iterator it = d.node_ids.begin();
         it != d.node_ids.end(); ++it) {
        ScenarioSource* s = dynamic_cast<ScenarioSource*>(d.graph.node(it->second));
        if (s != 0) { src = s; break; }
    }
    REQUIRE_MESSAGE(src != 0, "夹具里应当有一个 ScenarioSource");
    CHECK(src->scene_root() == lo.scene_root);

    // 懒加载：装载器只调 configure，不调 init，所以这时建筑一定还没读。
    // cuav_run --validate 走的正是这条路径——它今天约 9 ms，不该为 16 MB 的建筑文件停一下。
    CHECK(src->scene_map() == 0);

    // 即便跑起来，缺省的 E1 档也不读：建筑只在 E3 才有意义。
    Xoshiro256pp rng(1);
    std::string ierr;
    REQUIRE_MESSAGE(src->init(rng, ierr), ierr);
    CHECK(src->scene_map() == 0);
}

TEST_CASE("框图里自己写 scene_root 即拒：内部参数不进框图（D-037）") {
    const std::string diag = repo("engine/tests/diagrams/slice2_scenario_link.json");
    const std::string scen = repo("data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json");
    if (!file_exists(diag) || !file_exists(scen)) {
        MESSAGE("跳过：夹具或示例场景不在盘上");
        return;
    }
    std::ifstream f(diag.c_str(), std::ios::binary);
    REQUIRE(f.good());
    std::stringstream ss;
    ss << f.rdbuf();
    nlohmann::json j = nlohmann::json::parse(ss.str());

    bool patched = false;
    for (auto& n : j["nodes"]) {
        if (n["type"] == "ScenarioSource") {
            n["params"]["scene_root"] = "/somewhere/on/the/server";
            patched = true;
        }
    }
    REQUIRE(patched);

    Registry reg = builtin_registry();
    FileScenarioResolver res;
    std::string e;
    REQUIRE_MESSAGE(res.add_file(scen, e), e);
    LoadOptions lo;
    lo.scenarios = &res;
    lo.scene_root = repo(kAoiRoot);
    LoadedDiagram d;
    DiagramError err;
    CHECK_FALSE(load_diagram(j, reg, 0, lo, d, err));
    CHECK(err.message.find("scene_root") != std::string::npos);
}
