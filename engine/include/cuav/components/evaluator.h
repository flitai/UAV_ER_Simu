// 真值与评价 Evaluator（C-5，D-067；10 报告 §4.5 / 附录 C；04 §7.9、§11.4 任务层指标；EM-S-02 §10.18）。
//
// 评价不是模型：它把检测行（det）、识别行（rec）与真值对照，出帧级 Pd / Pfa / F1、突发级检出与发现时延、
// ROC（对每帧的统计量扫门限，不重跑）、识别混淆矩阵。真值只进这里（04 §5.2「可供评价使用但不向被测算法
// 泄漏」）：三种来源——
//   scenario  链路参数帧的 tx_on / tx_center_Hz（活动时间线）∩ 场景文件 emission.waveform 的门控（burst 的每个
//             导通窗一行）∩ 检测频段（[center ± bw/2] 与 [f_lo, f_hi] 相交），类别按波形反查（tone → cw_beacon、
//             burst → telemetry_burst / rc_hopping（有 hop）、noise ≥ 1 MHz → video_link、窄带 noise → noise）；
//   manifest  回放清单 truth.class_code：背景类（B / T0000）全片为假，飞控器类（DroneRFa T1xxxx）→ rc_hopping，
//             其余 → video_link；映射标 assumed，表在 data/iq/measured/README.md 与模型卡；
//   none      无真值，只有计数，指标 not_applicable。
// 消费真值的组件按 11 报告 §1.3 的约束：model_layer = M2、credibility ≤ V2、产物带 truth_consumed = true。
//
// 绑站（D-053 修正）：一个站的检测器看到的是 N 个源叠加后的信号，真值区间是这 N 条链路的并集；多站下每站一个
// eval__<site>，只收本站的参数帧。接受部分输入（accepts_partial_inputs）：det / rec / scene 三路不同拍，任一路
// 有数据就收下，上游全结束后在 flush() 里算——尾块（检测器最后一段的识别行）因此到得了这里。
// 不写文件：真值行与指标经观察者 on_truth / on_evaluation 上报，运行器落 truth.jsonl 并把 K 个站的分节拼成
// 一份 metrics.json（与 detections.index.json 同法）。

#ifndef CUAV_COMPONENTS_EVALUATOR_H
#define CUAV_COMPONENTS_EVALUATOR_H

#include <map>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/evaluation.h"
#include "cuav_geo/activity.h"
#include "cuav_geo/scenario.h"

namespace cuav {

class Evaluator : public IComponent {
public:
    std::string type_name() const override { return "Evaluator"; }
    std::vector<PortSpec> inputs() const override;
    std::vector<PortSpec> outputs() const override { return {}; }
    ComponentInfo describe() const override;
    bool check_wiring(const std::vector<std::string>& wired, std::string& err) const override;
    bool accepts_partial_inputs() const override { return true; }
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    void set_node_name(const std::string& name) override { node_name_ = name; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 供测试读取：flush() 之后有效
    const EvaluationMetrics& metrics() const { return metrics_; }
    const std::vector<TruthRow>& truth_rows() const { return truth_rows_; }
    const EvalParams& params() const { return eval_params_; }

    // 场景波形 → signal_role 标签的反查表（10 报告 §4.5；只是「场景怎么造的」的反查，不是识别算法的一部分）
    static std::string label_for_waveform(const std::string& waveform, double bw_Hz, bool has_hop);
    // 清单类别 → 标签；背景类返回空串（全片为假）。表见 data/iq/measured/README.md
    static std::string label_for_class_code(const std::string& class_code, bool& is_background);

private:
    // 场景里每个辐射源的静态信息（真值区间的带宽、波形门控与类别都从这里来；帧里没有带宽）
    struct EmitterInfo {
        double bw_Hz = 0.0;
        std::string waveform;      // tone / noise / burst
        double period_s = 0.0, duty = 0.0;
        bool has_hop = false;
        std::string label;
    };
    // 一段活动级的发射区间（tx_on 连续、中心频率不变）。
    // G-6（D-069）之后它的角色是「**链路可见窗口**」：跳频快于帧率时帧里的 tx_center_Hz
    // 只是混叠抽样，按它切段会切出一堆假边界，所以 build_truth_rows 会先把帧域切开的
    // 相邻段并回去，再用样点域的 ActivitySchedule 重新细分。
    struct Run {
        double start = 0.0, end = 0.0, center_Hz = 0.0;
    };

    std::string truth_source_ = "scenario";
    std::string data_id_, manifest_path_, scenario_path_, scenario_id_, site_id_, node_name_;
    double match_overlap_ = 0.5;
    std::size_t roc_points_ = 32;
    std::size_t nfft_ = 1024;
    IRunObserver* obs_ = nullptr;
    mutable bool rec_wired_ = false;        // check_wiring 里得知；validate 在 run 之前必跑

    std::map<std::string, EmitterInfo> emitters_;
    // 真值要按样点精确切段（G-6，D-069），因此把场景留在成员里而不是 configure 里用完就丢
    geo::Scenario scene_;
    bool has_scene_ = false;
    // 真值退回帧粒度了（取不到采样率或活动时间线折不成样点）：如实标降级，不静默（铁律 15）
    bool truth_frame_grained_ = false;
    bool manifest_is_background_ = false;
    std::string manifest_label_;
    bool background_has_target_ = false;    // scenario 模式给了 data_id：背景片段本身含目标 → degraded

    // 累积
    std::vector<Detection> det_;
    bool has_expected_ = false;
    std::uint64_t expected_frame_ = 0;
    bool have_det_meta_ = false;
    double fs_ = 0.0, f_lo_Hz_ = 0.0, f_hi_Hz_ = 0.0, threshold_ = 0.0;
    std::vector<RecognitionRow> rec_;
    std::map<std::string, std::vector<Run>> runs_;
    std::map<std::string, Run> open_;
    std::map<std::string, double> last_frame_start_;
    std::uint64_t frames_seen_ = 0;
    std::vector<std::string> unknown_emitters_;

    EvaluationMetrics metrics_;
    std::vector<TruthRow> truth_rows_;
    EvalParams eval_params_;
    ComponentStatus status_;

    void clear_state();
    void take_frame(const SceneParamFrame& f);
    void close_run(const std::string& em);
    void build_truth_rows();
    bool in_band(double center_Hz, double bw_Hz) const;
    ModelTrace trace() const;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_EVALUATOR_H
