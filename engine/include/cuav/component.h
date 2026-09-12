// 组件接口与端口数据。
//
// 依据：04 §8.4「模型组件规范」的生命周期 init / configure / process / flush /
// reset / status / destroy；03 §11.6 端口；CLAUDE.md 铁律 8、9、15；决策 D-013。
//
// 设计取舍写在这里，免得日后靠猜：
// - 组件不许自带随机源，随机性由 run 时注入的 IRandom& 提供（铁律 9）。
// - 组件不许假设块大小固定，块大小由调度器决定，组件按到手的块长处理。
// - 组件不许静默降级：处理不了就把块标 Degraded / Invalid 并写明理由，不拿默认值顶替（铁律 15）。

#ifndef CUAV_COMPONENT_H
#define CUAV_COMPONENT_H

#include <map>
#include <string>
#include <vector>

#include "cuav/random.h"
#include "cuav/param_spec.h"
#include "cuav/types.h"

namespace cuav {

class IRunObserver;   // observer.h

// 一次能量判决的结果。前五个字段是切片 ① 就有的；其余自 C-3（D-063）起补上，
// 让一行检测自描述（时间、频段、电平、突发编号），运行器落 detections.jsonl 时逐字段写出。
struct Detection {
    std::uint64_t start_sample = 0;   // 判决所用第一帧的首样点
    std::uint64_t frame_index = 0;
    double statistic = 0.0;           // 归一化检测量 Λ，H0 下均值为 1
    double threshold = 0.0;           // 所用门限 η
    bool hit = false;
    double t_s = 0.0;                 // 帧首样点的逻辑时间 = start_sample / fs
    std::int64_t segment_id = -1;     // 突发编号（按 merge_gap_frames 合并，从 0 起）；非命中帧为 −1
    double f_lo_Hz = 0.0;             // 检测频段的绝对下限 = center + band_lo
    double f_hi_Hz = 0.0;
    double band_power_dBm = 0.0;      // 频段内功率，has_dBm 为真时有效（Parseval：Σ|X_k|² / nfft²）
    double noise_dBm = 0.0;           // 噪声估计的频段功率，同上
    double snr_dB = 0.0;              // 10·log10 Λ，即 (S+N)/N
    bool has_dBm = false;             // 输入已标定且参数 band_power_dBm 为真
    bool overload = false;            // 组成该帧的任一块 clip_count > 0（削顶是数据标记，D-051）
    std::uint32_t noise_frames_used = 0;   // 判决时噪声估计用了几帧
};

struct DetectionList {
    std::vector<Detection> items;
    BlockMeta meta;
};

// 一帧功率谱（P1-4a）。口径：Welch 平均的功率谱（不是密度），每段加窗、|DFT|²、各段平均、
// 除以 (Σw)²，零频居中；复单音峰值等于其功率 A²，满量程单音读 0 dBFS。
// 值用 double：显示产品落盘时再转 float32，但帧本身要能与 MATLAB / numpy 对到 1e-9。
struct SpectrumFrame {
    std::vector<double> psd_dB;
    double bin_width_Hz = 0.0;
    std::uint64_t segments = 0;       // 本帧平均了几段
    std::string scale = "dBFS";       // 未标定一律 dBFS（D-020）；dBm 只在有绝对功率标定时出现
    std::string window;
    BlockMeta meta;                   // start_sample = 本帧第一段的首样点
};

// ---------------------------------------------------------------- 测向与定位报告（D-053）
//
// 三种报告都是 M2 效应级模型的输出：从链路参数帧取真值几何与电平，按误差预算给出量测。
// 它们是「测向 / 定位算法的统计模型」，不是被测算法本身——04 §5.2「真值只进评价器」约束的
// 是被测的 M3 算法（检测器、识别器），01 §6.2 允许模型的输入是真值。因此每一行都必须带
// truth_consumed = true，且 trace 里 model_layer = M2、credibility 不高于 V2（11 报告 §1.3）。
// 05 P1 的阵列估计器将来接同一个端口替换，届时 truth_consumed 才变成 false。

// 单站测向误差预算的六个分量（EM-S-05 §10.14）。bias 不在此列，它不进方差、直接加在方位上。
struct DfSigma {
    double method_deg = 0.0;      // 测向体制固有分辨力
    double snr_deg = 0.0;         // 信噪比相关项
    double cal_deg = 0.0;         // 标校残差
    double att_deg = 0.0;         // 平台姿态 / 方位基准
    double multipath_deg = 0.0;   // 多径（按帧的 LOS 二选一）
    double mixture_deg = 0.0;     // 同站同频多源混叠
};

struct BearingReport {
    double t_s = 0.0;
    std::string site_id, emitter_id, link_id;
    // 站址随报告走（D-053 §6.4 的同一原则：身份与位置都自带）。
    // 这样融合节点是**纯函数式**的——不必再绑一次场景、不必读场景文件，
    // 而「绑一个站」对全图唯一的融合节点本来就没有语义。
    double site_lon = 0.0, site_lat = 0.0, site_alt_m = 0.0;
    double bearing_deg = 0.0;         // 含噪量测方位，真北顺时针 [0, 360)
    double bearing_std_deg = 0.0;     // 合成 1σ
    double elevation_deg = 0.0;       // 真值俯仰（本档不加噪）
    double snr_dB = 0.0;
    double level_dBm = 0.0;
    std::string df_quality;           // DF-Q1..DF-Q4 / invalid
    State df_result_state = State::Valid;   // 这次测向裁决的状态，与本行数据的 state 正交
    std::string use_policy;           // normal / low_weight / exclude
    std::string method;               // amplitude_compare 等
    double bias_deg = 0.0;
    DfSigma sigma;
    bool line_of_sight = true;
    bool mixture = false;
    std::string signal_role;          // 预留给 C-4 的识别结果，本期恒空
    bool truth_consumed = true;
    State state = State::Valid;
    std::vector<std::string> reasons;
    ModelTrace trace;
};

struct ToaSigma {
    double pick_s = 0.0;      // 相关峰拾取 1/(2πB√SNR)
    double sync_s = 0.0;      // 站钟同步
    double rxdelay_s = 0.0;   // 接收通道群时延不确定度
    double floor_s = 0.0;     // 时戳量化底噪
};

struct ToaReport {
    double t_s = 0.0;
    std::string site_id, emitter_id, link_id;
    double site_lon = 0.0, site_lat = 0.0, site_alt_m = 0.0;
    double toa_s = 0.0;               // 含噪量测到达时刻
    double toa_std_s = 0.0;
    ToaSigma sigma;
    double snr_dB = 0.0;
    std::string time_quality;         // TQ-1..TQ-4
    std::string sync_state;           // locked / holdover / unsynced（场景声明值）
    bool truth_consumed = true;
    State state = State::Valid;
    std::vector<std::string> reasons;
    ModelTrace trace;
};

struct FixEllipse {
    double semi_major_m = 0.0;
    double semi_minor_m = 0.0;
    double rotation_deg = 0.0;        // 相对 ENU 东向
    // 2σ 椭圆在**二维**下的包含概率是 1 − exp(−2) = 86.47%，不是一维的 95.4%。
    // em-demo 的注释写「2σ (~95%)」是把一维置信搬到了二维，这里显式写出以免下游再算错。
    const char* scale = "2sigma";
    double confidence = 0.8646647167633873;
};

struct FixResidual {
    std::string site_id;
    double value = 0.0;
    std::string unit;                 // deg（AOA 方位残差）/ m（TDOA 距离差残差）
};

struct PositionReport {
    double t_s = 0.0;
    std::string emitter_id;
    std::string method;               // aoa / tdoa / aoa_tdoa
    double lon = 0.0, lat = 0.0;
    std::string crs = "EPSG:4326";
    std::string coord_version;
    double origin_lon = 0.0, origin_lat = 0.0, origin_alt_m = 0.0;   // ENU 原点（05 §6.2.3）
    double cov_m2[3] = {0.0, 0.0, 0.0};   // ENU 平面协方差上三角 [Pxx, Pxy, Pyy]
    FixEllipse ellipse;
    double cep_m = 0.0;
    double gdop = 0.0;
    // 最小两两交会角（度）。分级 geometry_quality 沿用 emcore 的最大张角口径（守 golden），
    // 这个量是**另加**的：两条近乎平行的测向线加一条好线，最大张角看不出问题，它能。
    double min_crossing_angle_deg = 0.0;
    std::string geometry_quality;     // good / fair / poor / degenerate
    std::string time_quality;         // 仅 tdoa / aoa_tdoa 有值，否则空
    std::vector<std::string> participating_sites;
    std::string reference_site;       // 仅 tdoa 有值
    std::vector<FixResidual> residuals;
    std::vector<std::string> outlier_sites;
    bool truth_consumed = true;
    State state = State::Valid;
    std::vector<std::string> reasons;
    ModelTrace trace;
};

// 端口上流动的数据。C++14 没有 variant，这里用带标志的聚合体，够用且不引依赖。
struct PortData {
    PortType type = PortType::IQStream;
    bool has_data = false;
    Block iq;
    DetectionList detections;
    std::vector<SpectrumFrame> spectra;   // 一个输入块可能切出多帧，一次 process 全部交出
    // 慢变参数帧也是向量：块长可能大于一帧的样点数（一块配多帧），也可能小于（多块共用一帧），
    // 单帧字段只能表达后者。生产端每轮交出**恰好覆盖本轮样点窗口的全部帧**（至少一帧），
    // 消费端按块的 start_sample 对齐取用并自己缓存上一帧做零阶保持（08 报告 §9.3）。
    std::vector<SceneParamFrame> scenes;
    // 报告类端口同样是「一轮可能产出多行」，与 scenes 同一模式（D-053）。
    std::vector<BearingReport> bearings;
    std::vector<ToaReport> toas;
    std::vector<PositionReport> positions;

