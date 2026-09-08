#include "cuav_geo/kinematics.h"

#include <cmath>

namespace cuav {
namespace geo {
namespace {
// 段长小于 1 毫米即视为重合航点：不除零、直接跨过去。
// em-demo 用的阈值是 0.1 m（segLen < 0.1 即跳段），这里收紧到 1 mm——本项目的航迹对拍
// 容差是 1e-6 度（约 0.1 m），0.1 m 的阈值本身就在容差量级上。
const double kMinSegment_m = 1e-3;
}  // namespace

Route::Route()
    : loop_(false), cycle_s_(0.0), length_m_(0.0), waypoint_count_(0), final_heading_deg_(0.0) {}

bool Route::build(const std::vector<Waypoint>& wps, bool loop, std::string& err) {
    legs_.clear();
    phases_.clear();
    loop_ = loop;
    cycle_s_ = 0.0;
    length_m_ = 0.0;
    waypoint_count_ = wps.size();
    final_heading_deg_ = 0.0;

    if (wps.empty()) {
        err = "航线没有航点";
        return false;
    }
    for (std::size_t i = 0; i < wps.size(); ++i) {
        if (!(wps[i].speed_mps > 0.0)) {
            err = "航点速度必须为正";
            return false;
        }
        if (wps[i].loiter_s < 0.0) {
            err = "悬停时长不得为负";
            return false;
        }
    }

    single_ = wps[0].position;
    if (wps.size() == 1) return true;

    const IGeodesy& g = default_geodesy();
    const std::size_t leg_count = loop ? wps.size() : (wps.size() - 1);
    double t = 0.0;
    for (std::size_t i = 0; i < leg_count; ++i) {
        const Waypoint& a = wps[i];
        const Waypoint& b = wps[(i + 1) % wps.size()];
        Leg leg;
        leg.from = a.position;
        leg.to = b.position;
        leg.from_ecef = g.to_ecef(a.position);
        leg.to_ecef = g.to_ecef(b.position);
        leg.length_m = chord_distance_m(leg.from_ecef, leg.to_ecef);
        leg.speed_mps = a.speed_mps;

        if (leg.length_m < kMinSegment_m) {
            // 重合航点：不产生行进片，但到达后的悬停仍然算数。
            leg.travel_s = 0.0;
            leg.heading_deg = legs_.empty() ? 0.0 : legs_.back().heading_deg;
            leg.velocity = Ecef();
        } else {
            leg.travel_s = leg.length_m / leg.speed_mps;
            leg.heading_deg = bearing_deg(leg.from, leg.to);
            leg.velocity = scale(sub(leg.to_ecef, leg.from_ecef), 1.0 / leg.travel_s);
        }
        length_m_ += leg.length_m;
        legs_.push_back(leg);

        if (leg.travel_s > 0.0) {
            Phase p;
            p.t0 = t;
            p.t1 = t + leg.travel_s;
            p.leg = legs_.size() - 1;
            p.moving = true;
            phases_.push_back(p);
            t = p.t1;
        }
        // 到达该段终点航点后的悬停（§5 第 3 条）。
        const double loiter = b.loiter_s;
        if (loiter > 0.0) {
            Phase p;
            p.t0 = t;
            p.t1 = t + loiter;
            p.leg = legs_.size() - 1;
            p.moving = false;
            phases_.push_back(p);
            t = p.t1;
        }
    }
    cycle_s_ = t;
    if (!legs_.empty()) final_heading_deg_ = legs_.back().heading_deg;
    return true;
}

MotionState Route::still_at(const Lla& p, double heading_deg, double t_s) const {
    MotionState s;
    s.t_s = t_s;
    s.position = p;
    s.heading_deg = heading_deg;
    s.speed_mps = 0.0;
    s.velocity = Ecef();
    s.moving = false;
    return s;
}

MotionState Route::state_at(double t_s) const {
    const double t_in = t_s;
    if (phases_.empty() || cycle_s_ <= 0.0) {
        // 单航点、全部航点重合、或全程时长为零：静止。
        return still_at(single_, final_heading_deg_, t_in);
    }

    double t = (t_s < 0.0) ? 0.0 : t_s;
    if (loop_) {
        // 只做一次 fmod，保证逐位可复现。
        t = std::fmod(t, cycle_s_);
        if (t < 0.0) t += cycle_s_;
    } else if (t >= cycle_s_) {
        const Leg& last = legs_.back();
        return still_at(last.to, last.heading_deg, t_in);
    }

    // 二分定位到时间片。phases_ 按 t0 严格递增。
    std::size_t lo = 0, hi = phases_.size();
    while (lo + 1 < hi) {
        const std::size_t mid = lo + (hi - lo) / 2;
        if (phases_[mid].t0 <= t) lo = mid; else hi = mid;
    }
    const Phase& ph = phases_[lo];
    const Leg& leg = legs_[ph.leg];

    if (!ph.moving) return still_at(leg.to, leg.heading_deg, t_in);

    // 行进片：经纬高各自线性（§5 第 1 条，已冻结；浏览器预览照此复算）。
    double u = (t - ph.t0) / leg.travel_s;
    if (u < 0.0) u = 0.0;
    if (u > 1.0) u = 1.0;

    MotionState s;
    s.t_s = t_in;
    s.position.lon_deg = leg.from.lon_deg + (leg.to.lon_deg - leg.from.lon_deg) * u;
    s.position.lat_deg = leg.from.lat_deg + (leg.to.lat_deg - leg.from.lat_deg) * u;
    s.position.alt_m = leg.from.alt_m + (leg.to.alt_m - leg.from.alt_m) * u;
    s.heading_deg = leg.heading_deg;
    s.speed_mps = leg.speed_mps;
    s.velocity = leg.velocity;
    s.moving = true;
    return s;
}

}  // namespace geo
}  // namespace cuav
