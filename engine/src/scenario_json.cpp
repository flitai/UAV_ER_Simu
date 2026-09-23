#include "cuav/numstr.h"
#include "cuav/scenario_json.h"

#include <cmath>
#include <cstdio>
#include <set>
#include <vector>

#include "cuav/sha256.h"

namespace cuav {
namespace {

using nlohmann::json;

bool is_id_char(char c) {
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}

bool match_id(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    for (std::size_t i = 0; i < s.size(); ++i) if (!is_id_char(s[i])) return false;
    return true;
}

bool fail(std::string& err, const std::string& where, const std::string& what) {
    err = where + " " + what;
    return false;
}

bool check_keys(const json& obj, const std::set<std::string>& allowed, const std::string& where,
                std::string& err) {
    for (json::const_iterator it = obj.begin(); it != obj.end(); ++it) {
        if (!allowed.count(it.key()))
            return fail(err, where, "出现未知键 \"" + it.key() + "\"，未知键一律拒绝");
    }
    return true;
}

bool need(const json& obj, const char* key, const std::string& where, std::string& err) {
    if (!obj.contains(key)) return fail(err, where, std::string("缺必填字段 ") + key);
    return true;
}

bool get_num(const json& obj, const char* key, const std::string& where, double& out, std::string& err) {
    if (!need(obj, key, where, err)) return false;
    if (!obj[key].is_number()) return fail(err, where, std::string("的 ") + key + " 必须是数值");
    out = obj[key].get<double>();
    return true;
}

bool get_str(const json& obj, const char* key, const std::string& where, std::string& out, std::string& err) {
    if (!need(obj, key, where, err)) return false;
    if (!obj[key].is_string()) return fail(err, where, std::string("的 ") + key + " 必须是字符串");
    out = obj[key].get<std::string>();
    return true;
}

// 可选字符串：缺席即放行并保持 out 不变；出现了就必须是字符串——
// 类型写错时静默忽略会让用户以为设置生效了（铁律 15）。
bool get_opt_str(const json& obj, const char* key, const std::string& where,
                 std::string& out, std::string& err) {
    if (!obj.contains(key)) return true;
    if (!obj[key].is_string()) return fail(err, where, std::string("的 ") + key + " 必须是字符串");
    out = obj[key].get<std::string>();
    return true;
}

bool get_id(const json& obj, const char* key, const std::string& where, std::string& out, std::string& err) {
    if (!get_str(obj, key, where, out, err)) return false;
    if (!match_id(out)) return fail(err, where, std::string("的 ") + key + " 必须匹配 [a-z0-9_-]{1,64}");
    return true;
}

bool get_pos(const json& obj, const std::string& where, geo::Lla& out, std::string& err) {
    if (!obj.is_object()) return fail(err, where, "必须是对象");
    static const std::set<std::string> kKeys = {"lon", "lat", "alt_m"};
    if (!check_keys(obj, kKeys, where, err)) return false;
    if (!get_num(obj, "lon", where, out.lon_deg, err)) return false;
    if (!get_num(obj, "lat", where, out.lat_deg, err)) return false;
    if (!get_num(obj, "alt_m", where, out.alt_m, err)) return false;
    if (out.lon_deg < -180.0 || out.lon_deg > 180.0) return fail(err, where, "的 lon 超出 [-180, 180]");
    if (out.lat_deg < -90.0 || out.lat_deg > 90.0) return fail(err, where, "的 lat 超出 [-90, 90]");
    return true;
}

bool positive(double v, const std::string& where, const char* key, std::string& err) {
    if (!(v > 0.0)) return fail(err, where, std::string("的 ") + key + " 必须为正");
    return true;
}

bool parse_waveform(const json& w, const std::string& where, geo::Waveform& out, std::string& err) {
    if (!w.is_object()) return fail(err, where, "必须是对象");
    std::string type;
    if (!get_str(w, "type", where, type, err)) return false;
    if (type == "tone") {
        static const std::set<std::string> k = {"type", "offset_Hz"};
        if (!check_keys(w, k, where, err)) return false;
        out.type = geo::WaveformType::Tone;
        return get_num(w, "offset_Hz", where, out.offset_Hz, err);
    }
    if (type == "noise") {
        // offset_Hz 自 C-8 起对三种波形通用（此前 noise 不搬移频率，给了也不起作用）；
        // 可选，缺省 0，于是既有场景文件不写它仍然合法
        static const std::set<std::string> k = {"type", "offset_Hz"};
        if (!check_keys(w, k, where, err)) return false;
        out.type = geo::WaveformType::Noise;
        if (w.contains("offset_Hz")) return get_num(w, "offset_Hz", where, out.offset_Hz, err);
        out.offset_Hz = 0.0;
        return true;
    }
    if (type == "burst") {
        static const std::set<std::string> k = {"type", "period_s", "duty", "offset_Hz"};
        if (!check_keys(w, k, where, err)) return false;
        out.type = geo::WaveformType::Burst;
        if (!get_num(w, "period_s", where, out.period_s, err)) return false;
        if (!get_num(w, "duty", where, out.duty, err)) return false;
        if (!get_num(w, "offset_Hz", where, out.offset_Hz, err)) return false;
        if (!positive(out.period_s, where, "period_s", err)) return false;
        if (!(out.duty > 0.0) || !(out.duty <= 1.0)) return fail(err, where, "的 duty 必须在 (0, 1] 内");
        return true;
    }
    return fail(err, where, "的 type 必须是 tone / noise / burst 之一（ofdm / fhss / template 随 P3）");
}

// 站钟（D-053，可选）。缺席时 has_clock 保持 false——TDOA 相关组件据此报错而不是
// 默认一个完美时钟（默认 0 ns 会让时差定位结果好得不真实，铁律 15）。
bool parse_clock(const json& c, const std::string& where, geo::Clock& out, std::string& err) {
    if (!c.is_object()) return fail(err, where, "必须是对象");
    static const std::set<std::string> kKeys = {"sync_sigma_ns", "bias_ns", "rx_delay_ns",
                                                "rx_delay_sigma_ns", "sync_state"};
    if (!check_keys(c, kKeys, where, err)) return false;
    if (!get_num(c, "sync_sigma_ns", where, out.sync_sigma_ns, err)) return false;
    if (out.sync_sigma_ns < 0.0) return fail(err, where, "的 sync_sigma_ns 不得为负");
    if (c.contains("bias_ns") && !get_num(c, "bias_ns", where, out.bias_ns, err)) return false;
    if (c.contains("rx_delay_ns") && !get_num(c, "rx_delay_ns", where, out.rx_delay_ns, err)) return false;
    if (c.contains("rx_delay_sigma_ns")) {
        if (!get_num(c, "rx_delay_sigma_ns", where, out.rx_delay_sigma_ns, err)) return false;
        if (out.rx_delay_sigma_ns < 0.0) return fail(err, where, "的 rx_delay_sigma_ns 不得为负");
    }
    std::string st = "locked";
    if (c.contains("sync_state") && !get_str(c, "sync_state", where, st, err)) return false;
    if (st == "locked") out.sync_state = geo::SyncState::Locked;
    else if (st == "holdover") out.sync_state = geo::SyncState::Holdover;
    else if (st == "unsynced") out.sync_state = geo::SyncState::Unsynced;
    else return fail(err, where, "的 sync_state 必须是 locked / holdover / unsynced 之一");
    out.has_clock = true;
    return true;
}

bool parse_site(const json& s, std::size_t i, geo::Site& out, std::string& err) {
    const std::string where = "sites[" + numstr(i) + "]";
    if (!s.is_object()) return fail(err, where, "必须是对象");
    static const std::set<std::string> kKeys = {"id", "name", "equipment_model", "position",
                                                "antenna", "receiver", "clock"};
    if (!check_keys(s, kKeys, where, err)) return false;
    if (!get_id(s, "id", where, out.id, err)) return false;
    if (!get_str(s, "name", where, out.name, err)) return false;
    // 设备型号只作前端的参数分组与显示，不进物理（D-054）。引擎收下并原样保存，不解释。
    if (!get_opt_str(s, "equipment_model", where, out.equipment_model, err)) return false;
    if (!need(s, "position", where, err)) return false;
    if (!get_pos(s["position"], where + ".position", out.position, err)) return false;

    if (!need(s, "antenna", where, err)) return false;
    const json& a = s["antenna"];
    static const std::set<std::string> kAnt = {"gain_dBi", "pattern"};
    if (!check_keys(a, kAnt, where + ".antenna", err)) return false;
    if (!get_num(a, "gain_dBi", where + ".antenna", out.antenna.gain_dBi, err)) return false;
    if (!get_str(a, "pattern", where + ".antenna", out.antenna.pattern, err)) return false;
    if (out.antenna.pattern != "omni") return fail(err, where + ".antenna", "的 pattern 首期只允许 omni");

    if (!need(s, "receiver", where, err)) return false;
    const json& r = s["receiver"];
    static const std::set<std::string> kRx = {"fs_Hz", "center_Hz", "bw_Hz", "nf_dB"};
    if (!check_keys(r, kRx, where + ".receiver", err)) return false;
    if (!get_num(r, "fs_Hz", where + ".receiver", out.receiver.fs_Hz, err)) return false;
    if (!get_num(r, "center_Hz", where + ".receiver", out.receiver.center_Hz, err)) return false;
    if (!get_num(r, "bw_Hz", where + ".receiver", out.receiver.bw_Hz, err)) return false;
    if (!get_num(r, "nf_dB", where + ".receiver", out.receiver.nf_dB, err)) return false;
    if (!positive(out.receiver.fs_Hz, where + ".receiver", "fs_Hz", err)) return false;
    if (!positive(out.receiver.center_Hz, where + ".receiver", "center_Hz", err)) return false;
    if (!positive(out.receiver.bw_Hz, where + ".receiver", "bw_Hz", err)) return false;
    if (out.receiver.nf_dB < 0.0) return fail(err, where + ".receiver", "的 nf_dB 不得为负");

    if (s.contains("clock") && !parse_clock(s["clock"], where + ".clock", out.clock, err)) return false;
    return true;
}

bool parse_emitter(const json& e, std::size_t i, geo::Emitter& out, std::string& err) {
    const std::string where = "emitters[" + numstr(i) + "]";
    if (!e.is_object()) return fail(err, where, "必须是对象");
    static const std::set<std::string> kKeys = {"id", "name", "equipment_model", "platform_type",
                                                "position", "emission"};
    if (!check_keys(e, kKeys, where, err)) return false;
    if (!get_id(e, "id", where, out.id, err)) return false;
    if (!get_str(e, "name", where, out.name, err)) return false;
    // 同站点：只作参数分组与显示。缺席时前端回退 platform_type 作分组键（D-054）。
    if (!get_opt_str(e, "equipment_model", where, out.equipment_model, err)) return false;

    std::string pt;
    if (!get_str(e, "platform_type", where, pt, err)) return false;
    if (pt == "multirotor") out.platform_type = geo::PlatformType::Multirotor;
    else if (pt == "fixed_wing") out.platform_type = geo::PlatformType::FixedWing;
    else if (pt == "racing") out.platform_type = geo::PlatformType::Racing;
    else if (pt == "medium") out.platform_type = geo::PlatformType::Medium;
    else return fail(err, where, "的 platform_type 必须是 multirotor / fixed_wing / racing / medium 之一");

    if (!need(e, "position", where, err)) return false;
    if (!get_pos(e["position"], where + ".position", out.position, err)) return false;

    if (!need(e, "emission", where, err)) return false;
    const json& em = e["emission"];
    static const std::set<std::string> kEm = {"center_Hz", "bw_Hz", "tx_power_dBm", "antenna_gain_dBi",
                                              "polarization", "waveform"};
    if (!check_keys(em, kEm, where + ".emission", err)) return false;
    if (!get_num(em, "center_Hz", where + ".emission", out.emission.center_Hz, err)) return false;
    if (!get_num(em, "bw_Hz", where + ".emission", out.emission.bw_Hz, err)) return false;
    if (!get_num(em, "tx_power_dBm", where + ".emission", out.emission.tx_power_dBm, err)) return false;
    if (!get_num(em, "antenna_gain_dBi", where + ".emission", out.emission.antenna_gain_dBi, err)) return false;
    if (!positive(out.emission.center_Hz, where + ".emission", "center_Hz", err)) return false;
    if (!positive(out.emission.bw_Hz, where + ".emission", "bw_Hz", err)) return false;
    // 极化可缺省（既有场景文件不写它也照旧合法），给出时必须在五档之内（D-051，C-1）
    if (em.contains("polarization")) {
        if (!get_str(em, "polarization", where + ".emission", out.emission.polarization, err)) return false;
        const std::string& q = out.emission.polarization;
        if (q != "vertical" && q != "horizontal" && q != "slant45" && q != "rhcp" && q != "lhcp") {
            return fail(err, where + ".emission",
                        "的 polarization 必须是 vertical / horizontal / slant45 / rhcp / lhcp 之一");
        }
    }
    if (!need(em, "waveform", where + ".emission", err)) return false;
    return parse_waveform(em["waveform"], where + ".emission.waveform", out.emission.waveform, err);
}

bool parse_route(const json& r, std::size_t i, geo::RouteSpec& out, std::string& err) {
    const std::string where = "routes[" + numstr(i) + "]";
    if (!r.is_object()) return fail(err, where, "必须是对象");
    static const std::set<std::string> kKeys = {"emitter_id", "waypoints", "loop"};
    if (!check_keys(r, kKeys, where, err)) return false;
    if (!get_id(r, "emitter_id", where, out.emitter_id, err)) return false;
    if (r.contains("loop")) {
        if (!r["loop"].is_boolean()) return fail(err, where, "的 loop 必须是布尔");
        out.loop = r["loop"].get<bool>();
    }
    if (!need(r, "waypoints", where, err)) return false;
    if (!r["waypoints"].is_array() || r["waypoints"].empty())
        return fail(err, where, "的 waypoints 必须是至少一项的数组");
    for (std::size_t k = 0; k < r["waypoints"].size(); ++k) {
        const std::string w = where + ".waypoints[" + numstr(k) + "]";
        const json& jw = r["waypoints"][k];
        if (!jw.is_object()) return fail(err, w, "必须是对象");
        static const std::set<std::string> kWp = {"position", "speed_mps", "loiter_s"};
        if (!check_keys(jw, kWp, w, err)) return false;
        geo::Waypoint wp;
        if (!need(jw, "position", w, err)) return false;
        if (!get_pos(jw["position"], w + ".position", wp.position, err)) return false;
        if (!get_num(jw, "speed_mps", w, wp.speed_mps, err)) return false;
        if (!positive(wp.speed_mps, w, "speed_mps", err)) return false;
        if (jw.contains("loiter_s")) {
            if (!jw["loiter_s"].is_number()) return fail(err, w, "的 loiter_s 必须是数值");
            wp.loiter_s = jw["loiter_s"].get<double>();
            if (wp.loiter_s < 0.0) return fail(err, w, "的 loiter_s 不得为负");
        }
        out.waypoints.push_back(wp);
    }
    return true;
}

bool parse_activity(const json& a, std::size_t i, geo::Activity& out, std::string& err) {
    const std::string where = "activities[" + numstr(i) + "]";
    if (!a.is_object()) return fail(err, where, "必须是对象");
    static const std::set<std::string> kKeys = {"emitter_id", "t_s", "event", "args"};
    if (!check_keys(a, kKeys, where, err)) return false;
    if (!get_id(a, "emitter_id", where, out.emitter_id, err)) return false;
    if (!get_num(a, "t_s", where, out.t_s, err)) return false;
    if (out.t_s < 0.0) return fail(err, where, "的 t_s 不得为负");

    std::string ev;
    if (!get_str(a, "event", where, ev, err)) return false;
    if (ev == "takeoff") out.event = geo::ActivityEvent::Takeoff;
    else if (ev == "cruise") out.event = geo::ActivityEvent::Cruise;
    else if (ev == "hover") out.event = geo::ActivityEvent::Hover;
    else if (ev == "land") out.event = geo::ActivityEvent::Land;
    else if (ev == "tx_on") out.event = geo::ActivityEvent::TxOn;
    else if (ev == "tx_off") out.event = geo::ActivityEvent::TxOff;
    else if (ev == "hop") out.event = geo::ActivityEvent::Hop;
    else return fail(err, where, "的 event 不在 takeoff / cruise / hover / land / tx_on / tx_off / hop 之内");

    if (a.contains("args")) {
        const json& ar = a["args"];
        static const std::set<std::string> kArgs = {"center_Hz", "sequence", "dwell_s"};
        if (!ar.is_object()) return fail(err, where + ".args", "必须是对象");
        if (!check_keys(ar, kArgs, where + ".args", err)) return false;
        if (ar.contains("center_Hz")) {
            if (!ar["center_Hz"].is_number()) return fail(err, where + ".args", "的 center_Hz 必须是数值");
            out.has_center_Hz = true;
            out.center_Hz = ar["center_Hz"].get<double>();
            if (!positive(out.center_Hz, where + ".args", "center_Hz", err)) return false;
        }
        if (ar.contains("sequence")) {
            if (!ar["sequence"].is_array() || ar["sequence"].empty())
                return fail(err, where + ".args", "的 sequence 必须是至少一项的数组");
            for (std::size_t k = 0; k < ar["sequence"].size(); ++k) {
                if (!ar["sequence"][k].is_number())
                    return fail(err, where + ".args.sequence", "的元素必须是数值");
                const double f = ar["sequence"][k].get<double>();
                if (!(f > 0.0)) return fail(err, where + ".args.sequence", "的元素必须为正");
                out.sequence.push_back(f);
            }
        }
        if (ar.contains("dwell_s")) {
            if (!ar["dwell_s"].is_number()) return fail(err, where + ".args", "的 dwell_s 必须是数值");
            out.dwell_s = ar["dwell_s"].get<double>();
            if (!positive(out.dwell_s, where + ".args", "dwell_s", err)) return false;
        }
    }
    return true;
}

// 圆形告警区（D-061）：只收下、不解释；枚举显式判定，不给缺省（铁律 15）。
bool parse_zone(const json& z, std::size_t i, geo::Zone& out, std::string& err) {
    const std::string where = "zones[" + numstr(i) + "]";
    if (!z.is_object()) return fail(err, where, "必须是对象");
    static const std::set<std::string> kKeys = {"id", "name", "kind", "shape", "center", "radius_m", "alt_max_m"};
    if (!check_keys(z, kKeys, where, err)) return false;
    if (!get_id(z, "id", where, out.id, err)) return false;
    if (!get_str(z, "name", where, out.name, err)) return false;
    std::string kind;
    if (!get_str(z, "kind", where, kind, err)) return false;
    if (kind == "alert") out.kind = geo::ZoneKind::Alert;
    else if (kind == "warning") out.kind = geo::ZoneKind::Warning;
    else return fail(err, where, "的 kind 必须是 alert / warning 之一");
    std::string shape;
    if (!get_str(z, "shape", where, shape, err)) return false;
    if (shape != "circle") return fail(err, where, "的 shape 本期只允许 circle");
    if (!need(z, "center", where, err)) return false;
    {
        const json& c = z["center"];
        const std::string cw = where + ".center";
        if (!c.is_object()) return fail(err, cw, "必须是对象");
        static const std::set<std::string> kC = {"lon", "lat"};
        if (!check_keys(c, kC, cw, err)) return false;
        if (!get_num(c, "lon", cw, out.center_lon_deg, err)) return false;
        if (!get_num(c, "lat", cw, out.center_lat_deg, err)) return false;
        if (out.center_lon_deg < -180.0 || out.center_lon_deg > 180.0) return fail(err, cw, "的 lon 超出 [-180, 180]");
        if (out.center_lat_deg < -90.0 || out.center_lat_deg > 90.0) return fail(err, cw, "的 lat 超出 [-90, 90]");
    }
    if (!get_num(z, "radius_m", where, out.radius_m, err)) return false;
    if (!positive(out.radius_m, where, "radius_m", err)) return false;
    if (z.contains("alt_max_m")) {
        if (!z["alt_max_m"].is_number()) return fail(err, where, "的 alt_max_m 必须是数值");
        out.has_alt_max = true;
        out.alt_max_m = z["alt_max_m"].get<double>();
        if (out.alt_max_m < 0.0) return fail(err, where, "的 alt_max_m 不得为负");
    }
    return true;
}

}  // namespace

bool parse_scenario(const json& j, geo::Scenario& out, std::string& err) {
    out = geo::Scenario();
    if (!j.is_object()) return fail(err, "场景文件", "顶层必须是对象");

    static const std::set<std::string> kTop = {"schema_version", "scenario_id", "name", "synthetic",
                                               "aoi", "coordinate", "time", "seed", "sites",
                                               "emitters", "routes", "activities", "zones", "trace"};
    if (!check_keys(j, kTop, "场景文件", err)) return false;

    if (!get_str(j, "schema_version", "场景文件", out.schema_version, err)) return false;
    if (out.schema_version != "cuav-scenario/1")
        return fail(err, "场景文件", "的 schema_version 必须是 cuav-scenario/1");
    if (!get_id(j, "scenario_id", "场景文件", out.scenario_id, err)) return false;
    if (!get_str(j, "name", "场景文件", out.name, err)) return false;
    if (out.name.empty()) return fail(err, "场景文件", "的 name 不得为空");

    if (!need(j, "synthetic", "场景文件", err)) return false;
    if (!j["synthetic"].is_boolean() || !j["synthetic"].get<bool>())
        return fail(err, "场景文件", "的 synthetic 必须为 true（本格式只描述合成场景）");
    out.synthetic = true;

    if (!need(j, "aoi", "场景文件", err)) return false;
    {
        const json& a = j["aoi"];
        static const std::set<std::string> k = {"id", "manifest_sha256"};
        if (!a.is_object()) return fail(err, "aoi", "必须是对象");
        if (!check_keys(a, k, "aoi", err)) return false;
        if (!get_id(a, "id", "aoi", out.aoi_id, err)) return false;
        if (!get_str(a, "manifest_sha256", "aoi", out.aoi_manifest_sha256, err)) return false;
    }

    if (!need(j, "coordinate", "场景文件", err)) return false;
    {
        const json& c = j["coordinate"];
        static const std::set<std::string> k = {"crs", "alt_ref", "terrainHeight_m", "coord_version"};
        if (!c.is_object()) return fail(err, "coordinate", "必须是对象");
        if (!check_keys(c, k, "coordinate", err)) return false;
        if (!get_str(c, "crs", "coordinate", out.coordinate.crs, err)) return false;
        if (out.coordinate.crs != "EPSG:4326")
            return fail(err, "coordinate", "的 crs 必须是 EPSG:4326（铁律 1，禁止 GCJ-02）");
        if (!get_str(c, "alt_ref", "coordinate", out.coordinate.alt_ref, err)) return false;
        if (out.coordinate.alt_ref != "AGL" && out.coordinate.alt_ref != "MSL")
            return fail(err, "coordinate", "的 alt_ref 必须是 AGL 或 MSL");
        if (!get_num(c, "terrainHeight_m", "coordinate", out.coordinate.terrainHeight_m, err)) return false;
        if (!get_str(c, "coord_version", "coordinate", out.coordinate.coord_version, err)) return false;
        if (out.coordinate.coord_version.empty())
            return fail(err, "coordinate", "的 coord_version 不得为空（铁律 1：记录坐标版本）");
    }

    if (!need(j, "time", "场景文件", err)) return false;
    {
        const json& t = j["time"];
        static const std::set<std::string> k = {"basis", "duration_s"};
        if (!t.is_object()) return fail(err, "time", "必须是对象");
        if (!check_keys(t, k, "time", err)) return false;
        std::string basis;
        if (!get_str(t, "basis", "time", basis, err)) return false;
        if (basis != "LogicalSim")
            return fail(err, "time", "的 basis 首期只允许 LogicalSim（铁律 3：四重时间不得混用）");
        if (!get_num(t, "duration_s", "time", out.duration_s, err)) return false;
        if (!positive(out.duration_s, "time", "duration_s", err)) return false;
    }

    if (!need(j, "seed", "场景文件", err)) return false;
    if (!j["seed"].is_number_unsigned())
        return fail(err, "场景文件", "的 seed 必须是非负整数（铁律 9）");
    out.seed = j["seed"].get<std::uint64_t>();

    if (!need(j, "sites", "场景文件", err)) return false;
    if (!j["sites"].is_array() || j["sites"].empty())
        return fail(err, "场景文件", "的 sites 必须是至少一项的数组");
    for (std::size_t i = 0; i < j["sites"].size(); ++i) {
        geo::Site s;
        if (!parse_site(j["sites"][i], i, s, err)) return false;
        out.sites.push_back(s);
    }

    if (!need(j, "emitters", "场景文件", err)) return false;
    if (!j["emitters"].is_array() || j["emitters"].empty())
        return fail(err, "场景文件", "的 emitters 必须是至少一项的数组");
    for (std::size_t i = 0; i < j["emitters"].size(); ++i) {
        geo::Emitter e;
        if (!parse_emitter(j["emitters"][i], i, e, err)) return false;
        out.emitters.push_back(e);
    }

    if (!need(j, "routes", "场景文件", err)) return false;
    if (!j["routes"].is_array()) return fail(err, "场景文件", "的 routes 必须是数组");
    for (std::size_t i = 0; i < j["routes"].size(); ++i) {
        geo::RouteSpec r;
        if (!parse_route(j["routes"][i], i, r, err)) return false;
        out.routes.push_back(r);
    }

    if (j.contains("activities")) {
        if (!j["activities"].is_array()) return fail(err, "场景文件", "的 activities 必须是数组");
        for (std::size_t i = 0; i < j["activities"].size(); ++i) {
            geo::Activity a;
            if (!parse_activity(j["activities"][i], i, a, err)) return false;
            out.activities.push_back(a);
        }
    }

    if (j.contains("zones")) {
        if (!j["zones"].is_array()) return fail(err, "场景文件", "的 zones 必须是数组");
        for (std::size_t i = 0; i < j["zones"].size(); ++i) {
            geo::Zone zn;
            if (!parse_zone(j["zones"][i], i, zn, err)) return false;
            out.zones.push_back(zn);
        }
    }

    if (j.contains("trace")) {
        static const std::set<std::string> k = {"created_by", "created_at", "notes"};
        if (!j["trace"].is_object()) return fail(err, "trace", "必须是对象");
        if (!check_keys(j["trace"], k, "trace", err)) return false;
    }
    return true;
}

bool load_scenario_file(const std::string& path, LoadedScenario& out, std::string& err) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == 0) {
        err = "打不开场景文件：" + path;
        return false;
    }
    std::string bytes;
    char buf[65536];
    for (;;) {
        const std::size_t n = std::fread(buf, 1, sizeof(buf), f);
        if (n > 0) bytes.append(buf, n);
        if (n < sizeof(buf)) break;
    }
    const bool bad = (std::ferror(f) != 0);
    std::fclose(f);
    if (bad) {
        err = "读场景文件出错：" + path;
        return false;
    }

    // 哈希算的是文件**原始字节**，不是解析后再序列化的结果——重排缩进就换哈希，
    // 所以场景编辑器保存后必须把落盘字节的哈希回给前端写进框图（08 报告 §9）。
    out.path = path;
    out.sha256 = sha256_hex(bytes);

    nlohmann::json j;
    try {
        j = nlohmann::json::parse(bytes);
    } catch (const std::exception& e) {
        err = std::string("场景文件不是合法 JSON：") + e.what();
        return false;
    }
    if (!parse_scenario(j, out.scenario, err)) return false;
    return out.scenario.cross_check(err);
}

bool check_aoi_manifest(const geo::Scenario& s, const std::string& scene_root,
                        std::string& actual_sha256, std::string& err) {
    actual_sha256.clear();
    if (!s.aoi_manifest_sha256.empty() && s.aoi_manifest_sha256[0] == '<') {
        err = "场景的 aoi.manifest_sha256 还是占位符 " + s.aoi_manifest_sha256 +
              "，必须填观测区域清单的真实哈希（铁律 15：不静默放行）";
        return false;
    }
    const std::string manifest = scene_root + "/" + s.aoi_id + "/manifest.json";
    if (!sha256_file(manifest, actual_sha256, err)) return false;
    if (actual_sha256 != s.aoi_manifest_sha256) {
        err = "场景声明的观测区域清单哈希与 " + manifest + " 不符：场景写 " +
              s.aoi_manifest_sha256.substr(0, 8) + "…，实际 " + actual_sha256.substr(0, 8) + "…";
        return false;
    }
    return true;
}

}  // namespace cuav
