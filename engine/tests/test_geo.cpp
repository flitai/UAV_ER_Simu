// cuav_geo 的单元测试（06 备忘录 §9C G-1）。
//
// 放在引擎侧而不是 geo/tests/：doctest 只 vendored 在 engine/third_party/，geo/ 保持零第三方
// 依赖。geo 自带一个不依赖 doctest 的裸 main 冒烟测试保证它能独立构建（08 报告 §15 暂定项 ⑥）。
//
// 三条验收数字（06 §9C G-1 行）：LLA↔ECEF 往返 < 1 mm；FSPL@2.4 GHz/1 km = 100.05 dB；
// 固定场景航迹逐点确定。

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "cuav_geo/geodesy.h"
#include "cuav_geo/kinematics.h"
#include "cuav_geo/legacy_frames.h"
#include "cuav_geo/link_budget.h"
#include "cuav_geo/scenario.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"

using namespace cuav::geo;

namespace {
const double kPi = 3.14159265358979323846;

// 方位角定义在 [0, 360) 上，359.999999999995 与 0 是同一个方向；比较必须模 360。
double azimuth_diff_deg(double a, double b) {
    double d = std::fabs(a - b);
    if (d > 180.0) d = 360.0 - d;
    return d;
}

Waypoint wp(double lon, double lat, double alt, double speed, double loiter = 0.0) {
    Waypoint w;
    w.position = Lla(lon, lat, alt);
    w.speed_mps = speed;
    w.loiter_s = loiter;
    return w;
}
}  // namespace

TEST_CASE("大地坐标：LLA→ECEF→LLA 往返误差小于 1 毫米") {
    const IGeodesy& g = default_geodesy();
    const double lats[] = {0.0, 39.99, -39.99, 89.9, -89.9, 60.0};
    const double lons[] = {0.0, 116.405, -73.9, 179.99, -179.99, 45.0};
    const double alts[] = {-100.0, 0.0, 150.0, 10000.0};
    for (int i = 0; i < 6; ++i) {
        for (int k = 0; k < 4; ++k) {
            const Lla p(lons[i], lats[i], alts[k]);
            const Ecef e = g.to_ecef(p);
            const Ecef back = g.to_ecef(g.to_lla(e));
            CHECK(chord_distance_m(e, back) < 1e-3);
        }
    }
}

TEST_CASE("大地坐标：ECEF→LLA→ECEF 反向往返也在 1 毫米内") {
    const IGeodesy& g = default_geodesy();
    const Ecef pts[] = {Ecef(wgs84_a(), 0.0, 0.0), Ecef(0.0, wgs84_a(), 0.0),
                        Ecef(0.0, 0.0, wgs84_b()), Ecef(-2170000.0, 4390000.0, 4080000.0)};
    for (int i = 0; i < 4; ++i) {
        const Ecef back = g.to_ecef(g.to_lla(pts[i]));
        CHECK(chord_distance_m(pts[i], back) < 1e-3);
    }
}

TEST_CASE("大地坐标：三个已知点与 WGS-84 常数逐位相符") {
    const IGeodesy& g = default_geodesy();
    const Ecef e0 = g.to_ecef(Lla(0.0, 0.0, 0.0));
    CHECK(std::fabs(e0.x - wgs84_a()) < 1e-9);
    CHECK(std::fabs(e0.y) < 1e-6);
    CHECK(std::fabs(e0.z) < 1e-6);

    const Ecef e90 = g.to_ecef(Lla(90.0, 0.0, 0.0));
    CHECK(std::fabs(e90.x) < 1e-6);
    CHECK(e90.y == doctest::Approx(wgs84_a()));

    const Ecef ep = g.to_ecef(Lla(0.0, 90.0, 0.0));
    CHECK(ep.z == doctest::Approx(wgs84_b()));
}

