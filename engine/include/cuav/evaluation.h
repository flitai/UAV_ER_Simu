// 真值与评价的纯函数层（C-5，D-067；10 报告 §4.5、附录 C）。
//
// 组件 Evaluator 只负责攒行与构造真值区间，指标全部在这里算；运行器与单测共用同一份实现，
// Python 参考 algos/reference/evaluate.py 逐步同序、逐值对拍（浮点按 D-046 ⑧ 显式循环累加）。
// 口径（两侧共同的契约，改动即基准变化，铁律 10）：
//   帧真值   帧中点 t_s + frame_dt/2 落在任一 in_band 真值区间内即「有信号」（区间先取并集）
//   突发匹配 overlap / min(len_det, len_truth) ≥ match_overlap；发现时延 = 首个匹配检测段起点 − 真值起点，钳到 ≥ 0
//   识别真值 与检测段重叠最大的真值段的标签（并列取 t_s 早者、再 emitter_id 字典序）
//   ROC      统计量升序，门限取 sorted[⌊i·(n−1)/(P−1)⌋] 去重，判决用严格大于（与检测器同）
//   分母为零 的比值一律 NaN，落盘写 null（铁律 15：缺的就是缺的）
#pragma once

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "cuav/component.h"

namespace cuav {

inline double eval_nan() { return std::numeric_limits<double>::quiet_NaN(); }

// 一段真值：一个辐射源在一段时间里、以某个中心频率与带宽在发射。
// scenario 模式下 burst 波形的每个导通窗一行、tone / noise 一段一行；manifest 模式全片一行（emitter_id 空、频率 NaN）。
struct TruthRow {
    double t_s = 0.0, t_end_s = 0.0;   // 半开区间 [t_s, t_end_s)
    std::string emitter_id;            // manifest 模式为空
    std::string label;                 // signal_role 层标签
    std::string waveform;              // tone / noise / burst / manifest
    double center_Hz = eval_nan();
    double bw_Hz = eval_nan();
    bool in_band = true;               // [center ± bw/2] 与检测频段相交；频段外的行只计数不进指标
};

struct EvalParams {
    std::string truth_source = "scenario";   // scenario / manifest / none
    double match_overlap = 0.5;
    std::size_t roc_points = 32;
    double frame_dt_s = 0.0;                  // nfft / fs，帧时长
    double threshold = eval_nan();            // 检测器的工作点门限（取自检测行；NaN = 未知）
    bool has_rec = false;                     // rec 口是否接了识别器
};

struct FrameMetrics {
    std::uint64_t total = 0, truth_on = 0, tp = 0, fp = 0, fn = 0, tn = 0;
    double pd = eval_nan(), pfa = eval_nan(), precision = eval_nan(), recall = eval_nan(), f1 = eval_nan();
};

struct SegmentMetrics {
    std::uint64_t truth = 0;              // in_band 的真值段数
    std::uint64_t truth_out_of_band = 0;  // 频段外的真值段数（EM-S-02 §10.18 not_observed，不进分母）
    std::uint64_t detected = 0;           // 检测段数
    std::uint64_t matched = 0;            // 匹配上的真值段数
    std::uint64_t false_segments = 0;     // 没匹配上任何真值的检测段数
    double pd_segment = eval_nan();
    double detect_delay_mean_s = eval_nan(), detect_delay_max_s = eval_nan();
};

struct RocPoint {
    double threshold = eval_nan(), pd = eval_nan(), pfa = eval_nan();
};

struct RocMetrics {
    RocPoint working_point;
    std::vector<RocPoint> points;
};

struct ClassMetrics {
    std::string label;
    std::uint64_t support = 0;
    double precision = eval_nan(), recall = eval_nan(), f1 = eval_nan();
};

struct RecognitionMetrics {
    State state = State::Valid;                       // rec 口未接 → NotApplicable
    std::vector<std::string> labels;                  // 四个基础标签 + 其它（字典序）+ unknown 末位
    std::vector<std::vector<std::uint64_t>> confusion;   // [真值][识别]，方阵
    std::uint64_t evaluated = 0;                      // 匹配上真值段、进了混淆矩阵的识别行数
    std::uint64_t unmatched = 0;                      // 识别行对应的检测段没匹配上真值（或找不到该段）
    std::uint64_t unknown_count = 0, ambiguous_count = 0;
    double accuracy = eval_nan(), unknown_rate = eval_nan(), ambiguous_rate = eval_nan();
    std::vector<ClassMetrics> per_class;              // 不含 unknown
};

struct QualityMetrics {
    std::uint64_t overload_frames = 0;
    std::uint64_t truth_rows = 0;         // 全部真值行数（含频段外）
};

struct EvaluationMetrics {
    FrameMetrics frames;
    SegmentMetrics segments;
    RocMetrics roc;
    RecognitionMetrics recognition;
    QualityMetrics quality;
    State state = State::Valid;
    std::vector<std::string> reasons;
};

// 纯函数：检测行（任意顺序，内部按 frame_index 排序）、识别行、真值行 → 指标。
EvaluationMetrics evaluate(const std::vector<Detection>& det, const std::vector<RecognitionRow>& rec,
                           const std::vector<TruthRow>& truth, const EvalParams& params);

// 混淆矩阵的基础标签序（10 报告附录 D 的四类），其后接遇到的其它标签（字典序）与 unknown。
const std::vector<std::string>& base_labels();

}  // namespace cuav
