#include "cuav/diagram_json.h"

#include <cmath>
#include <fstream>
#include <set>
#include <sstream>

namespace cuav {

namespace {

const char* const kDiagramSchema = "cuav-diagram/1";
const char* const kResolvedSchema = "cuav-resolved/1";
const char* const kIndexSchema = "cuav-batch-index/1";
const char* const kTapType = "ObservationTap";

// ------------------------------------------------------------------ 小工具

bool is_id_char(char c) {
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}

// docs/schemas/diagram.schema.json：id 为 ^[a-z0-9_-]{1,64}$
bool match_id(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    for (char c : s) if (!is_id_char(c)) return false;
    return true;
}

// 端口名 ^[a-z0-9_:-]{1,64}$，冒号给动态端口 link:<emitter_id> 留位
bool match_port(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    for (char c : s) if (!is_id_char(c) && c != ':') return false;
    return true;
}

// 组件类型名 ^[A-Za-z][A-Za-z0-9_]{0,63}$
bool match_type(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    auto alpha = [](char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); };
    if (!alpha(s[0])) return false;
    for (char c : s) if (!alpha(c) && !(c >= '0' && c <= '9') && c != '_') return false;
    return true;
}

bool match_sha256(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
}

bool integer_like(const nlohmann::json& v) {
    if (!v.is_number()) return false;
    const double d = v.get<double>();
    return std::floor(d) == d;
}

std::string fmt(double v) {
    std::ostringstream o;
    o.precision(15);
    o << v;
    return o.str();
}

DiagramError fail(const std::string& code, const std::string& node, const std::string& port,
                  const std::string& message) {
    DiagramError e;
    e.code = code;
    e.node_id = node;
    e.port = port;
    e.message = message;
    return e;
}

const ParamSpec* find_spec(const ComponentInfo& info, const std::string& name) {
    for (const auto& p : info.params) if (p.name == name) return &p;
    return nullptr;
}

const PortSpec* find_port(const std::vector<PortSpec>& v, const std::string& name) {
    for (const auto& p : v) if (p.name == name) return &p;
    return nullptr;
}

// 未知键一律拒绝（docs/diagram-format.md §2）。
bool check_keys(const nlohmann::json& obj, const std::set<std::string>& allowed,
                const std::string& where, const std::string& node_id, DiagramError& err) {
    for (auto it = obj.begin(); it != obj.end(); ++it) {
        if (!allowed.count(it.key())) {
            err = fail("schema", node_id, "", where + " 出现未知键 \"" + it.key() + "\"，未知键一律拒绝");
            return false;
        }
    }
    return true;
}

bool need(const nlohmann::json& obj, const char* key, const std::string& where,
          const std::string& node_id, DiagramError& err) {
    if (!obj.contains(key)) {
        err = fail("schema", node_id, "", where + " 缺必填字段 " + key);
        return false;
    }
    return true;
}

bool need_object(const nlohmann::json& v, const std::string& where, const std::string& node_id, DiagramError& err) {
    if (!v.is_object()) {
        err = fail("schema", node_id, "", where + " 必须是对象");
        return false;
    }
    return true;
}

bool optional_string(const nlohmann::json& obj, const char* key, std::size_t max_len, const std::string& where,
                     const std::string& node_id, DiagramError& err) {
    if (!obj.contains(key)) return true;
    if (!obj[key].is_string() || obj[key].get<std::string>().size() > max_len) {
        err = fail("schema", node_id, "", where + " 的 " + key + " 必须是长度不超过 " + std::to_string(max_len) + " 的字符串");
        return false;
    }
    return true;
}

// {node, port} 引用
bool parse_port_ref(const nlohmann::json& v, const std::string& where, std::string& node, std::string& port,
                    DiagramError& err) {
    if (!need_object(v, where, "", err)) return false;
    static const std::set<std::string> kKeys = {"node", "port"};
    if (!check_keys(v, kKeys, where, "", err)) return false;
    if (!need(v, "node", where, "", err) || !need(v, "port", where, "", err)) return false;
    if (!v["node"].is_string() || !match_id(v["node"].get<std::string>())) {
        err = fail("schema", "", "", where + " 的 node 必须匹配 [a-z0-9_-]{1,64}");
        return false;
    }
    if (!v["port"].is_string() || !match_port(v["port"].get<std::string>())) {
        err = fail("schema", v["node"].get<std::string>(), "", where + " 的 port 必须匹配 [a-z0-9_:-]{1,64}");
        return false;
    }
    node = v["node"].get<std::string>();
    port = v["port"].get<std::string>();
    return true;
}

bool parse_run(const nlohmann::json& r, RunSpec& run, DiagramError& err) {
    if (!need_object(r, "run", "", err)) return false;
    static const std::set<std::string> kKeys = {"seed", "duration_s", "block_size", "time_basis", "max_rounds"};
    if (!check_keys(r, kKeys, "run", "", err)) return false;
    for (const char* k : {"seed", "duration_s", "time_basis"}) if (!need(r, k, "run", "", err)) return false;
    if (!integer_like(r["seed"]) || r["seed"].get<double>() < 0.0) {
        err = fail("schema", "", "", "run.seed 必须是不小于 0 的整数（铁律 9）");
        return false;
    }
    run.seed = static_cast<std::uint64_t>(r["seed"].get<double>());
    if (!r["duration_s"].is_number() || !(r["duration_s"].get<double>() > 0.0)) {
        err = fail("schema", "", "", "run.duration_s 必须是大于 0 的数");
        return false;
    }
    run.duration_s = r["duration_s"].get<double>();
    if (!r["time_basis"].is_string() || r["time_basis"].get<std::string>() != "LogicalSim") {
        err = fail("schema", "", "", "run.time_basis 首期固定为 LogicalSim（铁律 3）");
        return false;
    }
    if (r.contains("block_size")) {
        if (!integer_like(r["block_size"]) || r["block_size"].get<double>() < 1.0) {
            err = fail("schema", "", "", "run.block_size 必须是不小于 1 的整数");
            return false;
        }
        run.block_size = static_cast<std::uint64_t>(r["block_size"].get<double>());
    }
    if (r.contains("max_rounds")) {
        if (!integer_like(r["max_rounds"]) || r["max_rounds"].get<double>() < 1.0) {
            err = fail("schema", "", "", "run.max_rounds 必须是不小于 1 的整数");
            return false;
        }
        run.max_rounds = static_cast<std::uint64_t>(r["max_rounds"].get<double>());
    }
    return true;
}

// 把框图 params 按组件描述分流到 configure() 的两张表：bool → 数值表 0/1，enum/string → 文本表。
// 内部参数出现即拒（D-037）；未知参数、类型错位都在这里带着节点 id 报出来。
bool split_params(const ComponentInfo& info, const nlohmann::json& params, const std::string& who,
                  const std::string& node_id, std::map<std::string, double>& num,
                  std::map<std::string, std::string>& txt, DiagramError& err) {
    for (auto it = params.begin(); it != params.end(); ++it) {
        const std::string& k = it.key();
        const nlohmann::json& v = it.value();
        const ParamSpec* s = find_spec(info, k);
        if (!s) {
            err = fail("param", node_id, "", who + "（" + info.type + "）未知参数 " + k);
            return false;
        }
        if (s->internal) {
            err = fail("internal_param", node_id, "",
                       who + " 的参数 " + k + " 是内部参数，由装载器解析注入，不得出现在框图文件里（04 §8.6，D-037）");
            return false;
        }
        const std::string declared = to_string(s->type);
        if (v.is_boolean()) {
            if (s->type != ParamType::Bool) {
                err = fail("param", node_id, "", who + " 的参数 " + k + " 是 " + declared + " 类型，不能给布尔值");
                return false;
            }
            num[k] = v.get<bool>() ? 1.0 : 0.0;
        } else if (v.is_number()) {
            if (s->type != ParamType::Number) {
                err = fail("param", node_id, "", who + " 的参数 " + k + " 是 " + declared + " 类型，不能给数值");
                return false;
            }
            num[k] = v.get<double>();
        } else if (v.is_string()) {
            if (s->type != ParamType::String && s->type != ParamType::Enum) {
                err = fail("param", node_id, "", who + " 的参数 " + k + " 是 " + declared + " 类型，不能给文本");
                return false;
            }
            txt[k] = v.get<std::string>();
        } else {
            err = fail("schema", node_id, "", who + " 的参数 " + k + " 值类型不允许：参数值只有 number / string / bool 三种");
            return false;
        }
    }
    return true;
}

// data_id → manifest_path（D-037）。只对同时声明用户参数 data_id 与内部参数 manifest_path 的组件生效。
bool inject_data(const ComponentInfo& info, const std::string& node_id, IDataResolver* resolver,
                 std::map<std::string, std::string>& txt, DiagramError& err) {
    const ParamSpec* d = find_spec(info, "data_id");
    const ParamSpec* m = find_spec(info, "manifest_path");
    if (!d || !m || !m->internal) return true;
    auto it = txt.find("data_id");
    if (it == txt.end()) return true;   // 缺必填交给 validate_params 报
    if (!resolver) {
        err = fail("data_id", node_id, "",
                   "节点 " + node_id + " 引用数据 " + it->second +
                   "，但没有数据解析器：cuav_run 需给 --resolved 或 --data-index，应用服务在提交时解析（D-037）");
        return false;
    }
    std::string path, e;
    if (!resolver->resolve(it->second, path, e)) {
        err = fail("data_id", node_id, "", "节点 " + node_id + " 的数据 " + it->second + " 无法解析：" + e);
        return false;
    }
    txt["manifest_path"] = path;
    return true;
}

// 源组件的 total_samples 由 run.duration_s × sample_rate_Hz 补（四舍五入到整数样点）；显式值不得超过它。
// run.block_size 给未写 block_samples 的节点当块长。（docs/diagram-format.md §3、§6）
bool fill_run_derived(const ComponentInfo& info, const std::string& node_id, const RunSpec& run,
                      std::map<std::string, double>& num, DiagramError& err) {
    if (find_spec(info, "total_samples")) {
        auto fs = num.find("sample_rate_Hz");
        if (fs != num.end() && fs->second > 0.0) {
            const double cap = std::floor(run.duration_s * fs->second + 0.5);
            auto ts = num.find("total_samples");
            if (ts == num.end()) {
                if (cap < 1.0) {
                    err = fail("duration", node_id, "",
                               "节点 " + node_id + "：run.duration_s × sample_rate_Hz = " + fmt(run.duration_s * fs->second) +
                               " 不足一个样点");
                    return false;
                }
                num["total_samples"] = cap;
            } else if (ts->second > cap) {
                err = fail("duration", node_id, "",
                           "节点 " + node_id + " 的 total_samples = " + fmt(ts->second) +
                           " 超过全局时长 run.duration_s × sample_rate_Hz = " + fmt(cap));
                return false;
            }
        }
    }
    if (run.block_size > 0 && find_spec(info, "block_samples") && !num.count("block_samples")) {
        num["block_samples"] = static_cast<double>(run.block_size);
    }
    return true;
}

std::string dir_of(const std::string& path) {
    const std::size_t slash = path.find_last_of("/\\");
    return slash == std::string::npos ? std::string() : path.substr(0, slash + 1);
}

bool read_json_file(const std::string& path, nlohmann::json& out, std::string& err) {
    std::ifstream f(path.c_str());
    if (!f) { err = "打不开 " + path; return false; }
    try {
        f >> out;
    } catch (const std::exception& e) {
        err = std::string("不是合法 JSON：") + e.what();
        return false;
    }
    return true;
}

}  // namespace