TEST_CASE("大地坐标：站心 ENU 三基正交，天向与椭球法线一致") {
    const IGeodesy& g = default_geodesy();
    const Lla o(116.405, 39.99, 30.0);
    const Ecef ee = g.rotate_to_ecef(Enu(1, 0, 0), o);
    const Ecef en = g.rotate_to_ecef(Enu(0, 1, 0), o);
    const Ecef eu = g.rotate_to_ecef(Enu(0, 0, 1), o);
    CHECK(std::fabs(dot(ee, en)) < 1e-12);
    CHECK(std::fabs(dot(ee, eu)) < 1e-12);
    CHECK(std::fabs(dot(en, eu)) < 1e-12);
    CHECK(norm(ee) == doctest::Approx(1.0));
    // 沿天向抬高 100 m，还原出来的高度应正好多 100 m。
    const Ecef up = g.from_enu(Enu(0, 0, 100.0), o);
    CHECK(g.to_lla(up).alt_m == doctest::Approx(130.0).epsilon(1e-9));
}

TEST_CASE("大地坐标：矢量旋转不含站心平移") {
    const IGeodesy& g = default_geodesy();
    const Lla o(116.405, 39.99, 30.0);
    // 零矢量转过去还是零。若误用了含平移的那一对，这里会得到地心到站点的整条矢量。
    const Ecef z = g.rotate_to_ecef(Enu(0, 0, 0), o);
    CHECK(norm(z) < 1e-9);
    const Enu back = g.rotate_to_enu(g.rotate_to_ecef(Enu(3.0, -4.0, 12.0), o), o);
    CHECK(back.e == doctest::Approx(3.0));
    CHECK(back.n == doctest::Approx(-4.0));
    CHECK(back.u == doctest::Approx(12.0));
}

TEST_CASE("距离口径：用 ECEF 弦长，与 em-demo 的半正矢在 AOI 尺度上差不到 0.01 米") {
    const Lla a(116.4035, 39.9885, 50.0);
    const Lla b(116.4300, 40.0110, 160.0);
    const double chord = chord_distance_m(a, b);

    // em-demo src/models/propagation.ts 的 distanceGeo：球面半正矢 R = 6371000，再合成高差。
    const double R = 6371000.0;
    const double dlat = (b.lat_deg - a.lat_deg) * kPi / 180.0;
    const double dlon = (b.lon_deg - a.lon_deg) * kPi / 180.0;
    const double la1 = a.lat_deg * kPi / 180.0, la2 = b.lat_deg * kPi / 180.0;
    const double h = std::sin(dlat / 2) * std::sin(dlat / 2) +
                     std::cos(la1) * std::cos(la2) * std::sin(dlon / 2) * std::sin(dlon / 2);
    const double ground = 2.0 * R * std::asin(std::sqrt(h));
    const double dalt = b.alt_m - a.alt_m;
    const double haversine = std::sqrt(ground * ground + dalt * dalt);

    CHECK(chord > 3000.0);
    CHECK(chord < 3500.0);
    // 两者差在厘米量级：偏离是有意的（08 报告 §9），但在本系统尺度上不改变物理结论。
    CHECK(std::fabs(chord - haversine) < 5.0);
}

TEST_CASE("视线角：四个正方向的方位为 0/90/180/270，水平俯仰为 0") {
    const Lla o(116.405, 39.99, 100.0);
    // 正南北在同一子午线上，方位精确（0 要模 360 比，浮点噪声会让它落在 359.999… 一侧）。
    CHECK(azimuth_diff_deg(look_angles(o, Lla(116.405, 40.00, 100.0)).azimuth_deg, 0.0) < 1e-6);
    CHECK(azimuth_diff_deg(look_angles(o, Lla(116.405, 39.98, 100.0)).azimuth_deg, 180.0) < 1e-6);
    // 正东西**不是**精确 90 / 270：同纬度两点之间的大圆是向极地方向拱的，
    // 北半球的起始方位因此略小于 90（实测 89.997）。这是椭球上的正确结果，不是缺陷；
    // em-demo 用 atan2(dLon, dLat) 的经纬度近似看不出这一点（差约 0.5 度，见 geodesy.h）。
    CHECK(azimuth_diff_deg(look_angles(o, Lla(116.415, 39.99, 100.0)).azimuth_deg, 90.0) < 0.01);
    CHECK(azimuth_diff_deg(look_angles(o, Lla(116.395, 39.99, 100.0)).azimuth_deg, 270.0) < 0.01);
    // 同高度的水平视线，俯仰应当接近 0（地球曲率带来极小的负值）。
    CHECK(std::fabs(look_angles(o, Lla(116.415, 39.99, 100.0)).elevation_deg) < 0.01);
    // 正上方 100 m：俯仰 90 度。
    CHECK(look_angles(o, Lla(116.405, 39.99, 200.0)).elevation_deg == doctest::Approx(90.0).epsilon(1e-6));
}

