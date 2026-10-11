// 机型预设表 v2 —— 本文件由脚本生成，不要手改。
//
// 来源：models/radiator/presets-v2.json（sha256 a12d9c001766941cda59a07a419d3cd83285a455b072178e7171587b5408df0b）
// 生成：uv run --quiet python scripts/gen_radiator_presets.py
//
// 每项参数的出处档（V / P / S / A / D / M）与引文只在 JSON 的 provenance 里，这里只放
// 生成与评价要用的数。与 JSON 的一致性由 engine/tests/test_ofdm.cpp 逐项核对（铁律 10）。

#include "cuav_geo/radiator_presets.h"

namespace cuav {
namespace geo {
namespace {

// dji-video-10m 突发 0：15 符号、16464 个原生样点
const int kDjiVideo10mCp0[15] = {80, 72, 72, 72, 72, 72, 72, 80, 72, 72, 72, 72, 72, 72, 80};
const int kDjiVideo10mZc0[15] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
// dji-video-10m 突发 1：30 符号、32920 个原生样点
const int kDjiVideo10mCp1[30] = {80, 72, 72, 72, 72, 72, 72, 80, 72, 72, 72, 72, 72, 72, 80, 72, 72, 72, 72, 72, 72, 80, 72, 72, 72, 72, 72, 72, 80, 72};
const int kDjiVideo10mZc1[30] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
const RadiatorBurst kDjiVideo10mBursts[2] = {
    { 15, kDjiVideo10mCp0, kDjiVideo10mZc0, 16464 },
    { 30, kDjiVideo10mCp1, kDjiVideo10mZc1, 32920 },
};
const double kDjiVideo10mCycle[3] = {0.2677508303282632, 0.5833829134774727, 0.1488662561942641};

// dji-video-20m-a 突发 0：15 符号、32928 个原生样点
const int kDjiVideo20mACp0[15] = {160, 144, 144, 144, 144, 144, 144, 160, 144, 144, 144, 144, 144, 144, 160};
const int kDjiVideo20mAZc0[15] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
// dji-video-20m-a 突发 1：30 符号、65840 个原生样点
const int kDjiVideo20mACp1[30] = {160, 144, 144, 144, 144, 144, 144, 160, 144, 144, 144, 144, 144, 144, 160, 144, 144, 144, 144, 144, 144, 160, 144, 144, 144, 144, 144, 144, 160, 144};
const int kDjiVideo20mAZc1[30] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
const RadiatorBurst kDjiVideo20mABursts[2] = {
    { 15, kDjiVideo20mACp0, kDjiVideo20mAZc0, 32928 },
    { 30, kDjiVideo20mACp1, kDjiVideo20mAZc1, 65840 },
};
const double kDjiVideo20mACycle[3] = {0.2677508303282632, 0.5833829134774727, 0.1488662561942641};

// dji-video-20m-c 突发 0：13 符号、28528 个原生样点
const int kDjiVideo20mCCp0[13] = {160, 144, 144, 144, 144, 144, 144, 160, 144, 144, 144, 144, 144};
const int kDjiVideo20mCZc0[13] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
// dji-video-20m-c 突发 1：15 符号、32928 个原生样点
const int kDjiVideo20mCCp1[15] = {160, 144, 144, 144, 144, 144, 144, 160, 144, 144, 144, 144, 144, 144, 160};
const int kDjiVideo20mCZc1[15] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
const RadiatorBurst kDjiVideo20mCBursts[2] = {
    { 13, kDjiVideo20mCCp0, kDjiVideo20mCZc0, 28528 },
    { 15, kDjiVideo20mCCp1, kDjiVideo20mCZc1, 32928 },
};
const double kDjiVideo20mCCycle[3] = {0.14316362938806826, 0.3213136389794744, 0.5355227316324573};

// dji-video-40m 突发 0：15 符号、65856 个原生样点
const int kDjiVideo40mCp0[15] = {320, 288, 288, 288, 288, 288, 288, 320, 288, 288, 288, 288, 288, 288, 320};
const int kDjiVideo40mZc0[15] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
// dji-video-40m 突发 1：30 符号、131680 个原生样点
const int kDjiVideo40mCp1[30] = {320, 288, 288, 288, 288, 288, 288, 320, 288, 288, 288, 288, 288, 288, 320, 288, 288, 288, 288, 288, 288, 320, 288, 288, 288, 288, 288, 288, 320, 288};
const int kDjiVideo40mZc1[30] = {29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
const RadiatorBurst kDjiVideo40mBursts[2] = {
    { 15, kDjiVideo40mCp0, kDjiVideo40mZc0, 65856 },
    { 30, kDjiVideo40mCp1, kDjiVideo40mZc1, 131680 },
};
const double kDjiVideo40mCycle[3] = {0.2914002880401674, 0.5263478660437637, 0.18225184591606894};

// dji-uplink-1m 突发 0：7 符号、7680 个原生样点
const int kDjiUplink1mCp0[7] = {80, 72, 72, 72, 72, 72, 72};
const int kDjiUplink1mZc0[7] = {29, 0, 0, 0, 0, 0, 0};
const RadiatorBurst kDjiUplink1mBursts[1] = {
    { 7, kDjiUplink1mCp0, kDjiUplink1mZc0, 7680 },
};
const double kDjiUplink1mCycle[10] = {0.0642, 0.9358, 1.0, 0.0, 0.0642, 0.9358, 1.0, 0.0, 1.0, 0.0};

// dji-uplink-2m 突发 0：7 符号、7680 个原生样点
const int kDjiUplink2mCp0[7] = {80, 72, 72, 72, 72, 72, 72};
const int kDjiUplink2mZc0[7] = {29, 0, 0, 0, 0, 0, 0};
const RadiatorBurst kDjiUplink2mBursts[1] = {
    { 7, kDjiUplink2mCp0, kDjiUplink2mZc0, 7680 },
};
const double kDjiUplink2mCycle[10] = {0.1162, 0.8838, 1.0, 0.0, 0.1162, 0.8838, 1.0, 0.0, 1.0, 0.0};

// dji-uplink-4m 突发 0：7 符号、8417 个原生样点
const int kDjiUplink4mCp0[7] = {181, 178, 178, 178, 178, 178, 178};
const int kDjiUplink4mZc0[7] = {29, 0, 0, 0, 0, 0, 0};
const RadiatorBurst kDjiUplink4mBursts[1] = {
    { 7, kDjiUplink4mCp0, kDjiUplink4mZc0, 8417 },
};
const double kDjiUplink4mCycle[10] = {0.1597, 0.8403, 1.0, 0.0, 0.1597, 0.8403, 1.0, 0.0, 1.0, 0.0};

// dji-droneid 突发 0：9 符号、9880 个原生样点
const int kDjiDroneidCp0[9] = {80, 72, 72, 72, 72, 72, 72, 72, 80};
const int kDjiDroneidZc0[9] = {0, 0, 0, 600, 0, 147, 0, 0, 0};
const RadiatorBurst kDjiDroneidBursts[1] = {
    { 9, kDjiDroneidCp0, kDjiDroneidZc0, 9880 },
};
const double kDjiDroneidCycle[2] = {0.0, 1.0};

const RadiatorPreset kPresets[] = {
    {
        "dji-video-10m", "ofdm", "video_link", "V1",
        1024, 15360000.0, 15000.0,
        300, 9015000.0,
        2,
        2, kDjiVideo10mBursts,
        30720, 1, kDjiVideo10mCycle,
    },
    {
        "dji-video-20m-a", "ofdm", "video_link", "V1",
        2048, 30720000.0, 15000.0,
        600, 18015000.0,
        2,
        2, kDjiVideo20mABursts,
        61440, 1, kDjiVideo20mACycle,
    },
    {
        "dji-video-20m-c", "ofdm", "video_link", "V1",
        2048, 30720000.0, 15000.0,
        600, 18015000.0,
        2,
        2, kDjiVideo20mCBursts,
        122880, 1, kDjiVideo20mCCycle,
    },
    {
        "dji-video-40m", "ofdm", "video_link", "V1",
        4096, 61440000.0, 15000.0,
        1200, 36015000.0,
        2,
        2, kDjiVideo40mBursts,
        122880, 1, kDjiVideo40mCycle,
    },
    {
        "dji-uplink-1m", "ofdm", "rc_hopping", "V1",
        1024, 15360000.0, 15000.0,
        37, 1125000.0,
        1,
        1, kDjiUplink1mBursts,
        30720, 5, kDjiUplink1mCycle,
    },
    {
        "dji-uplink-2m", "ofdm", "rc_hopping", "V1",
        1024, 15360000.0, 15000.0,
        74, 2235000.0,
        1,
        1, kDjiUplink2mBursts,
        30720, 5, kDjiUplink2mCycle,
    },
    {
        "dji-uplink-4m", "ofdm", "rc_hopping", "V1",
        1024, 15360000.0, 15000.0,
        147, 4425000.0,
        1,
        1, kDjiUplink4mBursts,
        30720, 5, kDjiUplink4mCycle,
    },
    {
        "dji-droneid", "droneid", "droneid", "V2",
        1024, 15360000.0, 15000.0,
        300, 9015000.0,
        1,
        1, kDjiDroneidBursts,
        9830400, 1, kDjiDroneidCycle,
    },
};

const char kSha256[] = "a12d9c001766941cda59a07a419d3cd83285a455b072178e7171587b5408df0b";

}  // namespace

const RadiatorPreset* radiator_preset(const std::string& id) {
    for (std::size_t i = 0; i < sizeof(kPresets) / sizeof(kPresets[0]); ++i) {
        if (id == kPresets[i].id) return &kPresets[i];
    }
    return 0;  // 不在表里：由调用方报错并列出可取值，不静默顶替（铁律 15）
}

std::size_t radiator_preset_count() { return sizeof(kPresets) / sizeof(kPresets[0]); }

const RadiatorPreset& radiator_preset_at(std::size_t i) { return kPresets[i]; }

const char* radiator_presets_sha256() { return kSha256; }

const char* radiator_presets_version() { return "v2"; }

}  // namespace geo
}  // namespace cuav
