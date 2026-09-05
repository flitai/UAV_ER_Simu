#include "cuav/platform.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>

#ifdef _WIN32
#include <direct.h>
#include <windows.h>
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <cerrno>
#endif

namespace cuav {
namespace platform {

namespace {

bool mkdir_one(const std::string& p, std::string& err) {
#ifdef _WIN32
    if (_mkdir(p.c_str()) == 0) return true;
    if (errno == EEXIST) return true;
    err = "建目录失败：" + p;
    return false;
#else
    if (::mkdir(p.c_str(), 0755) == 0) return true;
    if (errno == EEXIST) return true;
    err = "建目录失败：" + p + "（errno " + std::to_string(errno) + "）";
    return false;
#endif
}

}  // namespace

bool make_dirs(const std::string& path, std::string& err) {
    if (path.empty()) { err = "目录为空"; return false; }
    std::string cur;
    for (std::size_t i = 0; i < path.size(); ++i) {
        const char ch = path[i];
        cur.push_back(ch);
        const bool sep = (ch == '/');
        const bool last = (i + 1 == path.size());
        if ((sep && cur.size() > 1) || last) {
            std::string dir = cur;
            if (sep) dir.pop_back();
            if (dir.empty() || dir == "." ) continue;
#ifdef _WIN32
            if (dir.size() == 2 && dir[1] == ':') continue;   // 盘符
#endif
            if (!mkdir_one(dir, err)) return false;
        }
    }
    return true;
}

bool atomic_replace(const std::string& tmp, const std::string& dst, std::string& err) {
#ifdef _WIN32
    if (!MoveFileExA(tmp.c_str(), dst.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        err = "替换文件失败：" + dst;
        return false;
    }
    return true;
#else
    if (std::rename(tmp.c_str(), dst.c_str()) != 0) {
        err = "替换文件失败：" + dst + "（errno " + std::to_string(errno) + "）";
        return false;
    }
    return true;
#endif
}

bool is_little_endian() {
    const std::uint32_t v = 0x01020304u;
    unsigned char b[4];
    std::memcpy(b, &v, 4);
    return b[0] == 0x04;
}

std::string join(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    if (b.empty()) return a;
    const bool a_sep = a[a.size() - 1] == '/';
    const bool b_sep = b[0] == '/';
    if (a_sep && b_sep) return a + b.substr(1);
    if (!a_sep && !b_sep) return a + "/" + b;
    return a + b;
}

std::string utc_now_iso8601() {
    const std::time_t t = std::time(nullptr);
    std::tm tm;
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[32];
    std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

}  // namespace platform
}  // namespace cuav