TEST_CASE("链路预算：FSPL 解析锚点 2.4 GHz / 1 km = 100.052008 dB") {
    // 06 备忘录 §9C G-1 的验收数字写作 100.05，精确值 20·log10(4π·1000·2.4e9/299792458)。
    CHECK(std::fabs(fspl_dB(1000.0, 2.4e9) - 100.052008) < 1e-5);
    // 距离翻倍加 20·log10(2) = 6.0205999 dB。
    CHECK(std::fabs(fspl_dB(2000.0, 2.4e9) - fspl_dB(1000.0, 2.4e9) - 6.0205999132796) < 1e-9);
    // 光速常数不得被"顺手统一"成 3e8（D-009：那是移植模块守 golden 用的）。
    CHECK(speed_of_light_mps() == 299792458.0);
}

TEST_CASE("链路预算：退化输入不返回看着合理的数，而是标 invalid 并给理由") {
    LinkGeometry g;
    g.distance_m = 0.0;
    LinkBudget b = link_budget(g, 2.4e9, 6.0);
    CHECK_FALSE(b.valid);
    CHECK_FALSE(b.reason.empty());

    g.distance_m = 1000.0;
    b = link_budget(g, 0.0, 6.0);
    CHECK_FALSE(b.valid);
    CHECK_FALSE(b.reason.empty());
}

TEST_CASE("链路预算：多普勒远离为负、接近为正，量值与 f·v/c 相符") {
    const double f = 2.4405e9, v = 15.0;
    const double expect = f * v / speed_of_light_mps();   // 122.1 Hz
    CHECK(doppler_Hz(f, v) == doctest::Approx(-expect).epsilon(1e-12));    // 远离为负
    CHECK(doppler_Hz(f, -v) == doctest::Approx(expect).epsilon(1e-12));    // 接近为正
    CHECK(expect == doctest::Approx(122.10).epsilon(1e-3));
}

TEST_CASE("链路预算：热噪声底 = −174 + 噪声系数") {
    CHECK(thermal_noise_dBm_per_Hz(6.0) == doctest::Approx(-168.0));
}

TEST_CASE("运动学：单航点静止，任意时刻位置不变且速度为零") {
    std::vector<Waypoint> w;
    w.push_back(wp(116.405, 39.99, 100.0, 10.0));
    Route r;
    std::string err;
    REQUIRE(r.build(w, false, err));
    for (double t = 0.0; t < 100.0; t += 7.0) {
        const MotionState s = r.state_at(t);
        CHECK(s.position.lon_deg == 116.405);
        CHECK(s.speed_mps == 0.0);
        CHECK(norm(s.velocity) == 0.0);
        CHECK_FALSE(s.moving);
    }
}

