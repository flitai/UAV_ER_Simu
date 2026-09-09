// 场景的内存表示与运行时求值。
//
// 依据：docs/scenario-format.md（字段已冻结，2026-09-04，D-030 / D-033）；
// CLAUDE.md 铁律 1、2、3、4、9、15。
//
// **本文件不含任何 JSON。** 场景文件的读取与逐字段校验在引擎侧
// （engine/src/scenario_json.cpp，复用已 vendored 的 nlohmann），这样 geo/ 保持零第三方依赖，
// 将来独立承载 emcore 的移植（D3）时不会被 JSON 库拖住。

#ifndef CUAV_GEO_SCENARIO_H
#define CUAV_GEO_SCENARIO_H

#include <cstdint>
#include <string>
#include <vector>

#include "cuav_geo/geodesy.h"
#include "cuav_geo/kinematics.h"
#include "cuav_geo/link_budget.h"

namespace cuav {
namespace geo {

struct Antenna {
    double gain_dBi;
    std::string pattern;      // 首期只有 "omni"；供装载器注入天线组件的缺省方向图（D-051）
    Antenna() : gain_dBi(0.0), pattern("omni") {}
};

struct Receiver {
    double fs_Hz;
    double center_Hz;
    double bw_Hz;
    double nf_dB;
    Receiver() : fs_Hz(0.0), center_Hz(0.0), bw_Hz(0.0), nf_dB(0.0) {}
};

// 站钟与时统（D-053）。在 time.basis = LogicalSim 下这些是**建模的**同步误差，
// 不是任何真实设备的时统指标；真实站钟与卫星驯服属 05 P2 的 DeviceStatus。
// has_clock = false 时 TDOA 相关组件必须报错而不是假定一个完美时钟（铁律 15）。
enum class SyncState { Locked = 0, Holdover, Unsynced };

struct Clock {
    bool has_clock;
    double sync_sigma_ns;        // 站钟同步 1σ；卫星驯服 / 共视同步的固定网约 3 ns（≈ 0.9 m）
    double bias_ns;              // 固定钟差（未标定的系统偏差）
    double rx_delay_ns;          // 接收通道群时延
    double rx_delay_sigma_ns;    // 群时延不确定度
    SyncState sync_state;
    Clock()
        : has_clock(false), sync_sigma_ns(0.0), bias_ns(0.0), rx_delay_ns(0.0),
          rx_delay_sigma_ns(0.0), sync_state(SyncState::Locked) {}
};

const char* to_string(SyncState s);

struct Site {
    std::string id;
    std::string name;
    // 设备型号（D-054）。只作前端的参数分组与显示，不进任何物理计算；与 name 同性质，
    // 引擎收下并原样保存。缺席即空串。
    std::string equipment_model;
    Lla position;
    Antenna antenna;
    Receiver receiver;
    Clock clock;
};

enum class WaveformType { Tone = 0, Noise, Burst };

struct Waveform {
    WaveformType type;
    double offset_Hz;    // tone / burst
    double period_s;     // burst
    double duty;         // burst，(0, 1)
    Waveform() : type(WaveformType::Tone), offset_Hz(0.0), period_s(0.0), duty(0.0) {}
};

struct Emission {
    double center_Hz;
    double bw_Hz;
    double tx_power_dBm;
    double antenna_gain_dBi;
    // 发射极化（D-051，C-1）。缺省 vertical；极化失配损耗只在接收端算一次，
    // 由接收天线组件按自身 polarization 与这里注入的发射极化查五档表（10 报告 §3.2）。
    std::string polarization;
    Waveform waveform;
    Emission()
        : center_Hz(0.0), bw_Hz(0.0), tx_power_dBm(0.0), antenna_gain_dBi(0.0),
          polarization("vertical") {}
};

enum class PlatformType { Multirotor = 0, FixedWing, Racing, Medium };

struct Emitter {
    std::string id;
    std::string name;
    // 同站点（D-054）。缺席时前端回退 platform_type 作分组键。
    std::string equipment_model;
    PlatformType platform_type;
    Lla position;
    Emission emission;
    Emitter() : platform_type(PlatformType::Multirotor) {}
};

enum class ActivityEvent { Takeoff = 0, Cruise, Hover, Land, TxOn, TxOff, Hop };

struct Activity {
    std::string emitter_id;
    double t_s;
    ActivityEvent event;
    bool has_center_Hz;
    double center_Hz;
    std::vector<double> sequence;
    double dwell_s;
    Activity()
        : t_s(0.0), event(ActivityEvent::Cruise), has_center_Hz(false),
          center_Hz(0.0), dwell_s(0.0) {}
};

struct RouteSpec {
    std::string emitter_id;
    std::vector<Waypoint> waypoints;
    bool loop;
    RouteSpec() : loop(false) {}
};

struct Coordinate {
    std::string crs;
    std::string alt_ref;
    std::string coord_version;
    double terrainHeight_m;
    Coordinate() : terrainHeight_m(0.0) {}
};

struct Scenario {
    std::string schema_version;
    std::string scenario_id;
    std::string name;
    bool synthetic;
    std::string aoi_id;
    std::string aoi_manifest_sha256;
    Coordinate coordinate;
    double duration_s;
    std::uint64_t seed;
    std::vector<Site> sites;
    std::vector<Emitter> emitters;
    std::vector<RouteSpec> routes;
    std::vector<Activity> activities;

