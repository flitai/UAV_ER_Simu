// 传播效应的组合与逐项计算（12 号报告；决策 D-058）。
//
// 依据：概念模型 EM-P-01（自由空间）、EM-P-02（地面双径）、EM-P-05（城市经验）、
// EM-P-07（大气与降雨）、EM-P-08（统计阴影）、EM-P-13（传播模型选择与降级）；
// 01 §3（精度等级 E1–E4）；04 §7.3（传播模型简化策略）；05 §6.2.3（四态降级）；
// CLAUDE.md 铁律 2（显式平地假设）、5（dB 域与线性域不混算）、9（随机性显式注入）、
// 15（不静默降级）；D-009（新写代码 c = 299792458，移植件守原常数）。
//
// **本文件零第三方依赖，只用标准库**（geo/ 全库的第三方件只有 geodesy.cpp 里的
// GeographicLib 坐标基座一件，D-074 / D3-1）。随机源走 INormalSource 抽象，
// 不在这里复制第二份发生器——引擎已有 xoshiro256++，两份实现迟早分叉。
//
// 组合规则只有一条（12 §2.2，EM-P-13 §10.9 的最小落地）：
//   **至多一个「替代型主模型」；选中它就由它给出基础损耗，不再单独叠加自由空间。其余是加项。**
// 表达上一律经 extra_loss_dB 汇入：替代型主模型写成 extra = L_primary − L_fs(d)，
// 于是 path_loss_dB = free_space_dB + extra_loss_dB 这个恒等式在任何档位下都成立，
// link_budget.h 头注承诺的「只改 extra_loss_dB 与 line_of_sight 两处，帧结构不变」逐字兑现。

#ifndef CUAV_GEO_PROPAGATION_H
#define CUAV_GEO_PROPAGATION_H

#include <string>
#include <vector>

namespace cuav {
namespace geo {

// ---------------------------------------------------------------- 枚举

// 01 的精度等级。选中的档直接写进溯源六件套的 model_level。
// E3 需要逐建筑几何（自 D3-5 起可用，D-074）：`LinkFrameSource::build()` 必须拿到
// 一份 IMapQuery，拿不到即拒——不静默退回 E1（铁律 15）。
enum class PropLevel { E1 = 0, E2, E3 };

// 替代型主模型，至多一个（闸一：界面上做成单选）。
enum class PrimaryModel { FreeSpace = 0, TwoRay, UrbanEmpirical };

// 环境类别。放在信道参数里是已知取舍（12 §1.4）：物理上环境是地理属性，
// 要收紧就把它挪进场景的 sites[] 或 aoi，框图只留「算不算它」。
enum class EnvClass { Open = 0, Suburban, Urban, DenseUrban };

// 反射面材质。取值与 εr/σ/roughness 默认表来自本项目自有的
// 《天津机场_地表材质与建筑数据工作流》§3.5。
enum class GroundType { Paved = 0, Grass, Water, Dirt, Unknown };

// 城市经验模型给出的是均值还是「均值 + 分位裕度」。后者自带阴影，
// 与统计阴影同时开即同源双计（闸二，EM-P-13 §10.9）。
enum class UrbanLossMode { Mean = 0, MeanWithShadowMargin };

// EM-P-02 §10.8 的衰落状态。
enum class FadeState { NotApplicable = 0, Constructive, Neutral, Destructive, DeepFade, Averaged };

const char* to_string(PropLevel v);
const char* to_string(PrimaryModel v);
const char* to_string(EnvClass v);
const char* to_string(GroundType v);
const char* to_string(UrbanLossMode v);
const char* to_string(FadeState v);

// 文本 → 枚举。认不出返回 false，由调用方报错，不拿缺省顶替（铁律 15）。
bool parse_prop_level(const std::string& s, PropLevel& out);
bool parse_primary_model(const std::string& s, PrimaryModel& out);
bool parse_env_class(const std::string& s, EnvClass& out);
bool parse_ground_type(const std::string& s, GroundType& out);
bool parse_urban_loss_mode(const std::string& s, UrbanLossMode& out);

// ---------------------------------------------------------------- 参数表

// 地表电磁参数（《天津机场_地表材质与建筑数据工作流》§3.5 默认表）。
struct GroundParams {
    double eps_r;            // 相对介电常数
    double sigma_S_per_m;    // 电导率
    double roughness_m;      // 表面 RMS 粗糙度
    GroundParams() : eps_r(8.0), sigma_S_per_m(0.010), roughness_m(0.005) {}
};
GroundParams ground_params(GroundType t);

// 城市经验 log-distance 的环境模板（EM-P-05 §10.6）。
// open 行取 n = 2 / X = 0，于是它**恒等于自由空间**——这是替代关系的钉子（12 §3.3 B1）。
// 全部标 assumed（原型阶段验证值，D-028）；D-019 的 n ≈ 2 是空地准视距样本，
// 不能拿来给 urban / dense_urban 两行背书。
struct EnvTemplate {
    double path_loss_exponent;   // n
    double env_bias_dB;          // X_env
    double shadow_sigma_los_dB;  // σ_sh，视距
    double shadow_sigma_nlos_dB; // σ_sh，非视距（本期取不到：line_of_sight 恒真）
    EnvTemplate() : path_loss_exponent(2.0), env_bias_dB(0.0),
                    shadow_sigma_los_dB(3.0), shadow_sigma_nlos_dB(5.0) {}
};
EnvTemplate env_template(EnvClass c);

// ---------------------------------------------------------------- 配置

// 传播配置。缺省即 E1 + 自由空间 + 不开阴影不开天气 = **今天的行为**，
// 代码路径与本方案之前逐字相同（12 §0 第 10 条）。
struct PropagationConfig {
    PropLevel level;
    PrimaryModel primary;
    bool shadow;
    bool weather;
    EnvClass env;

