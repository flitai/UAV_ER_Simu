// 自 emcore `src/map/local_scene_adapter.cpp` 移植（D-005 / D-074，D3-3）。
// 祖本 em-demo `src/models/occlusion.ts`。黄金基准 tests/golden/occlusion.json，148 例。
// 算法与数值一字未改；改的只有两处：接口吃平面米（投影挪到调用方）、命名改蛇形风格。
// 偏离的理由见 cuav_geo/map.h 的头注与 07 报告 §6.3。

#include "cuav_geo/map.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace cuav {
namespace geo {
namespace {

const double kPi = 3.14159265358979323846;
const double kCellM = 100.0;   // 桶边长（米），同 occlusion.ts 的 CELL_M

inline std::int64_t cell_key(std::int64_t cx, std::int64_t cy) {
    // cx, cy 约在 [−70, 70]；偏到正区间避免负键冲突（同祖本）
    return (cx + 8192) * 16384 + (cy + 8192);
}

inline std::int64_t cell_of(double v) {
    return static_cast<std::int64_t>(std::floor(v / kCellM));
}

// 跨桶去重标记。thread_local 使 raycast 在批量计算下无锁并发（标记只在单次查询内有意义）。
thread_local std::vector<unsigned> tl_seen;
thread_local unsigned tl_gen = 0;

}  // namespace

LocalSceneAdapter::LocalSceneAdapter() : terrain_height_m_(0.0), dropped_(0) {}

void LocalSceneAdapter::set_buildings(std::vector<Building> buildings) {
    buildings_.clear();
    indexed_.clear();
    grid_.clear();
    dropped_ = 0;

    for (std::size_t bi = 0; bi < buildings.size(); ++bi) {
        Building& b = buildings[bi];
        const std::size_t n = b.ring_x.size();
        if (n < 3 || b.ring_y.size() != n) { ++dropped_; continue; }
        if (!(b.height_m > 0.0) || !(b.height_m == b.height_m) ||
            b.height_m == std::numeric_limits<double>::infinity()) { ++dropped_; continue; }

        Indexed idx;
        idx.xs.resize(n);
        idx.ys.resize(n);
        idx.min_x = std::numeric_limits<double>::infinity();
        idx.min_y = std::numeric_limits<double>::infinity();
        idx.max_x = -std::numeric_limits<double>::infinity();
        idx.max_y = -std::numeric_limits<double>::infinity();
        for (std::size_t i = 0; i < n; ++i) {
            const double x = b.ring_x[i];
            const double y = b.ring_y[i];
            idx.xs[i] = x;
            idx.ys[i] = y;
            if (x < idx.min_x) idx.min_x = x;
            if (y < idx.min_y) idx.min_y = y;
            if (x > idx.max_x) idx.max_x = x;
            if (y > idx.max_y) idx.max_y = y;
        }
        idx.height_m = b.height_m;
        idx.base_m = b.base_m;

        indexed_.push_back(idx);
        buildings_.push_back(b);
    }

    // 建网格：每栋插进它包围盒覆盖的所有桶
    for (std::size_t bi = 0; bi < indexed_.size(); ++bi) {
        const Indexed& b = indexed_[bi];
        const std::int64_t cx0 = cell_of(b.min_x);
        const std::int64_t cx1 = cell_of(b.max_x);
        const std::int64_t cy0 = cell_of(b.min_y);
        const std::int64_t cy1 = cell_of(b.max_y);
        for (std::int64_t cx = cx0; cx <= cx1; ++cx) {
            for (std::int64_t cy = cy0; cy <= cy1; ++cy) {
                grid_[cell_key(cx, cy)].push_back(static_cast<int>(bi));
            }
        }
    }
}

double LocalSceneAdapter::terrain_height_m(double, double) const {
    return terrain_height_m_;   // 显式平地假设（铁律 2）
}

std::vector<Building> LocalSceneAdapter::query_buildings(const MapBox& box) const {
    std::vector<Building> out;
    for (std::size_t i = 0; i < indexed_.size(); ++i) {
        const Indexed& b = indexed_[i];
        const bool overlap = !(b.max_x < box.min_x || b.min_x > box.max_x ||
                               b.max_y < box.min_y || b.min_y > box.max_y);
        if (overlap) out.push_back(buildings_[i]);
    }
    return out;
}

// 射线投射法判断平面点是否在外环内（自遮挡排除用），同祖本 pointInBuilding
bool LocalSceneAdapter::point_in_polygon(double px, double py, const Indexed& b) {
    if (px < b.min_x || px > b.max_x || py < b.min_y || py > b.max_y) return false;
    const std::size_t n = b.xs.size();
    bool inside = false;
    for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
        const double yi = b.ys[i];
        const double yj = b.ys[j];
        if ((yi > py) != (yj > py)) {
            const double x_cross = ((b.xs[j] - b.xs[i]) * (py - yi)) / (yj - yi) + b.xs[i];
            if (px < x_cross) inside = !inside;
        }
    }
    return inside;
}

