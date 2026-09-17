// 自 emcore `src/models/occlusion.cpp` 移植（D-005 / D-074，D3-3）。算法与常数一字未改。

#include "cuav_geo/occlusion.h"

#include <algorithm>

#include "cuav_geo/propagation.h"

namespace cuav {
namespace geo {

OcclusionResult segment_occlusion(const IMapQuery& map, const MapPoint& tx, const MapPoint& rx,
                                  double frequency_Hz) {
    OcclusionResult zero;

    RaycastHit hit;
    if (!map.raycast(tx, rx, hit) || hit.intrusion_m <= 0.0) return zero;

    // d1 / d2 下限 1 米：端点贴着障碍时 Fresnel 参数发散的工程钳位（同祖本）
    const double d1 = std::max(hit.distance_m, 1.0);
    const double d2 = std::max(hit.exit_distance_m, 1.0);
    const double v = legacy::fresnel_v(hit.intrusion_m, d1, d2, frequency_Hz);

    OcclusionResult out;
    out.obstruction_loss_dB = legacy::knife_edge_loss_dB(v);
    out.intrusion_m = hit.intrusion_m;
    out.blocked = true;
    return out;
}

}  // namespace geo
}  // namespace cuav
