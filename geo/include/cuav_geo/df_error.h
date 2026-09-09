// 单站测向的误差预算与质量分档（EM-S-05 §10.7、§10.8、§10.14；决策 D-053，11 报告 §3.2）。
//
// **这是「测向算法的统计模型」，不是测向算法本身。** 它不看 IQ，只按信噪比与配置算出方位量测的
// 1σ，由调用方抽一个高斯样本得到含噪方位。M2 效应级模型取真值是合法的（01 §6.2）；
// 04 §5.2「真值只进评价器」约束的是被测的 M3 算法（检测器、识别器），不含本模型。
// 05 P1 的阵列估计器将来从 ArrayIQStream 出发算方位，输出同一个端口替换它。
//
// 纯函数、无状态、无第三方依赖，因此 geo/ 仍可独立构建。

#ifndef CUAV_GEO_DF_ERROR_H
#define CUAV_GEO_DF_ERROR_H

#include <string>
#include <vector>

namespace cuav {
namespace geo {

// 七个分量。前六个进方差，bias 不进——它是系统偏差，直接加在方位上。
struct DfErrorBudget {
    double sigma_method_deg;      // 测向体制固有分辨力（比幅法的通道一致性、干涉仪的基线量化）
    double sigma_snr_ref_deg;     // 参考信噪比处的信噪比项
    double snr_ref_dB;            // 上一项的参考点
    double sigma_cal_deg;         // 标校残差
    double sigma_att_deg;         // 平台姿态 / 方位基准
    double sigma_mp_los_deg;      // 多径（视距）
    double sigma_mp_nlos_deg;     // 多径（非视距）
    double sigma_mix_deg;         // 同站同频多源混叠，只加在被压住的那个源上
    double bias_deg;              // 系统偏差，不进方差

    DfErrorBudget()
        : sigma_method_deg(1.5), sigma_snr_ref_deg(2.0), snr_ref_dB(10.0),
          sigma_cal_deg(0.5), sigma_att_deg(0.3),
          sigma_mp_los_deg(0.5), sigma_mp_nlos_deg(5.0),
          sigma_mix_deg(8.0), bias_deg(0.0) {}
};

// 逐项展开的结果，供报告逐分量落盘（模型卡与评价页要能说清「σ 是怎么来的」）。
struct DfSigmaParts {
    double method_deg;
    double snr_deg;
    double cal_deg;
    double att_deg;
    double multipath_deg;
    double mixture_deg;
    double total_deg;

    DfSigmaParts()
        : method_deg(0.0), snr_deg(0.0), cal_deg(0.0), att_deg(0.0),
          multipath_deg(0.0), mixture_deg(0.0), total_deg(0.0) {}
};

// 信噪比项：σ_snr = σ_ref · √(SNR_ref_lin / max(SNR_lin, 1))。
// 与 emcore 的 σ_base/√SNR 同形，只是把参考点显式化——写成 σ_base 时「base 对应多少 dB」
// 藏在常数里，换个体制就没法解释。SNR < 0 dB 时钳到 1（线性），不让 σ 无限放大。
double df_sigma_snr_deg(double sigma_ref_deg, double snr_ref_dB, double snr_dB);

// 合成 1σ：六项平方和开方。line_of_sight 决定多径项取哪一个；mixture 为真才计入混叠项。
DfSigmaParts df_sigma_total(const DfErrorBudget& b, double snr_dB, bool line_of_sight, bool mixture);

// 质量分档 DF-Q1..DF-Q4，超出最后一档为 "invalid"。
// 只看 σ 不看信噪比——信噪比已经进了 σ，再判一遍等于把同一个量算两次
// （emcore 的 dfQuality(snr, σ) 是双判据，这里有意简化）。
// thresholds 必须非降且非空，否则返回 "invalid"。
std::string df_quality_grade(double sigma_deg, const std::vector<double>& thresholds);

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_DF_ERROR_H
