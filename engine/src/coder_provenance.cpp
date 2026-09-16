// Coder 产物的溯源串 —— 本文件由脚本生成，不要手改。
//
// 生成：uv run --quiet python scripts/gen_coder_provenance.py
// 核对：uv run --quiet python scripts/gen_coder_provenance.py --verify
//
// 08 报告 §13 第 4 条：Coder 产物的组件把 implementation 置为 coder、source_ref 必填，
// 须含来源 .m 的路径、MATLAB 与 Coder 的版本、codegen 参数哈希；目录导出时校验，
// 缺失即拒绝（engine/src/catalog.cpp:65-69）。引擎不在 describe() 时读文件，故编进来。
//
// 产物文件的 sha256 也编进来：单测据此核对「入库的 .c 与生成它的那一次是同一份」，
// 「手改了生成物」或「改了 .m 忘了重生成」都会当场红（铁律 10）。

#include "cuav/coder_provenance.h"

namespace cuav {
namespace coder_provenance {

// Channelizer：models/channelizer/coder/
const char* pfb_source_ref() {
    return "matlab/ref/{cuav_pfb_cycle.m, cuav_pfb_m16.m, cuav_pfb_m2.m, cuav_pfb_m32.m, cuav_pfb_m4.m, cuav_pfb_m64.m, cuav_pfb_m8.m}｜来源集 sha256 5dddefa49112a750｜MATLAB 25.1.0.2973910 (R2025a) Update 1｜Coder 25.1 (R2025a)｜codegen 参数 sha256 c7f76b71131a0094｜models/channelizer/coder/";
}

const char* pfb_args_sha256() { return "c7f76b71131a009442a82795c44ce7e0505d69de8d10f40fb3f1b050ec634e27"; }

namespace {
const FileHash k_pfb_files[] = {
    { "cuav_pfb_m16.c", "a19449107108bb2632d614fc9586aa1f6fe10e05e752e5f49c7d34410cbfdd06" },
    { "cuav_pfb_m16.h", "a69c134f624e19be765c36a08b23f4782f510359d868f5572d0d2ba03d00711a" },
    { "cuav_pfb_m2.c", "ceac9620ac6b70c113cdfb0d07de8f7559947c80c2cf180791c104ee469dd740" },
    { "cuav_pfb_m2.h", "9449fa6aaf6e669a65acba8a60214737453f76dab5b1f2f815d7eb8396d66e07" },
    { "cuav_pfb_m2_data.h", "dd00789708505b4e4db882aa8003092c89cb188617d02f124c20997d1f6b6f24" },
    { "cuav_pfb_m2_initialize.c", "fb0d1e4746b38401c177f5d973fc9f81a1bbec45662c86fe15950ea834d5259d" },
    { "cuav_pfb_m2_initialize.h", "9904bbe6b1ea94151327d7aa75bd42a951843e205c17e49a172347088a7bffd0" },
    { "cuav_pfb_m2_terminate.c", "1eb9040d9c4d9f8be82d32f46160cfadb74dcdca5b15bdba797a67d631a1b91c" },
    { "cuav_pfb_m2_terminate.h", "7478b7704728cc90d62f219071dc732ee302339feb13d1d40dff3b008b66322c" },
    { "cuav_pfb_m2_types.h", "a578a528ab10ed3df0b99e03284af4bad45e233f5a57a66ec0d32ee26dfedc7c" },
    { "cuav_pfb_m32.c", "97ae45577855af9a33be7e75adbf212df0d5a87d7d402e79dbda254c9ab7b6ee" },
    { "cuav_pfb_m32.h", "3a8a20dce920799e0cf2576f4955525ef1e585874ec5b4d6a5d42f94a41be33f" },
    { "cuav_pfb_m4.c", "4171d129c5092c2271d934b00f82a6733c71bb98497add0637e525ef1435928d" },
    { "cuav_pfb_m4.h", "d517fd722fbdf511a06af4d58f0e00061e985a355245635eb4efa828009e13ab" },
    { "cuav_pfb_m64.c", "4e848599bd86a206f2679e0947aab48a69200d51ff3fcdd29f63401f2880d837" },
    { "cuav_pfb_m64.h", "381a1e41af4fe93250a950304642a9ba7958aa33427d33bdfb873755a1ccec6d" },
    { "cuav_pfb_m8.c", "c5918489b3a5dd1274e341a291e2fefa7bd5bc71d65d93bc9eb82cb50f3544b9" },
    { "cuav_pfb_m8.h", "df7080fb2b46d26b219117ceb57fd9a5c6a61a435ab8d064fabb5c1c21baef5f" },
    { "flipud.c", "7d0c6589fb2b95a84c1e2d0102e8fd001634385f05d593de9f9c94e75495a892" },
    { "flipud.h", "ea85592fc3286d927556a667656c2ac113e04abbd14ca67290904a6c076f92d0" },
    { "ifft.c", "cadc825ec09750692a04f3e83bafe67c103186de3a08b64cfb01a667ec350503" },
    { "ifft.h", "854997fa81cabfda6a00671b2c52cab005d70e89d6c838fe8fd509489955c881" },
    { "rtwtypes.h", "1854e8035a03d50340c2a6b0dc21f49fc560b38fcf9cfb0653dbbe44d67ef483" },
    { "sum.c", "569d57494f9adf3099061286b1705ccacde53b7615a493fa0291926aeb66f349" },
    { "sum.h", "e61980bf1f8d7933c7a240347f7d45000ed12d5b57b573bac5b13ed11b57025d" },
};
}  // namespace

std::size_t pfb_file_count() { return sizeof(k_pfb_files) / sizeof(k_pfb_files[0]); }
const FileHash& pfb_file_at(std::size_t i) { return k_pfb_files[i]; }

// RxFilter：models/receiver/coder/
const char* rx_source_ref() {
    return "matlab/ref/{cuav_rx_fir.m}｜来源集 sha256 74fdd8ada73e105e｜MATLAB 25.1.0.2973910 (R2025a) Update 1｜Coder 25.1 (R2025a)｜codegen 参数 sha256 b2655fcaa2341c7c｜models/receiver/coder/";
}

const char* rx_args_sha256() { return "b2655fcaa2341c7cb16defccea44f8315a6c7163b35ca574c7ec0e5e400d8004"; }

namespace {
const FileHash k_rx_files[] = {
    { "cuav_rx_fir.c", "2e0954129612c31049f543d08bf32b9a13b76145439fb82e2976849e33243704" },
    { "cuav_rx_fir.h", "60b034a920d1bc93b9c268ad1a8fe8c44bf2896c5ba6cda1a3ba85adb1833ff1" },
    { "cuav_rx_fir_data.h", "f10506d1c9d141b9fb462d6e3c2bdbcf5dd1ff48062e53f2e470806cedbfe5f2" },
    { "cuav_rx_fir_initialize.c", "2b157a35e9afd826162418ad6f256981dd5270e1bb608bc45ff1d2d0e37d80fa" },
    { "cuav_rx_fir_initialize.h", "c239aaf0047feebaa3d0b7a5bacbd644f60f40c8c784dc513529442fa473930b" },
    { "cuav_rx_fir_terminate.c", "913e68e2f505fbbae425570996655cfce892bc1e5c541f2dd1a16369009b482e" },
    { "cuav_rx_fir_terminate.h", "a5b5e418f4adb7bc17e9212b7b251b2757965726184a765f9635cc91b49ec95a" },
    { "cuav_rx_fir_types.h", "7569b28a44eb89fee3b70140a4f2eb0e2760ea25fe1ee10cf646a4e3c13b5526" },
    { "filter.c", "ecbcad2d9cd0293d55bebd0c7737b0186a2bdc9038abb81b2f0e3b6de50e1ecf" },
    { "filter.h", "438bc1dc8d5b380912d917fa0fe485f854b62316852ea27498bb6aec19423059" },
    { "rtwtypes.h", "1854e8035a03d50340c2a6b0dc21f49fc560b38fcf9cfb0653dbbe44d67ef483" },
};
}  // namespace

std::size_t rx_file_count() { return sizeof(k_rx_files) / sizeof(k_rx_files[0]); }
const FileHash& rx_file_at(std::size_t i) { return k_rx_files[i]; }

}  // namespace coder_provenance
}  // namespace cuav
