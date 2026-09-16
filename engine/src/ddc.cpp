#include "cuav/components/ddc.h"

#include <cmath>
#include <cstdio>

namespace cuav {
namespace {

const char* kFirVersion = "lp_v1";

std::string supported_decims() {
    std::string s;
    for (std::size_t i = 0; i < dsp::ddc_fir_lp_v1_count(); ++i) {
        if (i) s += " / ";
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%d", dsp::ddc_fir_lp_v1_at(i).decim);
        s += buf;
    }
    return s;
}

std::string num(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.10g", v);
    return buf;
}

}  // namespace

ComponentInfo DDC::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Receiver;
    i.display_name = "数字下变频";
    i.description =
        "数字下变频（04 §7.7）：数控振荡产生复本振、复混频把目标频段搬到零频附近、"
        "抗混叠低通保留目标带宽、按整数比抽取，并更新中心频率、采样率与时间元数据。"
        "**本组件改变采样率**，输出 fs = 输入 fs / decim、中心频率 = 输入中心 + f_shift_Hz。"
        "时间锚按 08 报告 §8 口径一与口径二：滤波器群时延在这一层扣除，"
        "输出样点 m 对应输入样点 m·decim，首样点序号自 0 起且严格连续。"
        "抗混叠低通是等波纹设计的冻结系数表（通带 0.4·fs_out、阻带 0.5·fs_out ≥ 60 dB、"
        "奇数抽头使群时延为整数样点），decim 的取值必须在表内。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-B-11";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;
    i.stateful = true;   // 滤波器延迟线、本振相位与抽取相位跨块保持
    i.params = {
        ParamSpec::number("f_shift_Hz", "Hz",
                          "复混频频移；输出中心频率 = 输入中心频率 + 本值。"
                          "缺省由频率计划填 f_tx − f_rx，即把目标搬到 S4 零频附近")
            .def(0.0),
        ParamSpec::number("decim", "", "整数抽取比；输出采样率 = 输入采样率 / 本值")
            .def(1.0).at_least(1.0)
            .constrained("取值须在冻结抽头表内（" + supported_decims() + "），"
                         "且输入采样率须能被它整除（08 报告 §8 口径一）"),
        ParamSpec::choice("fir_version", {"lp_v1"},
                          "抗混叠低通的抽头版本：通带 0.4·fs_out、阻带 0.5·fs_out ≥ 60 dB、奇数抽头")
            .def_text(kFirVersion),
    };
    return i;
}

bool DDC::configure(const std::map<std::string, double>& params,
                    const std::map<std::string, std::string>& text_params, std::string& err) {
    std::map<std::string, double>::const_iterator it = params.find("f_shift_Hz");
    f_shift_Hz_ = (it != params.end()) ? it->second : 0.0;
    if (!(f_shift_Hz_ > -1e18 && f_shift_Hz_ < 1e18)) {
        err = "f_shift_Hz 不是有限值";
        return false;
    }

    double d = 1.0;
    it = params.find("decim");
    if (it != params.end()) d = it->second;
    if (d != std::floor(d) || d < 1.0 || d > 1e6) {
        err = "decim 必须是不小于 1 的整数，收到 " + num(d);
        return false;
    }
    decim_ = static_cast<int>(d);

    std::map<std::string, std::string>::const_iterator t = text_params.find("fir_version");
    fir_version_ = (t != text_params.end()) ? t->second : kFirVersion;
    if (fir_version_ != kFirVersion) {
        err = "未知的 fir_version：" + fir_version_ + "，本版本只有 " + kFirVersion;
        return false;
    }

    // 建状态即查表：decim 不在表里、或表内部不自洽（抽头数不是奇数 / 群时延不是 (N-1)/2）
    // 都在这里拒绝，不静默换一档顶替（铁律 15；08 §8 口径二不做半样点插值）。
    if (!dsp::ddc_init(st_, decim_, err)) {
        err = "DDC 的 decim = " + num(d) + "：" + err;
        return false;
    }
    return true;
}

bool DDC::init(IRandom&, std::string& err) {
    // DDC 没有随机性。reset() 会整体重建状态，保证同种子两次运行的起点完全相同（铁律 9）。
    reset();
    return dsp::ddc_init(st_, decim_, err);
}