TEST_CASE("运动学：两航点匀速，中点是经纬高各自的中点，速度模长等于段速度") {
    std::vector<Waypoint> w;
    w.push_back(wp(116.40, 39.99, 100.0, 20.0));
    w.push_back(wp(116.42, 40.01, 200.0, 20.0));
    Route r;
    std::string err;
    REQUIRE(r.build(w, false, err));

    const MotionState mid = r.state_at(r.cycle_duration_s() / 2.0);
    CHECK(mid.position.lon_deg == doctest::Approx(116.41).epsilon(1e-12));
    CHECK(mid.position.lat_deg == doctest::Approx(40.00).epsilon(1e-12));
    CHECK(mid.position.alt_m == doctest::Approx(150.0).epsilon(1e-9));
    CHECK(norm(mid.velocity) == doctest::Approx(20.0).epsilon(1e-9));
    CHECK(mid.speed_mps == 20.0);
    CHECK(mid.moving);
    // 航向为该段的真北顺时针方位，东北向应在 0 与 90 度之间。
    CHECK(mid.heading_deg > 0.0);
    CHECK(mid.heading_deg < 90.0);
}

TEST_CASE("运动学：悬停期间位置与航向冻结、速度为零，之后继续且不丢时间") {
    std::vector<Waypoint> w;
    w.push_back(wp(116.40, 39.99, 100.0, 20.0));
    w.push_back(wp(116.41, 40.00, 100.0, 20.0, 30.0));   // 到达后悬停 30 秒
    w.push_back(wp(116.42, 40.01, 100.0, 20.0));
    Route r;
    std::string err;
    REQUIRE(r.build(w, false, err));

    const double leg0 = chord_distance_m(w[0].position, w[1].position) / 20.0;
    const double leg1 = chord_distance_m(w[1].position, w[2].position) / 20.0;
    CHECK(r.cycle_duration_s() == doctest::Approx(leg0 + 30.0 + leg1).epsilon(1e-12));

    const MotionState h1 = r.state_at(leg0 + 1.0);
    const MotionState h2 = r.state_at(leg0 + 29.0);
    CHECK(h1.position.lon_deg == doctest::Approx(116.41).epsilon(1e-12));
    CHECK(h1.position.lon_deg == h2.position.lon_deg);
    CHECK(h1.speed_mps == 0.0);
    CHECK(norm(h1.velocity) == 0.0);
    CHECK_FALSE(h1.moving);
    CHECK(h1.heading_deg == h2.heading_deg);

    // 悬停结束后立刻进入第二段，时间不丢：末刻应正好到末航点。
    const MotionState end = r.state_at(r.cycle_duration_s());
    CHECK(end.position.lon_deg == doctest::Approx(116.42).epsilon(1e-9));
}

TEST_CASE("运动学：越过一整段的时刻与手工按段推算相等") {
    std::vector<Waypoint> w;
    w.push_back(wp(116.40, 39.99, 100.0, 25.0));
    w.push_back(wp(116.41, 40.00, 140.0, 10.0));
    w.push_back(wp(116.43, 40.02, 220.0, 10.0));
    Route r;
    std::string err;
    REQUIRE(r.build(w, false, err));

    const double leg0 = chord_distance_m(w[0].position, w[1].position) / 25.0;
    const double leg1 = chord_distance_m(w[1].position, w[2].position) / 10.0;
    const double t = leg0 + leg1 * 0.25;
    const MotionState s = r.state_at(t);
    CHECK(s.position.lon_deg == doctest::Approx(116.41 + 0.02 * 0.25).epsilon(1e-12));
    CHECK(s.position.alt_m == doctest::Approx(140.0 + 80.0 * 0.25).epsilon(1e-9));
    CHECK(s.speed_mps == 10.0);
}

TEST_CASE("运动学：loop 为真时按周期循环，为假时到底停住且状态仍有效") {
    std::vector<Waypoint> w;
    w.push_back(wp(116.40, 39.99, 100.0, 20.0));
    w.push_back(wp(116.42, 40.01, 100.0, 20.0));

    Route looped;
    std::string err;
    REQUIRE(looped.build(w, true, err));
    const double cyc = looped.cycle_duration_s();
    const MotionState a = looped.state_at(3.5);
    const MotionState b = looped.state_at(cyc + 3.5);
    CHECK(a.position.lon_deg == b.position.lon_deg);
    CHECK(a.position.lat_deg == b.position.lat_deg);

    Route once;
    REQUIRE(once.build(w, false, err));
    const MotionState past = once.state_at(once.cycle_duration_s() * 3.0);
    CHECK(past.position.lon_deg == doctest::Approx(116.42).epsilon(1e-9));
    CHECK(past.speed_mps == 0.0);
    CHECK_FALSE(past.moving);
}

