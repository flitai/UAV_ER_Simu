#include "cuav/registry.h"

#include <algorithm>
#include <sstream>

#include "cuav/components/processing.h"
#include "cuav/components/sources.h"
#include "cuav/components/spectrum.h"
#include "cuav/components/tap.h"

namespace cuav {

// ------------------------------------------------------------------ ParamSpec

const char* to_string(ParamType t) {
    switch (t) {
        case ParamType::Number: return "number";
        case ParamType::String: return "string";
        case ParamType::Enum: return "enum";
        case ParamType::Bool: return "bool";
    }
    return "number";
}

ParamSpec ParamSpec::number(const std::string& name, const std::string& unit,
                            const std::string& description) {
    ParamSpec p;
    p.name = name;
    p.type = ParamType::Number;
    p.unit = unit;
    p.description = description;
    return p;
}

ParamSpec ParamSpec::text(const std::string& name, const std::string& description) {
    ParamSpec p;
    p.name = name;
    p.type = ParamType::String;
    p.description = description;
    return p;
}

ParamSpec ParamSpec::choice(const std::string& name, const std::vector<std::string>& values,
                            const std::string& description) {
    ParamSpec p;
    p.name = name;
    p.type = ParamType::Enum;
    p.enum_values = values;
    p.description = description;
    return p;
}

ParamSpec ParamSpec::boolean(const std::string& name, const std::string& description) {
    ParamSpec p;
    p.name = name;
    p.type = ParamType::Bool;
    p.description = description;
    return p;
}

ParamSpec& ParamSpec::req() { required = true; return *this; }
ParamSpec& ParamSpec::def(double v) { has_default = true; default_number = v; return *this; }
ParamSpec& ParamSpec::def_text(const std::string& v) { has_default = true; default_text = v; return *this; }
ParamSpec& ParamSpec::def_bool(bool v) { has_default = true; default_bool = v; return *this; }
ParamSpec& ParamSpec::at_least(double v, bool exclusive) {
    has_min = true; min = v; min_exclusive = exclusive; return *this;
}
ParamSpec& ParamSpec::at_most(double v, bool exclusive) {
    has_max = true; max = v; max_exclusive = exclusive; return *this;
}
ParamSpec& ParamSpec::constrained(const std::string& c) { constraint = c; return *this; }
ParamSpec& ParamSpec::internal_only() { internal = true; return *this; }

// ------------------------------------------------------------ validate_params

namespace {

const ParamSpec* find_spec(const ComponentInfo& info, const std::string& name) {
    for (const auto& p : info.params)
        if (p.name == name) return &p;
    return nullptr;
}

std::string fmt(double v) {
    std::ostringstream o;
    o << v;
    return o.str();
}

}  // namespace

bool validate_params(const ComponentInfo& info,
                     const std::map<std::string, double>& params,
                     const std::map<std::string, std::string>& text_params,
                     std::string& err) {
    const std::string who = info.type;

    for (const auto& kv : params) {
        const ParamSpec* s = find_spec(info, kv.first);
        if (!s) { err = who + " 未知参数 " + kv.first; return false; }
        if (s->type == ParamType::String || s->type == ParamType::Enum) {
            err = who + " 参数 " + kv.first + " 是文本类型，不能按数值给"; return false;
        }
        const double v = kv.second;
        if (s->type == ParamType::Bool) {
            if (v != 0.0 && v != 1.0) { err = who + " 参数 " + kv.first + " 是布尔量，只接受 0 或 1"; return false; }
            continue;
        }
        if (v != v) { err = who + " 参数 " + kv.first + " 不是数"; return false; }
        if (s->has_min && (s->min_exclusive ? !(v > s->min) : !(v >= s->min))) {
            err = who + " 参数 " + kv.first + " = " + fmt(v) + " 低于下限 " + fmt(s->min) +
                  (s->min_exclusive ? "（不含）" : "");
            return false;
        }
        if (s->has_max && (s->max_exclusive ? !(v < s->max) : !(v <= s->max))) {
            err = who + " 参数 " + kv.first + " = " + fmt(v) + " 高于上限 " + fmt(s->max) +
                  (s->max_exclusive ? "（不含）" : "");
            return false;
        }
    }

    for (const auto& kv : text_params) {
        const ParamSpec* s = find_spec(info, kv.first);
        if (!s) { err = who + " 未知参数 " + kv.first; return false; }
        if (s->type == ParamType::Number || s->type == ParamType::Bool) {
            err = who + " 参数 " + kv.first + " 是数值类型，不能按文本给"; return false;
        }
        if (s->type == ParamType::Enum &&
            std::find(s->enum_values.begin(), s->enum_values.end(), kv.second) == s->enum_values.end()) {
            err = who + " 参数 " + kv.first + " 取值 \"" + kv.second + "\" 不在枚举内";
            return false;
        }
    }

    for (const auto& s : info.params) {
        if (!s.required) continue;
        const bool numeric = (s.type == ParamType::Number || s.type == ParamType::Bool);
        const bool present = numeric ? params.count(s.name) > 0 : text_params.count(s.name) > 0;
        if (!present) { err = who + " 缺必填参数 " + s.name; return false; }
    }
    return true;
}

// ------------------------------------------------------------------- Registry

bool Registry::add(const std::string& type, Factory factory, std::string& err) {
    if (type.empty()) { err = "组件类型名为空"; return false; }
    if (factories_.count(type)) { err = "组件类型重复注册：" + type; return false; }
    factories_[type] = std::move(factory);
    return true;
}

std::vector<std::string> Registry::types() const {
    std::vector<std::string> out;
    for (const auto& kv : factories_) out.push_back(kv.first);   // std::map 已按键排序
    return out;
}

bool Registry::has(const std::string& type) const { return factories_.count(type) > 0; }

std::unique_ptr<IComponent> Registry::create(const std::string& type, std::string& err) const {
    auto it = factories_.find(type);
    if (it == factories_.end()) {
        err = "未知组件类型 " + type;
        return nullptr;
    }
    return it->second();
}

bool Registry::describe(const std::string& type, ComponentInfo& out, std::string& err) const {
    auto c = create(type, err);
    if (!c) return false;
    out = c->describe();
    return true;
}

std::unique_ptr<IComponent> Registry::create_configured(
        const std::string& type,
        const std::map<std::string, double>& params,
        const std::map<std::string, std::string>& text_params,
        std::string& err) const {
    auto c = create(type, err);
    if (!c) return nullptr;
    if (!validate_params(c->describe(), params, text_params, err)) return nullptr;
    if (!c->configure(params, text_params, err)) return nullptr;
    return c;
}

Registry builtin_registry() {
    Registry r;
    std::string err;
    // 这些都是首次注册，失败只可能是编码错误；用断言式处理而不是吞掉。
    bool ok = true;
    ok = r.add<ToneSource>(err) && ok;
    ok = r.add<NoiseSource>(err) && ok;
    ok = r.add<FileReplaySource>(err) && ok;
    ok = r.add<AddMixer>(err) && ok;
    ok = r.add<EnergyDetector>(err) && ok;
    ok = r.add<SpectrumAnalyzer>(err) && ok;
    ok = r.add<ObservationTap>(err) && ok;
    ok = r.add<DetectionSink>(err) && ok;
    (void)ok;
    return r;
}

}  // namespace cuav
