// 框图 JSON 装载器（06 备忘录 §9A B-2）：把 docs/diagram-format.md 定义的框图文件
// （schema_version = cuav-diagram/1）装成可运行的 Graph。
//
// 依据：04 §8.2（端口兼容性检查、中间观测点、错误定位到模型与端口）、§8.6（错误码映射到框图、
// 模型、端口；浏览器不见服务器路径）；决策 D-013（IQ 流与参数流不得直连）、D-030（组件目录只由
// 引擎生成，装载器只读 describe()）、D-037（内部参数不得出现在框图文件里，data_id 由解析器换成
// 文件位置注入）、D-040（解析旁挂、只校验模式、iq 产品本版本拒绝、错误码首版）。
//
// 三处消费同一份框图文件（画布、应用服务、引擎），语义只在这里解释一次：画布与服务的校验是
// 本文件规则的投影，冲突以这里为准。每个错误都带 {code, node_id, port, message}，画布据此高亮。

#ifndef CUAV_DIAGRAM_JSON_H
#define CUAV_DIAGRAM_JSON_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/graph.h"
#include "cuav/registry.h"

namespace cuav {

// 装载错误。code 取值表见 docs/diagram-format.md §4「错误码」：
//   json_parse / schema / unknown_type / internal_param / param / data_id / duration / scene_binding /
//   node_missing / port_missing / port_incompatible / input_occupied / input_unconnected / cycle /
//   observation_port / product_unsupported / graph
// node_id 是出错的框图节点 id；观测点自身的错误填观测点 id；与节点无关时为空。
struct DiagramError {
    std::string code;
    std::string node_id;
    std::string port;
    std::string message;
    bool empty() const { return code.empty(); }
};

nlohmann::json to_json(const DiagramError& e);

// 数据解析器：把框图里的数据标识 data_id 换成旁挂清单的文件位置（D-037）。
// 框图文件永远只写 data_id；路径只在服务端、解析旁挂与引擎进程里出现。
class IDataResolver {
public:
    virtual ~IDataResolver() {}
    virtual bool resolve(const std::string& data_id, std::string& manifest_path, std::string& err) = 0;
};

// 查表解析器：内存表，或从解析旁挂 diagram.resolved.json（schema_version = cuav-resolved/1，
// 字段 data: {"<data_id>": "<manifest_path>"}）装入。应用服务（B-5）走这一种。
class MapDataResolver : public IDataResolver {
public:
    MapDataResolver() {}
    explicit MapDataResolver(const std::map<std::string, std::string>& table) : table_(table) {}

    void set(const std::string& data_id, const std::string& manifest_path) { table_[data_id] = manifest_path; }
    bool load(const nlohmann::json& resolved, std::string& err);
    bool load_file(const std::string& path, std::string& err);
    std::size_t size() const { return table_.size(); }

    bool resolve(const std::string& data_id, std::string& manifest_path, std::string& err) override;

private:
    std::map<std::string, std::string> table_;
};

// 索引解析器：直接读一份或多份数据索引 index.manifest.json（schema = cuav-batch-index/1），
// 按约定 <索引所在目录>/<data_id>.manifest.json 定位旁挂清单并核对存在。
// 供 cuav_run 单机运行与回归测试用，不经过应用服务。
class IndexDataResolver : public IDataResolver {
public:
    bool add_index(const std::string& index_path, std::string& err);
    std::size_t size() const { return table_.size(); }

    bool resolve(const std::string& data_id, std::string& manifest_path, std::string& err) override;

private:
    std::map<std::string, std::string> table_;   // data_id → manifest_path
};

// 装载选项。out_dir 为空即「只校验」模式：观测点照常构造并校验参数，但不注入产品目录，
// 运行前会在 init() 被拒；cuav_run --validate 走这一种，不在盘上留任何东西。
struct LoadOptions {
    std::string out_dir;      // 产品目录 data/runs/<task_id>/，注入每个观测点的内部参数 out_dir
};

// 框图的 run 段，原样交给运行器：种子建 Xoshiro256pp，max_rounds 交给 Graph::run。
struct RunSpec {
    std::uint64_t seed = 0;
    double duration_s = 0.0;
    std::uint64_t block_size = 0;     // 0 = 框图未给，各源用自己的缺省块长
    std::uint64_t max_rounds = 0;     // 0 = 框图未给，运行器取默认
};

// 一个观测点在图里的落点：并联在 node.port 之后的 ObservationTap 节点。
struct TapBinding {
    std::string op_id;
    std::string node;
    std::string port;
    std::vector<std::string> products;
    NodeId tap_node = 0;
};

struct LoadedDiagram {
    std::string diagram_id;
    std::string name;
    Graph graph;                                   // 已通过 validate()
    std::map<std::string, NodeId> node_ids;        // 框图节点 id → Graph 编号（不含观测点节点）
    std::vector<std::string> node_names;           // Graph 编号 → 名字（观测点节点为 "op:<id>"）
    std::vector<TapBinding> taps;
    RunSpec run;
    bool has_scenario_ref = false;                 // 场景文件哈希核对由运行器做（需要读文件）
    std::string scenario_id;
    std::string scenario_sha256;
    nlohmann::json trace;                          // 框图 trace 段原样保留，运行器写进 task.json
};

// 装载。失败返回 false 并写 err，out 的内容不可用。resolver 可为空指针，此时框图里出现
// 引用数据的节点即报 data_id 错误。
bool load_diagram(const nlohmann::json& diagram, const Registry& registry, IDataResolver* resolver,
                  const LoadOptions& options, LoadedDiagram& out, DiagramError& err);

// 从文件装载；文件打不开或不是合法 JSON 报 json_parse。
bool load_diagram_file(const std::string& path, const Registry& registry, IDataResolver* resolver,
                       const LoadOptions& options, LoadedDiagram& out, DiagramError& err);

}  // namespace cuav

#endif  // CUAV_DIAGRAM_JSON_H
