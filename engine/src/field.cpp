#include "cuav/field.h"

#include <cmath>
#include <fstream>
#include <sstream>

#include "cuav/buildings_json.h"
#include "cuav/dsp.h"
#include "cuav/propagation_params.h"
#include "cuav/registry.h"
#include "cuav_geo/link_budget.h"

namespace cuav {
namespace {

const double kPi = 3.14159265358979323846;
// 一次请求最多这么多格：20 × 20 km 在 10 m 网格上就是四百万格，那是在拿服务端当沙袋
const long long kMaxCells = 1000000;

bool fail(std::string& err, const std::string& msg) { err = msg; return false; }

// 请求里的传播参数按 ScenarioSource 自己的参数描述校验：只收那十五个，类型与取值范围照组件目录。
// 于是框图里合法的传播配置在这里也合法，框图里不合法的这里一样拒——没有第二套规则。
bool split_propagation(const nlohmann::json& j, std::map<std::string, double>& num,
                       std::map<std::string, std::string>& txt, std::string& err) {
    Registry reg = builtin_registry();
    ComponentInfo full;
    if (!reg.describe("ScenarioSource", full, err)) return false;
    ComponentInfo sub;
    sub.type = "ScenarioSource（传播参数）";
    const std::vector<std::string>& names = propagation_param_names();
    for (std::size_t i = 0; i < full.params.size(); ++i) {
        for (std::size_t k = 0; k < names.size(); ++k)
            if (full.params[i].name == names[k]) sub.params.push_back(full.params[i]);
    }
    if (!j.is_object()) return fail(err, "propagation 必须是对象");
    for (auto it = j.begin(); it != j.end(); ++it) {
        const std::string& key = it.key();
        const ParamSpec* s = 0;
        for (std::size_t i = 0; i < sub.params.size(); ++i)
            if (sub.params[i].name == key) s = &sub.params[i];
        if (!s) return fail(err, "propagation 里的未知参数 " + key + "（只收传播信道的十五个参数）");
        const nlohmann::json& v = it.value();
        if (v.is_boolean()) num[key] = v.get<bool>() ? 1.0 : 0.0;
        else if (v.is_number()) num[key] = v.get<double>();
        else if (v.is_string()) txt[key] = v.get<std::string>();
        else return fail(err, "propagation." + key + " 的值只能是数、文本或布尔");
    }
    return validate_params(sub, num, txt, err);
}

bool read_bbox(const std::string& scene_root, const std::string& aoi_id, double bbox[4], std::string& err) {
    const std::string path = scene_root + "/" + aoi_id + "/manifest.json";
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f) return fail(err, "打不开观测区域清单：" + path);
    std::stringstream ss;
    ss << f.rdbuf();
    nlohmann::json m;
    try {
        m = nlohmann::json::parse(ss.str());
    } catch (const std::exception& e) {
        return fail(err, std::string("观测区域清单不是合法 JSON：") + e.what());
    }
    if (!m.contains("crs") || !m["crs"].is_string() || m["crs"].get<std::string>() != "EPSG:4326")
        return fail(err, path + " 的 crs 不是 EPSG:4326（铁律 1）");
    const nlohmann::json* b = (m.contains("aoi") && m["aoi"].is_object() && m["aoi"].contains("bbox")) ? &m["aoi"]["bbox"] : 0;
    if (!b || !b->is_array() || b->size() != 4)
        return fail(err, path + " 缺 aoi.bbox [西, 南, 东, 北]，覆盖场没有网格边界可用");
    for (int i = 0; i < 4; ++i) {
        if (!(*b)[i].is_number()) return fail(err, path + " 的 aoi.bbox 不全是数");
        bbox[i] = (*b)[i].get<double>();
    }
    if (!(bbox[2] > bbox[0]) || !(bbox[3] > bbox[1])) return fail(err, path + " 的 aoi.bbox 东西或南北颠倒");
    return true;
}

// 检测频段内的频点数：fftshift 后 f ∈ [lo, hi)，与 EnergyDetector::build_mask() 同式。
int band_bins(int nfft, double fs_Hz, double lo_Hz, double hi_Hz) {
    int m = 0;
    for (int k = 0; k < nfft; ++k) {
        const double idx = static_cast<double>(k) - static_cast<double>(nfft / 2);
        const double f = idx * fs_Hz / static_cast<double>(nfft);
        if (f >= lo_Hz && f < hi_Hz) ++m;
    }
    return m;
}

// 阴影平均后的 Pd 表：A(s) = ∫ φ_σ(x) · Pd(s − x) dx，s 是不含阴影的带内信噪比（dB）。
//
// **为什么是表而不是求积公式**：M ≈ 921 时 Pd(s) 在 dB 轴上是一道一两 dB 宽的陡坎，σ = 6 dB 的高斯
// 用 16 点 Gauss–Hermite 去积，节点隔得比那道坎还宽——实测陡坡上一格求积给 0.451、20 万次蒙特卡洛
// 给 0.435，差 14 倍标准误。改成先在 0.01 dB 细格上把 Pd 算出来、与离散化的高斯卷积，一站只做一次，
// 逐格线性插值（插值误差量级 1e-5，远小于蒙特卡洛能分辨的 1e-3）。
struct ShadowTable {
    double lo = 0.0, step = 0.01;
    std::vector<double> v;
    double at(double s) const {
        if (v.empty()) return 0.0;
        const double u = (s - lo) / step;
        if (u <= 0.0) return v.front();
        const double umax = static_cast<double>(v.size() - 1);
        if (u >= umax) return v.back();
        const std::size_t i = static_cast<std::size_t>(u);
        const double t = u - static_cast<double>(i);
        return v[i] + t * (v[i + 1] - v[i]);
    }
};

// 表覆盖 [−80, +80] dB 的信噪比；表外 Pd 已饱和（−80 dB 处就是虚警率、+80 dB 处是 1），取端点。
ShadowTable build_shadow_table(int m_bins, double eta, double sigma_dB) {
    ShadowTable t;
    const double step = t.step, half = 80.0;
    const int kx = static_cast<int>(std::ceil(8.0 * sigma_dB / step));   // 高斯截到 ±8σ，尾部质量 < 1e-15
    const int ns = static_cast<int>(std::lround(2.0 * half / step)) + 1;
    t.lo = -half;
    // 底表：Pd 在 [−half − 8σ, half + 8σ] 上逐 0.01 dB
    const int nb = ns + 2 * kx;
    std::vector<double> base(static_cast<std::size_t>(nb));
    for (int i = 0; i < nb; ++i) {
        const double s = -half + (i - kx) * step;
        base[static_cast<std::size_t>(i)] = dsp::pd_random(m_bins, eta, std::pow(10.0, s / 10.0));
    }
    // 离散高斯权（按格积分的中点近似，再归一，保证常数进常数出）
    std::vector<double> w(static_cast<std::size_t>(2 * kx + 1));
    double sum = 0.0;
    for (int k = -kx; k <= kx; ++k) {
        const double x = k * step;
        w[static_cast<std::size_t>(k + kx)] = std::exp(-0.5 * x * x / (sigma_dB * sigma_dB));
        sum += w[static_cast<std::size_t>(k + kx)];
    }
    for (double& x : w) x /= sum;
    // A(s_i) = Σ_k w_k · Pd(s_i − x_k)；阴影 X 为正即多衰减，故 s − x
    t.v.assign(static_cast<std::size_t>(ns), 0.0);
    for (int i = 0; i < ns; ++i) {
        double acc = 0.0;
        for (int k = -kx; k <= kx; ++k) acc += w[static_cast<std::size_t>(k + kx)] * base[static_cast<std::size_t>(i + kx - k)];
        t.v[static_cast<std::size_t>(i)] = acc;
    }
    return t;
}

struct CellEval {
    geo::LinkGeometry g;
    geo::LinkBudget b;
    double snr_dB = 0.0;
    double pd = 0.0;
};

}  // namespace

