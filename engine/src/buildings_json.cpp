// 建筑几何的读取（步骤 D3-4，决策 D-074）。接口与通路见 cuav/buildings_json.h。
//
// 与 scenario_json.cpp 同一套写法：报文带出错要素的位置，任何剔除都计数并说出来（铁律 15）。
// 与它不同的一点：场景文件是人写的，未知键一律拒；建筑文件是 scene/decode_buildings.py
// 机器生成的 GeoJSON，属性里还留着 src 之类的数据层标记（铁律 14），所以**不查未知键**，
// 只取用得上的那几个字段。

#include "cuav/buildings_json.h"

#include <cstdio>
#include <map>
#include <mutex>
#include <sstream>
#include <utility>

#include "cuav/sha256.h"

namespace cuav {

namespace {

std::string num_to_string(double v) {
    std::ostringstream os;
    os << v;
    return os.str();
}

// properties.id 在本数据集里是超过 2^32 的整数（OSM 要素号），也允许字符串。
std::string feature_id(const nlohmann::json& f, std::size_t index) {
    const nlohmann::json* src = nullptr;
    if (f.contains("properties") && f["properties"].is_object() && f["properties"].contains("id"))
        src = &f["properties"]["id"];
    else if (f.contains("id"))
        src = &f["id"];
    if (src != nullptr) {
        if (src->is_string()) return src->get<std::string>();
        if (src->is_number_integer()) return std::to_string(src->get<std::int64_t>());
        if (src->is_number_unsigned()) return std::to_string(src->get<std::uint64_t>());
        if (src->is_number()) return num_to_string(src->get<double>());
    }
    return "feature#" + std::to_string(index);
}

double prop_number(const nlohmann::json& f, const char* key, double def) {
    if (!f.contains("properties") || !f["properties"].is_object()) return def;
    const nlohmann::json& p = f["properties"];
    if (!p.contains(key) || !p[key].is_number()) return def;
    return p[key].get<double>();
}

bool fail(std::string& err, const std::string& what) {
    err = what;
    return false;
}

// 一个外环 → 一栋。返回 false 表示这一栋被剔除（原因已计数），不是出错。
bool ring_to_building(const nlohmann::json& ring, const geo::SceneFrame& frame,
                      const std::string& id, double base_m, double height_m,
                      geo::Building& out, BuildingsStats& stats, std::string& err) {
    err.clear();   // 调用方靠 err 空不空区分「这一栋被剔除」与「文件有错」，不能留上一轮的残值
    if (!ring.is_array()) return fail(err, "建筑 " + id + " 的环不是数组");

    // GeoJSON 的线性环是闭合的（首点 == 末点）；geo::Building 约定**首尾不闭合**，
    // 闭合边由遍历隐式补齐（map.h）。所以去掉重复的末点。
    std::size_t n = ring.size();
    if (n >= 2) {
        const nlohmann::json& a = ring[0];
        const nlohmann::json& b = ring[n - 1];
        if (a.is_array() && b.is_array() && a.size() >= 2 && b.size() >= 2 &&
            a[0] == b[0] && a[1] == b[1]) {
            --n;
        }
    }
    if (n < 3) {
        ++stats.dropped_degenerate;
        return false;
    }
    if (!(height_m > 0.0)) {
        ++stats.dropped_height;
        return false;
    }

    out.id = id;
    out.base_m = base_m;
    out.height_m = height_m;
    out.material_class.clear();   // 首期不用（铁律 12），EM-T-04 留 P3
    out.ring_x.clear();
    out.ring_y.clear();
    out.ring_x.reserve(n);
    out.ring_y.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
        const nlohmann::json& pt = ring[i];
        if (!pt.is_array() || pt.size() < 2 || !pt[0].is_number() || !pt[1].is_number())
            return fail(err, "建筑 " + id + " 的第 " + std::to_string(i) + " 个顶点不是 [经度, 纬度]");
        double x = 0.0, y = 0.0;
        frame.to_plane(pt[0].get<double>(), pt[1].get<double>(), x, y);
        out.ring_x.push_back(x);
        out.ring_y.push_back(y);
    }
    return true;
}

}  // namespace

std::string BuildingsStats::summary() const {
    std::ostringstream os;
    os << "建筑 " << buildings << " 栋（要素 " << features << "：Polygon " << polygons
       << "、MultiPolygon " << multipolygons << " 拆出 " << parts << " 件）";
    if (holes_ignored > 0) os << "；忽略内环 " << holes_ignored << " 个";
    if (dropped_degenerate > 0) os << "；顶点不足剔除 " << dropped_degenerate << " 件";
    if (dropped_height > 0) os << "；高度非正剔除 " << dropped_height << " 件";
    return os.str();
}