// ------------------------------------------------------------------ 错误报文

nlohmann::json to_json(const DiagramError& e) {
    return nlohmann::json{{"code", e.code}, {"node_id", e.node_id}, {"port", e.port}, {"message", e.message}};
}

// ------------------------------------------------------------------ 解析器

bool MapDataResolver::load(const nlohmann::json& resolved, std::string& err) {
    if (!resolved.is_object()) { err = "解析旁挂顶层必须是对象"; return false; }
    if (!resolved.contains("schema_version") || resolved["schema_version"] != kResolvedSchema) {
        err = std::string("解析旁挂的 schema_version 必须是 ") + kResolvedSchema;
        return false;
    }
    if (!resolved.contains("data") || !resolved["data"].is_object()) {
        err = "解析旁挂缺 data 对象（data_id → manifest_path）";
        return false;
    }
    for (auto it = resolved["data"].begin(); it != resolved["data"].end(); ++it) {
        if (!it.value().is_string()) { err = "解析旁挂 data." + it.key() + " 不是字符串"; return false; }
        table_[it.key()] = it.value().get<std::string>();
    }
    return true;
}

bool MapDataResolver::load_file(const std::string& path, std::string& err) {
    nlohmann::json j;
    if (!read_json_file(path, j, err)) { err = "解析旁挂 " + err; return false; }
    return load(j, err);
}

