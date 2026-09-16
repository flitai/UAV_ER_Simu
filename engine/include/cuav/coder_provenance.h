// Coder 产物的溯源串（M-3，D-071）。实现在 engine/src/coder_provenance.cpp，由
// scripts/gen_coder_provenance.py 生成，不要手改。
//
// 为什么编进来而不是运行时读 models/<环节>/coder/PROVENANCE.json：组件在 describe() 时就要给出
// source_ref（`catalog.cpp:65-69` 的校验发生在目录导出，那时还没有任何部署目录的概念），
// 读文件会让组件依赖部署目录布局——与 ddc_taps.cpp 不在运行时读 JSON 是同一条理由。

#ifndef CUAV_CODER_PROVENANCE_H
#define CUAV_CODER_PROVENANCE_H

#include <cstddef>

namespace cuav {
namespace coder_provenance {

// 一个产物文件与它入库那一刻的 sha256。单测据此核对「入库的 .c 与生成它的那一次是同一份」。
struct FileHash {
    const char* name;
    const char* sha256;
};

// 多相 FFT 信道化（models/channelizer/coder/）
const char* pfb_source_ref();
const char* pfb_args_sha256();
std::size_t pfb_file_count();
const FileHash& pfb_file_at(std::size_t i);

// 接收滤波（models/receiver/coder/）
const char* rx_source_ref();
const char* rx_args_sha256();
std::size_t rx_file_count();
const FileHash& rx_file_at(std::size_t i);

}  // namespace coder_provenance
}  // namespace cuav

#endif  // CUAV_CODER_PROVENANCE_H
