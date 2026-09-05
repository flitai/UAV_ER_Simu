// 组件目录黄金基准（docs/component-catalog.md §5）：比较规则是「已有条目不变」——
// 基准里每个组件的 type、ports、params 与当前目录逐字相同，端口类型与兼容矩阵相同；新增组件允许。
// 基准文件 tests/golden/component-catalog.json（仓库根）由 cuav_run --catalog 生成；变化即为发现（铁律 10）。
#include "doctest/doctest.h"

#include <fstream>
#include <string>

#include "nlohmann/json.hpp"

#include "cuav/catalog.h"
#include "cuav/registry.h"

using namespace cuav;

TEST_CASE("组件目录黄金基准：已有组件的 type / ports / params 与端口兼容矩阵不变") {
    const std::string path = std::string(CUAV_SOURCE_DIR) + "/../tests/golden/component-catalog.json";
    std::ifstream f(path.c_str());
    REQUIRE_MESSAGE(f.good(), "打不开黄金基准 " << path << "；首次生成：cuav_run --catalog > tests/golden/component-catalog.json");
    nlohmann::json golden;
    f >> golden;
    nlohmann::json cur = catalog_json(builtin_registry());

    CHECK(golden["schema_version"] == cur["schema_version"]);
    CHECK(golden["port_types"] == cur["port_types"]);
    CHECK(golden["port_compat"] == cur["port_compat"]);

    for (const auto& g : golden["components"]) {
        const std::string type = g["type"].get<std::string>();
        const nlohmann::json* found = nullptr;
        for (const auto& c : cur["components"]) if (c["type"] == type) { found = &c; break; }
        REQUIRE_MESSAGE(found, "基准里的组件 " << type << " 在当前目录里不存在：删组件即基准变化，须记决策");
        CHECK_MESSAGE(g["ports"] == (*found)["ports"], type << " 的端口变了");
        CHECK_MESSAGE(g["params"] == (*found)["params"], type << " 的参数描述变了");
    }
    if (cur["components"].size() > golden["components"].size()) {
        MESSAGE("当前目录比基准多 " << (cur["components"].size() - golden["components"].size())
                << " 个组件：允许，更新基准时在 WORKLOG 记一条");
    }
}
