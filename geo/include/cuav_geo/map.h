// 地图查询接口与本地场景适配器：建筑桶网格 + 线段遍历，供刀口衍射取几何。
//
// **来源**：自 `C-UAV Model Demo/emcore/` 移植（决策 D-005、D-074，步骤 D3-3）：
//   include/emcore/map/imap_query.h        → 本文件的 IMapQuery 一族
//   include/emcore/map/local_scene_adapter.h + src/map/local_scene_adapter.cpp
//                                          → 本文件的 LocalSceneAdapter + geo/src/local_scene_adapter.cpp
// 再往上的祖本是 em-demo `src/models/occlusion.ts`。
// **黄金基准**：`tests/golden/occlusion.json`，148 例 `segmentOcclusion`，相对误差 ≤ 1e-9。
//
// 依据：05 §3.1（IMapQuery 是电磁模型与地图平台之间的唯一边界，模型层不得直接调用
// 地图后端）；04 §7.3（首期建筑只用于视距判定与附加损耗）；EM-P-04（城市建筑遮挡）；
// 铁律 2（显式平地假设）、铁律 11（渲染与遮挡同源于 buildings.geojson）、铁律 12（几何与材质分管）。
//
// ---- 与 emcore 原件的两处有意偏离，都记在 07 报告 §6.3 ----
//
// 一、**接口改吃平面米，不吃经纬度**。emcore 的 raycast 收 {x=经度, y=纬度, z=高度}，
//     投影常数写死在适配器构造函数里。本项目把投影挪到调用方：
//       · 黄金基准回放 → `legacy::local_frame_occlusion()`（cuav_geo/legacy_frames.h，守 148 例）；
//       · 引擎实际运行 → `default_geodesy().to_enu()`（严格站心地平，铁律 1）。
//     这与 D-053 把定位求解器改成平面坐标接口是同一套做法：一份数学两处用，
//     旧常数只留在 legacy 里，不渗进新代码。
//
// 二、命名改成本项目的蛇形风格（同 R-2 移植大气与降雨两式时的处置），**数值与算法一字未改**。
//
// C++14，零第三方依赖（geo/ 的第三方件只有 geodesy.cpp 里的坐标基座一件）。

