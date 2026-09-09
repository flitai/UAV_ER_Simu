// 多站时差双曲定位（EM-S-07，E2 档；自 emcore `src/models/locate_tdoa.cpp` 移植，D-053 §7.1）。
//
// 各副站对参考站形成距离差约束 Δr_i = ‖x−p_i‖ − ‖x−p_0‖ = c·(t_i − t_0)，双曲线族交于辐射源。
// Gauss-Newton 迭代（≤ 6 步，步长 < 0.05 m 早停），雅可比行是视线单位向量差 H_i = û_i − û_0；
// 加权协方差 P = (HᵀR⁻¹H)⁻¹ → 误差椭圆 / CEP；不加权 (HᵀH)⁻¹ → 经典无量纲 GDOP。
//
// **接口是平面坐标（米）**，与 locate_aoa.h 同法：数学与投影解耦（D-009）。
//
// **两种加权，缺省与 emcore 不同**（D-053 §3.4，有意的偏离）：
//   independent_pairs   —— emcore 现行：把各站对当独立，w_i = 1/(c²(σ_i² + σ_0²))。
//                          参考站的噪声进了**每一个**站对，按独立处理会低估协方差、椭圆偏小。
//   correlated_reference —— 本项目缺省：显式构造 R = c²(diag σ_i² + σ_0²·11ᵀ)，用 HᵀR⁻¹H。
// 两种都实现、都进模型卡，验收时并列给出迹比，**不许调参使二者一致**（铁律 10）。

#ifndef CUAV_GEO_LOCATE_TDOA_H
#define CUAV_GEO_LOCATE_TDOA_H

#include <cstddef>
#include <string>
#include <vector>

#include "cuav_geo/fix_geometry.h"

namespace cuav {
namespace geo {

// 精确光速。新写代码统一用它（D-009），与 emcore 的 kTdoaSpeedOfLight_mps 同值：
// 1 ns 时差 ≈ 0.3 m 距离差，光速精度直接进误差预算。
extern const double kSpeedOfLightExact;

struct ToaPlaneObs {
    double x_m, y_m;
    double toa_s;          // 含噪的到达时刻
    double sigma_pick_s;   // 拾取 1σ（不含同步）
    double sigma_sync_s;   // 站钟同步 1σ
    ToaPlaneObs() : x_m(0.0), y_m(0.0), toa_s(0.0), sigma_pick_s(0.0), sigma_sync_s(0.0) {}
};

enum class TdoaWeighting { CorrelatedReference = 0, IndependentPairs };

// 时统质量 TQ-1..TQ-4（EM-S-07 §10.3）：由平均钟差与约化 χ² 分级。
enum class TimeQuality { TQ1 = 0, TQ2, TQ3, TQ4 };
const char* to_string(TimeQuality q);
TimeQuality tdoa_time_grade(double avg_sync_ns, double reduced_chi2, bool infeasible);

struct TdoaPlaneSolution {
    bool ok;
    double x_m, y_m;
    double cov[3];                   // [Pxx, Pxy, Pyy]，m²
    EllipseStats stats;
    double gdop;                     // 无量纲 √trace((HᵀH)⁻¹)；几何奇异时为 +inf
    GeometryQuality geometry_quality;
    TimeQuality time_quality;
    double avg_sync_ns;
    double reduced_chi2;
    std::size_t ref_index;           // 参考站在输入序列中的下标
    int feasibility_violations;      // |Δr| > 基线 + 余量 的站对数；降级不剔除
    std::vector<double> residuals_m; // 各副站的距离差残差（输入站序，剔除参考站）
    TdoaPlaneSolution()
        : ok(false), x_m(0.0), y_m(0.0), gdop(0.0),
          geometry_quality(GeometryQuality::Degenerate), time_quality(TimeQuality::TQ4),
          avg_sync_ns(0.0), reduced_chi2(0.0), ref_index(0), feasibility_violations(0) {
        cov[0] = cov[1] = cov[2] = 0.0;
    }
};

// 少于 3 站或协方差奇异 → ok = false。
// ref_index 由调用方给（最高信噪比那一站，EM-S-07 §10.5）；init 可给同帧的 AOA 解作初值。
TdoaPlaneSolution tdoa_solve_plane(const std::vector<ToaPlaneObs>& obs, std::size_t ref_index,
                                   TdoaWeighting weighting,
                                   const double* init_x = 0, const double* init_y = 0,
                                   double feasibility_margin_m = 50.0,
                                   double c_mps = kSpeedOfLightExact);

// TDOA 的几何分级按 GDOP（比 AOA 的张角分级更严：参考站差分天然放大稀释）。
GeometryQuality tdoa_geometry_grade(double gdop, bool singular, bool infeasible);

namespace legacy {

// emcore 的到达时间 σ：相关峰拾取（标称带宽 10 MHz）⊕ 时戳底噪 0.3 ns ⊕ 站钟同步。
// **两个常数是写死的**，与配置无关——本项目的 ToaEstimator 改用站的实际采样率作相关带宽，
// 这里保留原式只为守 golden（D-053 §3.3）。
double toa_sigma_s(double snr_dB, double sync_sigma_ns);

}  // namespace legacy

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_LOCATE_TDOA_H
