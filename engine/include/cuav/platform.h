// 平台抽象层：目录、原子替换、字节序。
//
// 依据：CLAUDE.md 铁律 16（引擎不得直接调用平台私有 API；路径与编码一律经抽象层）、
// 决策 D-015 / D-016（Windows x64 与 Linux x64 双平台）。所有 #ifdef _WIN32 只允许出现在
// 本模块的实现文件里。

#ifndef CUAV_PLATFORM_H
#define CUAV_PLATFORM_H

#include <string>

namespace cuav {
namespace platform {

// 逐级建目录，已存在视为成功。路径分隔符统一用 '/'，实现层负责转换。
bool make_dirs(const std::string& path, std::string& err);

// 用 tmp 原子替换 dst（dst 可能已存在）。用于「索引最后写」：读端要么读到旧索引要么读到新索引。
bool atomic_replace(const std::string& tmp, const std::string& dst, std::string& err);

// 交换格式固定小端（docs/iq-format.md、docs/display-products.md）。首期目标平台都是小端，
// 大端机上写产品前必须显式转换；这里先把事实查出来，不静默假设。
bool is_little_endian();

// 拼路径，保证中间只有一个 '/'。
std::string join(const std::string& a, const std::string& b);

}  // namespace platform
}  // namespace cuav

#endif  // CUAV_PLATFORM_H
