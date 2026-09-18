// 黄金基准回放专用的两套旧投影。常数一个字不许改，理由见 cuav_geo/legacy_frames.h。

#include "cuav_geo/legacy_frames.h"

#include <cmath>

namespace cuav {
namespace geo {
namespace legacy {
namespace {
const double kPi = 3.14159265358979323846;
inline double deg2rad(double d) { return d * (kPi / 180.0); }
}  // namespace

LocalFrame local_frame_locate(double ref_lat_deg) {
    LocalFrame f;
    f.m_per_deg_lat = 111320.0;
    f.m_per_deg_lon = 111320.0 * std::cos(deg2rad(ref_lat_deg));
    return f;
}

LocalFrame local_frame_occlusion(double ref_lat_deg) {
    LocalFrame f;
    f.m_per_deg_lat = 110540.0;   // 与 local_frame_locate 的 111320 不同，是有意的
    f.m_per_deg_lon = 111320.0 * std::cos(deg2rad(ref_lat_deg));
    return f;
}

}  // namespace legacy
}  // namespace geo
}  // namespace cuav