bool parse_buildings(const nlohmann::json& j, const geo::SceneFrame& frame,
                     std::vector<geo::Building>& out, BuildingsStats& stats, std::string& err) {
    out.clear();
    stats = BuildingsStats();

    if (!j.is_object() || !j.contains("type") || !j["type"].is_string() ||
        j["type"].get<std::string>() != "FeatureCollection")
        return fail(err, "建筑文件不是 GeoJSON FeatureCollection");
    if (!j.contains("features") || !j["features"].is_array())
        return fail(err, "建筑文件缺 features 数组");

    const nlohmann::json& feats = j["features"];
    stats.features = feats.size();
    out.reserve(feats.size());

    for (std::size_t i = 0; i < feats.size(); ++i) {
        const nlohmann::json& f = feats[i];
        if (!f.is_object() || !f.contains("geometry") || !f["geometry"].is_object())
            return fail(err, "第 " + std::to_string(i) + " 个要素缺 geometry");
        const nlohmann::json& g = f["geometry"];
        if (!g.contains("type") || !g["type"].is_string() ||
            !g.contains("coordinates") || !g["coordinates"].is_array())
            return fail(err, "第 " + std::to_string(i) + " 个要素的 geometry 不完整");

        const std::string gtype = g["type"].get<std::string>();
        const std::string id = feature_id(f, i);
        const double base_m = prop_number(f, "base_m", 0.0);
        const double height_m = prop_number(f, "height_m", 0.0);

        if (gtype == "Polygon") {
            ++stats.polygons;
            const nlohmann::json& rings = g["coordinates"];
            if (rings.empty()) { ++stats.dropped_degenerate; continue; }
            if (rings.size() > 1) stats.holes_ignored += rings.size() - 1;
            geo::Building b;
            if (!ring_to_building(rings[0], frame, id, base_m, height_m, b, stats, err)) {
                if (!err.empty()) return false;
                continue;
            }
            out.push_back(std::move(b));
        } else if (gtype == "MultiPolygon") {
            ++stats.multipolygons;
            const nlohmann::json& polys = g["coordinates"];
            for (std::size_t k = 0; k < polys.size(); ++k) {
                if (!polys[k].is_array() || polys[k].empty())
                    return fail(err, "要素 " + id + " 的第 " + std::to_string(k) + " 件多边形为空");
                ++stats.parts;
                if (polys[k].size() > 1) stats.holes_ignored += polys[k].size() - 1;
                // 每个子多边形的外环各当一栋，共用同一个 id 加序号后缀（07 报告 §7.3）。
                geo::Building b;
                if (!ring_to_building(polys[k][0], frame, id + "#" + std::to_string(k), base_m,
                                      height_m, b, stats, err)) {
                    if (!err.empty()) return false;
                    continue;
                }
                out.push_back(std::move(b));
            }
        } else {
            // 不静默跳过：本项目的建筑集只会有这两种，出现别的说明上游变了，要当场知道。
            return fail(err, "要素 " + id + " 的几何类型是 " + gtype +
                                 "，建筑只接受 Polygon 与 MultiPolygon");
        }
    }

    stats.buildings = out.size();
    return true;
}

bool load_buildings_file(const std::string& path, const std::string& expected_sha256,
                         const geo::SceneFrame& frame, LoadedBuildings& out, std::string& err) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == 0) return fail(err, "打不开建筑文件：" + path);
    std::string bytes;
    char buf[65536];
    for (;;) {
        const std::size_t n = std::fread(buf, 1, sizeof(buf), f);
        if (n > 0) bytes.append(buf, n);
        if (n < sizeof(buf)) break;
    }
    const bool bad = (std::ferror(f) != 0);
    std::fclose(f);
    if (bad) return fail(err, "读建筑文件出错：" + path);

    out.path = path;
    out.frame = frame;
    out.sha256 = sha256_hex(bytes);
    if (!expected_sha256.empty() && out.sha256 != expected_sha256) {
        return fail(err, "建筑文件 " + path + " 的哈希与观测区域清单不符：清单写 " +
                             expected_sha256.substr(0, 8) + "…，文件是 " + out.sha256.substr(0, 8) +
                             "…（铁律 8：产物与元数据必须对得上）");
    }

    nlohmann::json j;
    try {
        j = nlohmann::json::parse(bytes);
    } catch (const std::exception& e) {
        return fail(err, std::string("建筑文件不是合法 JSON：") + e.what());
    }
    return parse_buildings(j, frame, out.buildings, out.stats, err);
}

