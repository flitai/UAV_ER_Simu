// cuav_run 可执行入口（B-4）。全部逻辑在 runner.cpp，这里只做 argv 与进程退出码。
#include <iostream>

#include "cuav/platform.h"
#include "runner.h"

int main(int argc, char** argv) {
    // 早于任何输出：Windows 上不这么做，stdout 的 `\n` 会变成 `\r\n`，
    // 同一条事件在 events.jsonl 里与在管道里就不是同一串字节了（D3-8，D-074）。
    cuav::platform::set_stdout_binary();
    cuav::runner::Options opt;
    std::string err;
    if (!cuav::runner::parse_args(argc, argv, opt, err)) {
        std::cerr << err << "\n" << cuav::runner::usage();
        return cuav::runner::ExitUsage;
    }
    return cuav::runner::run(opt, std::cout, std::cerr);
}
