// GFSK 族机型预设表 v1 —— 本文件由脚本生成，不要手改。
//
// 来源：models/radiator/gfsk-presets-v1.json（sha256 a0c2c7f87150f2d0f08a04e4b285ce1ba16f0a37953412a510c75b0fe788b125）
// 生成：uv run --quiet python scripts/gen_gfsk_presets.py
//
// 每项参数的出处档（V / P / S / A / D / M）与引文只在 JSON 的 provenance 里，这里只放
// 生成与评价要用的数。与 JSON 的一致性由 engine/tests/test_gfsk.cpp 逐项核对（铁律 10）。
// 跳频频点表不在这里：频点写在场景的 hop 活动里（由 algos/reference/gfsk_ref.py 生成）。

#include "cuav_geo/gfsk_presets.h"

namespace cuav {
namespace geo {
namespace {

const GfskPacket kFrskyD16v2FccPackets[1] = {
    { 0.0, 219 },
};
const GfskPacket kFutabaSfhssPackets[2] = {
    { 0.0, 184 },
    { 0.001625, 184 },
};

const GfskPreset kPresets[] = {
    {
        "frsky-d16v2-fcc", "gfsk", "rc_hopping", "V2",
        1, 1.0,
        76965.33203125, 57128.90625, 191223.14453125,
        32, 0xD391D391u, 32,
        0.007, 1, kFrskyD16v2FccPackets,
        0.007,
    },
    {
        "futaba-sfhss", "gfsk", "rc_hopping", "V2",
        0, 0.0,
        128143.310546875, 38085.9375, 204315.185546875,
        32, 0xD391D391u, 32,
        0.0068, 2, kFutabaSfhssPackets,
        0.0068,
    },
};

const char kSha256[] = "a0c2c7f87150f2d0f08a04e4b285ce1ba16f0a37953412a510c75b0fe788b125";

}  // namespace

const GfskPreset* gfsk_preset_v1(const std::string& id) {
    for (std::size_t i = 0; i < sizeof(kPresets) / sizeof(kPresets[0]); ++i) {
        if (id == kPresets[i].id) return &kPresets[i];
    }
    return 0;  // 不在表里：由调用方报错并列出可取值，不静默顶替（铁律 15）
}

std::size_t gfsk_preset_v1_count() { return sizeof(kPresets) / sizeof(kPresets[0]); }

const GfskPreset& gfsk_preset_v1_at(std::size_t i) { return kPresets[i]; }

const char* gfsk_presets_v1_sha256() { return kSha256; }

}  // namespace geo
}  // namespace cuav
