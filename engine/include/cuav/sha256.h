// SHA-256（FIPS 180-4）。
//
// 为什么自己写：框图的 scenario_ref.sha256 与场景的 aoi.manifest_sha256 都要真核对
// （docs/diagram-format.md §7、docs/scenario-format.md §2），而引擎不得引入网络或平台加密库
// （铁律 6、16）。实现约一百行、零依赖、逐位可复现，带 NIST 测试向量单测。
//
// 与 platform.{h,cpp} 分开放：那边是操作系统抽象（目录、原子替换、字节序），这里是纯计算。

#ifndef CUAV_SHA256_H
#define CUAV_SHA256_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace cuav {

class Sha256 {
public:
    Sha256();
    void update(const void* data, std::size_t len);
    // 小写 64 位十六进制。调用后对象定型，再 update 无效。
    std::string hex();

private:
    void compress(const std::uint8_t block[64]);

    std::uint32_t h_[8];
    std::uint8_t buf_[64];
    std::size_t buf_len_;
    std::uint64_t total_bits_;
    bool done_;
    std::string hex_;
};

std::string sha256_hex(const std::string& bytes);

// 按二进制流读整个文件求哈希。打不开写 err 返回 false——不返回空串顶替（铁律 15）。
bool sha256_file(const std::string& path, std::string& hex, std::string& err);

}  // namespace cuav

#endif  // CUAV_SHA256_H
