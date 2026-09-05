// 组件参数描述。
//
// 依据：04 §8.4「模型组件规范」（每个组件至少声明参数、单位、默认值与有效范围）；
// docs/component-catalog.md 第 4 节 ParamSpec；06 备忘录 §9A B-1。
//
// 这里只描述，不校验；校验在 registry.h 的 validate_params()，它和组件自己的 configure()
// 是同一套规则的两道闸：前者按描述挡住未知参数、缺必填、越界与枚举取值错误，并把参数名写进
// 报错；后者做跨参数约束（如奈奎斯特检查）。两道闸都不拿默认值顶替缺失的必填项（铁律 15）。

#ifndef CUAV_PARAM_SPEC_H
#define CUAV_PARAM_SPEC_H

#include <string>
#include <vector>

namespace cuav {

// 框图文件只允许四种参数类型（docs/diagram-format.md 第 3 节）。
enum class ParamType { Number = 0, String, Enum, Bool };
const char* to_string(ParamType t);

struct ParamSpec {
    std::string name;
    ParamType type = ParamType::Number;
    std::string unit;                 // SI 单位字符串，无单位为空
    bool required = false;

    bool has_min = false, min_exclusive = false;
    double min = 0.0;
    bool has_max = false, max_exclusive = false;
    double max = 0.0;

    bool has_default = false;
    double default_number = 0.0;
    std::string default_text;
    bool default_bool = false;

    std::vector<std::string> enum_values;
    std::string description;
    std::string constraint;           // 跨参数约束的文字描述，校验在组件 configure() 里做
    // 内部参数：由装载器解析注入（如按 data_id 解析出的文件位置），不进画布，
    // 不得出现在框图文件里（04 §8.6 不向浏览器暴露服务器路径；决策 D-037）。
    bool internal = false;

    // 链式构造，让组件的 describe() 读起来像一张表。
    static ParamSpec number(const std::string& name, const std::string& unit,
                            const std::string& description);
    static ParamSpec text(const std::string& name, const std::string& description);
    static ParamSpec choice(const std::string& name, const std::vector<std::string>& values,
                            const std::string& description);
    static ParamSpec boolean(const std::string& name, const std::string& description);

    ParamSpec& req();
    ParamSpec& def(double v);
    ParamSpec& def_text(const std::string& v);
    ParamSpec& def_bool(bool v);
    ParamSpec& at_least(double v, bool exclusive = false);
    ParamSpec& at_most(double v, bool exclusive = false);
    ParamSpec& constrained(const std::string& c);
    ParamSpec& internal_only();
};

}  // namespace cuav

#endif  // CUAV_PARAM_SPEC_H
