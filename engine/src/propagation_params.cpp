#include "cuav/propagation_params.h"

namespace cuav {
namespace {

bool get_text(const std::map<std::string, std::string>& t, const char* key, std::string& out) {
    std::map<std::string, std::string>::const_iterator it = t.find(key);
    if (it == t.end()) return false;
    out = it->second;
    return true;
}

double get_num(const std::map<std::string, double>& p, const char* key, double def) {
    std::map<std::string, double>::const_iterator it = p.find(key);
    return it == p.end() ? def : it->second;
}

}  // namespace

const std::vector<std::string>& propagation_param_names() {
    static const std::vector<std::string> names = {
        "prop_level", "prop_primary", "prop_shadow", "prop_weather", "env_class", "ground_type",
        "ground_roughness_m", "coherence_rho", "max_fade_depth_dB", "path_loss_exponent",
        "ref_distance_m", "urban_loss_mode", "shadow_sigma_dB", "shadow_corr_distance_m", "rain_rate_mmh",
    };
    return names;
}

bool propagation_from_params(const std::map<std::string, double>& params,
                             const std::map<std::string, std::string>& text_params,
                             geo::PropagationConfig& out, std::string& err) {
    // 枚举一律显式解析：认不出就报错，不拿缺省顶替（铁律 15）。
    std::string txt;
    out = geo::PropagationConfig();
    if (get_text(text_params, "prop_level", txt) && !geo::parse_prop_level(txt, out.level)) {
        err = "prop_level 必须是 E1 / E2 / E3 之一，收到 " + txt;
        return false;
    }
    if (get_text(text_params, "prop_primary", txt)
        && !geo::parse_primary_model(txt, out.primary)) {
        err = "prop_primary 必须是 free_space / two_ray / urban_empirical 之一，收到 " + txt;
        return false;
    }
    if (get_text(text_params, "env_class", txt) && !geo::parse_env_class(txt, out.env)) {
        err = "env_class 必须是 open / suburban / urban / dense_urban 之一，收到 " + txt;
        return false;
    }
    if (get_text(text_params, "ground_type", txt) && !geo::parse_ground_type(txt, out.ground)) {
        err = "ground_type 必须是 paved / grass / water / dirt / unknown 之一，收到 " + txt;
        return false;
    }
    if (get_text(text_params, "urban_loss_mode", txt)
        && !geo::parse_urban_loss_mode(txt, out.urban_mode)) {
        err = "urban_loss_mode 必须是 mean / mean_with_shadow_margin 之一，收到 " + txt;
        return false;
    }
    out.shadow = get_num(params, "prop_shadow", 0.0) != 0.0;
    out.weather = get_num(params, "prop_weather", 0.0) != 0.0;
    out.roughness_m = get_num(params, "ground_roughness_m", -1.0);
    out.coherence_rho = get_num(params, "coherence_rho", 1.0);
    out.max_fade_depth_dB = get_num(params, "max_fade_depth_dB", 20.0);
    out.path_loss_exponent = get_num(params, "path_loss_exponent", -1.0);
    out.ref_distance_m = get_num(params, "ref_distance_m", 100.0);
    out.shadow_sigma_dB = get_num(params, "shadow_sigma_dB", -1.0);
    out.shadow_corr_distance_m = get_num(params, "shadow_corr_distance_m", 50.0);
    out.rain_rate_mmh = get_num(params, "rain_rate_mmh", 0.0);
    // 档位与组合的跨参数约束都在这一处（E1 却选了效应、城市经验裕度与统计阴影双计、E3 的闸三闸四）
    return out.validate(err);
}

}  // namespace cuav