bool MapDataResolver::resolve(const std::string& data_id, std::string& manifest_path, std::string& err) {
    auto it = table_.find(data_id);
    if (it == table_.end()) { err = "data_id 不在解析表里：" + data_id; return false; }
    manifest_path = it->second;
    return true;
}

bool IndexDataResolver::add_index(const std::string& index_path, std::string& err) {
    nlohmann::json j;
    if (!read_json_file(index_path, j, err)) { err = "数据索引 " + err; return false; }
    if (!j.is_object() || !j.contains("schema") || j["schema"] != kIndexSchema) {
        err = std::string("数据索引的 schema 必须是 ") + kIndexSchema + "：" + index_path;
        return false;
    }
    if (!j.contains("products") || !j["products"].is_array()) {
        err = "数据索引缺 products 数组：" + index_path;
        return false;
    }
    const std::string dir = dir_of(index_path);
    for (const auto& p : j["products"]) {
        if (!p.is_object() || !p.contains("data_id") || !p["data_id"].is_string()) {
            err = "数据索引里有产物缺 data_id：" + index_path;
            return false;
        }
        const std::string id = p["data_id"].get<std::string>();
        const std::string path = dir + id + ".manifest.json";
        auto it = table_.find(id);
        if (it != table_.end() && it->second != path) {
            err = "data_id 在多份索引里重复且位置不同：" + id;
            return false;
        }
        table_[id] = path;
    }
    return true;
}