bool aoi_buildings_ref(const std::string& scene_root, const std::string& aoi_id,
                       AoiBuildingsRef& out, std::string& err) {
    if (scene_root.empty())
        return fail(err, "没有观测区域数据包的根目录：E3 档要建筑几何，cuav_run 需给 --scene-root");
    out = AoiBuildingsRef();
    out.manifest_path = scene_root + "/" + aoi_id + "/manifest.json";

    std::FILE* f = std::fopen(out.manifest_path.c_str(), "rb");
    if (f == 0) return fail(err, "打不开观测区域清单：" + out.manifest_path);
    std::string bytes;
    char buf[65536];
    for (;;) {
        const std::size_t n = std::fread(buf, 1, sizeof(buf), f);
        if (n > 0) bytes.append(buf, n);
        if (n < sizeof(buf)) break;
    }
    const bool bad = (std::ferror(f) != 0);
    std::fclose(f);
    if (bad) return fail(err, "读观测区域清单出错：" + out.manifest_path);

    nlohmann::json m;
    try {
        m = nlohmann::json::parse(bytes);
    } catch (const std::exception& e) {
        return fail(err, std::string("观测区域清单不是合法 JSON：") + e.what());
    }

    // 坐标系：只认 WGS-84 经纬度，混进 GCJ-02 会整份平移几百米（铁律 1）。
    if (!m.contains("crs") || !m["crs"].is_string() || m["crs"].get<std::string>() != "EPSG:4326")
        return fail(err, out.manifest_path + " 的 crs 不是 EPSG:4326（铁律 1）");

    // 平面帧的原点取观测区域中心：它是数据包里记着的常量，与场景、与站点无关，
    // 于是同一个数据包的所有站、所有场景共用同一把尺子（map.h 的 SceneFrame 头注）。
    if (!m.contains("aoi") || !m["aoi"].is_object() || !m["aoi"].contains("center") ||
        !m["aoi"]["center"].is_array() || m["aoi"]["center"].size() != 2 ||
        !m["aoi"]["center"][0].is_number() || !m["aoi"]["center"][1].is_number())
        return fail(err, out.manifest_path + " 缺 aoi.center [经度, 纬度]，平面帧没有原点可用");
    out.frame = geo::SceneFrame(geo::Lla(m["aoi"]["center"][0].get<double>(),
                                         m["aoi"]["center"][1].get<double>(), 0.0));

    if (!m.contains("products") || !m["products"].is_array())
        return fail(err, out.manifest_path + " 缺 products 数组");
    for (const auto& p : m["products"]) {
        if (!p.is_object() || !p.contains("file") || !p["file"].is_string()) continue;
        if (p["file"].get<std::string>() != "buildings.geojson") continue;
        if (!p.contains("sha256") || !p["sha256"].is_string())
            return fail(err, out.manifest_path + " 里 buildings.geojson 一项没有 sha256");
        out.sha256 = p["sha256"].get<std::string>();
        out.buildings_path = scene_root + "/" + aoi_id + "/buildings.geojson";
        return true;
    }
    return fail(err, out.manifest_path + " 的 products 里没有 buildings.geojson："
                     "这份观测区域数据包不带建筑几何，E3 档跑不了");
}

namespace {

struct MapCacheEntry {
    geo::LocalSceneAdapter adapter;
    BuildingsStats stats;
    geo::SceneFrame frame;
};

std::mutex& map_cache_mutex() {
    static std::mutex m;
    return m;
}

std::map<std::string, MapCacheEntry*>& map_cache() {
    static std::map<std::string, MapCacheEntry*> c;
    return c;
}

}  // namespace

const geo::LocalSceneAdapter* shared_scene_map(const std::string& scene_root,
                                               const std::string& aoi_id,
                                               BuildingsStats& stats, geo::SceneFrame& frame,
                                               std::string& err) {
    const std::string key = scene_root + "\n" + aoi_id;
    std::lock_guard<std::mutex> lock(map_cache_mutex());
    std::map<std::string, MapCacheEntry*>& cache = map_cache();
    std::map<std::string, MapCacheEntry*>::iterator it = cache.find(key);
    if (it != cache.end()) {
        stats = it->second->stats;
        frame = it->second->frame;
        return &it->second->adapter;
    }

    AoiBuildingsRef ref;
    if (!aoi_buildings_ref(scene_root, aoi_id, ref, err)) return 0;
    LoadedBuildings lb;
    if (!load_buildings_file(ref.buildings_path, ref.sha256, ref.frame, lb, err)) return 0;

    // 进程生命期持有：K 个站共享同一份桶网格。不释放是有意的——缓存的键是文件加观测区域，
    // 一次任务里不会变；真要重载就得连进程一起换，那正是「建筑变了但缓存没失效」这类错的防线。
    MapCacheEntry* entry = new MapCacheEntry();
    entry->adapter.set_buildings(std::move(lb.buildings));
    entry->stats = lb.stats;
    // 适配器自己也会剔除退化件（顶点 < 3、高度 ≤ 0）。这里的解析已经先剔过一轮，
    // 两边的口径一致时它应当为零；不为零就把它并进计数，不让它无声无息（铁律 15）。
    entry->stats.dropped_degenerate += entry->adapter.dropped_count();
    entry->stats.buildings = entry->adapter.building_count();
    entry->frame = ref.frame;
    cache[key] = entry;
    stats = entry->stats;
    frame = entry->frame;
    return &entry->adapter;
}

}  // namespace cuav