Step DDC::process(PortMap& in, PortMap& out, std::string& err) {
    PortMap::iterator it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& src = it->second.iq;

    if (!have_fs_) {
        fs_in_ = src.meta.sample_rate_Hz;
        if (!(fs_in_ > 0.0)) {
            err = "DDC 收到的块没有采样率";
            return Step::Error;
        }
        // 08 §8 口径一：除不尽时报错，不四舍五入一个「差不多」的输出采样率。
        // 判据与前端 web/src/chain/plan.ts 的 decim 检查同式（那边是 fs_rf % decim），
        // 两侧口径写在一处，避免前端放行、引擎拒绝。
        if (std::fabs(std::fmod(fs_in_, static_cast<double>(decim_))) > 1e-9) {
            err = "输入采样率 " + num(fs_in_) + " Hz 不能被抽取比 " + num(decim_) + " 整除";
            return Step::Error;
        }
        fs_out_ = fs_in_ / static_cast<double>(decim_);
        // 铁律 4 在引擎侧可判定的那一半：抽取时保留的窄带窗口必须整块落在输入奈奎斯特窗内，
        // 否则输出带是从输入带边缘折回来的镜像。另一半（|Δf| + B/2 + 保护带 < Fs/2、过渡带）
        // 要发射带宽与跳频序列这些场景量，组件拿不到，留在前端 web/src/chain/plan.ts。
        //
        // decim = 1 不在此列：不抽取就没有混叠可言，此时 DDC 退化成纯频移，谱整体**循环**
        // 旋转、越过奈奎斯特的内容绕回另一端——这正是数字混频器的固有行为，不是错误。
        // 拿同一条判据去卡它会让「只改中心频率」这件事永远做不成（任何非零频移都过不去）。
        if (decim_ > 1 && std::fabs(f_shift_Hz_) + 0.5 * fs_out_ > 0.5 * fs_in_ * (1.0 + 1e-12)) {
            err = "|f_shift| + fs_out/2 = " + num(std::fabs(f_shift_Hz_) + 0.5 * fs_out_) +
                  " Hz 超过输入奈奎斯特 " + num(0.5 * fs_in_) + " Hz（铁律 4）";
            return Step::Error;
        }
        st_.dphi = dsp::ddc_phase_step(f_shift_Hz_, fs_in_);
        have_fs_ = true;
    } else if (src.meta.sample_rate_Hz != fs_in_) {
        err = "DDC 中途收到不同采样率的块";
        return Step::Error;
    }

    if (have_expect_ && src.meta.start_sample != expect_in_) {
        err = "DDC 的输入块不连续：期望首样点序号 " + std::to_string(expect_in_) + "，实际 " +
              std::to_string(src.meta.start_sample) + "；输出样点号由本组件自己数，"
              "丢块会静默错位（铁律 15）";
        return Step::Error;
    }
    if (have_expect_ && !src.meta.continuous_with_previous) {
        err = "DDC 收到标记为采集不连续的块：滤波器延迟线会把断点两侧混在一起，"
              "本期不做重对齐（铁律 3）";
        return Step::Error;
    }
    expect_in_ = src.meta.start_sample + static_cast<std::uint64_t>(src.size());
    have_expect_ = true;

    pend_clip_ += src.meta.clip_count;   // 上游削顶计数跨速率累计，随下一个输出块带走
    samples_in_ += static_cast<std::uint64_t>(src.size());
    status_.blocks_in++;
    status_.samples_in += src.size();

    outbuf_.clear();
    if (!src.samples.empty()) {
        dsp::ddc_block(st_, &src.samples[0], src.samples.size(), outbuf_);
    }

    if (outbuf_.empty()) {
        // 本轮攒不满一个输出样点。返回 Idle 是安全的：graph.cpp 在 process() 返回后
        // 无条件清空输入缓冲（与返回值无关），样点已经进了滤波器延迟线；而 any_progress
        // 是全图口径，上游这一轮刚产出过，不会误报「调度停滞」。
        //
        // 这段空转是**有界**的：抽取相位 next 每块减少一个块长，所以至多 ceil(gd / 块长)
        // 轮之后必定出第一个输出样点。块长再小也只是多空转几轮，不会卡死——原先这里写过
        // 一条「块长与抽取比不相容」的护栏，实测不可达，按删死代码的惯例去掉（同 D-057）。
        return Step::Idle;
    }

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.meta = src.meta;                 // 四态、标定、时基、降级理由原样继承
    d.iq.samples.swap(outbuf_);
    d.iq.meta.sample_rate_Hz = fs_out_;
    d.iq.meta.center_frequency_Hz = src.meta.center_frequency_Hz + f_shift_Hz_;
    d.iq.meta.start_sample = out_count_;  // 自 0 起、严格连续（08 §8 口径一）
    d.iq.meta.continuous_with_previous = true;
    d.iq.meta.clip_count = pend_clip_;
    pend_clip_ = 0;
    d.iq.meta.trace.model_id = "EM-B-11";
    d.iq.meta.trace.model_version = "0.1.0";
    d.iq.meta.trace.model_level = "E2";
    d.iq.meta.trace.model_layer = "M3";
    d.iq.meta.trace.credibility = "V2";
    // 口径四：下游与产品清单要能区分同一个 DDC 的不同抽头版本
    d.iq.meta.trace.parameter_version = std::string("ddc-") + fir_version_ + "-d" +
                                        std::to_string(decim_);
    d.iq.meta.trace.trace_id = "ddc";
    if (out_count_ == 0) {
        // 口径四：变更采样率的组件要在块上留一条说明。记录性质，不是降级。
        d.iq.meta.state_reasons.push_back(
            "ddc_rate:" + num(fs_in_) + "->" + num(fs_out_) + " Hz，抽取 " +
            std::to_string(decim_) + " 倍，群时延 " + std::to_string(st_.group_delay) +
            " 个输入样点已在时间锚里扣除");
    }
    out_count_ += static_cast<std::uint64_t>(d.iq.samples.size());
    status_.blocks_out++;
    status_.samples_out += d.iq.samples.size();
    status_.state = worst(status_.state, d.iq.meta.state);
    out["out"] = d;
    return Step::Produced;
}