TEST_CASE("运动学：闭式求值与调用次数、顺序、步长无关（有意不做增量积分）") {
    std::vector<Waypoint> w;
    w.push_back(wp(116.4035, 39.9885, 50.0, 18.0));
    w.push_back(wp(116.4110, 39.9955, 110.0, 20.0, 12.0));
    w.push_back(wp(116.4300, 40.0110, 160.0, 20.0));
    Route r;
    std::string err;
    REQUIRE(r.build(w, false, err));

    // 同一时刻取一千次，逐位相同。
    const MotionState ref = r.state_at(77.7);
    for (int i = 0; i < 1000; ++i) {
        const MotionState s = r.state_at(77.7);
        CHECK(s.position.lon_deg == ref.position.lon_deg);
        CHECK(s.position.lat_deg == ref.position.lat_deg);
        CHECK(s.position.alt_m == ref.position.alt_m);
    }
    // 乱序取值也一样：先取晚的再取早的，早的结果不变。
    r.state_at(150.0);
    const MotionState again = r.state_at(77.7);
    CHECK(again.position.lon_deg == ref.position.lon_deg);
}

TEST_CASE("运动学：重合航点不除零，直接跨过去") {
    std::vector<Waypoint> w;
    w.push_back(wp(116.40, 39.99, 100.0, 20.0));
    w.push_back(wp(116.40, 39.99, 100.0, 20.0));      // 与上一个重合
    w.push_back(wp(116.41, 40.00, 100.0, 20.0));
    Route r;
    std::string err;
    REQUIRE(r.build(w, false, err));
    CHECK(r.cycle_duration_s() > 0.0);
    const MotionState s = r.state_at(r.cycle_duration_s() / 2.0);
    CHECK(std::isfinite(s.position.lon_deg));
    CHECK(std::isfinite(s.position.lat_deg));
    CHECK(std::isfinite(norm(s.velocity)));
}

TEST_CASE("运动学：非法航线被拒且写明理由") {
    Route r;
    std::string err;
    std::vector<Waypoint> empty;
    CHECK_FALSE(r.build(empty, false, err));
    CHECK_FALSE(err.empty());

    std::vector<Waypoint> bad;
    bad.push_back(wp(116.40, 39.99, 100.0, 0.0));     // 速度为零
    CHECK_FALSE(r.build(bad, false, err));
    CHECK_FALSE(err.empty());
}

