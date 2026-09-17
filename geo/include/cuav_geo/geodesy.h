// WGS-84 大地坐标换算：LLA ↔ ECEF ↔ 站心 ENU。
//
// 依据：CLAUDE.md 铁律 1（交换与文件用 WGS-84 经纬度，内部计算 ECEF + 站心 ENU，
// 方位真北顺时针、俯仰水平为 0）；决策 D-035（G-1 先用自写闭式顶在 IGeodesy 接口后，
// D3-0 的 07 号报告再换并对拍回收）；**决策 D-074（2026-09-17，D-035 就此回收）**：
// 坐标基座改用 vendored GeographicLib 2.5.2（third_party/geographiclib/），
// 自写闭式 ClosedFormWgs84 **保留**，降为独立第二实现与对拍件；
// 决策 D-009（新写代码统一 c = 299792458 与严格 ENU，禁止"顺手统一"移植代码里的旧常数）。
//
// 两家实现并存的理由：① 两家对拍是"换对了"的唯一证据（同 DSP 那条线的 Python 第二参考）；
// ② 自写那份零依赖，是第三方件出问题时的退路。一致性由 tests/golden/geodesy.json 钉住。
// 三家实现（自写、GeographicLib、third_party/foundation 的 UtEllipsoidalEarth）
// 在本项目尺度上互相差 1e-9 米量级，**谁也不比谁更准**（07 报告 §3.2）。
//
// 本头文件不引入任何第三方头：GeographicLib 只出现在 geodesy.cpp 里，
// 调用方与 geo/ 的其余部分对它无感。
//
// ECEF 与 ENU 用**两个不同的类型**，不共用一个三元组：两者的分量含义完全不同，
// 混用不会有任何编译错误但结果全错，靠命名纪律是防不住的。
//
// C++14，不用 optional / variant / string_view，与 emcore 保持同一标准。
// GeographicLib 2.5.2 是最后一个只要求 C++14 的版本，正好卡在这个标准上（D-074 / D3-1）。
//
// 本库的第三方依赖只有一件：GeographicLib 的 Geocentric / LocalCartesian 抽取
// （third_party/geographiclib/，七个文件 78105 字节，MIT）。场景 JSON 的读取仍在引擎侧
// （engine/src/scenario_json.cpp），不在这里。

#ifndef CUAV_GEO_GEODESY_H
#define CUAV_GEO_GEODESY_H

namespace cuav {
namespace geo {

// 真空光速。新写代码统一取这个值（D-009）；自 emcore 移植的模块保留各自旧常数守 golden。
double speed_of_light_mps();

// WGS-84 椭球参数（EPSG:4326）。
double wgs84_a();    // 长半轴 6378137.0 m
double wgs84_f();    // 扁率 1/298.257223563
double wgs84_b();    // 短半轴 a(1−f)
double wgs84_e2();   // 第一偏心率平方 f(2−f)

// 大地坐标：经纬度（度）、高度（米）。高度按场景 coordinate.alt_ref 解释，首期固定为离地高 AGL
// 加显式平地假设常数（铁律 2）；本库不做垂直基准换算。
struct Lla {
    double lon_deg;
    double lat_deg;
    double alt_m;

    Lla() : lon_deg(0.0), lat_deg(0.0), alt_m(0.0) {}
    Lla(double lon, double lat, double alt) : lon_deg(lon), lat_deg(lat), alt_m(alt) {}
};

// 地心地固直角坐标，米。
struct Ecef {
    double x;
    double y;
    double z;

    Ecef() : x(0.0), y(0.0), z(0.0) {}
    Ecef(double a, double b, double c) : x(a), y(b), z(c) {}
};

// 站心地平坐标，米：东、北、天。
struct Enu {
    double e;
    double n;
    double u;

    Enu() : e(0.0), n(0.0), u(0.0) {}
    Enu(double a, double b, double c) : e(a), n(b), u(c) {}
};

Ecef sub(const Ecef& a, const Ecef& b);
Ecef add(const Ecef& a, const Ecef& b);
Ecef scale(const Ecef& a, double k);
double dot(const Ecef& a, const Ecef& b);
double norm(const Ecef& a);
double norm(const Enu& a);

// 坐标基座接口。D-035 的替换点：D3-0 换实现时只改工厂，调用方不动。
class IGeodesy {
public:
    virtual ~IGeodesy() {}

    virtual Ecef to_ecef(const Lla& p) const = 0;
    virtual Lla to_lla(const Ecef& p) const = 0;

    // 点：含站心平移。
    virtual Enu to_enu(const Ecef& p, const Lla& origin) const = 0;
    virtual Ecef from_enu(const Enu& v, const Lla& origin) const = 0;