Step DDC::flush(PortMap&, std::string& err) {
    (void)err;
    if (samples_in_ == 0) return Step::Finished;
    const std::uint64_t gd = static_cast<std::uint64_t>(st_.group_delay);
    const std::uint64_t used =
        out_count_ ? ((out_count_ - 1) * static_cast<std::uint64_t>(decim_) + gd + 1) : 0;
    const std::uint64_t dropped = samples_in_ > used ? samples_in_ - used : 0;
    const std::uint64_t warm = (gd + static_cast<std::uint64_t>(decim_) - 1) /
                               static_cast<std::uint64_t>(decim_);
    status_.notes.push_back(
        "入 " + std::to_string(samples_in_) + " 样点 @ " + num(fs_in_) + " Hz，出 " +
        std::to_string(out_count_) + " 样点 @ " + num(fs_out_) + " Hz；群时延 " +
        std::to_string(gd) + " 个输入样点已在时间锚里扣除（输出 m ↔ 输入 m·" +
        std::to_string(decim_) + "）；起始 " + std::to_string(warm) +
        " 个输出样点含滤波器启动瞬态；收尾丢弃 " + std::to_string(dropped) +
        " 个输入样点（不足以再出一个输出样点）");
    // 收尾不补零冲刷延迟线：补出来的最后几个输出样点是用根本没采到的数据算的（铁律 15），
    // 而且会在 S4 谱的末几行留下一段淡出，下游可能读成一次真实的电平变化。
    // 与 EnergyDetector 丢不满一帧、FeatureExtractor 丢未收口段同一口径。
    if (pend_clip_ > 0) {
        status_.notes.push_back("收尾时尚有 " + std::to_string(pend_clip_) +
                                " 个上游削顶样点未随块带出");
    }
    return Step::Finished;
}

void DDC::reset() {
    // 整体重建，不逐字段清：漏一个字节就可能让同种子两次运行不一致（铁律 9）
    std::string err;
    dsp::ddc_init(st_, decim_, err);
    outbuf_.clear();
    fs_in_ = 0.0;
    fs_out_ = 0.0;
    have_fs_ = false;
    expect_in_ = 0;
    have_expect_ = false;
    out_count_ = 0;
    samples_in_ = 0;
    pend_clip_ = 0;
    status_ = ComponentStatus();
}

}  // namespace cuav
