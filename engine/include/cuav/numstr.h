// 给人看的数字怎么写成字符串。
//
// 起因：`numstr(double)` 等价于 `printf("%f")`，**固定六位小数**，于是
// 组件说明与错误报文里全是「等效输入噪声 -111.010300 dBm（噪声系数 6.000000 dB,
// 带宽 500000.000000 Hz）」这种读不下去的句子（用户 2026-09-20 指出）。
//
// 规则两条：
//   1. 值是整数就写成整数——频率、样点数、计数这类最常见，`500000` 不是 `500000.000000`；
//   2. 其余按十位有效数字并去掉尾随零（`%.10g`）——十位对 double 够用，又不至于把
//      0.1 + 0.2 这种浮点噪声（0.30000000000000004）原样抖出来。
//
// **只用于给人看的文本**，不要用它写数据文件：产物与黄金基准的数字走各自的序列化路径，
// 那里要的是可复现的精度不是好看（铁律 9、10）。
//
// C++14。

#ifndef CUAV_NUMSTR_H
#define CUAV_NUMSTR_H

#include <string>
#include <type_traits>

namespace cuav {

/** 浮点：整数值写成整数，其余十位有效数字去尾随零。非有限值写成 nan / inf / -inf。 */
std::string numstr(double v);

/** 整数：与 std::to_string 逐字相同，重载在这里只是为了调用点不必区分类型。 */
template <typename T, typename std::enable_if<std::is_integral<T>::value, int>::type = 0>
std::string numstr(T v) { return std::to_string(v); }

}  // namespace cuav

#endif  // CUAV_NUMSTR_H