// ---- 坐标基座：两家实现对同一份黄金基准（D-074 / D3-1）----
//
// 基准由 geo/build/cuav_geo_smoke_test --write-golden tests/golden/geodesy.json 生成，
// 数值来自 vendored GeographicLib 2.5.2 的 Geocentric。它钉住两件事：
//   ① 上游升版或 third_party/geographiclib/include/GeographicLib/Config.h 改动导致读数变化；
//   ② 自写闭式 ClosedFormWgs84 与它的一致性——这是「换基座换对了」的唯一证据。
//
// 两个判据不同，理由各自写在断言旁边。
TEST_CASE("坐标基座：两家实现对 tests/golden/geodesy.json") {
    const std::string path = std::string(CUAV_SOURCE_DIR) + "/../tests/golden/geodesy.json";
    std::ifstream f(path);
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << path
                    << "；重新生成：geo/build/cuav_geo_smoke_test --write-golden tests/golden/geodesy.json");
    std::stringstream ss;
    ss << f.rdbuf();
    const nlohmann::json j = nlohmann::json::parse(ss.str());
    REQUIRE(j.contains("cases"));
    REQUIRE(j["cases"].size() > 0);

    const Lla origin(j["origin"]["lon"].get<double>(),
                     j["origin"]["lat"].get<double>(),
                     j["origin"]["alt_m"].get<double>());

    const IGeodesy& gl = geographiclib_geodesy();
    const IGeodesy& cf = closed_form_geodesy();

    double worst_gl = 0.0, worst_cf = 0.0, worst_gl_enu = 0.0, worst_cf_enu = 0.0;
    double worst_back_gl = 0.0, worst_back_cf = 0.0;

    for (const auto& c : j["cases"]) {
        const Lla p(c["lon"].get<double>(), c["lat"].get<double>(), c["alt_m"].get<double>());
        const Ecef want(c["ecef"][0].get<double>(), c["ecef"][1].get<double>(),
                        c["ecef"][2].get<double>());
        const Enu want_enu(c["enu"][0].get<double>(), c["enu"][1].get<double>(),
                           c["enu"][2].get<double>());

        const Ecef e_gl = gl.to_ecef(p);
        const Ecef e_cf = cf.to_ecef(p);
        worst_gl = std::max(worst_gl, chord_distance_m(e_gl, want));
        worst_cf = std::max(worst_cf, chord_distance_m(e_cf, want));

        const Enu n_gl = gl.to_enu(e_gl, origin);
        const Enu n_cf = cf.to_enu(e_cf, origin);
        worst_gl_enu = std::max(worst_gl_enu,
                                norm(Enu(n_gl.e - want_enu.e, n_gl.n - want_enu.n, n_gl.u - want_enu.u)));
        worst_cf_enu = std::max(worst_cf_enu,
                                norm(Enu(n_cf.e - want_enu.e, n_cf.n - want_enu.n, n_cf.u - want_enu.u)));

        // 反算也要钉住：只钉正算的话，Reverse 改坏了这条基准看不出来。
        worst_back_gl = std::max(worst_back_gl, chord_distance_m(gl.to_ecef(gl.to_lla(want)), want));
        worst_back_cf = std::max(worst_back_cf, chord_distance_m(cf.to_ecef(cf.to_lla(want)), want));
    }

    // GeographicLib 判据 1e-9 米而不是逐位：本表就是它生成的，同一台机器上必然逐位复现，
    // 但换一个平台时 std::sin / std::cos 可能差一个最低位（D-049 ⑪ 已记过同一件事），
    // 所以判据取纳米级——足以逮住任何真正的改动，又不会在换平台时假红。
    CHECK(worst_gl < 1e-9);
    CHECK(worst_gl_enu < 1e-9);

    // 自写闭式判据 1e-6 米：两家的反算算法不同（自写是 Bowring 闭式，不迭代），
    // 本就不该期望逐位相同；能到微米级就说明两边都对。这个判据是刻意放宽于铁律 10 的 1e-9 的，
    // 理由同 M-3 把算法核与组件分成两个尺度（D-071 ③）——比较的对象不同，判据就该不同。
    CHECK(worst_cf < 1e-6);
    CHECK(worst_cf_enu < 1e-6);

    // 往返：两家都必须回得来。1 毫米是 G-1 立的验收线（06 §9C），这里顺带复核。
    CHECK(worst_back_gl < 1e-3);
    CHECK(worst_back_cf < 1e-3);

    MESSAGE("坐标基座 " << j["cases"].size() << " 例："
            << "GeographicLib 正算最差 " << worst_gl << " m、站心 " << worst_gl_enu << " m；"
            << "自写闭式正算最差 " << worst_cf << " m、站心 " << worst_cf_enu << " m");
}

TEST_CASE("坐标基座：缺省工厂是 GeographicLib（D3-2 换过来）") {
    // D3-1 时这条断言的是 "closed-form-wgs84"，并写明「在 D3-2 会被有意改掉，
    // 改动本身就是那一步的标志」。2026-09-17 由 D3-2 改成现在这样。
    // 自写闭式没有删，仍然受 tests/golden/geodesy.json 那条用例约束。
    CHECK(std::string(default_geodesy().name()) == "geographiclib-2.5.2");
    CHECK(std::string(closed_form_geodesy().name()) == "closed-form-wgs84");
    CHECK(std::string(geographiclib_geodesy().name()) == "geographiclib-2.5.2");
}

