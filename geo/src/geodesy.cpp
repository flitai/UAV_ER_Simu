#include "cuav_geo/geodesy.h"

#include <cmath>

// 坐标基座 vendored GeographicLib 2.5.2（D-074 / D3-1）。
// 第三方头只出现在这里，不进 cuav_geo/geodesy.h，调用方对它无感。
#include <GeographicLib/Geocentric.hpp>

namespace cuav {
namespace geo {
namespace {
const double kPi = 3.14159265358979323846;
inline double deg2rad(double d) { return d * (kPi / 180.0); }
inline double rad2deg(double r) { return r * (180.0 / kPi); }
}  // namespace

double speed_of_light_mps() { return 299792458.0; }
double wgs84_a() { return 6378137.0; }
double wgs84_f() { return 1.0 / 298.257223563; }
double wgs84_b() { return wgs84_a() * (1.0 - wgs84_f()); }
double wgs84_e2() { return wgs84_f() * (2.0 - wgs84_f()); }

Ecef sub(const Ecef& a, const Ecef& b) { return Ecef(a.x - b.x, a.y - b.y, a.z - b.z); }
Ecef add(const Ecef& a, const Ecef& b) { return Ecef(a.x + b.x, a.y + b.y, a.z + b.z); }
Ecef scale(const Ecef& a, double k) { return Ecef(a.x * k, a.y * k, a.z * k); }
double dot(const Ecef& a, const Ecef& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
double norm(const Ecef& a) { return std::sqrt(dot(a, a)); }
double norm(const Enu& a) { return std::sqrt(a.e * a.e + a.n * a.n + a.u * a.u); }

Ecef ClosedFormWgs84::to_ecef(const Lla& p) const {
    const double lat = deg2rad(p.lat_deg);
    const double lon = deg2rad(p.lon_deg);
    const double s = std::sin(lat), c = std::cos(lat);
    const double n = wgs84_a() / std::sqrt(1.0 - wgs84_e2() * s * s);
    return Ecef((n + p.alt_m) * c * std::cos(lon),
                (n + p.alt_m) * c * std::sin(lon),
                (n * (1.0 - wgs84_e2()) + p.alt_m) * s);
}

// Bowring 1976 闭式。一次三角函数求值即可，不迭代；对 |h| < 数十公里，纬度误差 ~1e-10 rad。
Lla ClosedFormWgs84::to_lla(const Ecef& p) const {
    const double a = wgs84_a(), b = wgs84_b(), e2 = wgs84_e2();
    const double ep2 = (a * a - b * b) / (b * b);      // 第二偏心率平方
    const double r = std::sqrt(p.x * p.x + p.y * p.y);

    Lla out;
    out.lon_deg = rad2deg(std::atan2(p.y, p.x));

    if (r < 1e-9) {
        // 极点：经度无定义，取 0；纬度取 ±90，高度沿短半轴。不返回 NaN（铁律 15）。
        out.lat_deg = (p.z >= 0.0) ? 90.0 : -90.0;
        out.alt_m = std::fabs(p.z) - b;
        out.lon_deg = 0.0;
        return out;
    }

    const double theta = std::atan2(p.z * a, r * b);
    const double st = std::sin(theta), ct = std::cos(theta);
    const double lat = std::atan2(p.z + ep2 * b * st * st * st,
                                  r - e2 * a * ct * ct * ct);
    const double sl = std::sin(lat), cl = std::cos(lat);
    const double n = a / std::sqrt(1.0 - e2 * sl * sl);

    out.lat_deg = rad2deg(lat);
    // 高纬用 z/sinφ − N(1−e²) 更稳，低纬用 r/cosφ − N。
    out.alt_m = (std::fabs(cl) > 0.5) ? (r / cl - n) : (p.z / sl - n * (1.0 - e2));
    return out;
}

Enu ClosedFormWgs84::to_enu(const Ecef& p, const Lla& origin) const {
    return rotate_to_enu(sub(p, to_ecef(origin)), origin);
}

Ecef ClosedFormWgs84::from_enu(const Enu& v, const Lla& origin) const {
    return add(rotate_to_ecef(v, origin), to_ecef(origin));
}

Enu ClosedFormWgs84::rotate_to_enu(const Ecef& v, const Lla& origin) const {
    const double lat = deg2rad(origin.lat_deg), lon = deg2rad(origin.lon_deg);
    const double sp = std::sin(lat), cp = std::cos(lat);
    const double sl = std::sin(lon), cl = std::cos(lon);
    return Enu(-sl * v.x + cl * v.y,
               -sp * cl * v.x - sp * sl * v.y + cp * v.z,
               cp * cl * v.x + cp * sl * v.y + sp * v.z);
}

Ecef ClosedFormWgs84::rotate_to_ecef(const Enu& v, const Lla& origin) const {
    const double lat = deg2rad(origin.lat_deg), lon = deg2rad(origin.lon_deg);
    const double sp = std::sin(lat), cp = std::cos(lat);
    const double sl = std::sin(lon), cl = std::cos(lon);
    return Ecef(-sl * v.e - sp * cl * v.n + cp * cl * v.u,
                cl * v.e - sp * sl * v.n + cp * sl * v.u,
                cp * v.n + sp * v.u);
}

// ---- GeographicLib 实现（D-074 定的坐标基座）----
//
// 椭球换算交 GeographicLib::Geocentric；站心旋转在下面自己写，理由见头文件。
// WGS84() 返回的是进程内的常量单例，线程安全。

Ecef GeographicLibGeodesy::to_ecef(const Lla& p) const {
    double x = 0.0, y = 0.0, z = 0.0;
    GeographicLib::Geocentric::WGS84().Forward(p.lat_deg, p.lon_deg, p.alt_m, x, y, z);
    return Ecef(x, y, z);
}

Lla GeographicLibGeodesy::to_lla(const Ecef& p) const {
    double lat = 0.0, lon = 0.0, h = 0.0;
    GeographicLib::Geocentric::WGS84().Reverse(p.x, p.y, p.z, lat, lon, h);
    return Lla(lon, lat, h);
}

Enu GeographicLibGeodesy::to_enu(const Ecef& p, const Lla& origin) const {
    return rotate_to_enu(sub(p, to_ecef(origin)), origin);
}

Ecef GeographicLibGeodesy::from_enu(const Enu& v, const Lla& origin) const {
    return add(rotate_to_ecef(v, origin), to_ecef(origin));
}

// 与 ClosedFormWgs84 的同名函数逐字相同：站心旋转只用原点的经纬度，不含椭球参数。
Enu GeographicLibGeodesy::rotate_to_enu(const Ecef& v, const Lla& origin) const {
    const double lat = deg2rad(origin.lat_deg), lon = deg2rad(origin.lon_deg);
    const double sp = std::sin(lat), cp = std::cos(lat);
    const double sl = std::sin(lon), cl = std::cos(lon);
    return Enu(-sl * v.x + cl * v.y,
               -sp * cl * v.x - sp * sl * v.y + cp * v.z,
               cp * cl * v.x + cp * sl * v.y + sp * v.z);
}

Ecef GeographicLibGeodesy::rotate_to_ecef(const Enu& v, const Lla& origin) const {
    const double lat = deg2rad(origin.lat_deg), lon = deg2rad(origin.lon_deg);
    const double sp = std::sin(lat), cp = std::cos(lat);
    const double sl = std::sin(lon), cl = std::cos(lon);
    return Ecef(-sl * v.e - sp * cl * v.n + cp * cl * v.u,
                cl * v.e - sp * sl * v.n + cp * sl * v.u,
                cp * v.n + sp * v.u);
}

// **D3-1 阶段仍然返回自写闭式**。切换基座会改动每一个航迹样点的末几位，
// 是一次真正的基准变更（07 报告 §3.4），按铁律 10 单独成一步（D3-2）。
// 换的时候只改这一处，调用方一行不动——这正是 D-035 当初把接口留出来的用意。
const IGeodesy& default_geodesy() {
    static const ClosedFormWgs84 g;
    return g;
}

// 两家实现都要能被单测直接拿到（对拍用），不经缺省工厂。
const IGeodesy& closed_form_geodesy() {
    static const ClosedFormWgs84 g;
    return g;
}

const IGeodesy& geographiclib_geodesy() {
    static const GeographicLibGeodesy g;
    return g;
}

double chord_distance_m(const Ecef& a, const Ecef& b) { return norm(sub(a, b)); }

double chord_distance_m(const Lla& a, const Lla& b) {
    const IGeodesy& g = default_geodesy();
    return chord_distance_m(g.to_ecef(a), g.to_ecef(b));
}

LookAngles look_angles(const Lla& from, const Lla& to) {
    const IGeodesy& g = default_geodesy();
    const Enu d = g.to_enu(g.to_ecef(to), from);
    LookAngles la;
    la.distance_m = norm(d);
    const double horiz = std::sqrt(d.e * d.e + d.n * d.n);
    double az = rad2deg(std::atan2(d.e, d.n));
    if (az < 0.0) az += 360.0;
    if (az >= 360.0) az -= 360.0;
    la.azimuth_deg = az;
    la.elevation_deg = (la.distance_m > 0.0) ? rad2deg(std::atan2(d.u, horiz)) : 0.0;
    return la;
}

double bearing_deg(const Lla& from, const Lla& to) { return look_angles(from, to).azimuth_deg; }

}  // namespace geo
}  // namespace cuav