bool LocalSceneAdapter::raycast(const MapPoint& p1, const MapPoint& p2, RaycastHit& hit) const {
    hit = RaycastHit();
    if (indexed_.empty()) return false;

    const double x0 = p1.x, y0 = p1.y;
    const double x1 = p2.x, y1 = p2.y;
    const double dx = x1 - x0;
    const double dy = y1 - y0;
    const double d_ground = std::sqrt(dx * dx + dy * dy);
    if (d_ground < 1e-6) return false;

    if (tl_seen.size() != indexed_.size()) {
        tl_seen.assign(indexed_.size(), 0u);
        tl_gen = 0;
    }
    if (++tl_gen == 0) {   // 极罕见的回绕：重置标记
        std::fill(tl_seen.begin(), tl_seen.end(), 0u);
        tl_gen = 1;
    }
    const unsigned gen = tl_gen;

    const double inf = std::numeric_limits<double>::infinity();
    double max_intrusion = 0.0;
    double best_d1 = 0.0, best_d2 = 0.0, best_t = 0.0;
    int best_idx = -1;

    // 单栋候选：求段与多边形的交点参数区间，取侵入最深那一端（结构同祖本）
    const auto test_building = [&](int bi) {
        const Indexed& b = indexed_[static_cast<std::size_t>(bi)];
        // 排除架在楼顶（或楼内）的设备与目标：自遮挡
        if (point_in_polygon(x0, y0, b) || point_in_polygon(x1, y1, b)) return;

        const std::size_t n = b.xs.size();
        double t_min = inf;
        double t_max = -inf;
        for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
            const double ax = b.xs[j];
            const double ay = b.ys[j];
            const double ex = b.xs[i] - ax;
            const double ey = b.ys[i] - ay;
            const double denom = dx * ey - dy * ex;
            if (std::fabs(denom) < 1e-12) continue;   // 平行
            const double wx = ax - x0;
            const double wy = ay - y0;
            const double t = (wx * ey - wy * ex) / denom;   // 沿射线
            const double u = (wx * dy - wy * dx) / denom;   // 沿边
            if (t < 0.0 || t > 1.0 || u < 0.0 || u > 1.0) continue;
            if (t < t_min) t_min = t;
            if (t > t_max) t_max = t;
        }
        if (t_max < 0.0) return;   // 不相交（含 −inf 初值）

        // 侵入最深处 = 遮挡区间内视线高度最低的那一端（视线高度沿 t 线性）
        const double alt_min = p1.z + (p2.z - p1.z) * t_min;
        const double alt_max = p1.z + (p2.z - p1.z) * t_max;
        const double t_deep = alt_min <= alt_max ? t_min : t_max;
        const double ray_alt = p1.z + (p2.z - p1.z) * t_deep;
        if (ray_alt < b.base_m || ray_alt >= b.height_m) return;   // 楼下穿过或楼顶掠过
        const double intrusion = b.height_m - ray_alt;
        if (intrusion > max_intrusion) {
            max_intrusion = intrusion;
            best_d1 = t_deep * d_ground;
            best_d2 = (1.0 - t_deep) * d_ground;
            best_t = t_deep;
            best_idx = bi;
        }
    };

    // ---- Amanatides-Woo 网格遍历：只走线段穿过的桶 ----
    std::int64_t cx = cell_of(x0);
    std::int64_t cy = cell_of(y0);
    const std::int64_t cx_end = cell_of(x1);
    const std::int64_t cy_end = cell_of(y1);
    const std::int64_t step_x = dx > 0.0 ? 1 : -1;
    const std::int64_t step_y = dy > 0.0 ? 1 : -1;
    const double t_delta_x = dx != 0.0 ? std::fabs(kCellM / dx) : inf;
    const double t_delta_y = dy != 0.0 ? std::fabs(kCellM / dy) : inf;
    const double next_x = static_cast<double>(dx > 0.0 ? cx + 1 : cx) * kCellM;
    const double next_y = static_cast<double>(dy > 0.0 ? cy + 1 : cy) * kCellM;
    double t_max_x = dx != 0.0 ? (next_x - x0) / dx : inf;
    double t_max_y = dy != 0.0 ? (next_y - y0) / dy : inf;

    std::int64_t guard = 0;
    const std::int64_t guard_max =
        (cx_end > cx ? cx_end - cx : cx - cx_end) + (cy_end > cy ? cy_end - cy : cy - cy_end) + 4;
    for (;;) {
        const std::unordered_map<std::int64_t, std::vector<int> >::const_iterator it =
            grid_.find(cell_key(cx, cy));
        if (it != grid_.end()) {
            for (std::size_t k = 0; k < it->second.size(); ++k) {
                const int bi = it->second[k];
                if (tl_seen[static_cast<std::size_t>(bi)] == gen) continue;
                tl_seen[static_cast<std::size_t>(bi)] = gen;
                test_building(bi);
            }
        }
        if (cx == cx_end && cy == cy_end) break;
        if (++guard > guard_max) break;   // 数值兜底
        if (t_max_x < t_max_y) {
            cx += step_x;
            t_max_x += t_delta_x;
        } else {
            cy += step_y;
            t_max_y += t_delta_y;
        }
    }

    if (max_intrusion <= 0.0) return false;

    const Building& b = buildings_[static_cast<std::size_t>(best_idx)];
    hit.hit = true;
    hit.object_id = b.id;
    hit.point.x = p1.x + (p2.x - p1.x) * best_t;
    hit.point.y = p1.y + (p2.y - p1.y) * best_t;
    hit.point.z = b.height_m;   // 等效刀口顶高
    hit.distance_m = best_d1;
    hit.intrusion_m = max_intrusion;
    hit.exit_distance_m = best_d2;
    return true;
}

MaterialInfo LocalSceneAdapter::material(const std::string& object_id, double) const {
    MaterialInfo m;
    // 缺省混凝土参数：EM-T-04 材质库接入前的工程缺省，首期不参与任何计算（铁律 12）
    m.material_class = "concrete_generic";
    m.penetration_loss_ref_dB = 12.0;
    m.permittivity_real = 5.3;
    m.conductivity_S_m = 0.026;
    for (std::size_t i = 0; i < buildings_.size(); ++i) {
        if (buildings_[i].id == object_id && !buildings_[i].material_class.empty()) {
            m.material_class = buildings_[i].material_class;
            break;
        }
    }
    return m;
}

namespace legacy {

LocalFrame2 local_frame_occlusion(double ref_lat_deg) {
    LocalFrame2 f;
    f.m_per_deg_lat = 110540.0;
    f.m_per_deg_lon = 111320.0 * std::cos(ref_lat_deg * (kPi / 180.0));
    return f;
}

}  // namespace legacy

}  // namespace geo
}  // namespace cuav
