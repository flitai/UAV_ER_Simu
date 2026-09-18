// 自 emcore `src/core/geo.cpp` 移植（D-053 §7.1）。公式与常数逐字保留，
// 只把接口从经纬度改成平面坐标，并把 111320 投影挪进 legacy 命名空间。

#include "cuav_geo/fix_geometry.h"

#include <cmath>

namespace cuav {
namespace geo {

namespace {
const double kPi = 3.14159265358979323846;
double rad2deg(double r) { return r * 180.0 / kPi; }
}  // namespace

double ellipse_confidence_2sigma() {
    // 1 − exp(−k²/2)，k = 2：二维瑞利分布落在 2σ 椭圆内的概率
    return 1.0 - std::exp(-2.0);
}

EllipseStats covariance_to_ellipse(double p00, double p01, double p11, int n_obs) {
    EllipseStats s;
    const double trace = std::fmax(p00 + p11, 0.0);
    s.rms_trace_m = std::sqrt(trace / std::fmax(static_cast<double>(n_obs), 1.0));

    const double avg = (p00 + p11) / 2.0;
    const double diff = (p00 - p11) / 2.0;
    const double disc = std::sqrt(diff * diff + p01 * p01);
    const double lambda1 = std::fmax(avg + disc, 0.0);
    const double lambda2 = std::fmax(avg - disc, 0.0);
    s.cep_m = 0.5887 * (std::sqrt(lambda1) + std::sqrt(lambda2));
    s.ellipse.semi_major_m = 2.0 * std::sqrt(lambda1);
    s.ellipse.semi_minor_m = 2.0 * std::sqrt(lambda2);
    s.ellipse.rotation_deg = rad2deg(std::atan2(2.0 * p01, p00 - p11) / 2.0);
    return s;
}

bool inv_sym2x2(double a, double b, double c, Sym2x2Inv& out) {
    const double det = a * c - b * b;
    if (std::fabs(det) < 1e-12) return false;
    out.i00 = c / det;
    out.i01 = -b / det;
    out.i11 = a / det;
    out.det = det;
    return true;
}

const char* to_string(GeometryQuality q) {
    switch (q) {
        case GeometryQuality::Good: return "good";
        case GeometryQuality::Fair: return "fair";
        case GeometryQuality::Poor: return "poor";
        case GeometryQuality::Degenerate: return "degenerate";
    }
    return "degenerate";
}

}  // namespace geo
}  // namespace cuav
