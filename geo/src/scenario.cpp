#include "cuav_geo/scenario.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <sstream>

#include "cuav_geo/activity.h"

namespace cuav {
namespace geo {

const char* to_string(SyncState s) {
    switch (s) {
        case SyncState::Locked: return "locked";
        case SyncState::Holdover: return "holdover";
        case SyncState::Unsynced: return "unsynced";
    }
    return "unsynced";
}

const Site* Scenario::find_site(const std::string& id) const {
    for (std::size_t i = 0; i < sites.size(); ++i)
        if (sites[i].id == id) return &sites[i];
    return 0;
}

const Emitter* Scenario::find_emitter(const std::string& id) const {
    for (std::size_t i = 0; i < emitters.size(); ++i)
        if (emitters[i].id == id) return &emitters[i];
    return 0;
}

const RouteSpec* Scenario::find_route(const std::string& emitter_id) const {
    for (std::size_t i = 0; i < routes.size(); ++i)
        if (routes[i].emitter_id == emitter_id) return &routes[i];
    return 0;
}

bool Scenario::cross_check(std::string& err) const {
    std::set<std::string> ids;
    for (std::size_t i = 0; i < sites.size(); ++i) {
        if (!ids.insert("site:" + sites[i].id).second) {
            err = "站点标识重复：" + sites[i].id;
            return false;
        }
        const Receiver& r = sites[i].receiver;
        if (!(r.fs_Hz > 0.0) || !(r.center_Hz > 0.0) || !(r.bw_Hz > 0.0)) {
            err = "站点 " + sites[i].id + " 的接收机参数必须为正";
            return false;
        }
        if (r.bw_Hz > r.fs_Hz) {
            err = "站点 " + sites[i].id + " 的接收带宽大于采样率，违反奈奎斯特（铁律 4）";
            return false;
        }
    }
    for (std::size_t i = 0; i < emitters.size(); ++i) {
        if (!ids.insert("emitter:" + emitters[i].id).second) {
            err = "辐射源标识重复：" + emitters[i].id;
            return false;
        }
        const Waveform& w = emitters[i].emission.waveform;
        if (w.type == WaveformType::Burst) {
            if (!(w.period_s > 0.0)) {
                err = "辐射源 " + emitters[i].id + " 的突发周期必须为正";
                return false;
            }
            if (!(w.duty > 0.0) || !(w.duty < 1.0)) {
                err = "辐射源 " + emitters[i].id + " 的占空比必须在 0 与 1 之间（开区间）；"
                      "占空比为 1 请直接用 tone";
                return false;
            }
        }
    }

    std::set<std::string> zone_ids;
    for (std::size_t i = 0; i < zones.size(); ++i) {
        if (!zone_ids.insert(zones[i].id).second) {
            err = "告警区标识重复：" + zones[i].id;
            return false;
        }
    }

    std::set<std::string> routed;
    for (std::size_t i = 0; i < routes.size(); ++i) {
        if (find_emitter(routes[i].emitter_id) == 0) {
            err = "航线引用的辐射源不存在：" + routes[i].emitter_id;
            return false;
        }
        if (!routed.insert(routes[i].emitter_id).second) {
            err = "辐射源 " + routes[i].emitter_id + " 有多条航线，每个辐射源至多一条";
            return false;
        }
        if (routes[i].waypoints.empty()) {
            err = "航线 " + routes[i].emitter_id + " 没有航点";
            return false;
        }
    }

    double last_t = -1.0;
    for (std::size_t i = 0; i < activities.size(); ++i) {
        const Activity& a = activities[i];
        if (find_emitter(a.emitter_id) == 0) {
            err = "活动引用的辐射源不存在：" + a.emitter_id;
            return false;
        }
        if (a.t_s < last_t) {
            err = "活动时间线必须按时刻非降排序（docs/scenario-format.md §6）";
            return false;
        }
        last_t = a.t_s;
        if (a.t_s > duration_s) {
            err = "活动时刻超出仿真时长";
            return false;
        }
        if (a.event == ActivityEvent::Hop) {
            const bool single = a.has_center_Hz;
            const bool seq = !a.sequence.empty();
            if (single == seq) {
                err = "跳频活动只能给 center_Hz 或 sequence 之一";
                return false;
            }
            if (seq && !(a.dwell_s > 0.0)) {
                err = "跳频序列必须带正的 dwell_s";
                return false;
            }
        }
    }

    // 铁律 4：辐射源必须落在站点的观测带内，否则生成出来的样点会混叠。
    // 首期单站，逐站逐源都查一遍，多站时任一站不满足即拒。
    // **跳频点同样要过这道闸**（G-6，D-069）：跳出奈奎斯特不会有任何征兆，只会静默混叠，
    // 而基频过闸不代表序列里的每一跳都过得了（铁律 15）。
    for (std::size_t si = 0; si < sites.size(); ++si) {
        const Receiver& r = sites[si].receiver;
        for (std::size_t ei = 0; ei < emitters.size(); ++ei) {
            const Emission& em = emitters[ei].emission;
            const Waveform& w = em.waveform;
            // C-8 起 noise 也带限并搬移频率，offset_Hz 对三种波形一视同仁
            const double offset = w.offset_Hz;
            const std::vector<CenterPoint> centers = emitter_center_set(*this, emitters[ei].id);
            for (std::size_t ci = 0; ci < centers.size(); ++ci) {
                const double df = std::fabs(centers[ci].Hz + offset - r.center_Hz);
                if (df + em.bw_Hz / 2.0 < r.fs_Hz / 2.0) continue;
                if (centers[ci].where == "emission.center_Hz") {
                    err = "辐射源 " + emitters[ei].id + " 相对站点 " + sites[si].id +
                          " 的频偏加半带宽不小于采样率的一半，违反 |Δf| + B/2 < Fs/2（铁律 4）";
                } else {
                    std::ostringstream os;
                    os.precision(9);
                    os << "辐射源 " << emitters[ei].id << " 的跳频点 " << centers[ci].Hz
                       << " Hz（" << centers[ci].where << "）相对站点 " << sites[si].id
                       << " 的频偏加半带宽不小于采样率的一半，违反 |Δf| + B/2 < Fs/2（铁律 4）";
                    err = os.str();
                }
                return false;
            }
        }
    }
    return true;
}

// ---------------------------------------------------------------------------

EmitterRuntime::EmitterRuntime()
    : has_route_(false), base_center_Hz_(0.0), has_tx_events_(false) {}

bool EmitterRuntime::build(const Scenario& s, const std::string& emitter_id, std::string& err) {
    const Emitter* em = s.find_emitter(emitter_id);
    if (em == 0) {
        err = "场景里没有辐射源 " + emitter_id;
        return false;
    }
    id_ = emitter_id;
    fixed_ = em->position;
    base_center_Hz_ = em->emission.center_Hz;
    has_route_ = false;
    has_tx_events_ = false;
    tx_t_.clear();
    tx_on_.clear();
    hops_.clear();

    const RouteSpec* r = s.find_route(emitter_id);
    if (r != 0 && !r->waypoints.empty()) {
        if (!route_.build(r->waypoints, r->loop, err)) return false;
        has_route_ = true;
    }

    for (std::size_t i = 0; i < s.activities.size(); ++i) {
        const Activity& a = s.activities[i];
        if (a.emitter_id != emitter_id) continue;
        if (a.event == ActivityEvent::TxOn || a.event == ActivityEvent::TxOff) {
            has_tx_events_ = true;
            tx_t_.push_back(a.t_s);
            tx_on_.push_back(a.event == ActivityEvent::TxOn ? 1 : 0);
        } else if (a.event == ActivityEvent::Hop) {
            Hop h;
            h.t_s = a.t_s;
            if (a.has_center_Hz) {
                h.sequence.push_back(a.center_Hz);
                h.dwell_s = 0.0;
            } else {
                h.sequence = a.sequence;
                h.dwell_s = a.dwell_s;
            }
            hops_.push_back(h);
        }
        // takeoff / cruise / hover / land 首期只改状态标签与显示，不改运动（§6）。
    }
    return true;
}

MotionState EmitterRuntime::motion_at(double t_s) const {
    if (has_route_) return route_.state_at(t_s);
    MotionState st;
    st.t_s = t_s;
    st.position = fixed_;
    st.heading_deg = 0.0;
    st.speed_mps = 0.0;
    st.moving = false;
    return st;
}

bool EmitterRuntime::tx_on_at(double t_s) const {
    if (!has_tx_events_) return true;      // 无活动即自 t = 0 起持续发射（§6）
    bool on = false;                       // 有活动时，首个 tx_on 之前不发射
    for (std::size_t i = 0; i < tx_t_.size(); ++i) {
        if (tx_t_[i] <= t_s) on = (tx_on_[i] != 0);
        else break;                        // 活动已按时刻非降排序（cross_check 保证）
    }
    return on;
}

double EmitterRuntime::center_Hz_at(double t_s) const {
    double f = base_center_Hz_;
    for (std::size_t i = 0; i < hops_.size(); ++i) {
        const Hop& h = hops_[i];
        if (h.t_s > t_s) break;
        if (h.sequence.empty()) continue;
        if (h.dwell_s > 0.0) {
            const double elapsed = t_s - h.t_s;
            const double k = std::floor(elapsed / h.dwell_s);
            std::size_t idx = static_cast<std::size_t>(
                std::fmod(k, static_cast<double>(h.sequence.size())));
            if (idx >= h.sequence.size()) idx = 0;
            f = h.sequence[idx];
        } else {
            f = h.sequence[0];
        }
    }
    return f;
}

// ---------------------------------------------------------------------------

LinkFrameSource::LinkFrameSource()
    : rx_nf_dB_(0.0), rate_(0.0), terrain_height_m_(0.0), polarization_("vertical") {}

bool LinkFrameSource::build(const Scenario& s, const std::string& site_id,
                            const std::string& emitter_id, double update_rate_Hz,
                            std::string& err, const PropagationConfig& cfg) {
    if (!(update_rate_Hz >= 10.0) || !(update_rate_Hz <= 100.0)) {
        err = "参数帧更新率必须在 10 到 100 赫兹之间（docs/scenario-format.md §7）";
        return false;
    }
    const Site* site = s.find_site(site_id);
    if (site == 0) {
        err = "场景里没有站点 " + site_id;
        return false;
    }
    if (!emitter_.build(s, emitter_id, err)) return false;

    site_id_ = site_id;
    emitter_id_ = emitter_id;
    link_id_ = site_id + "-" + emitter_id;
    site_pos_ = site->position;
    rx_nf_dB_ = site->receiver.nf_dB;
    rate_ = update_rate_Hz;
    prop_ = cfg;
    terrain_height_m_ = s.coordinate.terrainHeight_m;
    // 发射极化只有地面双径读它（EM-P-02 §10.4）。场景缺省 "vertical"（D-051，C-1）。
    const Emitter* em = s.find_emitter(emitter_id);
    polarization_ = (em != 0 && !em->emission.polarization.empty())
                        ? em->emission.polarization : std::string("vertical");
    shadow_ = ShadowSequence();
    return true;
}

bool LinkFrameSource::init_shadow(INormalSource& rng, double duration_s, std::string& err) {
    shadow_ = ShadowSequence();
    if (!prop_.shadow || !prop_.effects_enabled()) return true;
    const std::uint64_t n = frame_count(duration_s);
    if (n == 0) {
        err = "统计阴影需要正的仿真时长才能按帧序预生成序列";
        return false;
    }
    // 上限只是防呆：100 Hz × 24 小时也才 8.64e6。超了说明时长或更新率填错了，
    // 与其吃掉几百兆内存不如当场说清楚（铁律 15）。
    if (n > 10000000ull) {
        err = "统计阴影要预生成 " + std::to_string(n) + " 帧，超过上限一千万；"
              "请缩短时长或降低 update_rate_Hz";
        return false;
    }
    // 逐帧的空间位移：第 k 帧目标位置与第 k−1 帧的 ECEF 弦长（D-049 ①：距离一律 ECEF 弦长）。
    // 阴影随**空间位移**变化而不是随时间，所以悬停时相邻帧几乎完全相关、高速飞行时很快去相关
    // （EM-P-08 §10.9 裁决要点第 3 条）。
    const IGeodesy& g = default_geodesy();
    std::vector<double> steps(static_cast<std::size_t>(n), 0.0);
    Ecef prev;
    for (std::uint64_t k = 0; k < n; ++k) {
        const double t = static_cast<double>(k) / rate_;
        const Ecef cur = g.to_ecef(emitter_.motion_at(t).position);
        if (k > 0) steps[static_cast<std::size_t>(k)] = norm(sub(cur, prev));
        prev = cur;
    }
    shadow_.build(steps, shadow_sigma_dB(prop_, true), prop_.shadow_corr_distance_m, rng);
    return true;
}

LinkFrameSource::Frame LinkFrameSource::frame(std::uint64_t k) const {
    Frame f;
    f.index = k;
    // 生产与消费两侧必须用同一个表达式形式：k / R，不写成 k * (1/R)，
    // 否则最后一位会不一样，浏览器预览与 C++ 就对不上了。
    f.valid_from_s = static_cast<double>(k) / rate_;
    f.valid_to_s = static_cast<double>(k + 1) / rate_;
    f.update_rate_Hz = rate_;

    const double t = f.valid_from_s;
    const MotionState m = emitter_.motion_at(t);
    f.lon = m.position.lon_deg;
    f.lat = m.position.lat_deg;
    f.alt_m = m.position.alt_m;
    f.heading_deg = m.heading_deg;
    f.speed_mps = m.speed_mps;
    f.tx_on = emitter_.tx_on_at(t);
    f.center_Hz = emitter_.center_Hz_at(t);

    const LinkGeometry g = link_geometry(site_pos_, m.position, m.velocity, terrain_height_m_);
    f.distance_m = g.distance_m;
    f.azimuth_deg = g.azimuth_deg;
    f.elevation_deg = g.elevation_deg;
    f.line_of_sight = g.line_of_sight;

    // 离开角：辐射源看站点。不用 azimuth ± 180 反推——那在球面上只有短基线才近似成立，
    // 俯仰更是差一个符号之外还差地球曲率项（D-051，C-1）。
    const LookAngles back = look_angles(m.position, site_pos_);
    f.aod_azimuth_deg = back.azimuth_deg;
    f.aod_elevation_deg = back.elevation_deg;

    const LinkBudget b = link_budget(g, f.center_Hz, rx_nf_dB_, prop_,
                                    shadow_.at(static_cast<std::size_t>(k)), polarization_);
    f.path_loss_dB = b.path_loss_dB;
    f.noise_floor_dBm_per_Hz = b.noise_floor_dBm_per_Hz;
    f.doppler_Hz = b.doppler_Hz;
    f.delay_s = b.delay_s;
    f.valid = b.valid;
    f.free_space_dB = b.free_space_dB;
    f.extra_loss_dB = b.extra_loss_dB;
    f.included_loss_terms = b.terms.included;
    f.degraded = b.degraded;
    f.reason = b.reason;
    return f;
}

std::uint64_t LinkFrameSource::frame_count(double duration_s) const {
    if (!(duration_s > 0.0) || !(rate_ > 0.0)) return 0;
    const double n = std::ceil(duration_s * rate_ - 1e-9);
    return static_cast<std::uint64_t>(n < 1.0 ? 1.0 : n);
}

}  // namespace geo
}  // namespace cuav
