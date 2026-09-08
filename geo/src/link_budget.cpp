#include "cuav_geo/link_budget.h"

#include <cmath>

namespace cuav {
namespace geo {
namespace {
const double kPi = 3.14159265358979323846;
}

double fspl_dB(double distance_m, double frequency_Hz) {
    if (!(distance_m > 0.0) || !(frequency_Hz > 0.0)) return 0.0;
    const double lambda = speed_of_light_mps() / frequency_Hz;
    return 20.0 * std::log10(4.0 * kPi * distance_m / lambda);
}

double doppler_Hz(double frequency_Hz, double range_rate_mps) {
    return -frequency_Hz * range_rate_mps / speed_of_light_mps();
}

double delay_s(double distance_m) { return distance_m / speed_of_light_mps(); }

double thermal_noise_dBm_per_Hz(double nf_dB) { return -174.0 + nf_dB; }

LinkGeometry link_geometry(const Lla& site, const Lla& emitter, const Ecef& emitter_velocity) {
    const IGeodesy& g = default_geodesy();
    LinkGeometry out;
    const LookAngles la = look_angles(site, emitter);
    out.distance_m = la.distance_m;
    out.azimuth_deg = la.azimuth_deg;
    out.elevation_deg = la.elevation_deg;
    out.line_of_sight = true;   // 显式平地假设，D3 接入遮挡后在此改

    if (out.distance_m > 0.0) {
        const Ecef los = sub(g.to_ecef(emitter), g.to_ecef(site));
        const double n = norm(los);
        if (n > 0.0) {
            out.range_rate_mps = dot(emitter_velocity, scale(los, 1.0 / n));
        }
    }
    return out;
}

LinkBudget link_budget(const LinkGeometry& g, double frequency_Hz, double rx_nf_dB) {
    LinkBudget b;
    b.line_of_sight = g.line_of_sight;
    b.noise_floor_dBm_per_Hz = thermal_noise_dBm_per_Hz(rx_nf_dB);

    if (!(g.distance_m > 0.0)) {
        b.valid = false;
        b.reason = "站点与辐射源重合，距离为零，路损无定义";
        return b;
    }
    if (!(frequency_Hz > 0.0)) {
        b.valid = false;
        b.reason = "频率必须为正";
        return b;
    }
    b.free_space_dB = fspl_dB(g.distance_m, frequency_Hz);
    b.extra_loss_dB = 0.0;
    b.path_loss_dB = b.free_space_dB + b.extra_loss_dB;
    b.doppler_Hz = doppler_Hz(frequency_Hz, g.range_rate_mps);
    b.delay_s = delay_s(g.distance_m);
    return b;
}

}  // namespace geo
}  // namespace cuav
