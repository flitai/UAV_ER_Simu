#include "cuav/catalog.h"

#include <set>

namespace cuav {

namespace {

const PortType kPortTypes[] = {
    PortType::IQStream, PortType::SceneParamFrame, PortType::ChannelPathSet,
    PortType::SpectrumFrame, PortType::DetectionList, PortType::FeatureVector,
};

nlohmann::json port_json(const PortSpec& p) {
    return nlohmann::json{{"name", p.name}, {"type", to_string(p.type)}};
}

nlohmann::json param_json(const ParamSpec& p) {
    nlohmann::json j;
    j["name"] = p.name;
    j["type"] = to_string(p.type);
    j["unit"] = p.unit;
    j["required"] = p.required;
    j["description"] = p.description;
    if (p.has_min) { j["min"] = p.min; if (p.min_exclusive) j["min_exclusive"] = true; }
    if (p.has_max) { j["max"] = p.max; if (p.max_exclusive) j["max_exclusive"] = true; }
    if (p.has_default) {
        switch (p.type) {
            case ParamType::Number: j["default"] = p.default_number; break;
            case ParamType::Bool: j["default"] = p.default_bool; break;
            default: j["default"] = p.default_text; break;
        }
    }
    if (p.type == ParamType::Enum) j["enum"] = p.enum_values;
    if (!p.constraint.empty()) j["constraint"] = p.constraint;
    if (p.internal) j["internal"] = true;
    if (!p.excludes.empty()) j["excludes"] = p.excludes;
    return j;
}

}  // namespace

bool validate_catalog_entry(const ComponentInfo& info, std::string& err) {
    static const char* const kCategories[] = {
        category::Source, category::Channel, category::Antenna,
        category::Receiver, category::Data, category::Algorithm,
    };
    bool cat_ok = false;
    for (const char* c : kCategories) if (info.category == c) cat_ok = true;
    if (!cat_ok) { err = info.type + " 的类别不在六类之内：\"" + info.category + "\""; return false; }
    if (info.model_layer != "M1" && info.model_layer != "M2" && info.model_layer != "M3") {
        err = info.type + " 的 model_layer 不合法：\"" + info.model_layer + "\""; return false;
    }
    if (info.model_level != "E1" && info.model_level != "E2" &&
        info.model_level != "E3" && info.model_level != "E4") {
        err = info.type + " 的 model_level 不合法：\"" + info.model_level + "\""; return false;
    }
    if (info.version.empty()) { err = info.type + " 缺版本号"; return false; }
    if (info.display_name.empty()) { err = info.type + " 缺显示名"; return false; }
    if (info.implementation != "cpp" && info.implementation != "coder") {
        err = info.type + " 的 implementation 不合法：\"" + info.implementation + "\""; return false;
    }
    if (info.implementation == "coder" && info.source_ref.empty()) {
        err = info.type + " 是 Coder 产物但缺 source_ref（决策 D-036）"; return false;
    }
    std::set<std::string> names;
    for (const auto& p : info.params) {
        if (p.name.empty()) { err = info.type + " 有参数缺名字"; return false; }
        if (!names.insert(p.name).second) { err = info.type + " 参数名重复：" + p.name; return false; }
        if (p.type == ParamType::Enum && p.enum_values.empty()) {
            err = info.type + " 参数 " + p.name + " 是枚举但没有取值表"; return false;
        }
        if (p.required && p.has_default) {
            err = info.type + " 参数 " + p.name + " 既必填又带默认值，二者只能取一"; return false;
        }
    }
    return true;
}

nlohmann::json catalog_json(const Registry& registry) {
    nlohmann::json j;
    j["schema_version"] = "cuav-catalog/1";
    j["engine_version"] = engine_version();

    nlohmann::json types = nlohmann::json::array();
    for (PortType t : kPortTypes) types.push_back(to_string(t));
    j["port_types"] = types;

    nlohmann::json compat = nlohmann::json::array();
    for (PortType a : kPortTypes) {
        for (PortType b : kPortTypes) {
            const bool ok = can_connect(a, b);
            nlohmann::json row = {to_string(a), to_string(b), ok};
            if (!ok) row.push_back("端口类型不同；跨类型必须由显式组件承担，IQ 流与参数流不得直连（决策 D-013）");
            compat.push_back(row);
        }
    }
    j["port_compat"] = compat;

    nlohmann::json comps = nlohmann::json::array();
    for (const std::string& type : registry.types()) {
        ComponentInfo info;
        std::string err;
        if (!registry.describe(type, info, err)) throw std::runtime_error(err);
        if (!validate_catalog_entry(info, err)) throw std::runtime_error(err);
        nlohmann::json c;
        c["type"] = info.type;
        c["category"] = info.category;
        c["display_name"] = info.display_name;
        c["description"] = info.description;
        c["model_layer"] = info.model_layer;
        c["model_level"] = info.model_level;
        c["model_id"] = info.model_id;
        c["version"] = info.version;
        nlohmann::json in = nlohmann::json::array(), out = nlohmann::json::array();
        for (const auto& p : info.inputs) in.push_back(port_json(p));
        for (const auto& p : info.outputs) out.push_back(port_json(p));
        c["ports"] = {{"in", in}, {"out", out}};
        if (info.has_dynamic_ports) {
            c["dynamic_ports"] = {{"pattern", info.dynamic_port_pattern},
                                  {"type", to_string(info.dynamic_port_type)},
                                  {"source", info.dynamic_port_source}};
        }
        nlohmann::json params = nlohmann::json::array();
        for (const auto& p : info.params) params.push_back(param_json(p));
        c["params"] = params;
        c["scene_bindable"] = info.scene_bindable;
        c["stateful"] = info.stateful;
        c["implementation"] = info.implementation;
        if (!info.source_ref.empty()) c["source_ref"] = info.source_ref;
        comps.push_back(c);
    }
    j["components"] = comps;
    return j;
}

}  // namespace cuav
