// 组件目录导出：把注册表里每个组件的自描述与端口兼容矩阵写成 docs/component-catalog.md
// 规定的 JSON（schema cuav-catalog/1）。
//
// 目录是画布、参数表单、连线校验的唯一规则来源（决策 D-030）。port_compat 由 can_connect()
// 全枚举导出，前端不手抄连线规则。黄金基准 tests/golden/component-catalog.json 由
// cuav_run --catalog（B-4）首次生成；比较规则是「已有条目不变」（docs/component-catalog.md 第 5 节）。

#ifndef CUAV_CATALOG_H
#define CUAV_CATALOG_H

#include "nlohmann/json.hpp"

#include "cuav/registry.h"

namespace cuav {

// 输出确定性的：组件按类型名排序，参数按声明顺序，兼容矩阵按端口类型枚举顺序。
// 不含 generated_at；需要时由调用方（cuav_run）加，免得黄金基准每次都变。
nlohmann::json catalog_json(const Registry& registry);

// 目录的自检：每个组件都有六类之一的类别、M/E 等级与版本；参数名不重复；coder 产物带 source_ref。
// 不合规的条目会让目录生成失败而不是带病输出。
bool validate_catalog_entry(const ComponentInfo& info, std::string& err);

}  // namespace cuav

#endif  // CUAV_CATALOG_H