    // 地面双径（EM-P-02）
    GroundType ground;
    double roughness_m;          // < 0 表示按 ground 取表值
    double coherence_rho;        // ρ_c ∈ [0, 1]
    double max_fade_depth_dB;    // 相消限幅（§10.8 第 3 条）

    // 城市经验（EM-P-05）
    double path_loss_exponent;   // < 0 表示按 env 取表值
    double ref_distance_m;       // d_0
    UrbanLossMode urban_mode;

    // 统计阴影（EM-P-08）
    double shadow_sigma_dB;      // < 0 表示按 env × 视距取表值
    double shadow_corr_distance_m;

    // 大气与降雨（EM-P-07）
    double rain_rate_mmh;

    PropagationConfig()
        : level(PropLevel::E1), primary(PrimaryModel::FreeSpace), shadow(false), weather(false),
          env(EnvClass::Urban), ground(GroundType::Unknown), roughness_m(-1.0),
          coherence_rho(1.0), max_fade_depth_dB(20.0),
          path_loss_exponent(-1.0), ref_distance_m(100.0), urban_mode(UrbanLossMode::Mean),
          shadow_sigma_dB(-1.0), shadow_corr_distance_m(50.0), rain_rate_mmh(0.0) {}

    // E1 档下除主模型外一切效应都不参与——判据集中在这里，免得每处各写一遍。
    bool effects_enabled() const { return level != PropLevel::E1; }

    // 跨参数约束（12 §2.2 闸二 + §4.4 的 E3）。不通过时写 err 返回 false。
    // 调用点是 ScenarioSource::configure()：界面置灰拦不住手写的框图（铁律 15）。
    bool validate(std::string& err) const;
};

// ---------------------------------------------------------------- 结果

// 已含的损耗类别（EM-P-13 §10.9 的 included_loss_terms）。取值域固定五项，
// 下游据此判断能不能再叠加。free_space 恒在：替代型主模型的表达式里也含它。
extern const char* const kTermFreeSpace;        // "free_space"
extern const char* const kTermGroundReflection; // "ground_reflection"
extern const char* const kTermUrbanMean;        // "urban_mean"
extern const char* const kTermDiffraction;      // "diffraction"（E3 建筑刀口衍射，D3-5）
extern const char* const kTermShadow;           // "shadow"
extern const char* const kTermWeather;          // "weather"

// 逐项分解。总额 = free_space_dB + extra_dB，其中
// extra_dB = primary_excess_dB + diffraction_dB + shadow_dB + weather_dB。
struct PropagationTerms {
    double free_space_dB;        // L_fs(d_d)，基线
    double primary_excess_dB;    // 替代型主模型相对自由空间的差；free_space 时为 0
    double diffraction_dB;       // EM-P-04 建筑单刀口衍射，**单程 ×1**；只有 E3 档非零
    double shadow_dB;            // X_σ，正值 = 额外衰减
    double weather_dB;           // 大气 + 降雨
    double atmospheric_dB;
    double rain_dB;
    double extra_dB;             // = primary_excess + diffraction + shadow + weather

