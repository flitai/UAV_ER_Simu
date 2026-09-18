// 建筑几何的读取：buildings.geojson → 平面米的 geo::Building（步骤 D3-4，决策 D-074）。
//
// 放在引擎侧而不是 geo/：geo/ 不碰 JSON（同 scenario_json.cpp 的分工），nlohmann 已经
// vendored 在 engine/third_party/。
//
// 通路（07 报告 §7.1）：
//
//   data/scene/<aoi>/manifest.json         入口清单，字节哈希已由 check_aoi_manifest 核过
//        └─ products[] 里 buildings.geojson 的 sha256   ← 本文件据此核对建筑文件的原始字节
//        └─ aoi.center                                   ← 平面帧的原点
//   data/scene/<aoi>/buildings.geojson
//        └─ load_buildings_file()  → std::vector<geo::Building>（平面米，首尾不闭合）
//             └─ geo::LocalSceneAdapter::set_buildings()
//                  └─ 各 LinkFrameSource 共享一份 const IMapQuery&（D3-5 接线）
//
// **懒加载**：只有 prop_level == E3 才走这条路。校验路径（cuav_run --validate）不读建筑，
// 它今天约 9 ms，不该为一个大多数任务用不上的 16 MB 文件付 160 ms（07 报告 §7.4）。
//
// **同一份文件在一个进程里只解析一次**：K 个站共享一份适配器（shared_scene_map），
// 否则 K 站就是 K 份 47662 栋的桶网格。
//
// 铁律 1（严格 ENU）、2（离地高差与海拔禁止隐式相加）、8（溯源）、15（不静默降级）。

#ifndef CUAV_BUILDINGS_JSON_H
#define CUAV_BUILDINGS_JSON_H

#include <cstddef>
#include <string>
#include <vector>

#include "cuav_geo/map.h"
#include "nlohmann/json.hpp"

namespace cuav {

// 加载过程中的计数。**全部要随产物走**（铁律 8、15）：剔了几件、忽略了几个孔，
// 都不是可以不说的事。
struct BuildingsStats {
    std::size_t features = 0;          // GeoJSON 要素数
    std::size_t polygons = 0;          // 其中 Polygon
    std::size_t multipolygons = 0;     // 其中 MultiPolygon
    std::size_t parts = 0;             // MultiPolygon 拆出的子多边形数
    std::size_t holes_ignored = 0;     // 忽略的内环（孔）数——偏保守的简化，07 报告 §8 第 5 条
    std::size_t dropped_degenerate = 0;  // 外环顶点 < 3 而剔除的
    std::size_t dropped_height = 0;      // height_m ≤ 0 而剔除的
    std::size_t buildings = 0;         // 最终交给适配器的体块数

    // 一行人话，进产物的 notes。
    std::string summary() const;
};

struct LoadedBuildings {
    std::vector<geo::Building> buildings;
    BuildingsStats stats;
    geo::SceneFrame frame;
    std::string path;
    std::string sha256;    // 文件**原始字节**的哈希
};

// 内存 JSON → 平面米的建筑体块。
//
// · `Polygon` 取外环，内环（孔）忽略并计数；
// · `MultiPolygon` 的**每个子多边形的外环各当一栋**，id 加 `#<序号>` 后缀，孔同样忽略；
// · GeoJSON 的环是闭合的（首点 == 末点），这里去掉重复的末点——geo::Building 约定首尾不闭合；
// · `height_m ≤ 0` 或外环顶点 < 3 的要素剔除并计数，**不拿缺省值顶替**（铁律 15）。
bool parse_buildings(const nlohmann::json& j, const geo::SceneFrame& frame,
                     std::vector<geo::Building>& out, BuildingsStats& stats, std::string& err);

// 读文件 → 算 sha256（expected 非空则核对）→ parse_buildings。
bool load_buildings_file(const std::string& path, const std::string& expected_sha256,
                         const geo::SceneFrame& frame, LoadedBuildings& out, std::string& err);

// 观测区域入口清单里的建筑一项：文件位置、声明的哈希、平面帧原点。
struct AoiBuildingsRef {
    std::string manifest_path;
    std::string buildings_path;
    std::string sha256;
    geo::SceneFrame frame;
};

// <scene_root>/<aoi_id>/manifest.json → AoiBuildingsRef。
// 清单里没有 buildings.geojson 这一项、或没有 aoi.center，都失败并说明（铁律 15）。
bool aoi_buildings_ref(const std::string& scene_root, const std::string& aoi_id,
                       AoiBuildingsRef& out, std::string& err);

// 进程内共享的场景地图：同一个 (scene_root, aoi_id) 只加载一次。
// 返回的指针由进程持有，调用方不得释放；失败返回 nullptr 并写 err。
//
// 线程安全：内部加锁；返回之后的适配器是只读的，raycast 可并发调用（见 map.h）。
const geo::LocalSceneAdapter* shared_scene_map(const std::string& scene_root,
                                               const std::string& aoi_id,
                                               BuildingsStats& stats, std::string& err);

}  // namespace cuav

#endif  // CUAV_BUILDINGS_JSON_H
