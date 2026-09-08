// cuav_geo 的独立冒烟测试：不依赖 doctest，保证本库脱离引擎也能构建与自检。
//
// 完整单测在 engine/tests/test_geo.cpp（引擎链接 cuav_geo，doctest 已 vendored 在那边）。
// 待 D3 从 emcore 移植 148 例遮挡黄金基准时，第三方件上提到仓库根 third_party/，
// 本库再建自己的 doctest 运行器（08 报告 §15 暂定项 ⑥）。

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "cuav_geo/geodesy.h"
#include "cuav_geo/kinematics.h"
#include "cuav_geo/link_budget.h"

using namespace cuav::geo;

static int failures = 0;

static void check(bool ok, const char* what) {
    if (!ok) {
        std::printf("失败：%s\n", what);
        ++failures;
    }
}

int main() {
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

    if (failures == 0) std::printf("cuav_geo 冒烟测试通过\n");
    return failures == 0 ? 0 : 1;
}