bool IndexDataResolver::resolve(const std::string& data_id, std::string& manifest_path, std::string& err) {
    auto it = table_.find(data_id);
    if (it == table_.end()) { err = "data_id 不在已装入的数据索引里：" + data_id; return false; }
    std::ifstream f(it->second.c_str());
    if (!f) { err = "索引里有 " + data_id + " 但旁挂清单不在盘上：" + it->second; return false; }
    manifest_path = it->second;
    return true;
}

// ------------------------------------------------------------------ 装载

bool load_diagram(const nlohmann::json& j, const Registry& registry, IDataResolver* resolver,
                  const LoadOptions& options, LoadedDiagram& out, DiagramError& err) {
    out = LoadedDiagram();
    err = DiagramError();

    // 1. 顶层结构
    if (!need_object(j, "框图顶层", "", err)) return false;
    static const std::set<std::string> kTopKeys = {
        "schema_version", "diagram_id", "name", "nodes", "edges", "observation_points", "run", "scenario_ref", "trace"};
    if (!check_keys(j, kTopKeys, "框图顶层", "", err)) return false;
    for (const char* k : {"schema_version", "diagram_id", "name", "nodes", "edges", "run"}) {
        if (!need(j, k, "框图顶层", "", err)) return false;
    }
    if (!j["schema_version"].is_string() || j["schema_version"].get<std::string>() != kDiagramSchema) {
        err = fail("schema", "", "", std::string("schema_version 必须是 ") + kDiagramSchema);
        return false;
    }
    if (!j["diagram_id"].is_string() || !match_id(j["diagram_id"].get<std::string>())) {
        err = fail("schema", "", "", "diagram_id 必须匹配 [a-z0-9_-]{1,64}");
        return false;
    }
    out.diagram_id = j["diagram_id"].get<std::string>();
    if (!j["name"].is_string() || j["name"].get<std::string>().empty() || j["name"].get<std::string>().size() > 200) {
        err = fail("schema", "", "", "name 必须是 1 到 200 个字符的字符串");
        return false;
    }
    out.name = j["name"].get<std::string>();
    if (!j["nodes"].is_array() || j["nodes"].empty()) {
        err = fail("schema", "", "", "nodes 必须是至少一项的数组");
        return false;
    }
    if (!j["edges"].is_array()) {
        err = fail("schema", "", "", "edges 必须是数组");
        return false;
    }
    if (j.contains("observation_points") && !j["observation_points"].is_array()) {
        err = fail("schema", "", "", "observation_points 必须是数组");
        return false;
    }
    if (!parse_run(j["run"], out.run, err)) return false;

    if (j.contains("scenario_ref")) {
        const nlohmann::json& s = j["scenario_ref"];
        if (!need_object(s, "scenario_ref", "", err)) return false;
        static const std::set<std::string> kKeys = {"scenario_id", "sha256"};
        if (!check_keys(s, kKeys, "scenario_ref", "", err)) return false;
        if (!need(s, "scenario_id", "scenario_ref", "", err) || !need(s, "sha256", "scenario_ref", "", err)) return false;
        if (!s["scenario_id"].is_string() || !match_id(s["scenario_id"].get<std::string>())) {
            err = fail("schema", "", "", "scenario_ref.scenario_id 必须匹配 [a-z0-9_-]{1,64}");
            return false;
        }
        if (!s["sha256"].is_string() || !match_sha256(s["sha256"].get<std::string>())) {
            err = fail("schema", "", "", "scenario_ref.sha256 必须是 64 位小写十六进制");
            return false;
        }
        out.has_scenario_ref = true;
        out.scenario_id = s["scenario_id"].get<std::string>();
        out.scenario_sha256 = s["sha256"].get<std::string>();
    }

    if (j.contains("trace")) {
        const nlohmann::json& t = j["trace"];
        if (!need_object(t, "trace", "", err)) return false;
        static const std::set<std::string> kKeys = {"created_by", "created_at", "parent_diagram_id", "notes"};
        if (!check_keys(t, kKeys, "trace", "", err)) return false;
        for (auto it = t.begin(); it != t.end(); ++it) {
            if (!it.value().is_string()) {
                err = fail("schema", "", "", "trace." + it.key() + " 必须是字符串");
                return false;
            }
        }
        if (t.contains("parent_diagram_id") && !match_id(t["parent_diagram_id"].get<std::string>())) {
            err = fail("schema", "", "", "trace.parent_diagram_id 必须匹配 [a-z0-9_-]{1,64}");
            return false;
        }
        out.trace = t;
    }

    // 2. 节点：结构校验、参数分流、内部参数注入、按注册表构造
    static const std::set<std::string> kNodeKeys = {"id", "type", "label", "params", "position", "scene_binding"};
    for (const auto& n : j["nodes"]) {
        if (!need_object(n, "nodes[] 每项", "", err)) return false;
        if (!n.contains("id") || !n["id"].is_string() || !match_id(n["id"].get<std::string>())) {
            err = fail("schema", "", "", "节点缺 id 或 id 不匹配 [a-z0-9_-]{1,64}");
            return false;
        }
        const std::string id = n["id"].get<std::string>();
        const std::string who = "节点 " + id;
        if (out.node_ids.count(id)) {
            err = fail("schema", id, "", "节点 id 重复：" + id);
            return false;
        }
        if (!check_keys(n, kNodeKeys, who, id, err)) return false;
        if (!need(n, "type", who, id, err) || !need(n, "params", who, id, err)) return false;
        if (!n["type"].is_string() || !match_type(n["type"].get<std::string>())) {
            err = fail("schema", id, "", who + " 的 type 必须匹配 [A-Za-z][A-Za-z0-9_]{0,63}");
            return false;
        }
        if (!n["params"].is_object()) {
            err = fail("schema", id, "", who + " 的 params 必须是对象");
            return false;
        }
        if (!optional_string(n, "label", 200, who, id, err)) return false;
        if (n.contains("position")) {
            const nlohmann::json& p = n["position"];
            if (!need_object(p, who + " 的 position", id, err)) return false;
            static const std::set<std::string> kPos = {"x", "y"};
            if (!check_keys(p, kPos, who + " 的 position", id, err)) return false;
            if (!p.contains("x") || !p.contains("y") || !p["x"].is_number() || !p["y"].is_number()) {
                err = fail("schema", id, "", who + " 的 position 必须是 {x, y} 两个数");
                return false;
            }
        }
        if (n.contains("scene_binding")) {
            const nlohmann::json& b = n["scene_binding"];
            if (!need_object(b, who + " 的 scene_binding", id, err)) return false;
            static const std::set<std::string> kBind = {"scenario_id", "entity_id", "site_id"};
            if (!check_keys(b, kBind, who + " 的 scene_binding", id, err)) return false;
            if (!need(b, "scenario_id", who + " 的 scene_binding", id, err)) return false;
            const bool has_entity = b.contains("entity_id"), has_site = b.contains("site_id");
            if (has_entity == has_site) {
                err = fail("schema", id, "", who + " 的 scene_binding 必须且只能带 entity_id 或 site_id 之一");
                return false;
            }
            for (auto it = b.begin(); it != b.end(); ++it) {
                if (!it.value().is_string() || !match_id(it.value().get<std::string>())) {
                    err = fail("schema", id, "", who + " 的 scene_binding." + it.key() + " 必须匹配 [a-z0-9_-]{1,64}");
                    return false;
                }
            }
        }

        const std::string type = n["type"].get<std::string>();
        ComponentInfo info;
        std::string e;
        if (!registry.describe(type, info, e)) {
            err = fail("unknown_type", id, "", who + " 的组件类型 " + type + " 不在组件目录里");
            return false;
        }
        if (n.contains("scene_binding")) {
            if (!info.scene_bindable) {
                err = fail("scene_binding", id, "", who + "（" + type + "）不可绑定场景：目录 scene_bindable = false");
                return false;
            }
            if (!out.has_scenario_ref) {
                err = fail("scene_binding", id, "", who + " 带 scene_binding，但框图没有 scenario_ref");
                return false;
            }
        }

        std::map<std::string, double> num;
        std::map<std::string, std::string> txt;
        if (!split_params(info, n["params"], who, id, num, txt, err)) return false;
        if (!inject_data(info, id, resolver, txt, err)) return false;
        if (!fill_run_derived(info, id, out.run, num, err)) return false;

        std::unique_ptr<IComponent> comp = registry.create_configured(type, num, txt, e);
        if (!comp) {
            // 引用数据的组件，构造失败多半出在数据上（清单打不开、格式不对），归到 data_id 便于定位
            const char* code = find_spec(info, "data_id") ? "data_id" : "param";
            err = fail(code, id, "", who + "：" + e);
            return false;
        }
        const NodeId nid = out.graph.add(std::move(comp), id);
        out.node_ids[id] = nid;
        out.node_names.push_back(id);
    }

    // 3. 连线：规则在 Graph::connect 一处解释，这里只把失败分类映射成带定位的错误码
    static const std::set<std::string> kEdgeKeys = {"id", "from", "to"};
    std::set<std::string> edge_ids;
    for (const auto& ed : j["edges"]) {
        if (!need_object(ed, "edges[] 每项", "", err)) return false;
        if (!ed.contains("id") || !ed["id"].is_string() || !match_id(ed["id"].get<std::string>())) {
            err = fail("schema", "", "", "连线缺 id 或 id 不匹配 [a-z0-9_-]{1,64}");
            return false;
        }
        const std::string eid = ed["id"].get<std::string>();
        const std::string who = "连线 " + eid;
        if (!edge_ids.insert(eid).second) {
            err = fail("schema", "", "", "连线 id 重复：" + eid);
            return false;
        }
        if (!check_keys(ed, kEdgeKeys, who, "", err)) return false;
        if (!need(ed, "from", who, "", err) || !need(ed, "to", who, "", err)) return false;
        std::string fn, fp, tn, tp;
        if (!parse_port_ref(ed["from"], who + " 的 from", fn, fp, err)) return false;
        if (!parse_port_ref(ed["to"], who + " 的 to", tn, tp, err)) return false;
        auto a = out.node_ids.find(fn);
        if (a == out.node_ids.end()) {
            err = fail("node_missing", fn, fp, who + " 的起点节点 " + fn + " 不存在");
            return false;
        }
        auto b = out.node_ids.find(tn);
        if (b == out.node_ids.end()) {
            err = fail("node_missing", tn, tp, who + " 的终点节点 " + tn + " 不存在");
            return false;
        }
        std::string e;
        LinkFault fault = LinkFault::None;
        if (!out.graph.connect(a->second, fp, b->second, tp, e, fault)) {
            switch (fault) {
                case LinkFault::NoOutputPort:  err = fail("port_missing", fn, fp, who + "：" + e); break;
                case LinkFault::NoInputPort:   err = fail("port_missing", tn, tp, who + "：" + e); break;
                case LinkFault::Incompatible:  err = fail("port_incompatible", fn, fp, who + "：" + e); break;
                case LinkFault::InputOccupied: err = fail("input_occupied", tn, tp, who + "：" + e); break;
                case LinkFault::SelfLoop:      err = fail("cycle", fn, fp, who + "：" + e); break;
                default:                       err = fail("graph", fn, fp, who + "：" + e); break;
            }
            return false;
        }
        ++out.edge_count;
    }

    // 4. 观测点：在 IQStream 输出口后并联一个 ObservationTap，不改用户的边
    if (j.contains("observation_points")) {
        static const std::set<std::string> kOpKeys = {"id", "node", "port", "products", "label", "params"};
        static const std::set<std::string> kProducts = {"spectrum", "envelope", "iq"};
        std::set<std::string> op_ids;
        ComponentInfo tap_info;
        std::string e;
        if (!j["observation_points"].empty() && !registry.describe(kTapType, tap_info, e)) {
            err = fail("graph", "", "", std::string("注册表里没有 ") + kTapType + "，无法并联观测点");
            return false;
        }
        for (const auto& op : j["observation_points"]) {
            if (!need_object(op, "observation_points[] 每项", "", err)) return false;
            if (!op.contains("id") || !op["id"].is_string() || !match_id(op["id"].get<std::string>())) {
                err = fail("schema", "", "", "观测点缺 id 或 id 不匹配 [a-z0-9_-]{1,64}");
                return false;
            }
            const std::string id = op["id"].get<std::string>();
            const std::string who = "观测点 " + id;
            if (!op_ids.insert(id).second) {
                err = fail("schema", id, "", "观测点 id 重复：" + id);
                return false;
            }
            if (!check_keys(op, kOpKeys, who, id, err)) return false;
            for (const char* k : {"node", "port", "products"}) if (!need(op, k, who, id, err)) return false;
            if (!op["node"].is_string() || !match_id(op["node"].get<std::string>())) {
                err = fail("schema", id, "", who + " 的 node 必须匹配 [a-z0-9_-]{1,64}");
                return false;
            }
            if (!op["port"].is_string() || !match_port(op["port"].get<std::string>())) {
                err = fail("schema", id, "", who + " 的 port 必须匹配 [a-z0-9_:-]{1,64}");
                return false;
            }
            if (!optional_string(op, "label", 200, who, id, err)) return false;
            const std::string node = op["node"].get<std::string>();
            const std::string port = op["port"].get<std::string>();

            // products：非空、无重复、取值受限；iq 本版本尚未实现，明确拒绝而不是静默忽略（铁律 15）
            if (!op["products"].is_array() || op["products"].empty()) {
                err = fail("schema", id, "", who + " 的 products 必须是至少一项的数组");
                return false;
            }
            std::set<std::string> products;
            for (const auto& p : op["products"]) {
                if (!p.is_string() || !kProducts.count(p.get<std::string>())) {
                    err = fail("schema", id, "", who + " 的 products 只允许 spectrum / envelope / iq");
                    return false;
                }
                if (!products.insert(p.get<std::string>()).second) {
                    err = fail("schema", id, "", who + " 的 products 有重复项 " + p.get<std::string>());
                    return false;
                }
            }
            if (products.count("iq")) {
                err = fail("product_unsupported", id, "",
                           who + " 要求 iq 产品：观测点的原始 IQ 产品待后续步骤实现，本版本不接受（docs/display-products.md §1）");
                return false;
            }

            auto target = out.node_ids.find(node);
            if (target == out.node_ids.end()) {
                err = fail("node_missing", node, port, who + " 挂在不存在的节点 " + node);
                return false;
            }
            // outputs() 按值返回，先落到局部变量再取指针，否则指针悬空
            const std::vector<PortSpec> outs = out.graph.node(target->second)->outputs();
            const PortSpec* ps = find_port(outs, port);
            if (!ps) {
                err = fail("observation_port", node, port, who + " 挂在 " + node + "." + port + "，它不是输出口；观测点只能挂 IQStream 输出口");
                return false;
            }
            if (ps->type != PortType::IQStream) {
                err = fail("observation_port", node, port,
                           who + " 挂在 " + node + "." + port + "，类型是 " + to_string(ps->type) + "；观测点只能挂 IQStream 输出口");
                return false;
            }

            // 参数：op_id / spectrum / envelope 由观测点字段派生，不许手写；out_dir 是内部参数由 split_params 拒
            std::map<std::string, double> num;
            std::map<std::string, std::string> txt;
            if (op.contains("params")) {
                if (!op["params"].is_object()) {
                    err = fail("schema", id, "", who + " 的 params 必须是对象");
                    return false;
                }
                for (const char* k : {"op_id", "spectrum", "envelope"}) {
                    if (op["params"].contains(k)) {
                        err = fail("schema", id, "", who + " 的 params 不得含 " + std::string(k) + "：它由观测点的 id 与 products 派生");
                        return false;
                    }
                }
                if (!split_params(tap_info, op["params"], who, id, num, txt, err)) return false;
            }
            txt["op_id"] = id;
            if (!options.out_dir.empty()) txt["out_dir"] = options.out_dir;
            num["spectrum"] = products.count("spectrum") ? 1.0 : 0.0;
            num["envelope"] = products.count("envelope") ? 1.0 : 0.0;
            std::unique_ptr<IComponent> tap = registry.create_configured(kTapType, num, txt, e);
            if (!tap) {
                err = fail("param", id, "", who + "：" + e);
                return false;
            }
            const NodeId tid = out.graph.add(std::move(tap), "op:" + id);
            out.node_names.push_back("op:" + id);
            LinkFault fault = LinkFault::None;
            if (!out.graph.connect(target->second, port, tid, "in", e, fault)) {
                err = fail("graph", node, port, who + " 并联失败：" + e);
                return false;
            }
            TapBinding tb;
            tb.op_id = id;
            tb.node = node;
            tb.port = port;
            tb.products.assign(products.begin(), products.end());
            tb.tap_node = tid;
            out.taps.push_back(tb);
        }
    }

    // 5. 拓扑排序、环、悬空输入口
    std::string e;
    GraphFault gf = GraphFault::None;
    NodeId gn = 0;
    std::string gp;
    if (!out.graph.validate(e, gf, gn, gp)) {
        switch (gf) {
            case GraphFault::Cycle:            err = fail("cycle", "", "", e); break;
            case GraphFault::InputUnconnected: err = fail("input_unconnected", out.node_names.at(gn), gp, e); break;
            default:                           err = fail("graph", "", "", e); break;
        }
        return false;
    }
    return true;
}

bool load_diagram_file(const std::string& path, const Registry& registry, IDataResolver* resolver,
                       const LoadOptions& options, LoadedDiagram& out, DiagramError& err) {
    nlohmann::json j;
    std::string e;
    if (!read_json_file(path, j, e)) {
        err = fail("json_parse", "", "", "框图文件 " + e);
        return false;
    }
    return load_diagram(j, registry, resolver, options, out, err);
}

}  // namespace cuav
