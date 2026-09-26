#include "cuav_geo/coverage.h"

#include <cmath>

namespace cuav {
namespace geo {

CoverageCell coverage_cell(const Lla& site, const Lla& target, double terrain_height_m,
                           const OcclusionQuery* occ, const CoverageLink& link) {
    CoverageCell c;
    // 衍射频率只认 link.frequency_Hz：调用方传进来的 occ 里那个频率不用——同一格的两个数
    // （自由空间与刀口衍射）必须按同一个频率算，让它们各取各的就会在调用方漏填时悄悄不一致
    // （第一版就是这样：生成基准时没填 occ->frequency_Hz，85 例一例都没过楼）。
    OcclusionQuery q;
    if (occ != 0) {
        q = *occ;
        q.frequency_Hz = link.frequency_Hz;
    }
    // 覆盖图只要位置，不要多普勒：速度给零矢量，径向速率不参与下面任何一项
    const LinkGeometry g = link_geometry(site, target, Ecef(), terrain_height_m, occ != 0 ? &q : 0);
    c.distance_m = g.distance_m;
    c.diffraction_dB = g.diffraction_dB;
    c.blocked = !g.line_of_sight;
    if (!(g.distance_m > 0.0) || !(link.frequency_Hz > 0.0) || !(link.noise_bw_Hz > 0.0)) return c;
    c.fspl_dB = fspl_dB(g.distance_m, link.frequency_Hz);
    c.signal_dBm = link.tx_power_dBm + link.tx_gain_dBi + link.rx_gain_dBi - c.fspl_dB - c.diffraction_dB;
    c.noise_dBm = thermal_noise_dBm_per_Hz(link.nf_dB) + 10.0 * std::log10(link.noise_bw_Hz);
    c.snr_dB = c.signal_dBm - c.noise_dBm;
    c.valid = true;
    return c;
}

}  // namespace geo
}  // namespace cuav
