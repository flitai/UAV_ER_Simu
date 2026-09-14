// 评价指标的落盘形状（C-5）。与 evaluation.h 分开只为不把 nlohmann/json 拖进 observer.h 的包含链。
#pragma once

#include <string>

#include "nlohmann/json.hpp"

#include "cuav/evaluation.h"

namespace cuav {

// 分节里 detector{} 一段的内容：评价器从检测行与块元数据里取到的检测器参数，Python 参考据此重算。
struct DetectorInfo {
    std::size_t nfft = 0;
    double sample_rate_Hz = 0.0;
    double f_lo_Hz = 0.0, f_hi_Hz = 0.0;   // 绝对频率
};

// metrics.json 的一节（cuav-metrics/1，10 报告附录 C + D-053 按站分节）。NaN → null。
nlohmann::json metrics_section_json(const EvaluationMetrics& m, const EvalParams& p, const DetectorInfo& d,
                                    const std::string& node_id, const std::string& site_id,
                                    const ModelTrace& trace);

}  // namespace cuav