    Scenario() : synthetic(false), duration_s(0.0), seed(0) {}

    const Site* find_site(const std::string& id) const;
    const Emitter* find_emitter(const std::string& id) const;
    const RouteSpec* find_route(const std::string& emitter_id) const;

    // schema 表达不了的跨引用与物理约束：标识唯一、航线与活动引用的辐射源存在、
    // 每个辐射源至多一条航线、活动按时刻非降且不超过时长、hop 参数只能给一种、
    // burst 占空比在开区间内、以及铁律 4 的 |Δf| + B/2 < Fs/2。
    bool cross_check(std::string& err) const;
};

// 一个辐射源的运行时：航线 + 活动状态机。build() 之后完全闭式，取值函数无副作用，
// 可任意乱序、任意次数调用，结果逐位相同。
class EmitterRuntime {
public:
    EmitterRuntime();

    bool build(const Scenario& s, const std::string& emitter_id, std::string& err);

    const std::string& id() const { return id_; }
    MotionState motion_at(double t_s) const;

    // 无 tx_on / tx_off 活动时自 t = 0 起恒真（docs/scenario-format.md §6）；
    // 一旦该辐射源有这类活动，**首个 tx_on 之前视为不发射**——否则"t=3 开图传"这条活动
    // 在画面上看不出任何变化，写它就没有意义了。
    bool tx_on_at(double t_s) const;

    // hop 活动改中心频率；无 hop 时恒为 emission.center_Hz。
    // sequence + dwell_s 形式自该时刻起按停留时长循环。
    double center_Hz_at(double t_s) const;

    double route_duration_s() const { return has_route_ ? route_.cycle_duration_s() : 0.0; }

private:
    std::string id_;
    Route route_;
    bool has_route_;
    Lla fixed_;
    double base_center_Hz_;

    bool has_tx_events_;
    std::vector<double> tx_t_;
    std::vector<char> tx_on_;

    struct Hop {
        double t_s;
        std::vector<double> sequence;   // 单值形式即长度 1
        double dwell_s;                 // 0 表示不循环
        Hop() : t_s(0.0), dwell_s(0.0) {}
    };
    std::vector<Hop> hops_;
};

// 一条（站点, 辐射源）链路的参数帧发生器。
// 帧边界按样点序号：第 k 帧覆盖 [k/R, (k+1)/R)，帧内零阶保持（docs/scenario-format.md §7、D-033）。
// 取值时刻取**帧起点** t = k/R（不取中点），与 valid_from_s 一致，浏览器预览可逐位复现。
class LinkFrameSource {
public:
    LinkFrameSource();

    // update_rate_Hz ∈ [10, 100]，越界写 err 返回 false。
    bool build(const Scenario& s, const std::string& site_id, const std::string& emitter_id,
               double update_rate_Hz, std::string& err);

    const std::string& link_id() const { return link_id_; }        // "<site_id>-<emitter_id>"
    const std::string& emitter_id() const { return emitter_id_; }
    const std::string& site_id() const { return site_id_; }
    double update_rate_Hz() const { return rate_; }

    struct Frame {
        std::uint64_t index;
        double valid_from_s, valid_to_s, update_rate_Hz;
        double path_loss_dB, noise_floor_dBm_per_Hz;
        bool line_of_sight;
        double doppler_Hz, delay_s;
        // 站点看辐射源的方向（到达角）与辐射源看站点的方向（离开角）。
        // 两者各算各的：地球曲率与高差使它们不是简单的互为反方位（D-051，C-1）。
        double distance_m, azimuth_deg, elevation_deg;
        double aod_azimuth_deg, aod_elevation_deg;
        double lon, lat, alt_m, heading_deg, speed_mps;
        bool tx_on;
        double center_Hz;
        bool valid;
        std::string reason;

        Frame()
            : index(0), valid_from_s(0.0), valid_to_s(0.0), update_rate_Hz(0.0),
              path_loss_dB(0.0), noise_floor_dBm_per_Hz(0.0), line_of_sight(true),
              doppler_Hz(0.0), delay_s(0.0), distance_m(0.0), azimuth_deg(0.0),
              elevation_deg(0.0), aod_azimuth_deg(0.0), aod_elevation_deg(0.0),
              lon(0.0), lat(0.0), alt_m(0.0), heading_deg(0.0),
              speed_mps(0.0), tx_on(true), center_Hz(0.0), valid(true) {}
    };

    Frame frame(std::uint64_t k) const;
    // 覆盖 [0, duration_s) 需要的帧数。
    std::uint64_t frame_count(double duration_s) const;

private:
    std::string site_id_, emitter_id_, link_id_;
    Lla site_pos_;
    double rx_nf_dB_;
    EmitterRuntime emitter_;
    double rate_;
};

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_SCENARIO_H
