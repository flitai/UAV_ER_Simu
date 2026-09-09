// 自 emcore `src/models/locate_tdoa.cpp` 移植（D-053 §7.1）。Gauss-Newton ≤ 6 步、
// 步长 < 0.05 m 早停、可行性门降级不裁、GDOP 与时统分级的门限，全部逐字保留；
// 接口改成平面坐标，并新增 correlated_reference 加权（emcore 只有独立站对那一种）。

#include "cuav_geo/locate_tdoa.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace cuav {
namespace geo {

const double kSpeedOfLightExact = 299792458.0;

namespace {

const double kPi = 3.14159265358979323846;

// emcore 的两个写死常数，只在 legacy 里用
const double kNominalBandwidthHz = 10e6;
const double kSigmaFloorS = 0.3e-9;

/** 对称正定矩阵求逆（高斯-约当，带部分主元）。n ≤ 8，直接写开，不引第三方。 */
bool invert_sym(std::vector<double>& a, std::size_t n) {
    std::vector<double> inv(n * n, 0.0);
    for (std::size_t i = 0; i < n; ++i) inv[i * n + i] = 1.0;
    for (std::size_t col = 0; col < n; ++col) {
        std::size_t piv = col;
        for (std::size_t r = col + 1; r < n; ++r) {
            if (std::fabs(a[r * n + col]) > std::fabs(a[piv * n + col])) piv = r;
        }
        if (std::fabs(a[piv * n + col]) < 1e-30) return false;
        if (piv != col) {
            for (std::size_t k = 0; k < n; ++k) {
                std::swap(a[col * n + k], a[piv * n + k]);
                std::swap(inv[col * n + k], inv[piv * n + k]);
            }
        }
        const double d = a[col * n + col];
        for (std::size_t k = 0; k < n; ++k) { a[col * n + k] /= d; inv[col * n + k] /= d; }
        for (std::size_t r = 0; r < n; ++r) {
            if (r == col) continue;
            const double f = a[r * n + col];
            if (f == 0.0) continue;
            for (std::size_t k = 0; k < n; ++k) {
                a[r * n + k] -= f * a[col * n + k];
                inv[r * n + k] -= f * inv[col * n + k];
            }
        }
    }
    a.swap(inv);
    return true;
}

}  // namespace

const char* to_string(TimeQuality q) {
    switch (q) {
        case TimeQuality::TQ1: return "TQ-1";
        case TimeQuality::TQ2: return "TQ-2";
        case TimeQuality::TQ3: return "TQ-3";
        case TimeQuality::TQ4: return "TQ-4";
    }
    return "TQ-4";
}

TimeQuality tdoa_time_grade(double avg_sync_ns, double reduced_chi2, bool infeasible) {
    if (infeasible || avg_sync_ns > 100.0 || reduced_chi2 > 9.0) return TimeQuality::TQ4;
    if (avg_sync_ns > 30.0 || reduced_chi2 > 4.0) return TimeQuality::TQ3;
    if (avg_sync_ns > 5.0 || reduced_chi2 > 2.0) return TimeQuality::TQ2;
    return TimeQuality::TQ1;
}

GeometryQuality tdoa_geometry_grade(double gdop, bool singular, bool infeasible) {
    // 时差定位的稀释天然高于直接测距（参考站差分；三站时只有两条约束），分档比 AOA 严
    if (singular || !(gdop == gdop) || !(gdop < std::numeric_limits<double>::infinity())) {
        return GeometryQuality::Degenerate;
    }
    if (infeasible) return GeometryQuality::Poor;
    if (gdop < 3.0) return GeometryQuality::Good;
    if (gdop < 6.0) return GeometryQuality::Fair;
    if (gdop < 15.0) return GeometryQuality::Poor;
    return GeometryQuality::Degenerate;
}

TdoaPlaneSolution tdoa_solve_plane(const std::vector<ToaPlaneObs>& obs, std::size_t ref_index,
                                   TdoaWeighting weighting, const double* init_x, const double* init_y,
                                   double feasibility_margin_m, double c_mps) {
    TdoaPlaneSolution out;
    if (obs.size() < 3 || ref_index >= obs.size()) return out;   // 2D TDOA 至少三站（EM-S-07 §10.2）
    out.ref_index = ref_index;

    const ToaPlaneObs& ref = obs[ref_index];
    const std::size_t m = obs.size() - 1;      // 站对数

    struct Pair { double x, y, dr_obs, baseline; std::size_t idx; };
    std::vector<Pair> pairs;
    pairs.reserve(m);
    for (std::size_t i = 0; i < obs.size(); ++i) {
        if (i == ref_index) continue;
        Pair p;
        p.x = obs[i].x_m;
        p.y = obs[i].y_m;
        p.dr_obs = c_mps * (obs[i].toa_s - ref.toa_s);
        p.baseline = std::sqrt((p.x - ref.x_m) * (p.x - ref.x_m) + (p.y - ref.y_m) * (p.y - ref.y_m));
        p.idx = i;
        pairs.push_back(p);
    }

    // 物理可行性门（§10.4）：|Δr| ≤ 基线 + ε。粗大违例 = 符号或关联错误——**降级不静默截断**
    for (std::size_t k = 0; k < pairs.size(); ++k) {
        if (std::fabs(pairs[k].dr_obs) > pairs[k].baseline + feasibility_margin_m) {
            ++out.feasibility_violations;
        }
    }

    // 量测协方差 R（距离域 m²）。两种口径的差别全在这里。
    std::vector<double> R(m * m, 0.0);
    const double c2 = c_mps * c_mps;
    const double var0 = ref.sigma_pick_s * ref.sigma_pick_s + ref.sigma_sync_s * ref.sigma_sync_s;
    for (std::size_t i = 0; i < m; ++i) {
        const ToaPlaneObs& oi = obs[pairs[i].idx];
        const double vi = oi.sigma_pick_s * oi.sigma_pick_s + oi.sigma_sync_s * oi.sigma_sync_s;
        R[i * m + i] = c2 * (vi + var0);
        if (weighting == TdoaWeighting::CorrelatedReference) {
            // 参考站的噪声进了每一个站对，站对之间因此相关：off-diagonal = c²σ_0²
            for (std::size_t j = 0; j < m; ++j) {
                if (i != j) R[i * m + j] = c2 * var0;
            }
        }
    }
    std::vector<double> Rinv = R;
    if (!invert_sym(Rinv, m)) return out;

    // 初值：同帧的 AOA 解（若有），否则站质心 + 1 m 北向扰动（保证首迭代视线良定）
    double x = 0.0, y = 0.0;
    if (init_x && init_y) {
        x = *init_x;
        y = *init_y;
    } else {
        for (std::size_t i = 0; i < obs.size(); ++i) { x += obs[i].x_m; y += obs[i].y_m; }
        x /= static_cast<double>(obs.size());
        y /= static_cast<double>(obs.size());
        y += 1.0;
    }

    // Gauss-Newton：(HᵀR⁻¹H)Δx = HᵀR⁻¹e，e_i = Δr_obs_i − (‖x−p_i‖ − ‖x−p_0‖)
    double n00 = 0.0, n01 = 0.0, n11 = 0.0;
    std::vector<double> H(m * 2, 0.0), e(m, 0.0);
    for (int iter = 0; iter < 6; ++iter) {
        double r0 = std::sqrt((x - ref.x_m) * (x - ref.x_m) + (y - ref.y_m) * (y - ref.y_m));
        if (r0 == 0.0) r0 = 1e-6;
        const double u0x = (x - ref.x_m) / r0;
        const double u0y = (y - ref.y_m) / r0;
        for (std::size_t i = 0; i < m; ++i) {
            double ri = std::sqrt((x - pairs[i].x) * (x - pairs[i].x) + (y - pairs[i].y) * (y - pairs[i].y));
            if (ri == 0.0) ri = 1e-6;
            H[i * 2 + 0] = (x - pairs[i].x) / ri - u0x;
            H[i * 2 + 1] = (y - pairs[i].y) / ri - u0y;
            e[i] = pairs[i].dr_obs - (ri - r0);
        }
        n00 = n01 = n11 = 0.0;
        double g0 = 0.0, g1 = 0.0;
        for (std::size_t i = 0; i < m; ++i) {
            for (std::size_t j = 0; j < m; ++j) {
                const double w = Rinv[i * m + j];
                n00 += H[i * 2 + 0] * w * H[j * 2 + 0];
                n01 += H[i * 2 + 0] * w * H[j * 2 + 1];
                n11 += H[i * 2 + 1] * w * H[j * 2 + 1];
                g0 += H[i * 2 + 0] * w * e[j];
                g1 += H[i * 2 + 1] * w * e[j];
            }
        }
        Sym2x2Inv inv;
        if (!inv_sym2x2(n00, n01, n11, inv)) break;
        const double dx = inv.i00 * g0 + inv.i01 * g1;
        const double dy = inv.i01 * g0 + inv.i11 * g1;
        x += dx;
        y += dy;
        if (std::fabs(dx) < 0.05 && std::fabs(dy) < 0.05) break;
    }

    Sym2x2Inv cov;
    if (!inv_sym2x2(n00, n01, n11, cov)) return out;
    out.cov[0] = cov.i00;
    out.cov[1] = cov.i01;
    out.cov[2] = cov.i11;
    out.stats = covariance_to_ellipse(cov.i00, cov.i01, cov.i11, static_cast<int>(obs.size()));

    // 不加权几何矩阵 → 经典无量纲 GDOP；同时出残差与 χ²
    double g00 = 0.0, g01 = 0.0, g11 = 0.0, chi2 = 0.0;
    double r0f = std::sqrt((x - ref.x_m) * (x - ref.x_m) + (y - ref.y_m) * (y - ref.y_m));
    if (r0f == 0.0) r0f = 1e-6;
    const double u0xf = (x - ref.x_m) / r0f;
    const double u0yf = (y - ref.y_m) / r0f;
    out.residuals_m.reserve(m);
    for (std::size_t i = 0; i < m; ++i) {
        double ri = std::sqrt((x - pairs[i].x) * (x - pairs[i].x) + (y - pairs[i].y) * (y - pairs[i].y));
        if (ri == 0.0) ri = 1e-6;
        const double hx = (x - pairs[i].x) / ri - u0xf;
        const double hy = (y - pairs[i].y) / ri - u0yf;
        g00 += hx * hx;
        g01 += hx * hy;
        g11 += hy * hy;
        H[i * 2 + 0] = hx;
        H[i * 2 + 1] = hy;
        e[i] = pairs[i].dr_obs - (ri - r0f);
        out.residuals_m.push_back(e[i]);
    }
    for (std::size_t i = 0; i < m; ++i) {
        for (std::size_t j = 0; j < m; ++j) chi2 += e[i] * Rinv[i * m + j] * e[j];
    }
    Sym2x2Inv ginv;
    const bool gok = inv_sym2x2(g00, g01, g11, ginv);
    out.gdop = gok ? std::sqrt(std::fmax(ginv.i00 + ginv.i11, 0.0))
                   : std::numeric_limits<double>::infinity();

    double sync = 0.0;
    for (std::size_t i = 0; i < obs.size(); ++i) sync += obs[i].sigma_sync_s;
    out.avg_sync_ns = sync / static_cast<double>(obs.size()) * 1e9;
    const double dof = std::fmax(static_cast<double>(m) - 2.0, 1.0);
    out.reduced_chi2 = chi2 / dof;

    out.geometry_quality = tdoa_geometry_grade(out.gdop, !gok, out.feasibility_violations > 0);
    out.time_quality = tdoa_time_grade(out.avg_sync_ns, out.reduced_chi2, out.feasibility_violations > 0);
    out.ok = true;
    out.x_m = x;
    out.y_m = y;
    return out;
}

namespace legacy {

double toa_sigma_s(double snr_dB, double sync_sigma_ns) {
    const double lin = std::pow(10.0, snr_dB / 10.0);
    const double corr = 1.0 / (2.0 * kPi * kNominalBandwidthHz * std::sqrt(std::fmax(lin, 1.0)));
    const double sync = sync_sigma_ns * 1e-9;
    return std::sqrt(corr * corr + kSigmaFloorS * kSigmaFloorS + sync * sync);
}

}  // namespace legacy

}  // namespace geo
}  // namespace cuav
