// cuav_geo 的独立冒烟测试：不依赖 doctest，保证本库脱离引擎也能构建与自检。
//
// 完整单测在 engine/tests/test_geo.cpp（引擎链接 cuav_geo，doctest 已 vendored 在那边）。
// 待 D3 从 emcore 移植 148 例遮挡黄金基准时，第三方件上提到仓库根 third_party/，
// 本库再建自己的 doctest 运行器（08 报告 §15 暂定项 ⑥）。
//
// 本文件同时是 tests/golden/geodesy.json 的**生成器**（D-074 / D3-1）：
//     cuav_geo_smoke_test --write-golden tests/golden/geodesy.json
// 带这个参数时只写基准不跑自检；不带参数时行为与以前逐字相同。
// 同理生成 tests/golden/coverage-cells.json（D-079，覆盖场单格链路预算，C++ 是真理源）：
//     cuav_geo_smoke_test --write-golden-coverage tests/golden/coverage-cells.json
// 放在这里是因为它是全仓唯一既链接 cuav_geo、又拿得到 GeographicLib 私有头的目标。

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

// 只有本文件用得着第三方头：要拿 LocalCartesian 来验「站心旋转各家一样」这句话（D-074 §3.3）。
#include <GeographicLib/Geocentric.hpp>
#include <GeographicLib/LocalCartesian.hpp>

#include "cuav_geo/coverage.h"
#include "cuav_geo/geodesy.h"
#include "cuav_geo/kinematics.h"
#include "cuav_geo/link_budget.h"
#include "cuav_geo/map.h"
#include "cuav_geo/occlusion.h"

using namespace cuav::geo;

static int failures = 0;

static void check(bool ok, const char* what) {
    if (!ok) {
        std::printf("失败：%s\n", what);
        ++failures;
    }
}

namespace {

// 黄金基准的算例集：观测区域尺度为主，另加几个全球锚点防止只在一个纬度上对。
// 取值固定、不随机，改动即为发现（铁律 10）。
std::vector<Lla> golden_points() {
    const double lons[] = {116.288, 116.405, 116.522, 0.0, -73.9, 139.7};
    const double lats[] = {39.900, 39.990, 40.080, 0.0, 45.0, -33.9, 85.0};
    const double alts[] = {0.0, 50.0, 150.0, 1000.0, 10000.0};
    std::vector<Lla> out;
    for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 7; ++j)
            for (int k = 0; k < 5; ++k) out.push_back(Lla(lons[i], lats[j], alts[k]));
    return out;
}

const Lla& golden_origin() {
    static const Lla o(116.405, 39.990, 30.0);   // 示例场景的站点，观测区域中心
    return o;
}

// 写基准。数值一律 %.17g：double 的往返精度，少一位就不是「逐位」了。
int write_golden(const char* path) {
    std::ofstream f(path);
    if (!f.good()) {
        std::printf("写不开 %s\n", path);
        return 1;
    }
    const IGeodesy& gl = geographiclib_geodesy();
    const std::vector<Lla> pts = golden_points();
    const Lla& o = golden_origin();

    f << "{\n";
    f << "  \"_meta\": {\n";
    f << "    \"source\": \"third_party/geographiclib 2.5.2 的 Geocentric（决策 D-074，步骤 D3-1）\",\n";
    f << "    \"generator\": \"geo/build/cuav_geo_smoke_test --write-golden tests/golden/geodesy.json\",\n";
    f << "    \"guards\": \"① 上游升版或 Config.h 改动导致读数变化；② 自写闭式 ClosedFormWgs84 与它的一致性\",\n";
    f << "    \"tolerance_m\": 1e-06,\n";
    f << "    \"tolerance_note\": \"两家的反算算法不同（自写是 Bowring 闭式），本就不该期望逐位相同；"
         "能到微米级即说明两边都对。GeographicLib 自身对本表应逐位复现\",\n";
    f << "    \"origin_note\": \"enu 是相对 origin 的站心地平坐标，用来同时钉住旋转那一半\"\n";
    f << "  },\n";

    char buf[256];
    std::snprintf(buf, sizeof buf, "  \"origin\": { \"lon\": %.17g, \"lat\": %.17g, \"alt_m\": %.17g },\n",
                  o.lon_deg, o.lat_deg, o.alt_m);
    f << buf;
    f << "  \"cases\": [\n";
    for (std::size_t i = 0; i < pts.size(); ++i) {
        const Ecef e = gl.to_ecef(pts[i]);
        const Enu n = gl.to_enu(e, o);
        std::snprintf(buf, sizeof buf,
                      "    { \"lon\": %.17g, \"lat\": %.17g, \"alt_m\": %.17g,",
                      pts[i].lon_deg, pts[i].lat_deg, pts[i].alt_m);
        f << buf;
        std::snprintf(buf, sizeof buf,
                      " \"ecef\": [%.17g, %.17g, %.17g],", e.x, e.y, e.z);
        f << buf;
        std::snprintf(buf, sizeof buf,
                      " \"enu\": [%.17g, %.17g, %.17g] }%s\n",
                      n.e, n.n, n.u, (i + 1 == pts.size() ? "" : ","));
        f << buf;
    }
    f << "  ]\n}\n";
    std::printf("已写入 %s（%zu 例）\n", path, pts.size());
    return 0;
}