bool parse_field_request(const nlohmann::json& j, FieldRequest& out, std::string& err) {
    out = FieldRequest();
    if (!j.is_object()) return fail(err, "覆盖场请求必须是 JSON 对象");
    static const char* const known[] = {"schema_version", "emitter_id", "height_agl_m", "res_m",
                                        "propagation", "detectors", "points"};
    for (auto it = j.begin(); it != j.end(); ++it) {
        bool ok = false;
        for (const char* k : known) ok = ok || it.key() == k;
        if (!ok) return fail(err, "覆盖场请求里的未知键 " + it.key());
    }
    if (!j.contains("schema_version") || j["schema_version"] != "cuav-field-request/1")
        return fail(err, "schema_version 必须是 cuav-field-request/1");
    if (!j.contains("emitter_id") || !j["emitter_id"].is_string()) return fail(err, "缺 emitter_id");
    out.emitter_id = j["emitter_id"].get<std::string>();
    if (!j.contains("height_agl_m") || !j["height_agl_m"].is_number() || !(j["height_agl_m"].get<double>() >= 0.0))
        return fail(err, "height_agl_m 必须是不小于 0 的数（离地高度，米）");
    out.height_agl_m = j["height_agl_m"].get<double>();
    if (j.contains("res_m")) {
        if (!j["res_m"].is_number() || !(j["res_m"].get<double>() >= 10.0) || !(j["res_m"].get<double>() <= 2000.0))
            return fail(err, "res_m 必须在 10 到 2000 米之间");
        out.res_m = j["res_m"].get<double>();
    }
    if (!split_propagation(j.contains("propagation") ? j["propagation"] : nlohmann::json::object(),
                           out.prop_num, out.prop_txt, err)) return false;
    if (!j.contains("detectors") || !j["detectors"].is_object()) return fail(err, "缺 detectors（站 id → 检测器参数）");
    for (auto it = j["detectors"].begin(); it != j["detectors"].end(); ++it) {
        const nlohmann::json& d = it.value();
        FieldDetector fd;
        const std::string who = "detectors." + it.key();
        if (!d.is_object()) return fail(err, who + " 必须是对象");
        for (auto k = d.begin(); k != d.end(); ++k) {
            if (k.key() != "nfft" && k.key() != "pfa" && k.key() != "band_lo_Hz" && k.key() != "band_hi_Hz")
                return fail(err, who + " 里的未知键 " + k.key());
            if (!k.value().is_number()) return fail(err, who + "." + k.key() + " 必须是数");
        }
        if (!d.contains("nfft") || !d.contains("pfa") || !d.contains("band_lo_Hz") || !d.contains("band_hi_Hz"))
            return fail(err, who + " 须给全 nfft / pfa / band_lo_Hz / band_hi_Hz");
        const double nfft = d["nfft"].get<double>();
        if (!(nfft >= 2.0) || nfft != std::floor(nfft) || nfft > 1048576.0) return fail(err, who + ".nfft 必须是不小于 2 的整数");
        fd.nfft = static_cast<int>(nfft);
        fd.pfa = d["pfa"].get<double>();
        if (!(fd.pfa > 0.0 && fd.pfa < 1.0)) return fail(err, who + ".pfa 必须在 (0, 1) 内");
        fd.band_lo_Hz = d["band_lo_Hz"].get<double>();
        fd.band_hi_Hz = d["band_hi_Hz"].get<double>();
        if (!(fd.band_hi_Hz > fd.band_lo_Hz)) return fail(err, who + " 频段上下限颠倒");
        out.detectors[it.key()] = fd;
    }
    if (j.contains("points")) {
        if (!j["points"].is_array()) return fail(err, "points 必须是 [[经度, 纬度(, 离地高度)], …]");
        for (const auto& p : j["points"]) {
            if (!p.is_array() || (p.size() != 2 && p.size() != 3) || !p[0].is_number() || !p[1].is_number()
                || (p.size() == 3 && (!p[2].is_number() || !(p[2].get<double>() >= 0.0))))
                return fail(err, "points 的每一项必须是 [经度, 纬度] 或 [经度, 纬度, 不小于 0 的离地高度]");
            FieldRequest::Point q;
            q.lon = p[0].get<double>();
            q.lat = p[1].get<double>();
            q.height_agl_m = p.size() == 3 ? p[2].get<double>() : out.height_agl_m;
            out.points.push_back(q);
        }
    }
    return true;
}