    // 双径的解释字段（EM-P-02 §10.7、§10.8）
    double two_ray_correction_dB;   // C_2ray，> 0 为增强
    double reflection_mag;          // |Γ_eff|
    double reflection_phase_rad;    // arg(Γ_eff)
    double path_diff_m;             // Δd
    double breakpoint_m;            // d_bp = 4 h_t h_r / λ
    bool fade_clipped;              // 触发 max_fade_depth_dB
    FadeState fade;

    std::vector<std::string> included;   // included_loss_terms，按固定顺序
    bool degraded;
    std::string reason;

    PropagationTerms()
        : free_space_dB(0.0), primary_excess_dB(0.0), diffraction_dB(0.0),
          shadow_dB(0.0), weather_dB(0.0),
          atmospheric_dB(0.0), rain_dB(0.0), extra_dB(0.0),
          two_ray_correction_dB(0.0), reflection_mag(0.0), reflection_phase_rad(0.0),
          path_diff_m(0.0), breakpoint_m(0.0), fade_clipped(false),
          fade(FadeState::NotApplicable), degraded(false) {}
};

// ---------------------------------------------------------------- 逐项模型

// EM-P-02 地面双径。h_t / h_r 是**离地高度**（alt_m − terrainHeight_m，铁律 2 的显式平地假设）。
// polarization 取场景 emission.polarization：vertical → Γ_V、horizontal → Γ_H，
// 其余按 §10.4「极化未知时不得默认高可信相干深衰落」取幅度较小者并置 degraded。
// h_t ≤ 0 或 h_r ≤ 0 时没有地面反射路径，置 degraded 且 C_2ray = 0（退回自由空间）。
void two_ray(double distance_m, double frequency_Hz, double h_t_m, double h_r_m,
             const std::string& polarization, const PropagationConfig& cfg,
             PropagationTerms& out);

// EM-P-05 城市经验的 E1 档 log-distance：
//   L_emp = L_fs(d0, f) + 10·n·log10(d/d0) + X_env [+ 1.2816·σ_sh]
// 返回相对 L_fs(d) 的差（即 primary_excess）。d ≤ d0 时近区退回自由空间并置 degraded。
double urban_excess_dB(double distance_m, double frequency_Hz, bool line_of_sight,
                       const PropagationConfig& cfg, bool& degraded, std::string& reason);

// EM-P-07 大气吸收（简化 ITU-R P.676）。**自 emcore 逐字移植，保留原常数与原分段**（D-009）；
// 黄金基准 tests/golden/propagation.json 的 atmosphericLoss_dB 40 例。
// 本式不含光速常数，因此与 geo/ 的 c = 299792458 不冲突。
double atmospheric_loss_dB(double distance_km, double frequency_GHz);

// EM-P-07 降雨衰减（简化 ITU-R P.838）。同上，emcore 移植，rainAttenuation_dB 24 例。
double rain_attenuation_dB(double distance_km, double frequency_GHz, double rain_rate_mmh);

// EM-P-08 的 σ_sh 选择：给了正值就用它，否则按 env × 视距查表。
double shadow_sigma_dB(const PropagationConfig& cfg, bool line_of_sight);

// ---------------------------------------------------------------- 随机源

// 标准正态的最小抽象。geo/ 不实现它——引擎侧用 Xoshiro256pp 适配（铁律 9：随机性显式注入，
// 库内无全局随机源）。在这里复制第二份发生器迟早会与引擎那份分叉。
struct INormalSource {
    virtual ~INormalSource() {}
    virtual double normal() = 0;
};

// 沿航迹一阶相关的阴影序列（EM-P-08 §10.6、§10.9）：
//   X_0 = σ·Z_0,  X_k = ρ_k·X_{k−1} + sqrt(1 − ρ_k²)·σ·Z_k,  ρ_k = exp(−Δs_k / d_corr)
//
// **必须一次算完存成向量**：LinkFrameSource::frame(k) 的类注释把「无副作用、可任意乱序、
// 任意次数调用、结果逐位相同」定为硬不变量，而 ScenarioSource::process() 对同一个 k
// 确实会调用两次（一次出帧、一次上报）。递推写在取值函数里会当场违反它（12 §3.4）。
class ShadowSequence {
public:
    ShadowSequence();