// ---------------------------------------------------------------- 覆盖场单格（D-079）
//
// 建筑集写在本文件里、也原样写进基准：浏览器侧拿同一组楼建桶网格，两侧的差异只可能来自
// 被测的计算本身。楼放在观测区域中心附近、平面米、外环首尾不闭合（map.h 的约定）。
struct CovBox { const char* id; double x0, y0, x1, y1, base, height; };
const CovBox kCovBoxes[] = {
    {"b1", 150.0, -60.0, 230.0, 60.0, 0.0, 45.0},
    {"b2", -320.0, 200.0, -240.0, 300.0, 0.0, 80.0},
    {"b3", 400.0, 380.0, 520.0, 440.0, 0.0, 25.0},
    {"b4", -80.0, -520.0, 80.0, -470.0, 0.0, 60.0},
    {"b5", 900.0, -120.0, 960.0, 140.0, 10.0, 120.0},
    {"b6", -900.0, -900.0, -700.0, -700.0, 0.0, 35.0},
};

std::vector<Building> cov_buildings() {
    std::vector<Building> out;
    for (size_t i = 0; i < sizeof(kCovBoxes) / sizeof(kCovBoxes[0]); ++i) {
        const CovBox& b = kCovBoxes[i];
        Building bd;
        bd.id = b.id;
        bd.ring_x = {b.x0, b.x1, b.x1, b.x0};
        bd.ring_y = {b.y0, b.y0, b.y1, b.y1};
        bd.base_m = b.base;
        bd.height_m = b.height;
        out.push_back(bd);
    }
    return out;
}