    // 矢量（速度、方向）：只旋转不平移。速度必须走这一对——走上面那一对会把站心平移量
    // 算进速度里，多普勒会大到离谱。
    virtual Enu rotate_to_enu(const Ecef& v, const Lla& origin) const = 0;
    virtual Ecef rotate_to_ecef(const Enu& v, const Lla& origin) const = 0;

    virtual const char* name() const = 0;
};

// 自写 WGS-84 闭式实现。**曾是 D-035 的临时件，自 D-074 起是独立第二实现与对拍件**，
// 不再是缺省基座，但保留且继续受单测约束。
// ECEF → LLA 用 Bowring 1976 闭式，不迭代；地面到数十公里高度上纬度误差在 0.1 mm 量级，
// 满足 G-1 的「往返 < 1 mm」验收。
class ClosedFormWgs84 : public IGeodesy {
public:
    Ecef to_ecef(const Lla& p) const override;
    Lla to_lla(const Ecef& p) const override;
    Enu to_enu(const Ecef& p, const Lla& origin) const override;
    Ecef from_enu(const Enu& v, const Lla& origin) const override;
    Enu rotate_to_enu(const Ecef& v, const Lla& origin) const override;
    Ecef rotate_to_ecef(const Enu& v, const Lla& origin) const override;
    const char* name() const override { return "closed-form-wgs84"; }
};

// GeographicLib 2.5.2 的 Geocentric / LocalCartesian 实现（D-074 定的坐标基座）。
//
// 分工：椭球换算（LLA ↔ ECEF）走 GeographicLib::Geocentric；**站心旋转在实现文件里自己写**。
// 后者不是偷懒：LocalCartesian 只暴露「大地坐标 ↔ 站心」，没有「ECEF 进、ENU 出」的入口，
// 经它走要多绕一次 ECEF → 大地坐标 → ECEF 的往返，反而引入误差；而站心旋转矩阵是原点经纬度的
// 纯三角函数、不含任何椭球参数，各家一模一样。这个说法不是声称——
// tests 里有一条把本实现的 to_enu 与 LocalCartesian::Forward 在网格上逐点对拍的用例。
class GeographicLibGeodesy : public IGeodesy {
public:
    Ecef to_ecef(const Lla& p) const override;
    Lla to_lla(const Ecef& p) const override;
    Enu to_enu(const Ecef& p, const Lla& origin) const override;
    Ecef from_enu(const Enu& v, const Lla& origin) const override;
    Enu rotate_to_enu(const Ecef& v, const Lla& origin) const override;
    Ecef rotate_to_ecef(const Enu& v, const Lla& origin) const override;
    const char* name() const override { return "geographiclib-2.5.2"; }
};

// 进程内唯一的常量实例。无可变全局状态，与铁律 9「库内无全局随机源」同一精神。
//
// **D3-1 阶段仍返回 ClosedFormWgs84**：切换基座会改动每一个航迹样点的末几位，
// 那是一次真正的基准变更（07 报告 §3.4），按铁律 10 单独成一步（D3-2），不夹在引入第三方件这一步里。
const IGeodesy& default_geodesy();

// 两家实现的直取入口，供对拍单测用（不经缺省工厂，这样换基座之后对拍仍然是两家在比）。
const IGeodesy& closed_form_geodesy();
const IGeodesy& geographiclib_geodesy();

// 两点间的 ECEF 弦长，米。
//
// **全系统只用这一个距离函数**：航段长度、链路斜距、浏览器预览插值都走它（08 报告 §9）。
// 这是有意偏离 em-demo src/models/propagation.ts 的 distanceGeo（半正矢，R = 6371000）：
//   ① 弦长闭式、无迭代、无球半径常数，C++ 与浏览器 TypeScript 能逐位一致，
//      而航迹对拍的容差是 1e-6 度（约 0.1 m），两套公式差 0.5% 在 2 km 段上就是 10 m；
//   ② 弦长直接由 ECEF 差得出，与「经纬高各自线性」的插值同在一个坐标系里，不引第二套几何。
// 在本系统的尺度（AOI 20 km）内弦长与椭球面距离差不到 0.01 m，不影响链路预算。
double chord_distance_m(const Lla& a, const Lla& b);
double chord_distance_m(const Ecef& a, const Ecef& b);

// 视线角。方位真北顺时针 [0, 360)，俯仰水平为 0、向上为正（铁律 1）。
struct LookAngles {
    double distance_m;
    double azimuth_deg;
    double elevation_deg;

    LookAngles() : distance_m(0.0), azimuth_deg(0.0), elevation_deg(0.0) {}
};

LookAngles look_angles(const Lla& from, const Lla& to);

// 地面航向，真北顺时针 [0, 360)。
// em-demo engine.ts 用 atan2(dLon, dLat) 的经纬度近似（未乘 cosφ），北纬 40° 处可差约 0.5°；
// 这里用严格 ENU 的 atan2(e, n)。属有意修正，写进 08 报告。
double bearing_deg(const Lla& from, const Lla& to);

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_GEODESY_H
