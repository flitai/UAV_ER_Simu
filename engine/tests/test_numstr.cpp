// numstr：给人看的数字怎么写成字符串。
//
// 起因是 `std::to_string(double)` 固定六位小数，于是说明里全是
// 「噪声系数 6.000000 dB，带宽 500000.000000 Hz」这种句子（用户 2026-09-20 指出）。

#include "doctest/doctest.h"

#include <cstddef>
#include <cstdint>
#include <limits>

#include "cuav/numstr.h"

using cuav::numstr;

TEST_CASE("整数值写成整数，不拖六位小数") {
    CHECK(numstr(6.0) == "6");
    CHECK(numstr(500000.0) == "500000");
    CHECK(numstr(-98.0) == "-98");
    CHECK(numstr(0.0) == "0");
    // 负零在给人看的文本里没有意义
    CHECK(numstr(-0.0) == "0");
}

TEST_CASE("非整数按十位有效数字，尾随零去掉") {
    CHECK(numstr(-111.0103) == "-111.0103");
    CHECK(numstr(0.01) == "0.01");
    CHECK(numstr(0.5) == "0.5");
    CHECK(numstr(2.5e-7) == "2.5e-07");
    // 十位有效数字：既够用，又不至于把浮点噪声抖出来
    CHECK(numstr(0.1 + 0.2) == "0.3");           // 真值是 0.30000000000000004
    CHECK(numstr(1.0 / 3.0) == "0.3333333333");
}

TEST_CASE("大整数值不退化成科学记数法") {
    CHECK(numstr(2440500000.0) == "2440500000");
    CHECK(numstr(1e14) == "100000000000000");
    // 超过 1e15 之后每个整数不再都能精确表示，转交 %.10g，不假装还是整数
    CHECK(numstr(1e16) == "1e+16");
}

TEST_CASE("非有限值照实写，不崩也不假装是数") {
    CHECK(numstr(std::numeric_limits<double>::quiet_NaN()) == "nan");
    CHECK(numstr(std::numeric_limits<double>::infinity()) == "inf");
    CHECK(numstr(-std::numeric_limits<double>::infinity()) == "-inf");
}

TEST_CASE("整数类型走 std::to_string，逐字不变") {
    CHECK(numstr(0) == "0");
    CHECK(numstr(609142) == "609142");
    CHECK(numstr(-1) == "-1");
    CHECK(numstr(static_cast<std::size_t>(10000000)) == "10000000");
    CHECK(numstr(static_cast<std::uint64_t>(18446744073709551615ULL)) == "18446744073709551615");
    // 这一条是本文件存在的另一个理由：写头文件时把整数重载写成了 numstr(v) 自己调自己，
    // 编译得过、一跑就栈溢出（SIGTRAP），17 项 ctest 全红才发现（2026-09-21）。
    CHECK(numstr(42) == "42");
}
