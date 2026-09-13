// 模板匹配识别（C-4，10 报告 §4.4；EM-S-04 §10.2 / §10.5 / §10.6 / §10.9 的 E2「工程模板加权匹配」）。
//
// M2 裁决件：只吃观测量（FeatureVector），不碰 IQ（02 §8.5）；不做学习型（04 §7.9 取传统基线）。
// 库文件 models/recognition/library-<version>.json 的路径是内部参数 library_path，由装载器按用户参数
// library_version 注入（D-037 同法：框图里永远只写版本号，路径只在引擎进程里出现）；库的取值标 assumed，
// 只对本项目的合成波形有效（模型卡 models/recognition/README.md）。
//
// 算法（每条特征行；与 algos/reference/classify.py 逐步同序，黄金基准 engine/tests/golden/recognition.json）：
//   对每个模板 k：逐特征取区间外距离 d_ik（对数域特征 (ln 边界 − ln x)/log_scale，线性特征 (边界 − x)/半区间宽），
//   缺失的特征不计（m_i = 0）；D_k = Σ w_ik·m_i·d_ik / Σ w_ik·m_i；L_k = exp(−D_k/2)，未知假设 L_u = exp(−unknown_distance/2)；
//   先验均匀，p_k = L_k / (Σ_j L_j + L_u)。判决：max p ≥ accept_threshold 且与次大之差 ≥ ambiguity_margin → known；
//   差不足 → ambiguous（仍给 Top-1）；max p 低于门限 → unknown（最近模板距离 > unknown_distance 为 unknown_novel，
//   否则 unknown_ambiguous）；特征行 quality 低于 min_quality 的直接 unknown_low_quality，不算后验。
// 标签只到 signal_role 层（video_link / telemetry_burst / rc_hopping / cw_beacon），型号级随 T 线。

#ifndef CUAV_COMPONENTS_RECOGNITION_H
#define CUAV_COMPONENTS_RECOGNITION_H

#include <string>
#include <vector>

#include "cuav/component.h"

namespace cuav {

class TemplateClassifier : public IComponent {
public:
    std::string type_name() const override { return "TemplateClassifier"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::FeatureVector}}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::RecognitionList}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    void set_node_name(const std::string& name) override { node_name_ = name; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 对一行特征做一次识别（纯函数，供单测与黄金基准直接调用）
    RecognitionRow classify(const FeatureRow& f) const;
    std::vector<std::string> labels() const;
    std::uint64_t rows() const { return rows_; }

    // 库文件的装载与结构校验（未知键拒、区间与权重自洽）。公开是为了让装载器与测试能单独校验一份库。
    struct FeatureDef {
        std::string name;
        bool log = false;
        bool abs = false;
        double floor = 0.0;
    };
    struct Template {
        std::string label;
        std::string description;
        std::vector<bool> used;        // 按 feature_order 的下标：该模板是否声明了这个特征
        std::vector<double> lo, hi;
        std::vector<bool> has_hi;
        std::vector<double> weight;
    };
    struct Library {
        std::string version;
        std::string source;
        double log_scale = 0.3;
        std::vector<FeatureDef> features;   // 按 feature_order
        std::vector<Template> templates;
    };
    static bool load_library(const std::string& path, Library& lib, std::string& err);

private:
    double accept_threshold_ = 0.5;
    double ambiguity_margin_ = 0.2;
    double unknown_distance_ = 4.0;
    std::string min_quality_ = "short";
    std::string library_version_ = "v1";
    std::string library_path_;
    std::string site_id_;
    std::string node_name_;
    IRunObserver* obs_ = nullptr;
    Library lib_;
    std::uint64_t rows_ = 0;
    ComponentStatus status_;

    // 特征行里某个特征的取值与可用性（缺失的特征不计入距离，EM-S-04 §10.5）
    bool feature_value(const FeatureRow& f, const FeatureDef& def, double& x) const;
    double interval_distance(const FeatureDef& def, double x, double lo, double hi, bool has_hi) const;
    void report(const RecognitionRow& r);
    ModelTrace trace() const;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_RECOGNITION_H
