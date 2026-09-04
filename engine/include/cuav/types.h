// 分块流引擎的核心类型：样点块、块元数据、端口类型、结果四态。
//
// 依据：04 §5.2（主产品定义）、§8.3（运行引擎）、§9.2（最小元数据）；
//       CLAUDE.md 铁律 4（IQ 语义）、铁律 8（溯源）、铁律 15（四态，不静默降级）；
//       决策 D-013（新增 SceneParamFrame 端口；IQ 流与参数流不得直连）。
//
// C++14。不使用 optional / variant / string_view，与 emcore 保持同一标准。

#ifndef CUAV_TYPES_H
#define CUAV_TYPES_H

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

namespace cuav {

// 引擎版本。进 /health 端点与每个产物的溯源字段，不是装饰。
const char* engine_version();

// 内部计算一律复 float32（docs/iq-format.md 第 3.2 节）。
// 交换与保存才是复 int16 交织，那是文件层的事，引擎内部不出现。
using Complex = std::complex<float>;

// 结果四态（铁律 15）。禁止用默认值顶替缺失值。
enum class State {
    Valid = 0,
    Degraded,
    Invalid,
    NotApplicable,
};

const char* to_string(State s);

// 取最差的一档；NotApplicable 不参与，与 tools/iq_format/manifest.py 的 worst() 同语义。
State worst(State a, State b);

// 端口类型。IQ 流与慢变参数流是两类东西，不得直连（D-013）。
enum class PortType {
    IQStream = 0,       // S0–S5 各观测点的复基带样点流
    SceneParamFrame,    // 慢变场景参数：链路几何、LOS/NLOS、损耗分量、噪声底、天线复增益
    ChannelPathSet,     // 多径路径集合，首期即启用，单径双径也走它
    SpectrumFrame,      // 功率谱与瀑布
    DetectionList,      // 检测结果
    FeatureVector,      // 特征
};

const char* to_string(PortType t);

// 两个端口类型能否直接相连。
// 规则来自 D-013：IQStream 与 SceneParamFrame / ChannelPathSet 不得直接相连，
// 必须经过“施加”类 M3 组件；同类型之间才可连。
bool can_connect(PortType from, PortType to);

// 溯源六件套加两项扩展，共八项（铁律 8、决策 D-012）。
// 每个数据产物都挂同构元数据，块级别也不例外。
struct ModelTrace {
    std::string model_id;
    std::string model_version;
    std::string model_level;      // E1–E4
    std::string model_layer;      // M1 / M2 / M3
    std::string credibility;      // V1–V5
    std::string parameter_version;
    double confidence = -1.0;     // 负值表示未给出，不用 0 顶替
    std::string trace_id;

    bool complete() const;
};

// 时间基准四选一，不得混用（铁律 3）。
enum class TimeBasis {
    LogicalSim = 0,
    FileAcquisition,
    DeviceHardware,
    External,
};

const char* to_string(TimeBasis b);

// 块元数据。样点自身不带单位，全部解释都在这里。
struct BlockMeta {
    double sample_rate_Hz = 0.0;
    double center_frequency_Hz = 0.0;
    // 本块首样点在整条流中的序号。分块是存储与调度行为，
    // 不改变时间连续性，也不得与采集的时间不连续混为一谈。
    std::uint64_t start_sample = 0;
    TimeBasis time_basis = TimeBasis::LogicalSim;
    bool continuous_with_previous = true;

    // 功率标度。未标定时 scale 取负值并把 state 标 Degraded，不拿 1.0 顶替。
    double scale = -1.0;
    double full_scale = 32768.0;

    State state = State::Valid;
    std::vector<std::string> state_reasons;
    ModelTrace trace;

    void degrade(const std::string& why);
    void invalidate(const std::string& why);
};

// 一块样点。引擎内部按块流动，块大小由调度器定，组件不得假设它固定。
struct Block {
    std::vector<Complex> samples;
    BlockMeta meta;

    Block() {}
    explicit Block(std::size_t n) : samples(n) {}
    std::size_t size() const { return samples.size(); }
    bool empty() const { return samples.empty(); }
};

// 慢变场景参数帧（D-013）。按 10–100 Hz 更新，由 M1/M2 侧算好后注入，
// M3 组件只负责“施加”，不得自行硬编码传播或噪声参数。
struct SceneParamFrame {
    double valid_from_s = 0.0;
    double valid_to_s = 0.0;
    double update_rate_Hz = 0.0;

    double path_loss_dB = 0.0;
    double noise_floor_dBm_per_Hz = 0.0;
    bool line_of_sight = true;
    double doppler_Hz = 0.0;
    double delay_s = 0.0;

    State state = State::Valid;
    ModelTrace trace;
};

}  // namespace cuav

#endif  // CUAV_TYPES_H
