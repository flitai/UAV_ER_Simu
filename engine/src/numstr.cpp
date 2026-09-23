#include "cuav/numstr.h"

#include <cmath>
#include <cstdio>

namespace cuav {

std::string numstr(double v) {
    if (std::isnan(v)) return "nan";
    if (std::isinf(v)) return v > 0 ? "inf" : "-inf";
    char buf[48];
    // 整数值直接写整数。上界取 1e15：double 在那以下每个整数都能精确表示，
    // 再大 %.0f 会印出一串没有意义的尾数。
    if (v == std::floor(v) && std::fabs(v) < 1e15) {
        std::snprintf(buf, sizeof buf, "%.0f", v);
        // "-0" 写成 "0"：给人看的文本里负零没有意义
        if (buf[0] == '-' && buf[1] == '0' && buf[2] == '\0') return "0";
        return buf;
    }
    std::snprintf(buf, sizeof buf, "%.10g", v);
    return buf;
}

}  // namespace cuav
