// 场景文件的读取与逐字段校验（docs/scenario-format.md、docs/schemas/scenario.schema.json）。
//
// 放在引擎侧而不是 geo/：geo/ 保持零第三方依赖（将来独立承载 emcore 移植），
// nlohmann 已经 vendored 在 engine/third_party/。与 diagram_json.cpp 同一套写法：
// 未知键一律拒绝，报文带出错字段的 JSON 路径。
//
// 语义只在这一处解释：应用服务不复刻 schema，PUT 场景时调 cuav_run --scenario-track 看退出码
// （与 B-5 的框图路数一致，D-042）。

#ifndef CUAV_SCENARIO_JSON_H
#define CUAV_SCENARIO_JSON_H

#include <string>

#include "cuav_geo/scenario.h"
#include "nlohmann/json.hpp"

namespace cuav {

struct LoadedScenario {
    geo::Scenario scenario;
    std::string sha256;   // 文件**原始字节**的哈希，不是解析后再序列化的结果
    std::string path;
};

// 内存 JSON → Scenario。校验冻结常量（schema_version / synthetic / crs / time.basis）、
// 未知键、类型、正则与取值范围；不做跨引用校验（那是 Scenario::cross_check）。
bool parse_scenario(const nlohmann::json& j, geo::Scenario& out, std::string& err);

// 读文件 → 算 sha256 → parse_scenario → cross_check。任一步失败即写 err 返回 false。
bool load_scenario_file(const std::string& path, LoadedScenario& out, std::string& err);

// 与场景数据包入口清单 <scene_root>/<aoi_id>/manifest.json 的字节哈希核对。
// schema 允许 "<...>" 占位形式，这里判为未填并返回 false——铁律 15，不静默放行。
bool check_aoi_manifest(const geo::Scenario& s, const std::string& scene_root,
                        std::string& actual_sha256, std::string& err);

}  // namespace cuav

#endif  // CUAV_SCENARIO_JSON_H
