// 自 emcore `src/models/locate_aoa.cpp` 移植（D-053 §7.1）。两遍加权最小二乘、
// R ≥ 100 m 与 σ ≥ 0.1° 的钳位、几何质量按最大张角分级，全部逐字保留；
// 只把接口从经纬度改成平面坐标，经纬度那一层挪进 legacy 供 golden 回放。

#include "cuav_geo/locate_aoa.h"

#include <cmath>
#include <cstddef>

namespace cuav {
namespace geo {

namespace {

const double kPi = 3.14159265358979323846;
double deg2rad(double d) { return d * kPi / 180.0; }
double rad2deg(double r) { return r * 180.0 / kPi; }

struct StationXY {
    double x, y, theta, sigma;    // theta / sigma 单位：弧度
    StationXY() : x(0.0), y(0.0), theta(0.0), sigma(0.0) {}
};

struct WlsResult {
    double x, y;
    double cov[3];
    EllipseStats stats;
    WlsResult() : x(0.0), y(0.0) { cov[0] = cov[1] = cov[2] = 0.0; }
};

// distances == 0 → 等权（R = 1）
bool solve_wls(const std::vector<StationXY>& st, const std::vector<double>* distances,
               WlsResult& out) {
    double a00 = 0.0, a01 = 0.0, a10 = 0.0, a11 = 0.0, b0 = 0.0, b1 = 0.0;
    for (std::size_t i = 0; i < st.size(); ++i) {
        const StationXY& s = st[i];
        const double sinT = std::sin(s.theta);
        const double cosT = std::cos(s.theta);
        const double r = distances ? (*distances)[i] : 1.0;
        const double w = 1.0 / (r * r * s.sigma * s.sigma);
        const double a0 = cosT;
        const double a1 = -sinT;
        const double bi = a0 * s.x + a1 * s.y;
        a00 += w * a0 * a0;
        a01 += w * a0 * a1;
        a10 += w * a1 * a0;
        a11 += w * a1 * a1;
        b0 += w * a0 * bi;
        b1 += w * a1 * bi;
    }
    const double det = a00 * a11 - a01 * a10;
    if (std::fabs(det) < 1e-12) return false;
    out.x = (a11 * b0 - a01 * b1) / det;
    out.y = (-a10 * b0 + a00 * b1) / det;
    out.cov[0] = a11 / det;
    out.cov[1] = -a01 / det;
    out.cov[2] = a00 / det;
    out.stats = covariance_to_ellipse(out.cov[0], out.cov[1], out.cov[2],
                                      static_cast<int>(st.size()));
    return true;
}

double wrap180(double d) {
    while (d > 180.0) d -= 360.0;
    while (d < -180.0) d += 360.0;
    return d;
}

}  // namespace

GeometryQuality aoa_geometry_grade(double max_spread_deg,
                                   double good_deg, double fair_deg, double poor_deg) {
    if (max_spread_deg > good_deg) return GeometryQuality::Good;
    if (max_spread_deg > fair_deg) return GeometryQuality::Fair;
    if (max_spread_deg > poor_deg) return GeometryQuality::Poor;
    return GeometryQuality::Degenerate;
}

AoaPlaneSolution aoa_solve_plane(const std::vector<AoaPlaneObs>& obs) {
    AoaPlaneSolution out;
    if (obs.size() < 2) return out;

    std::vector<StationXY> xy;
    xy.reserve(obs.size());
    for (std::size_t i = 0; i < obs.size(); ++i) {
        StationXY p;
        p.x = obs[i].x_m;
        p.y = obs[i].y_m;
        p.theta = deg2rad(obs[i].bearing_deg);
        // σ 的 0.1° 下限：某一站被判得极准时权重会发散，解被它一家绑架
        p.sigma = deg2rad(std::fmax(obs[i].sigma_deg, 0.1));
        xy.push_back(p);
    }

    WlsResult init;
    if (!solve_wls(xy, 0, init)) return out;      // 第一遍：等权取初值

    std::vector<double> dist;
    dist.reserve(xy.size());
    for (std::size_t i = 0; i < xy.size(); ++i) {
        const double dx = init.x - xy[i].x;
        const double dy = init.y - xy[i].y;
        // R 的 100 m 下限：站与解算点几乎重合时同样会让权重发散
        dist.push_back(std::fmax(std::sqrt(dx * dx + dy * dy), 100.0));
    }
    WlsResult r;
    if (!solve_wls(xy, &dist, r)) return out;     // 第二遍：按站距加权

    out.ok = true;
    out.x_m = r.x;
    out.y_m = r.y;
    out.cov[0] = r.cov[0];
    out.cov[1] = r.cov[1];
    out.cov[2] = r.cov[2];
    out.stats = r.stats;

    double spread = 0.0;
    double min_cross = 90.0;
    for (std::size_t i = 0; i < obs.size(); ++i) {
        for (std::size_t j = i + 1; j < obs.size(); ++j) {
            double d = std::fabs(obs[i].bearing_deg - obs[j].bearing_deg);
            if (d > 180.0) d = 360.0 - d;
            spread = std::fmax(spread, d);
            // 交会角看的是两条**直线**的夹角：180° 与 0° 一样是共线，都折到 0
            const double cross = d > 90.0 ? 180.0 - d : d;
            min_cross = std::fmin(min_cross, cross);
        }
    }
    out.max_spread_deg = spread;
    out.min_crossing_deg = obs.size() >= 2 ? min_cross : 0.0;
    out.quality = aoa_geometry_grade(spread);

    out.residuals_deg.reserve(obs.size());
    for (std::size_t i = 0; i < obs.size(); ++i) {
        // 解算点相对该站的方位：平面上直接 atan2(Δx, Δy)（x 东、y 北，自北顺时针）
        const double az = std::fmod(rad2deg(std::atan2(r.x - obs[i].x_m, r.y - obs[i].y_m)) + 360.0, 360.0);
        out.residuals_deg.push_back(wrap180(obs[i].bearing_deg - az));
    }
    return out;
}

namespace legacy {

AoaLonLatSolution aoa_localization_lonlat(const std::vector<AoaLonLatObs>& obs) {
    AoaLonLatSolution out;
    if (obs.size() < 2) return out;
    const double ref_lat = obs[0].lat;
    const double ref_lon = obs[0].lon;
    const LocalFrame f = local_frame_111320(ref_lat);

    std::vector<AoaPlaneObs> plane;
    plane.reserve(obs.size());
    for (std::size_t i = 0; i < obs.size(); ++i) {
        AoaPlaneObs p;
        p.x_m = (obs[i].lon - ref_lon) * f.m_per_deg_lon;
        p.y_m = (obs[i].lat - ref_lat) * f.m_per_deg_lat;
        p.bearing_deg = obs[i].bearing_deg;
        p.sigma_deg = obs[i].bearing_error_deg;
        plane.push_back(p);
    }
    const AoaPlaneSolution s = aoa_solve_plane(plane);
    if (!s.ok) return out;
    out.ok = true;
    out.lon = ref_lon + s.x_m / f.m_per_deg_lon;
    out.lat = ref_lat + s.y_m / f.m_per_deg_lat;
    out.cep_m = s.stats.cep_m;
    out.gdop = s.stats.rms_trace_m;
    out.ellipse = s.stats.ellipse;
    return out;
}

std::vector<double> aoa_residuals_lonlat(const std::vector<AoaLonLatObs>& obs,
                                         double sol_lon, double sol_lat) {
    std::vector<double> out;
    out.reserve(obs.size());
    for (std::size_t i = 0; i < obs.size(); ++i) {
        const double expected = rad2deg(std::atan2((sol_lon - obs[i].lon) * std::cos(deg2rad(obs[i].lat)),
                                                   sol_lat - obs[i].lat));
        out.push_back(wrap180(obs[i].bearing_deg - std::fmod(expected + 360.0, 360.0)));
    }
    return out;
}

}  // namespace legacy

}  // namespace geo
}  // namespace cuav
