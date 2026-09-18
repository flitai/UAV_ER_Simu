// Coder 产物的溯源与完整性（M-3，D-071；08 报告 §13 第 4 条）。
//
// 两件事：
//   ① source_ref 真的带齐了 §13 要的四样（来源 .m、MATLAB 版本、Coder 版本、codegen 参数哈希），
//      而不是随便填个非空串把 catalog.cpp:65-69 那道闸糊弄过去；
//   ② 入库的每个 .c / .h 与生成它那一次的 sha256 逐位相符 —— 「手改了生成物」与
//      「改了 .m 忘了重生成」都会在这里当场红（铁律 10）。
//
// 这道核对在引擎侧再做一遍（scripts/gen_coder_provenance.py --verify 也做），
// 因为交付与 CI 都不装 MATLAB，产物是否被动过只能靠哈希说话。

#include <string>

#include "cuav/coder_provenance.h"
#include "cuav/sha256.h"
#include "doctest/doctest.h"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif

bool has(const std::string& s, const char* needle) { return s.find(needle) != std::string::npos; }

void check_ref(const std::string& ref, const char* dir) {
    CHECK_FALSE(ref.empty());
    CHECK_MESSAGE(has(ref, "matlab/ref/"), "source_ref 没写来源 .m 的路径：" << ref);
    CHECK_MESSAGE(has(ref, ".m"), "source_ref 没写来源 .m 的路径：" << ref);
    CHECK_MESSAGE(has(ref, "MATLAB "), "source_ref 没写 MATLAB 版本：" << ref);
    CHECK_MESSAGE(has(ref, "Coder "), "source_ref 没写 Coder 版本：" << ref);
    CHECK_MESSAGE(has(ref, "codegen 参数 sha256 "), "source_ref 没写 codegen 参数哈希：" << ref);
    CHECK_MESSAGE(has(ref, "来源集 sha256 "), "source_ref 没写来源集哈希：" << ref);
    CHECK_MESSAGE(has(ref, dir), "source_ref 没写产物目录：" << ref);
}

void check_files(const char* dir, std::size_t n,
                 const coder_provenance::FileHash& (*at)(std::size_t)) {
    REQUIRE_MESSAGE(n > 0u, "溯源里一个产物文件都没有：跑 scripts/gen_coder_provenance.py");
    std::size_t ok = 0;
    for (std::size_t i = 0; i < n; ++i) {
        const coder_provenance::FileHash& f = at(i);
        const std::string path = std::string(CUAV_SOURCE_DIR) + "/../" + dir + "/" + f.name;
        std::string hex, err;
        // 报文里的文件名要包一层 std::string：MSVC 上直接把 `const char*` 交给 doctest
        // 会打印成指针地址（D3-8 实测：`00007FF6636423F0 与入库时的 sha256 对不上`），
        // 失败时就看不出是哪个产物——而这条测试失败时唯一要回答的问题就是"哪一个"。
        REQUIRE_MESSAGE(sha256_file(path, hex, err),
                        "读不到产物 " << std::string(f.name) << "：" << err);
        CHECK_MESSAGE(hex == std::string(f.sha256),
                      std::string(f.name) << " 与入库时的 sha256 对不上：产物被改过，"
                                             "或改了 .m 重生成后没跑 scripts/gen_coder_provenance.py");
        if (hex == std::string(f.sha256)) ++ok;
    }
    MESSAGE(std::string(dir) << "：" << ok << " / " << n << " 个产物文件哈希相符");
}
}  // namespace

TEST_CASE("Coder 溯源：source_ref 带齐 08 §13 第 4 条要的四样") {
    check_ref(coder_provenance::pfb_source_ref(), "models/channelizer/coder/");
    check_ref(coder_provenance::rx_source_ref(), "models/receiver/coder/");
    // codegen 参数哈希是完整的 64 位，source_ref 里只截前 16 位便于阅读
    CHECK(std::string(coder_provenance::pfb_args_sha256()).size() == 64u);
    CHECK(std::string(coder_provenance::rx_args_sha256()).size() == 64u);
    // 两套产物的 codegen 参数不同（接口尺寸不同），哈希必须不同——相同说明哈希没把参数算进去
    CHECK(std::string(coder_provenance::pfb_args_sha256())
          != std::string(coder_provenance::rx_args_sha256()));
}

TEST_CASE("Coder 溯源：入库的每个产物文件与生成它那一次逐位相符") {
    check_files("models/channelizer/coder", coder_provenance::pfb_file_count(),
                &coder_provenance::pfb_file_at);
    check_files("models/receiver/coder", coder_provenance::rx_file_count(),
                &coder_provenance::rx_file_at);
}
