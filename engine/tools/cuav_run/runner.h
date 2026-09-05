// cuav_run 运行器（06 备忘录 §9A B-4；决策 D-031：引擎运行形态 = 子进程 + 定长二进制产品文件 + stdout JSON 事件）。
//
// 子命令：
//   --catalog                          组件目录 JSON（docs/component-catalog.md），黄金基准 tests/golden/component-catalog.json 由此生成
//   --validate <框图>                  只校验：装成 Graph 并 validate()，不落盘；错误带 {code, node_id, port, message}
//   --run <框图> --out <目录> [--task-id <id>] [--seed N] [--resolved <旁挂> | --data-index <索引>...]
//                                      运行：产品写 <目录>/<观测点>/…，事件写 stdout 并原样落 <目录>/events.jsonl
//   --scenario-track <场景>            航迹预览（G-2 后实现，现在返回 ExitUsage 并说明）
//
// stdout 每行一条 JSON 事件，信封与 WebSocket 文本帧相同（docs/api-versions.md §4）：
//   {seq, task_id, type, t_s, payload}，seq 从 1 单调递增。
// 事件与退出码的约定见 docs/api-versions.md §4.1。诊断文字走 stderr，不混进事件流。
//
// 逻辑与 main.cpp 分开放在这里，是为了让 doctest 直接驱动 run() 检查事件流，不必起子进程。

#ifndef CUAV_RUN_RUNNER_H
#define CUAV_RUN_RUNNER_H

#include <cstdint>
#include <ostream>
#include <string>
#include <vector>

namespace cuav {
namespace runner {

enum class Mode { None = 0, Help, Catalog, Validate, Run, ScenarioTrack };

struct Options {
    Mode mode = Mode::None;
    std::string diagram_path;
    std::string out_dir;
    std::string task_id;                          // 缺省：--out 的末级目录名（运行）或 diagram_id（校验）
    bool seed_given = false;
    std::uint64_t seed = 0;                       // --seed 覆盖框图 run.seed，事件里写明来源
    std::string resolved_path;                    // 解析旁挂 cuav-resolved/1（docs/diagram-format.md §9）
    std::vector<std::string> data_index_paths;    // 数据索引 index.manifest.json，可多份
    std::string scenario_path;
    std::uint64_t progress_interval_ms = 100;     // progress 事件的最小墙钟间隔；0 = 每轮都发
};

// 退出码约定（docs/api-versions.md §4.1）
enum ExitCode {
    ExitOk = 0,          // 目录已输出 / 校验通过 / 运行到底（结果四态在 task.state 事件里，不影响退出码）
    ExitUsage = 1,       // 命令行错误，或尚未实现的子命令
    ExitDiagram = 2,     // 框图装载失败（含解析旁挂 / 数据索引读不到）：已发 error 事件
    ExitRunFailed = 3,   // 运行失败（初始化、处理、收尾、调度停滞、超轮数）：已发 error 与 task.state failed
    ExitIo = 4,          // 产品目录建不了或 events.jsonl 打不开
};

// argv → Options。失败写 err 并返回 false，调用方打印 usage() 后以 ExitUsage 退出。
bool parse_args(int argc, const char* const* argv, Options& opt, std::string& err);
const char* usage();

// 执行。events 收 stdout 的 JSON 行（--catalog 时收目录 JSON），diag 收人读的诊断。返回退出码。
int run(const Options& opt, std::ostream& events, std::ostream& diag);

}  // namespace runner
}  // namespace cuav

#endif  // CUAV_RUN_RUNNER_H