int write_golden_coverage(const char* path) {
    const Lla origin(116.405, 39.990, 0.0);
    const double terrain = 0.0;
    LocalSceneAdapter map;
    map.set_buildings(cov_buildings());
    OcclusionQuery occ;
    occ.map = &map;
    occ.frame = SceneFrame(origin);

    const Lla sites[] = {Lla(116.405, 39.990, 30.0), Lla(116.3990, 39.9860, 15.0)};
    // 目标：楼后、楼前、掠射、远处、贴地，外加一个与站重合的无效点（valid = false）
    const double tlon[] = {116.4080, 116.4150, 116.4000, 116.4250, 116.3950, 116.4065, 116.3860};
    const double tlat[] = {39.9900, 39.9910, 39.9930, 39.9950, 39.9800, 39.9848, 39.9810};
    const double heights[] = {1.5, 60.0, 150.0};
    const double freqs[] = {2.44e9, 5.8e9};

    CoverageLink base;
    base.tx_power_dBm = 27.0;
    base.tx_gain_dBi = 2.0;
    base.rx_gain_dBi = 3.0;
    base.nf_dB = 6.0;
    base.noise_bw_Hz = 921.0 * 500000.0 / 1024.0;   // 缺省链：M = 921、fs = 500 kS/s、nfft = 1024

    std::ofstream f(path, std::ios::binary);
    if (!f) { std::printf("打不开 %s\n", path); return 1; }
    char buf[1024];
    f << "{\n  \"_meta\": {\n";
    f << "    \"what\": \"覆盖场单格链路预算（D-079）：C++ geo::coverage_cell 的输出，浏览器 web/src/scene/coverage/cell.ts 逐格复算对拍\",\n";
    f << "    \"generator\": \"geo/build/cuav_geo_smoke_test --write-golden-coverage tests/golden/coverage-cells.json\",\n";
    f << "    \"tolerance\": {\"distance_m\": \"rel <= 1e-9\", \"fspl_dB\": \"rel <= 1e-9\", \"diffraction_dB/signal_dBm/noise_dBm/snr_dB\": \"abs <= 1e-8 dB\"},\n";
    f << "    \"why_abs_for_dB\": \"信噪比、刀口损耗会落在 0 dB 附近，相对差在那里会被放大成没有意义的大数（实测 snr 0.30 dB 那格 abs 1.6e-10 dB 即 rel 5.2e-10）；两侧的差来自椭球换算两家实现相差 1.7e-9 m，折到 dB 上约 1e-10 量级，1e-8 dB 留约五十倍余量\",\n";
    f << "    \"frame\": \"geo::SceneFrame，原点 [116.405, 39.99]；楼的外环是平面米、首尾不闭合；terrain_height_m = 0\",\n";
    f << "    \"formula\": \"S = P_tx + G_t + G_r - FSPL - L_diff；N = -174 + nf + 10 log10(noise_bw_Hz)；snr = S - N\"\n  },\n";
    f << "  \"origin\": {\"lon\": 116.405, \"lat\": 39.99},\n  \"terrain_height_m\": 0,\n  \"buildings\": [\n";
    const size_t nb = sizeof(kCovBoxes) / sizeof(kCovBoxes[0]);
    for (size_t i = 0; i < nb; ++i) {
        const CovBox& b = kCovBoxes[i];
        std::snprintf(buf, sizeof(buf),
                      "    {\"id\": \"%s\", \"ring_x\": [%.17g, %.17g, %.17g, %.17g], \"ring_y\": [%.17g, %.17g, %.17g, %.17g], \"base_m\": %.17g, \"height_m\": %.17g}%s\n",
                      b.id, b.x0, b.x1, b.x1, b.x0, b.y0, b.y0, b.y1, b.y1, b.base, b.height, i + 1 < nb ? "," : "");
        f << buf;
    }
    f << "  ],\n  \"cases\": [\n";
    std::vector<std::string> rows;
    for (int si = 0; si < 2; ++si)
        for (size_t ti = 0; ti < sizeof(tlon) / sizeof(tlon[0]); ++ti)
            for (int hi = 0; hi < 3; ++hi)
                for (int fi = 0; fi < 2; ++fi) {
                    CoverageLink link = base;
                    link.frequency_Hz = freqs[fi];
                    const Lla target(tlon[ti], tlat[ti], terrain + heights[hi]);
                    const CoverageCell c = coverage_cell(sites[si], target, terrain, &occ, link);
                    std::snprintf(buf, sizeof(buf),
                                  "    {\"site\": [%.17g, %.17g, %.17g], \"target\": [%.17g, %.17g, %.17g], \"frequency_Hz\": %.17g, "
                                  "\"out\": {\"valid\": %s, \"blocked\": %s, \"distance_m\": %.17g, \"fspl_dB\": %.17g, \"diffraction_dB\": %.17g, "
                                  "\"signal_dBm\": %.17g, \"noise_dBm\": %.17g, \"snr_dB\": %.17g}}",
                                  sites[si].lon_deg, sites[si].lat_deg, sites[si].alt_m, target.lon_deg, target.lat_deg, target.alt_m,
                                  link.frequency_Hz, c.valid ? "true" : "false", c.blocked ? "true" : "false", c.distance_m,
                                  c.fspl_dB, c.diffraction_dB, c.signal_dBm, c.noise_dBm, c.snr_dB);
                    rows.push_back(buf);
                }
    // 与站重合的点：距离为零，valid 必须为 false
    {
        CoverageLink link = base;
        link.frequency_Hz = 2.44e9;
        const CoverageCell c = coverage_cell(sites[0], sites[0], terrain, &occ, link);
        std::snprintf(buf, sizeof(buf),
                      "    {\"site\": [%.17g, %.17g, %.17g], \"target\": [%.17g, %.17g, %.17g], \"frequency_Hz\": %.17g, "
                      "\"out\": {\"valid\": %s, \"blocked\": %s, \"distance_m\": %.17g, \"fspl_dB\": %.17g, \"diffraction_dB\": %.17g, "
                      "\"signal_dBm\": %.17g, \"noise_dBm\": %.17g, \"snr_dB\": %.17g}}",
                      sites[0].lon_deg, sites[0].lat_deg, sites[0].alt_m, sites[0].lon_deg, sites[0].lat_deg, sites[0].alt_m,
                      link.frequency_Hz, c.valid ? "true" : "false", c.blocked ? "true" : "false", c.distance_m,
                      c.fspl_dB, c.diffraction_dB, c.signal_dBm, c.noise_dBm, c.snr_dB);
        rows.push_back(buf);
    }
    for (size_t i = 0; i < rows.size(); ++i) f << rows[i] << (i + 1 < rows.size() ? ",\n" : "\n");
    f << "  ],\n";
    std::snprintf(buf, sizeof(buf), "  \"link\": {\"tx_power_dBm\": %.17g, \"tx_gain_dBi\": %.17g, \"rx_gain_dBi\": %.17g, \"nf_dB\": %.17g, \"noise_bw_Hz\": %.17g}\n}\n",
                  base.tx_power_dBm, base.tx_gain_dBi, base.rx_gain_dBi, base.nf_dB, base.noise_bw_Hz);
    f << buf;
    int blocked = 0;
    for (size_t i = 0; i < rows.size(); ++i) if (rows[i].find("\"blocked\": true") != std::string::npos) ++blocked;
    std::printf("已写入 %s（%zu 例，其中判非视距 %d 例）\n", path, rows.size(), blocked);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 3 && std::strcmp(argv[1], "--write-golden") == 0) return write_golden(argv[2]);
    if (argc == 3 && std::strcmp(argv[1], "--write-golden-coverage") == 0) return write_golden_coverage(argv[2]);

    const IGeodesy& g = default_geodesy();

    // 一、LLA → ECEF → LLA 往返，判据用 ECEF 欧氏距离（度数差会被纬度尺度骗过去）。
    const Lla points[] = {Lla(0.0, 0.0, 0.0), Lla(116.405, 39.99, 30.0),
                          Lla(-73.9, 40.7, 10000.0), Lla(0.0, 89.9, -100.0)};
    for (int i = 0; i < 4; ++i) {
        const Ecef e = g.to_ecef(points[i]);
        const Ecef back = g.to_ecef(g.to_lla(e));
        check(chord_distance_m(e, back) < 1e-3, "LLA↔ECEF 往返误差应小于 1 毫米");
    }

    // 二、自由空间路损的解析锚点：2.4 GHz、1 km。
    // 精确值 20·log10(4π·1000·2.4e9/299792458) = 100.052008 dB，即 06 备忘录 G-1 的 100.05。
    check(std::fabs(fspl_dB(1000.0, 2.4e9) - 100.052008) < 1e-5, "FSPL 解析锚点 100.052008 dB");
    check(speed_of_light_mps() == 299792458.0, "光速常数必须是 299792458（D-009）");

    // 三、运动学：两航点匀速，中点位置是经纬高各自的中点。
    std::vector<Waypoint> wps(2);
    wps[0].position = Lla(116.40, 39.99, 100.0);
    wps[0].speed_mps = 20.0;
    wps[1].position = Lla(116.42, 40.01, 200.0);
    wps[1].speed_mps = 20.0;
    Route r;
    std::string err;
    check(r.build(wps, false, err), "航线应能建成");
    const MotionState mid = r.state_at(r.cycle_duration_s() / 2.0);
    check(std::fabs(mid.position.lon_deg - 116.41) < 1e-12, "中点经度");
    check(std::fabs(mid.position.lat_deg - 40.00) < 1e-12, "中点纬度");
    check(std::fabs(mid.position.alt_m - 150.0) < 1e-9, "中点高度");
    check(std::fabs(norm(mid.velocity) - 20.0) < 1e-9, "速度模长应等于段速度");

    // 四、坐标基座（D-074 / D3-1）：两家实现在观测区域尺度上必须一致到微米。
    {
        const IGeodesy& cf = closed_form_geodesy();
        const IGeodesy& gl = geographiclib_geodesy();
        double worst_ecef = 0.0, worst_enu = 0.0;
        const std::vector<Lla> pts = golden_points();
        for (std::size_t i = 0; i < pts.size(); ++i) {
            const double d = chord_distance_m(cf.to_ecef(pts[i]), gl.to_ecef(pts[i]));
            if (d > worst_ecef) worst_ecef = d;
            const Enu a = cf.to_enu(cf.to_ecef(pts[i]), golden_origin());
            const Enu b = gl.to_enu(gl.to_ecef(pts[i]), golden_origin());
            const double de = norm(Enu(a.e - b.e, a.n - b.n, a.u - b.u));
            if (de > worst_enu) worst_enu = de;
        }
        check(worst_ecef < 1e-6, "自写闭式与 GeographicLib 的 ECEF 应一致到微米");
        check(worst_enu < 1e-6, "自写闭式与 GeographicLib 的 ENU 应一致到微米");
        std::printf("坐标基座两家一致性：ECEF 最差 %.3e m，ENU 最差 %.3e m\n", worst_ecef, worst_enu);
    }

    // 五、把「站心旋转各家一样」这句话验了，而不是只写在注释里（D-074 §3.3）。
    // GeographicLibGeodesy 的 to_enu 是「ECEF 相减 + 自己写的旋转矩阵」；
    // 上游的 LocalCartesian 走的是另一条路（大地坐标直接进、内部保存旋转矩阵）。
    // 两条路必须给出同一个站心坐标，否则那句话就不成立。
    {
        const Lla& o = golden_origin();
        GeographicLib::LocalCartesian lc(o.lat_deg, o.lon_deg, o.alt_m,
                                         GeographicLib::Geocentric::WGS84());
        const IGeodesy& gl = geographiclib_geodesy();
        double worst = 0.0;
        const std::vector<Lla> pts = golden_points();
        for (std::size_t i = 0; i < pts.size(); ++i) {
            double x = 0.0, y = 0.0, z = 0.0;
            lc.Forward(pts[i].lat_deg, pts[i].lon_deg, pts[i].alt_m, x, y, z);
            const Enu mine = gl.to_enu(gl.to_ecef(pts[i]), o);
            const double d = norm(Enu(mine.e - x, mine.n - y, mine.u - z));
            if (d > worst) worst = d;
        }
        // 判据比两家一致性严一个数量级：这里比的是同一个库的两条代码路径，
        // 差别只该来自浮点运算次序，不该来自模型。
        check(worst < 1e-7, "自写的站心旋转应与上游 LocalCartesian 一致");
        std::printf("站心旋转对上游 LocalCartesian：最差 %.3e m\n", worst);
    }

    // 六、建筑遮挡（D3-3）：一栋楼、一条穿过它的视线，取解析锚点与单调性。
    // 完整的 148 例黄金对拍在 engine/tests/test_occlusion.cpp，这里只保证本库脱离引擎也自检得动。
    {
        check(std::fabs(legacy::knife_edge_loss_dB(0.0) - 6.0329) < 1e-3,
              "掠射刀口损耗解析锚点 6.03 dB");
        check(legacy::knife_edge_loss_dB(-2.0) == 0.0, "v ≤ −0.78 判为无遮挡");

        Building b;
        b.id = "B";
        b.height_m = 40.0;
        const double half = 50.0;
        b.ring_x.push_back(-half); b.ring_y.push_back(-half);
        b.ring_x.push_back(half);  b.ring_y.push_back(-half);
        b.ring_x.push_back(half);  b.ring_y.push_back(half);
        b.ring_x.push_back(-half); b.ring_y.push_back(half);
        std::vector<Building> bs;
        bs.push_back(b);
        LocalSceneAdapter map;
        map.set_buildings(bs);
        check(map.building_count() == 1 && map.dropped_count() == 0, "建筑应全部入网格");

        const OcclusionResult low =
            segment_occlusion(map, MapPoint(-500.0, 0.0, 10.0), MapPoint(500.0, 0.0, 10.0), 2.44e9);
        check(low.blocked && low.obstruction_loss_dB > 6.0, "楼下穿过应判非视距且损耗大于掠射值");
        const OcclusionResult high =
            segment_occlusion(map, MapPoint(-500.0, 0.0, 60.0), MapPoint(500.0, 0.0, 60.0), 2.44e9);
        check(!high.blocked && high.obstruction_loss_dB == 0.0, "楼顶掠过应判视距且零损耗");
        std::printf("建筑遮挡：楼下穿过 %.1f dB（侵入 %.0f m），楼顶掠过 %.1f dB\n",
                    low.obstruction_loss_dB, low.intrusion_m, high.obstruction_loss_dB);
    }

    if (failures == 0) std::printf("cuav_geo 冒烟测试通过\n");
    return failures == 0 ? 0 : 1;
}
