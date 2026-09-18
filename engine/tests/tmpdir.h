#ifndef CUAV_TESTS_TMPDIR_H
#define CUAV_TESTS_TMPDIR_H

// 测试用的系统临时目录（D3-8，D-074）。
//
// **为什么单独立一个头**：这四行原来在五个测试文件里各抄了一份，名字还各不相同
// （`temp_dir` / `temp_root` / `temp_dir_components`）。D3-8 第一次在 Windows 上跑时
// 它们同时坏掉——Windows 没有 `TMPDIR` 也没有 `/tmp`——于是同一个修法要做五遍。
// 抄一份是省事，改五遍是代价，这次把它收成一处。
//
// 三件事：
//   1. 变量名各平台不同：类 Unix 给 `TMPDIR`，Windows 给 `TEMP` / `TMP`；
//   2. Windows 给回来的是反斜杠，要归一成 `/`——`platform::make_dirs` 只按 `/` 切段；
//   3. 末尾补一个 `/`，调用方直接拼文件名。

#include <cstddef>
#include <cstdlib>
#include <string>

namespace cuav_test {

inline std::string temp_dir() {
    const char* t = std::getenv("TMPDIR");
    if (!t) t = std::getenv("TEMP");
    if (!t) t = std::getenv("TMP");
    std::string d = t ? t : "/tmp/";
    for (std::size_t i = 0; i < d.size(); ++i) {
        if (d[i] == '\\') d[i] = '/';
    }
    if (!d.empty() && d[d.size() - 1] != '/') d += '/';
    return d;
}

/** 本测试专用的子目录，末尾不带 `/`（调用方按既有写法自己拼 `"/xxx"`）。 */
inline std::string temp_root(const std::string& name) {
    return temp_dir() + name;
}

}  // namespace cuav_test

#endif  // CUAV_TESTS_TMPDIR_H