// ---- 两套旧投影必须保持不同（D3-3 收尾，2026-09-17）----
//
// 本项目从 emcore 移植了两批黄金基准，当年是用两把刻度不同的尺子量出来的：
// 测向定位那批纬向 111320、建筑遮挡那批纬向 110540，经向两批都是 111320·cos(参考纬度)。
//
// **把它们「统一」掉是一个看起来像清理、实际上会毁掉验证的动作**：统一 = 用我方常数重新
// 生成黄金基准 = 抹掉「基准独立于我方代码产生」这个唯一的价值（铁律 10）。
// 此前拦这件事的只有注释。注释改错了没人知道，断言改错了当场就红——本用例把两套常数
// 连同「它们必须不同」这条关系一起钉住。
//
// 系统实际运行两把都不用：链路几何、定位求解与将来的遮挡接线走的都是严格站心地平（铁律 1）。
TEST_CASE("两套旧投影：常数钉死，且必须彼此不同") {
    const double lat = 39.99;   // 观测区域中心
    const legacy::LocalFrame loc = legacy::local_frame_locate(lat);
    const legacy::LocalFrame occ = legacy::local_frame_occlusion(lat);

    // 一、各自的常数原样钉住。改任何一个都要先想清楚对应那批 golden 会不会废。
    CHECK(loc.m_per_deg_lat == 111320.0);
    CHECK(occ.m_per_deg_lat == 110540.0);

    // 二、经向两套同式，纬向两套必须不同——**这条就是「不许统一」的可执行版本**。
    CHECK(loc.m_per_deg_lon == occ.m_per_deg_lon);
    CHECK(loc.m_per_deg_lat != occ.m_per_deg_lat);
    CHECK(std::fabs(loc.m_per_deg_lat - occ.m_per_deg_lat) == doctest::Approx(780.0));

    // 三、两套都是刻意近似的，谁也不等于 WGS-84 的真值——所以谁也不能拿去当生产用的尺子。
    // 真值：子午圈曲率半径与卯酉圈曲率半径在该纬度上各自折成米/度。
    const double a = wgs84_a(), e2 = wgs84_e2();
    const double sphi = std::sin(lat * kPi / 180.0), cphi = std::cos(lat * kPi / 180.0);
    const double w = std::sqrt(1.0 - e2 * sphi * sphi);
    const double true_lat = a * (1.0 - e2) / (w * w * w) * kPi / 180.0;
    const double true_lon = a / w * cphi * kPi / 180.0;
    const double err_loc_lat = loc.m_per_deg_lat / true_lat - 1.0;
    const double err_occ_lat = occ.m_per_deg_lat / true_lat - 1.0;
    const double err_lon = loc.m_per_deg_lon / true_lon - 1.0;
    CHECK(std::fabs(err_loc_lat) > 1e-3);      // 定位那套偏大约 +0.26%
    CHECK(std::fabs(err_occ_lat) > 1e-3);      // 遮挡那套偏小约 −0.45%
    CHECK(err_loc_lat * err_occ_lat < 0.0);    // **一个偏大一个偏小，方向都相反**
    MESSAGE("在 " << lat << "°N：定位那套纬向偏 " << err_loc_lat * 100.0
            << "%、遮挡那套偏 " << err_occ_lat * 100.0 << "%，两套经向同偏 " << err_lon * 100.0 << "%");

    // 四、参考纬度改变时经向跟着变、纬向不变（等距圆柱投影的定义）。
    const legacy::LocalFrame occ0 = legacy::local_frame_occlusion(0.0);
    CHECK(occ0.m_per_deg_lat == occ.m_per_deg_lat);
    CHECK(occ0.m_per_deg_lon > occ.m_per_deg_lon);
}