    // steps[i] = 第 i 帧与第 i−1 帧之间的空间位移（米），steps[0] 未使用。
    // sigma_dB ≤ 0 或 count == 0 时序列为空，at() 恒返回 0。
    void build(const std::vector<double>& steps, double sigma_dB, double corr_distance_m,
               INormalSource& rng);

    bool empty() const { return values_.empty(); }
    std::size_t size() const { return values_.size(); }
    // 越界返回最后一个值：帧数由时长算出，边界上多要一帧不该让整条链失效。
    double at(std::size_t k) const;

private:
    std::vector<double> values_;
};

// ---------------------------------------------------------------- 组合

// 按配置把各项组合起来。distance_m / frequency_Hz / h_* / line_of_sight 由调用方给；
// shadow_dB 由调用方从 ShadowSequence 取好传进来（本函数不持有随机状态，保持纯函数）。
//
// 返回的 terms 里 extra_dB 就是要写进 LinkBudget::extra_loss_dB 的值。
//
// diffraction_sample_dB 与 shadow_sample_dB 同一形状：**由调用方算好传进来**，本函数不碰地图、
// 保持纯函数（遮挡要 IMapQuery 与平面帧，那是 link_geometry() 的事，D3-5）。
// 它只在 E3 档被计入——与 cfg.shadow 门住阴影样本同理，免得别处漏传一个非零值就悄悄改了结果。
PropagationTerms combine(double distance_m, double frequency_Hz,
                         double h_t_m, double h_r_m, bool line_of_sight,
                         const std::string& polarization,
                         const PropagationConfig& cfg, double shadow_sample_dB,
                         double diffraction_sample_dB = 0.0);

namespace legacy {

// ---- 刀口衍射（EM-P-04）：自 emcore `src/models/propagation.cpp` 移植，D3-3 ----
//
// 为什么在 legacy 里：这两式的波长用 emcore 的 `kSpeedOfLight = 3e8`，而本项目新写代码
// 统一 c = 299792458（D-009）。两者相对差 **6.9e-4**（3e8 比 299792458 大 0.069%），
// 落到刀口损耗上约 **3e-3 dB**（07 报告 §6.4 原写「1e-5 dB」，差三个数量级，§14.4 已修正）——
// **物理上无关紧要，1e-9 的黄金基准上却是硬伤**。
//
// 与别处 legacy 符号不同的是：**引擎实际运行也调这两个**。理由是刀口衍射这一整套
// （fresnel_v + knife_edge_loss_dB + 适配器几何）是被 148 例黄金基准整体钉住的一个模块，
// 只换其中一个常数会让它内部自相矛盾——几何走严格站心坐标、波长却走旧光速。
// R-2 当时预判「D-009 的常数冲突要到 D3 移植 fresnelV 时才出现」，出现了，
// 按 D-009 的原则处理：移植模块保留原常数，禁止顺手统一（07 报告 §6.4）。

// Fresnel-Kirchhoff 衍射参数 v。obstacle_height_m 是视线侵入刀口的深度。
double fresnel_v(double obstacle_height_m, double d1_m, double d2_m, double frequency_Hz);

// ITU-R P.526 单刀口衍射损耗（dB，单程）。v ≤ −0.78 时为 0；
// 掠射（v = 0）解析值 6.9 + 20·log10(√1.01 − 0.1) = 6.03 dB。
double knife_edge_loss_dB(double v);

}  // namespace legacy

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_PROPAGATION_H