    void clear() {
        has_data = false;
        iq.samples.clear();
        detections.items.clear();
        spectra.clear();
        scenes.clear();          // 原来漏了这一句：缓冲里会长期挂着上一轮的帧
        bearings.clear();
        toas.clear();
        positions.clear();
    }
};

using PortMap = std::map<std::string, PortData>;

struct PortSpec {
    std::string name;
    PortType type;
    // 可选输入口（D-051，C-1）：没有连线时组件照常运行，用自己的参数顶替。
    // 首批使用者是 AntennaGain 与 Evaluator 的 scene 口——定参链路（FreeSpaceChannel）没有场景，
    // 此时天线按固定来波角、评价器按数据清单真值工作。
    // Graph::validate 不把未连的可选口报成 input_unconnected，调度器也不等它的数据。
    // C++14 起聚合体允许默认成员初始化，因此 PortSpec{"in", PortType::IQStream} 仍然成立。
    bool optional = false;
};

// 组件目录里的类别（04 §8.1 六类：辐射源、信道、天线、接收机、数据、算法）。
namespace category {
const char* const Source = "source";
const char* const Channel = "channel";
const char* const Antenna = "antenna";
const char* const Receiver = "receiver";
const char* const Data = "data";
const char* const Algorithm = "algorithm";
}  // namespace category

// 组件的自描述（docs/component-catalog.md 第 3 节）。目录、框图装载器、参数表单都只读它，
// 不各自维护一份组件清单（决策 D-030：组件目录只由引擎生成）。
struct ComponentInfo {
    std::string type;                 // 与 type_name() 一致
    std::string category;             // category:: 六类之一
    std::string display_name;
    std::string description;
    std::string model_layer;          // M1 / M2 / M3
    std::string model_level;          // E1 – E4
    std::string model_id;             // 对应概念模型编号，可空
    std::string version;
    std::vector<PortSpec> inputs;
    std::vector<PortSpec> outputs;
    std::vector<ParamSpec> params;
    bool scene_bindable = false;      // 回放源永远为 false（06 备忘录防线二、三）
    bool stateful = false;
    std::string implementation = "cpp";   // cpp | coder（决策 D-036）
    std::string source_ref;           // coder 产物必填：来源 .m、MATLAB 与 Coder 版本、codegen 参数哈希
    bool has_dynamic_ports = false;   // 场景绑定组件按绑定生成端口，如 link:<emitter_id>
    std::string dynamic_port_pattern;
    PortType dynamic_port_type = PortType::IQStream;
    std::string dynamic_port_source;
};

// 一次 process 的结果。
enum class Step {
    Produced = 0,   // 产出了数据
    Idle,           // 本轮没产出，但还没结束（例如攒够一帧才输出）
    Finished,       // 数据源耗尽，本组件不再产出
    Error,
};

struct ComponentStatus {
    State state = State::Valid;
    std::uint64_t blocks_in = 0;
    std::uint64_t blocks_out = 0;
    std::uint64_t samples_in = 0;
    std::uint64_t samples_out = 0;
    std::vector<std::string> notes;
};

class IComponent {
public:
    virtual ~IComponent() {}

