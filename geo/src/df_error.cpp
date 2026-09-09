#include "cuav_geo/df_error.h"

#include <cmath>
#include <cstdio>

namespace cuav {
namespace geo {

double df_sigma_snr_deg(double sigma_ref_deg, double snr_ref_dB, double snr_dB) {
    const double ref_lin = std::pow(10.0, snr_ref_dB / 10.0);
    double lin = std::pow(10.0, snr_dB / 10.0);
    if (!(lin > 1.0)) lin = 1.0;          // 也挡住 NaN：NaN 比较为假，走这一支
    return sigma_ref_deg * std::sqrt(ref_lin / lin);
}

DfSigmaParts df_sigma_total(const DfErrorBudget& b, double snr_dB, bool line_of_sight, bool mixture) {
    DfSigmaParts p;
    p.method_deg = b.sigma_method_deg;
    p.snr_deg = df_sigma_snr_deg(b.sigma_snr_ref_deg, b.snr_ref_dB, snr_dB);
    p.cal_deg = b.sigma_cal_deg;
    p.att_deg = b.sigma_att_deg;
    p.multipath_deg = line_of_sight ? b.sigma_mp_los_deg : b.sigma_mp_nlos_deg;
    p.mixture_deg = mixture ? b.sigma_mix_deg : 0.0;
    const double sum = p.method_deg * p.method_deg + p.snr_deg * p.snr_deg
                     + p.cal_deg * p.cal_deg + p.att_deg * p.att_deg
                     + p.multipath_deg * p.multipath_deg + p.mixture_deg * p.mixture_deg;
    p.total_deg = std::sqrt(sum);
    return p;
}

std::string df_quality_grade(double sigma_deg, const std::vector<double>& thresholds) {
    if (thresholds.empty()) return "invalid";
    for (std::size_t i = 0; i < thresholds.size(); ++i) {
        if (i > 0 && thresholds[i] < thresholds[i - 1]) return "invalid";   // 门限必须非降
        if (sigma_deg < thresholds[i]) {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "DF-Q%d", static_cast<int>(i) + 1);
            return std::string(buf);
        }
    }
    return "invalid";
}

}  // namespace geo
}  // namespace cuav