#ifndef CUAV_GEO_MAP_H
#define CUAV_GEO_MAP_H

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace cuav {
namespace geo {

// 平面局部坐标，米。x 东、y 北、z 天（离地高，铁律 2 的显式平地假设）。
// 与 Enu 分开是有意的：Enu 是坐标基座的产物、带椭球语义；这里只是遮挡几何的平面工作坐标，
// 它的原点与投影由调用方约定并保持一致。
struct MapPoint {
    double x;
    double y;
    double z;
    MapPoint() : x(0.0), y(0.0), z(0.0) {}
    MapPoint(double a, double b, double c) : x(a), y(b), z(c) {}
};

// 平面包围盒，米。
struct MapBox {
    double min_x;
    double min_y;
    double max_x;
    double max_y;
    MapBox() : min_x(0.0), min_y(0.0), max_x(0.0), max_y(0.0) {}
};

// 建筑体块。外环顶点已经是平面米、**首尾不闭合**（闭合环由遍历隐式补齐）。
// base_m / height_m 是离地高差，不是海拔——禁止与数字高程隐式相加（铁律 2）。
struct Building {
    std::string id;
    std::vector<double> ring_x;
    std::vector<double> ring_y;
    double base_m;
    double height_m;
    std::string material_class;   // 首期不用（铁律 12），EM-T-04 留 P3
    Building() : base_m(0.0), height_m(0.0) {}
};

// 线段求交结果。
//
// **命中语义是「侵入最深的等效单刀口」，不是首个交点**——一条穿城而过的视线可能切到
// 几十栋楼，本模型只取侵入最深的那一栋做单刀口衍射。这是一处声明过的简化，**偏乐观**
// （多刀口会更大），写进模型卡，不要当成实现缺陷。
struct RaycastHit {
    bool hit;
    MapPoint point;          // 最深侵入处；z 取等效刀口顶高（楼顶）
    std::string object_id;
    double distance_m;       // 起点 → 命中点的地面距离 d1
    double intrusion_m;      // 视线侵入命中体块的竖直深度；未命中为 0
    double exit_distance_m;  // 命中点 → 终点的地面距离 d2
    RaycastHit() : hit(false), distance_m(0.0), intrusion_m(0.0), exit_distance_m(0.0) {}
};

// 材质电磁参数（EM-T-04）。**首期不用**：建筑只参与视距判定与刀口衍射，
// 穿透与反射留 P3（铁律 12：几何、材质、无线参数分开管理）。
struct MaterialInfo {
    std::string material_class;
    double penetration_loss_ref_dB;
    double permittivity_real;
    double conductivity_S_m;
    MaterialInfo()
        : penetration_loss_ref_dB(0.0), permittivity_real(1.0), conductivity_S_m(0.0) {}
};

// 电磁模型与地图之间的唯一边界（05 §3.1）。模型层只许依赖本接口。
class IMapQuery {
public:
    virtual ~IMapQuery() {}

    // 地面高程（米）。首期是显式平地假设的常数（铁律 2）。
    virtual double terrain_height_m(double x, double y) const = 0;

    // 包围盒内的建筑体块。
    virtual std::vector<Building> query_buildings(const MapBox& box) const = 0;

    // 线段求交。命中返回 true 并填 hit。
    virtual bool raycast(const MapPoint& p1, const MapPoint& p2, RaycastHit& hit) const = 0;

    // 指定频点上的材质参数。
    virtual MaterialInfo material(const std::string& object_id, double frequency_Hz) const = 0;
};

// 本地场景实现：100 米桶网格 + Amanatides-Woo 线段遍历。
//
//   · 段与多边形求交（不是点采样）：不漏窄楼、每栋只测一次；
//   · 桶网格只遍历线段穿过的格子，空域瞬间跳过；
//   · 命中语义见 RaycastHit。
//
// 声明过的简化（模型卡须原样收录，07 报告 §8）：地面视平面、侵入量用竖直距近似视线垂距、
// 多楼只取侵入最深的一栋、d1/d2 下限钳到 1 米、建筑的孔忽略、端点落在楼的投影内即排除该楼。
//
// 线程安全：`set_buildings()` 之后 raycast 与 query_buildings 可多线程并发调用
// （跨桶去重标记是 thread_local）。
class LocalSceneAdapter : public IMapQuery {
public:
    LocalSceneAdapter();

    // 重建桶网格索引。height_m ≤ 0 或顶点数 < 3 的要素剔除，剔除数由 dropped_count() 给出
    // ——**不静默丢**（铁律 15），调用方要把它记进产物的 notes。
    void set_buildings(std::vector<Building> buildings);
    std::size_t building_count() const { return buildings_.size(); }
    std::size_t dropped_count() const { return dropped_; }

    void set_terrain_height_m(double h) { terrain_height_m_ = h; }

    double terrain_height_m(double x, double y) const override;
    std::vector<Building> query_buildings(const MapBox& box) const override;
    bool raycast(const MapPoint& p1, const MapPoint& p2, RaycastHit& hit) const override;
    MaterialInfo material(const std::string& object_id, double frequency_Hz) const override;

private:
    struct Indexed {
        std::vector<double> xs;
        std::vector<double> ys;
        double min_x, min_y, max_x, max_y;
        double height_m;
        double base_m;
        Indexed() : min_x(0.0), min_y(0.0), max_x(0.0), max_y(0.0), height_m(0.0), base_m(0.0) {}
    };

    static bool point_in_polygon(double px, double py, const Indexed& b);

    double terrain_height_m_;
    std::size_t dropped_;
    std::vector<Building> buildings_;
    std::vector<Indexed> indexed_;
    std::unordered_map<std::int64_t, std::vector<int> > grid_;
};

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_MAP_H
