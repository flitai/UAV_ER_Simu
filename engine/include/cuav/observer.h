// 运行观察者（06 备忘录 §9A B-3）。引擎把进度、实体状态、链路读数、日志与显示产品行
// 经回调交给运行器（cuav_run，B-4），运行器再转成 stdout JSON 事件与文件。
//
// 为什么用回调而不是端口：这些都不是数据流（04 §8.3「将运行状态、日志摘要和降采样显示产品
// 发布给应用服务」），实体状态与链路读数按决策 D-033 也不做端口类型。
// 观察者是可选的：Graph::run 不带观察者时行为不变。

#ifndef CUAV_OBSERVER_H
#define CUAV_OBSERVER_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/evaluation.h"

namespace cuav {

struct ProgressInfo {
    std::uint64_t round = 0;
    std::vector<std::string> node_names;
    std::vector<ComponentStatus> node_status;
};

// 实体状态与链路读数的结构见 docs/scenario-format.md §7 与 docs/api-versions.md §4（link 事件）。
struct EntityState {
    double t_s = 0.0;
    std::string id;
    double lon = 0.0, lat = 0.0, alt_m = 0.0;
    double heading_deg = 0.0, speed_mps = 0.0;
    bool tx_on = true;
    double center_Hz = 0.0;
};

struct LinkFrame {
    std::string link_id;
    double t_s = 0.0;
    bool line_of_sight = true;
    double distance_m = 0.0, azimuth_deg = 0.0, elevation_deg = 0.0;
    double path_loss_dB = 0.0, delay_s = 0.0, doppler_Hz = 0.0;
    double valid_from_s = 0.0, valid_to_s = 0.0, update_rate_Hz = 0.0;
    // 传播分档（D-058）：path_loss_dB = free_space_dB + extra_loss_dB 恒成立；
    // included_loss_terms 是 free_space / ground_reflection / urban_mean / diffraction / shadow / weather
    // 的有序子集，下游据此判断能不能再叠加（EM-P-13 §10.9）。
    // E1 缺省档下 extra 恒 0、清单只有 free_space，读数与 D-058 之前逐数值相同。
    double free_space_dB = 0.0, extra_loss_dB = 0.0;
    // E3 档的建筑刀口衍射（EM-P-04，D3-5），已含在 extra_loss_dB 里。
    // **运行器只在它非零时写这个键**，于是 E1 / E2 的 links.jsonl 逐字节不变。
    double diffraction_dB = 0.0;
    std::vector<std::string> included_loss_terms;
    State state = State::Valid;
};

// 检测行与检测摘要（C-3，D-063）。行是逐帧的：Detection 自带时间、频段、电平与突发编号，
// 这里再加节点与站点身份。摘要在 flush() 时每个检测器发一次，带溯源六件套与计数。
// 行**不带 trace**——逐帧重复七个键只会把文件撑大一半；trace 由运行器写进 detections.index.json
// 一次到位（铁律 8 的「每个数据产物挂同构元数据」由索引文件兑现，与观测点产品的索引同法）。
struct DetectionReport {
    std::string node_id;
    std::string site_id;     // 未绑站时为空，运行器省略该键
    Detection d;
};

struct DetectionSummary {
    std::string node_id;
    std::string site_id;
    ModelTrace trace;
    std::size_t nfft = 0;
    double sample_rate_Hz = 0.0;
    double center_Hz = 0.0;
    double band_lo_Hz = 0.0, band_hi_Hz = 0.0;   // 绝对频率
    std::size_t m_bins = 0;                       // 频段内 bin 数 M：门限 Q(M, M·η) = pfa 与解析检出率的参数
    double pfa = 0.0;
    double threshold = 0.0;
    std::string noise_mode;                       // probe / sliding
    std::size_t noise_window_frames = 0;          // sliding 的环长；probe 时为实际用的探针帧数
    std::size_t merge_gap_frames = 0;
    double dt_s = 0.0;                            // 一帧的时长 nfft / fs
    std::uint64_t frames = 0, hits = 0, segments = 0;
    std::uint64_t noise_stale_frames = 0;         // sliding：环连续超过 W 帧未更新时判决的帧数
    std::uint64_t overload_frames = 0;
    bool calibrated = false;
    State state = State::Valid;
    std::vector<std::string> notes;
};

// 特征行（C-4）。与检测行同一范式：自描述的行加节点与站点身份。特征是按突发出的（每个突发一行），
// 量级比检测行小两个数量级，所以行**自带 trace**（与 bearings.jsonl 同法），不另设索引文件。
struct FeatureReport {
    std::string node_id;
    std::string site_id;     // 未绑站时为空，运行器省略该键
    FeatureRow row;
    ModelTrace trace;
};

// 识别行（C-4）。与特征行同范式：每个突发一行、自带 trace。
struct RecognitionReport {
    std::string node_id;
    std::string site_id;
    RecognitionRow row;
    ModelTrace trace;
};

// 真值行与评价指标（C-5，D-067）。评价器不写文件：真值行逐行、指标在 flush() 时一次经这里上报，
// 运行器落 truth.jsonl 并把 K 个站的分节拼成一份 metrics.json（与 detections.index.json 同法）。
struct TruthReport {
    std::string node_id;
    std::string site_id;     // 未绑站时为空
    TruthRow row;
};

// detector{} 一段：评价器从检测行与块元数据里取到的检测器参数，metrics.json 的分节带它，Python 参考据此重算
struct EvaluatorDetectorInfo {
    std::size_t nfft = 0;
    double sample_rate_Hz = 0.0;
    double f_lo_Hz = 0.0, f_hi_Hz = 0.0;
};

struct EvaluationReport {
    std::string node_id;
    std::string site_id;
    EvaluationMetrics metrics;
    EvalParams params;
    EvaluatorDetectorInfo detector;
    ModelTrace trace;
};

class IRunObserver {
public:
    virtual ~IRunObserver() {}
    virtual void on_progress(const ProgressInfo&) {}
    virtual void on_entity(const EntityState&) {}
    virtual void on_link(const LinkFrame&) {}
    virtual void on_log(const std::string& level, const std::string& message) { (void)level; (void)message; }
    // 测向与定位报告（D-053）。与 on_link 同法：不是数据流，走回调，由运行器落 JSONL 并发事件。
    virtual void on_bearing(const BearingReport&) {}
    // 到达时间报告不单独落盘（它是隐含节点的中间量），但留一个回调供诊断与将来的产品
    virtual void on_toa(const ToaReport&) {}
    virtual void on_position(const PositionReport&) {}
    // 检测行与摘要（D-063）。与 on_bearing 同法：端口上照旧交 DetectionList 给下游，
    // 观察者这条路由运行器落 detections.jsonl / detections.index.json 并发事件。
    virtual void on_detection(const DetectionReport&) {}
    virtual void on_detection_summary(const DetectionSummary&) {}
    // 突发特征（C-4）：端口上照旧交 FeatureVector 给下游，这条路由运行器落 features.jsonl 并发 feature 事件
    virtual void on_feature(const FeatureReport&) {}
    virtual void on_recognition(const RecognitionReport&) {}
    // 真值行与评价指标（C-5）：评价器 flush() 时上报，运行器落 truth.jsonl 与 metrics.json
    virtual void on_truth(const TruthReport&) {}
    virtual void on_evaluation(const EvaluationReport&) {}
    // 一行显示产品：kind ∈ {spectrum, envelope}；row 为 float32，len 个元素；t_s 为该行首样点的逻辑时间。
    virtual void on_product_row(const std::string& op_id, const std::string& kind, std::uint64_t row_index,
                                const float* row, std::size_t len, double t_s) {
        (void)op_id; (void)kind; (void)row_index; (void)row; (void)len; (void)t_s;
    }
};

}  // namespace cuav

#endif  // CUAV_OBSERVER_H
