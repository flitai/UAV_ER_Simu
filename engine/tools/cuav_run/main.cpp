// cuav_run 可执行入口（B-4）。全部逻辑在 runner.cpp，这里只做 argv 与进程退出码。
#include <iostream>

#include "runner.h"

int main(int argc, char** argv) {
    cuav::runner::Options opt;
    std::string err;
    if (!cuav::runner::parse_args(argc, argv, opt, err)) {
        std::cerr << err << "\n" << cuav::runner::usage();
        return cuav::runner::ExitUsage;
    }
    return cuav::runner::run(opt, std::cout, std::cerr);
}
