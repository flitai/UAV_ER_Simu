// 组件注册表：按类型名构造组件，并按组件的自描述校验参数。
//
// 依据：04 §8.4（组件规范）、§8.6（错误码映射到具体模型与端口）；docs/component-catalog.md；
// 06 备忘录 §9A B-1。框图装载器（B-2）、cuav_run --catalog（B-4）、应用服务的
// GET /api/v1/components（B-5）都从这里取组件与描述。
//
// 注册表是显式对象，不是全局单例：builtin_registry() 每次返回一份新的，含引擎自带的
// 全部组件；用户插件（P1-9、04 §15.2 第 12 项）将来往自己的 Registry 里 add()。

#ifndef CUAV_REGISTRY_H
#define CUAV_REGISTRY_H

#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "cuav/component.h"

namespace cuav {

// 按描述校验参数。规则：
//   1. 数值表里的键必须是 Number 或 Bool 类型的参数；文本表里的键必须是 String 或 Enum 类型；
//      两张表里出现描述之外的键即为错误（未知参数不静默忽略，与框图文件「未知键拒绝」一致）。
//   2. 必填参数缺失即错误，不用默认值顶替（铁律 15）。
//   3. 数值越过 min / max 即错误；Enum 取值不在 enum_values 内即错误；Bool 只接受 0 或 1。
// 报错文本一定含参数名，便于映射回框图节点（04 §8.6）。
bool validate_params(const ComponentInfo& info,
                     const std::map<std::string, double>& params,
                     const std::map<std::string, std::string>& text_params,
                     std::string& err);

class Registry {
public:
    using Factory = std::function<std::unique_ptr<IComponent>()>;

    // 重复注册同一类型名即失败，不静默覆盖。
    bool add(const std::string& type, Factory factory, std::string& err);

    template <class T>
    bool add(std::string& err) {
        const std::string type = T().type_name();
        return add(type, []() { return std::unique_ptr<IComponent>(new T()); }, err);
    }

    std::vector<std::string> types() const;      // 按类型名排序
    bool has(const std::string& type) const;

    std::unique_ptr<IComponent> create(const std::string& type, std::string& err) const;
    bool describe(const std::string& type, ComponentInfo& out, std::string& err) const;

    // 构造 + 按描述校验 + configure()。任一步失败返回空指针并写 err。
    std::unique_ptr<IComponent> create_configured(const std::string& type,
                                                  const std::map<std::string, double>& params,
                                                  const std::map<std::string, std::string>& text_params,
                                                  std::string& err) const;

private:
    std::map<std::string, Factory> factories_;
};

// 引擎自带组件的注册表。
Registry builtin_registry();

}  // namespace cuav

#endif  // CUAV_REGISTRY_H