    virtual std::string type_name() const = 0;
    virtual std::vector<PortSpec> inputs() const = 0;
    virtual std::vector<PortSpec> outputs() const = 0;

    // 自描述。默认实现只带类型与端口，没有参数描述与类别；进目录的组件必须重写它，
    // 否则目录校验会把它挡下来（test_registry.cpp）。
    virtual ComponentInfo describe() const {
        ComponentInfo i;
        i.type = type_name();
        i.inputs = inputs();
        i.outputs = outputs();
        return i;
    }

    // 连线检查（D-053）。固定的可选输入口（in1..in8 / scene1..scene8 / b1..b8 / t1..t8）
    // 取代了动态端口，代价是「一个口都没连」在 Graph::validate 眼里也合法——每个口自己是 optional。
    // 于是把「到底要连几个」交给组件自己声明：validate 在悬空口检查之后对每个节点调一次，
    // wired_inputs 是该节点已被连上的输入口名。失败映射到装载器错误码 port_optional。
    virtual bool check_wiring(const std::vector<std::string>& wired_inputs, std::string& err) const {
        (void)wired_inputs; (void)err;
        return true;
    }

    // 参数配置。失败必须写 err 并返回 false，不得吞掉。
    virtual bool configure(const std::map<std::string, double>& params,
                           const std::map<std::string, std::string>& text_params,
                           std::string& err) = 0;

    // 运行前初始化。随机性由此注入（铁律 9）。
    virtual bool init(IRandom& rng, std::string& err) = 0;

    // 节点名（D-063，C-3）。Graph::run 在 attach 之前对每个节点调一次：组件本来不知道自己在框图里
    // 叫什么，而检测行要带 node_id——多站下每站一个检测器 det__<site>（D-053），不带节点名就分不清
    // 是哪一站检出的。不解析节点名后缀去猜站点：站点身份走 scene_binding 注入的 site_id。
    virtual void set_node_name(const std::string& name) { (void)name; }

    // 挂接运行观察者（observer.h）。Graph::run 在 init 之前对每个节点调一次；多数组件不需要，默认忽略。
    virtual void attach(IRunObserver* obs) { (void)obs; }

    virtual Step process(PortMap& in, PortMap& out, std::string& err) = 0;

    // 收尾：把攒着的不满一帧的数据吐出来或丢弃并标记。
    virtual Step flush(PortMap& out, std::string& err) {
        (void)out; (void)err;
        return Step::Finished;
    }

    virtual void reset() = 0;
    virtual ComponentStatus status() const = 0;
};

}  // namespace cuav

#endif  // CUAV_COMPONENT_H