void field_grid(const double bbox[4], double res_m, int& nx, int& ny) {
    const double lat_mid = 0.5 * (bbox[1] + bbox[3]) * kPi / 180.0;
    const double width_m = (bbox[2] - bbox[0]) * 111320.0 * std::cos(lat_mid);
    const double height_m = (bbox[3] - bbox[1]) * 111132.0;
    nx = static_cast<int>(std::lround(width_m / res_m));
    ny = static_cast<int>(std::lround(height_m / res_m));
    if (nx < 1) nx = 1;
    if (ny < 1) ny = 1;
}

bool compute_field(const geo::Scenario& sc, const FieldRequest& req, const std::string& scene_root,
                   FieldResult& out, std::string& err) {
    out = FieldResult();
    const geo::Emitter* em = sc.find_emitter(req.emitter_id);
    if (!em) return fail(err, "场景 " + sc.scenario_id + " 里没有辐射源 " + req.emitter_id);
    if (sc.sites.empty()) return fail(err, "场景 " + sc.scenario_id + " 里没有侦测站");
    for (std::size_t i = 0; i < sc.sites.size(); ++i)
        if (!req.detectors.count(sc.sites[i].id))
            return fail(err, "detectors 里缺站 " + sc.sites[i].id + " 的检测器参数");

    geo::PropagationConfig cfg;
    if (!propagation_from_params(req.prop_num, req.prop_txt, cfg, err)) return false;
    out.prop_level = geo::to_string(cfg.level);

    if (!read_bbox(scene_root, sc.aoi_id, out.bbox, err)) return false;
    field_grid(out.bbox, req.res_m, out.nx, out.ny);
    if (static_cast<long long>(out.nx) * out.ny > kMaxCells)
        return fail(err, "网格 " + std::to_string(out.nx) + " × " + std::to_string(out.ny) + " 超过一百万格，请把 res_m 调大");

    // E3 才读建筑；与链路帧同一个共享地图、同一个平面帧（shared_scene_map 一并给出，不许另算）
    geo::OcclusionQuery occ;
    bool use_occ = false;
    if (cfg.level == geo::PropLevel::E3) {
        BuildingsStats stats;
        geo::SceneFrame frame;
        const geo::LocalSceneAdapter* m = shared_scene_map(scene_root, sc.aoi_id, stats, frame, err);
        if (!m) return fail(err, "选了 E3（建筑遮挡与绕射）但建筑几何取不到：" + err);
        occ.map = m;
        occ.frame = frame;
        occ.frequency_Hz = em->emission.center_Hz;
        use_occ = true;
        out.notes.push_back(stats.summary());
    }

    const double f = em->emission.center_Hz;
    const double terrain = sc.coordinate.terrainHeight_m;
    const bool shadow = cfg.shadow && cfg.effects_enabled();

    const long long n = static_cast<long long>(out.nx) * out.ny;
    std::vector<double> miss(static_cast<std::size_t>(n), 1.0);
    const double dlon = (out.bbox[2] - out.bbox[0]) / out.nx;
    const double dlat = (out.bbox[3] - out.bbox[1]) / out.ny;
    bool terms_taken = false;

    for (std::size_t si = 0; si < sc.sites.size(); ++si) {
        const geo::Site& site = sc.sites[si];
        const FieldDetector& d = req.detectors.at(site.id);
        FieldSite fs;
        fs.id = site.id;
        fs.m_bins = band_bins(d.nfft, site.receiver.fs_Hz, d.band_lo_Hz, d.band_hi_Hz);
        if (fs.m_bins <= 0) return fail(err, "站 " + site.id + " 的检测频段内没有频点");
        fs.eta = dsp::threshold_for_pfa(fs.m_bins, d.pfa);
        fs.noise_bw_Hz = fs.m_bins * site.receiver.fs_Hz / d.nfft;
        const double df = f - site.receiver.center_Hz;
        fs.out_of_band = !(df >= d.band_lo_Hz && df < d.band_hi_Hz);   // 与频点掩码同一个左闭右开
        fs.shadow_sigma_dB = shadow ? geo::shadow_sigma_dB(cfg, true) : 0.0;
        fs.pd.assign(static_cast<std::size_t>(n), 0.0f);
        ShadowTable table;
        if (shadow && fs.shadow_sigma_dB > 0.0) table = build_shadow_table(fs.m_bins, fs.eta, fs.shadow_sigma_dB);

        auto eval = [&](double lon, double lat, double h, CellEval& c) {
            const geo::Lla target(lon, lat, terrain + h);
            c.g = geo::link_geometry(site.position, target, geo::Ecef(), terrain, use_occ ? &occ : 0);
            // 阴影样本给 0：平均在下面对 Pd 做，不在路损上做（Pd 对 snr 是非线性的）
            c.b = geo::link_budget(c.g, f, site.receiver.nf_dB, cfg, 0.0, em->emission.polarization);
            if (!c.b.valid) { c.pd = 0.0; return; }
            const double s_dBm = em->emission.tx_power_dBm + em->emission.antenna_gain_dBi + site.antenna.gain_dBi
                                 - c.b.path_loss_dB;
            const double n_dBm = c.b.noise_floor_dBm_per_Hz + 10.0 * std::log10(fs.noise_bw_Hz);
            c.snr_dB = s_dBm - n_dBm;
            if (fs.out_of_band) { c.pd = d.pfa; return; }
            // 不开阴影：直接代公式；开了：查阴影平均表 E_X[Pd(snr − X)]，X ~ N(0, σ)
            c.pd = table.v.empty() ? dsp::pd_random(fs.m_bins, fs.eta, std::pow(10.0, c.snr_dB / 10.0))
                                   : table.at(c.snr_dB);
        };

        CellEval c;
        for (int jy = 0; jy < out.ny; ++jy) {
            const double lat = out.bbox[3] - (jy + 0.5) * dlat;
            for (int ix = 0; ix < out.nx; ++ix) {
                const double lon = out.bbox[0] + (ix + 0.5) * dlon;
                eval(lon, lat, req.height_agl_m, c);
                const std::size_t k = static_cast<std::size_t>(jy) * out.nx + ix;
                fs.pd[k] = static_cast<float>(c.pd);
                miss[k] *= 1.0 - c.pd;
                if (!c.g.line_of_sight) ++fs.blocked;
                if (c.b.degraded) ++fs.degraded;
                if (!terms_taken && c.b.valid) { out.included_loss_terms = c.b.terms.included; terms_taken = true; }
            }
        }
        for (std::size_t p = 0; p < req.points.size(); ++p) {
            if (out.points.size() <= p) {
                FieldPoint fp;
                fp.lon = req.points[p].lon;
                fp.lat = req.points[p].lat;
                fp.height_agl_m = req.points[p].height_agl_m;
                out.points.push_back(fp);
            }
            eval(req.points[p].lon, req.points[p].lat, req.points[p].height_agl_m, c);
            FieldPointSite ps;
            ps.distance_m = c.g.distance_m;
            ps.path_loss_dB = c.b.path_loss_dB;
            ps.diffraction_dB = c.g.diffraction_dB;
            ps.line_of_sight = c.g.line_of_sight;
            ps.snr_dB = c.snr_dB;
            ps.pd = c.pd;
            ps.valid = c.b.valid;
            out.points[p].sites[site.id] = ps;
        }
        out.sites.push_back(fs);
    }
    out.combined.resize(static_cast<std::size_t>(n));
    for (long long k = 0; k < n; ++k) out.combined[static_cast<std::size_t>(k)] = static_cast<float>(1.0 - miss[static_cast<std::size_t>(k)]);
    return true;
}

}  // namespace cuav
