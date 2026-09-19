// 多站测向交叉定位（EM-S-06，E2 档；自 emcore `src/models/locate_aoa.cpp` 移植，D-053 §7.1）。
//
// 测向线加权最小二乘交汇：x̂ = (AᵀWA)⁻¹AᵀWb，站 i 的测向线法线行
//   A_i = [cosθ_i, −sinθ_i]，b_i = A_i·p_i，w_i = 1/(R_i²·σ_θi²)
// 两遍求解：等权最小二乘取初值 → 按初值站距 R（钳位 ≥ 100 m）加权。
// 方位量测由调用方给（EM-S-05 的输出），本模型在给定输入下完全确定。
//
// **接口是平面坐标（米），不是经纬度**——数学与投影解耦，见 fix_geometry.h 的说明。
// σ 的 0.1° 下限与 R 的 100 m 下限是 emcore 的原钳位，保留：
// 它们防的是「某一站被判得极准或极近」时权重发散，去掉会让解被单站绑架。

#ifndef CUAV_GEO_LOCATE_AOA_H
#define CUAV_GEO_LOCATE_AOA_H

#include <vector>

#include "cuav_geo/fix_geometry.h"

namespace cuav {
namespace geo {

// 平面上的一条方位观测。x 向东、y 向北（引擎侧即 ENU）；bearing 自 +y 顺时针。
struct AoaPlaneObs {
    double x_m, y_m;
    double bearing_deg;
    double sigma_deg;
    AoaPlaneObs() : x_m(0.0), y_m(0.0), bearing_deg(0.0), sigma_deg(0.0) {}
};

struct AoaPlaneSolution {
    bool ok;
    double x_m, y_m;
    double cov[3];              // [Pxx, Pxy, Pyy]，m²
    EllipseStats stats;
    GeometryQuality quality;    // 按测向线最大张角分级（emcore 口径，守 golden）
    double max_spread_deg;
    // **最小两两交会角**（把测向线当无向直线，折到 [0, 90]）。emcore 只算最大张角，
    // 于是「两条近乎平行的线 + 一条好线」会被判成 good——最大张角看不见那一对近简并的线。
    // golden-03 上实测：uav-1 有两站真方位差 3.2°，最大张角却有 51–90°，
    // 被判 good 的那批 2σ 椭圆覆盖率只有 45%（理论 86.5%）。这个量是新加的，不改既有分级。
    double min_crossing_deg;
    std::vector<double> residuals_deg;   // 各站方位残差（输入站序），折返到 (−180, 180]
    AoaPlaneSolution()
        : ok(false), x_m(0.0), y_m(0.0), quality(GeometryQuality::Degenerate),
          max_spread_deg(0.0), min_crossing_deg(0.0) {
        cov[0] = cov[1] = cov[2] = 0.0;
    }
};

// 少于 2 站或法方程近奇异（测向线平行）→ ok = false。
AoaPlaneSolution aoa_solve_plane(const std::vector<AoaPlaneObs>& obs);

// 几何质量分级的门限（度）。emcore 原值 60 / 30 / 10。
GeometryQuality aoa_geometry_grade(double max_spread_deg,
                                   double good_deg = 60.0, double fair_deg = 30.0,
                                   double poor_deg = 10.0);

namespace legacy {

// 只供黄金基准回放：经纬度 + 111320 投影 + 上面的平面求解器。
struct AoaLonLatObs {
    double lon, lat;
    double bearing_deg;
    double bearing_error_deg;
    AoaLonLatObs() : lon(0.0), lat(0.0), bearing_deg(0.0), bearing_error_deg(0.0) {}
};

struct AoaLonLatSolution {
    bool ok;
    double lon, lat;
    double cep_m, gdop;
    ErrorEllipse ellipse;
    AoaLonLatSolution() : ok(false), lon(0.0), lat(0.0), cep_m(0.0), gdop(0.0) {}
};

AoaLonLatSolution aoa_localization_lonlat(const std::vector<AoaLonLatObs>& obs);

// emcore `computeAOAFix` 的残差口径：解算点反推方位用的是
// atan2(Δlon·cos(站纬), Δlat)，与 trueBearing_deg 同式。
std::vector<double> aoa_residuals_lonlat(const std::vector<AoaLonLatObs>& obs,
                                         double sol_lon, double sol_lat);

}  // namespace legacy

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_LOCATE_AOA_H
