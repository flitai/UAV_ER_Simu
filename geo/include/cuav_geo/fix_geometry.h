// 定位几何的公共工具（EM-S-06 / EM-S-07 共用；自 emcore `src/core/geo.cpp` 移植，D-053 §7.1）。
//
// 来源：`C-UAV Model Demo/emcore/{include/emcore/core/geo.h, src/core/geo.cpp}`，
// 黄金基准 `emcore/tests/golden/geo_fix.json` 一并拷入本项目 `tests/golden/`（铁律 13）。
//
// **移植时做了一处有意的接口改动**：emcore 的求解器吃经纬度、内部用 111320·cos(φ) 的等距圆柱
// 投影。本项目的口径是严格 ENU（D-009：移植模块保留原常数守 golden，新写代码统一严格 ENU，
// 禁止顺手统一）。做法是把**数学部分与投影解耦**：这里只做平面上的协方差与椭圆，
// golden 回放走 `legacy::local_frame_111320()` 投影，引擎侧走 `default_geodesy().to_enu()`，
// 一份数学两处用。`legacy::` 里的常数一个字都不许改，否则 golden 就废了。

#ifndef CUAV_GEO_FIX_GEOMETRY_H
#define CUAV_GEO_FIX_GEOMETRY_H

namespace cuav {
namespace geo {

// 水平位置不确定度的 2σ 椭圆。
// **二维 2σ 的包含概率是 1 − exp(−2) = 86.47%，不是一维的 95.4%**——
// em-demo 的注释写「2σ (~95%)」是把一维置信搬到了二维，这里显式记住这个数以免下游再算错。
struct ErrorEllipse {
    double semi_major_m;
    double semi_minor_m;
    double rotation_deg;      // 相对平面 x 轴（引擎侧即 ENU 东向）
    ErrorEllipse() : semi_major_m(0.0), semi_minor_m(0.0), rotation_deg(0.0) {}
};

// 2σ 椭圆在二维下的包含概率。
double ellipse_confidence_2sigma();

struct EllipseStats {
    // 50% 圆概率误差 ≈ 0.5887·(σ_max + σ_min)（RAND 近似）。圆形场合退化为 1.1774σ，
    // 即精确的 Rayleigh 中位数。**曾经写成 √trace 是错的**，emcore 靠蒙特卡洛散布校验才发现
    // （EM-C-UAV 09 号方案 W4）——解析锚点与统计校验缺一不可。
    double cep_m;
    double rms_trace_m;       // √(trace(P)/n)，米制几何均方根
    ErrorEllipse ellipse;
    EllipseStats() : cep_m(0.0), rms_trace_m(0.0) {}
};

// 2×2 位置协方差 P（m²）→ 2σ 椭圆 + CEP。
//   λ = avg ± √(((P00−P11)/2)² + P01²)，a = 2√λ_max，b = 2√λ_min
EllipseStats covariance_to_ellipse(double p00, double p01, double p11, int n_obs);

// 对称 2×2 [[a,b],[b,c]] 求逆；近奇异（|det| < 1e-12）返回 false。
struct Sym2x2Inv {
    double i00, i01, i11, det;
    Sym2x2Inv() : i00(0.0), i01(0.0), i11(0.0), det(0.0) {}
};
bool inv_sym2x2(double a, double b, double c, Sym2x2Inv& out);

// 定位几何质量（AOA 按测向线最大张角，TDOA 按无量纲 GDOP）。
enum class GeometryQuality { Good = 0, Fair, Poor, Degenerate };
const char* to_string(GeometryQuality q);

// ---------------------------------------------------------------------------
// 只供黄金基准回放的旧口径。**新代码一律不许用**（D-009），
// `scripts/build-all.sh` 有一条 grep 守着：`legacy::` 只允许出现在 golden 与 legacy 文件里。
namespace legacy {

// emcore 的局部等距圆柱投影尺度（m/度），锚定参考纬度。常数 111320 原样保留。
struct LocalFrame {
    double m_per_deg_lat;
    double m_per_deg_lon;
    LocalFrame() : m_per_deg_lat(0.0), m_per_deg_lon(0.0) {}
};
LocalFrame local_frame_111320(double ref_lat_deg);

}  // namespace legacy

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_FIX_GEOMETRY_H
