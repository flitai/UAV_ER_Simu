#include "cuav/numstr.h"
#include "cuav/components/channelizer.h"

#include <cmath>
#include <cstdio>

#include "cuav/coder_provenance.h"

extern "C" {
#include "cuav_pfb_m16.h"
#include "cuav_pfb_m2_initialize.h"
#include "cuav_pfb_m32.h"
#include "cuav_pfb_m4.h"
#include "cuav_pfb_m64.h"
#include "cuav_pfb_m8.h"
}

namespace cuav {
namespace {

const char* kFirVersion = "pfb_v1";

std::string num(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.10g", v);
    return buf;
}

std::string supported_channels() {
    std::string s;
    for (std::size_t i = 0; i < dsp::pfb_fir_v1_count(); ++i) {
        if (i) s += " / ";
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%d", dsp::pfb_fir_v1_at(i).channels);
        s += buf;
    }
    return s;
}

// 子信道数 → Coder 入口。表里有而这里没有的档位一律返回 0，由 configure() 报错：
// 「表里有一档但没有对应的内核」是加了档位忘了重跑 codegen，必须说出来（铁律 15）。
void (*kernel_for(int m))(const creal_T*, const double*, creal_T*) {
    switch (m) {
        case 2:  return &cuav_pfb_m2;
        case 4:  return &cuav_pfb_m4;
        case 8:  return &cuav_pfb_m8;
        case 16: return &cuav_pfb_m16;
        case 32: return &cuav_pfb_m32;
        case 64: return &cuav_pfb_m64;
        default: return 0;
    }
}

}  // namespace

ComponentInfo Channelizer::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Receiver;
    i.display_name = "多相信道化";
    i.description =
        "多相 FFT 信道化（04 §7.7）：把宽带 IQ 切成 channels 条等宽子信道，临界抽取，"
        "**本期只输出其中一路**（select_channel）。**本组件改变采样率**："
        "输出 fs = 输入 fs / channels，中心频率 = 输入中心 + (select_channel − channels/2)·fs_out。"
        "时间锚按 08 报告 §8 口径一与口径二：原型滤波器的群时延在这一层扣除，"
        "输出样点 m 对应输入样点 m·channels，首样点序号自 0 起且严格连续。"
        "原型是等波纹设计的冻结系数表（通带 0.4·fs_out、阻带 0.5·fs_out ≥ 60 dB，"
        "抽头数 M·T+1 且 T 取偶数，使群时延为 M 的整数倍）。"
        "临界抽取的固有后果：相邻子信道的过渡带折进本路外侧 20%，可用子带是 ±0.4·fs_out。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-B-11";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;
    i.stateful = true;   // 滤波器延迟线与换向器相位跨块保持
    i.implementation = "coder";
    i.source_ref = coder_provenance::pfb_source_ref();
    i.params = {
        ParamSpec::number("channels", "", "子信道数；输出采样率 = 输入采样率 / 本值")
            .def(8.0).at_least(2.0)
            .constrained("取值须在冻结原型表内（" + supported_channels() + "），"
                         "且输入采样率须能被它整除（08 报告 §8 口径一）"),
        ParamSpec::number("select_channel", "",
                          "输出哪一路：相对输入中心从低到高编号，channels/2 那一路是零频。"
                          "缺省 4 对应缺省的 channels = 8，即零频那一路；改了 channels 要一并改它")
            .def(4.0).at_least(0.0),
        ParamSpec::choice("fir_version", {"pfb_v1"},
                          "多相原型滤波器的版本：通带 0.4·fs_out、阻带 0.5·fs_out ≥ 60 dB")
            .def_text(kFirVersion),
    };
    return i;
}

bool Channelizer::configure(const std::map<std::string, double>& params,
                            const std::map<std::string, std::string>& text_params,
                            std::string& err) {
    double m = 8.0;
    std::map<std::string, double>::const_iterator it = params.find("channels");
    if (it != params.end()) m = it->second;
    if (m != std::floor(m) || m < 2.0 || m > 1e6) {
        err = "channels 必须是不小于 2 的整数，收到 " + num(m);
        return false;
    }
    channels_ = static_cast<int>(m);

    const dsp::PfbTable* tab = dsp::pfb_fir_v1(channels_);
    if (tab == 0) {
        err = "channels = " + num(m) + " 不在冻结原型表内，支持的取值是 " + supported_channels() +
              "（不做信道化请旁路本环节，channels = 1 不是它的写法；铁律 15）";
        return false;
    }
    fn_ = kernel_for(channels_);
    if (fn_ == 0) {
        err = "channels = " + num(m) + " 在原型表里，却没有对应的 Coder 内核："
              "加了档位之后要重跑 matlab/coder/build_coder.m";
        return false;
    }
    if (tab->ntaps % 2 == 0 || tab->group_delay * 2 != tab->ntaps - 1 ||
        tab->group_delay % channels_ != 0) {
        err = "原型表内部不一致：抽头数须为奇数、群时延须等于 (N−1)/2 且为 channels 的整数倍"
              "（后者是常数相位恒为 1 的前提）";
        return false;
    }
    ntaps_ = tab->ntaps;
    pad_to_ = tab->pad_to;
    group_delay_ = tab->group_delay;

    double j = 4.0;
    it = params.find("select_channel");
    if (it != params.end()) j = it->second;
    if (j != std::floor(j) || j < 0.0 || j >= static_cast<double>(channels_)) {
        err = "select_channel 必须是 [0, channels) 内的整数，收到 " + num(j) +
              "，channels = " + num(m) + "（零频那一路是 " + num(m / 2.0) + "）";
        return false;
    }
    select_ = static_cast<int>(j);
    raw_bin_ = raw_bin_of(select_, channels_);

    std::map<std::string, std::string>::const_iterator t = text_params.find("fir_version");
    fir_version_ = (t != text_params.end()) ? t->second : kFirVersion;
    if (fir_version_ != kFirVersion) {
        err = "未知的 fir_version：" + fir_version_ + "，本版本只有 " + kFirVersion;
        return false;
    }

    // 抽头零填充到 pad_to 再整体反转：内核吃正序窗口，所以反转的是抽头不是数据（见头文件口径 ②）
    std::vector<double> h;
    dsp::pfb_fir_expand(*tab, h);
    taps_rev_.assign(h.size(), 0.0);
    for (std::size_t k = 0; k < h.size(); ++k) taps_rev_[k] = h[h.size() - 1 - k];
    return true;
}

bool Channelizer::init(IRandom&, std::string& err) {
    (void)err;
    // 信道化没有随机性。reset() 整体重建运行态，保证同种子两次运行的起点完全相同（铁律 9）；
    // 它**不动** configure() 定下的那些（channels_ / select_ / 抽头 / 内核指针），
    // 那些是配置不是状态 —— 与 DDC 的 reset() 同一分界。
    reset();
    cuav_pfb_m2_initialize();   // 六个入口共用一个库初始化，名字跟着首个入口走
    return true;
}

Step Channelizer::process(PortMap& in, PortMap& out, std::string& err) {
    PortMap::iterator it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& src = it->second.iq;

    if (!have_fs_) {
        fs_in_ = src.meta.sample_rate_Hz;
        if (!(fs_in_ > 0.0)) {
            err = "Channelizer 收到的块没有采样率";
            return Step::Error;
        }
        // 08 §8 口径一：除不尽就报错，不四舍五入一个「差不多」的输出采样率。
        // 判据与前端 web/src/chain/plan.ts 的 fs_s5 = fs_s4 / channels 同式。
        if (std::fabs(std::fmod(fs_in_, static_cast<double>(channels_))) > 1e-9) {
            err = "输入采样率 " + num(fs_in_) + " Hz 不能被子信道数 " + num(channels_) + " 整除";
            return Step::Error;
        }
        fs_out_ = fs_in_ / static_cast<double>(channels_);
        hist_.assign(static_cast<std::size_t>(pad_to_ - 1), creal_T());
        for (std::size_t k = 0; k < hist_.size(); ++k) { hist_[k].re = 0.0; hist_[k].im = 0.0; }
        ybuf_.assign(static_cast<std::size_t>(channels_), creal_T());
        next_ = static_cast<std::size_t>(group_delay_);   // 时间锚就在这一行
        have_fs_ = true;
    } else if (src.meta.sample_rate_Hz != fs_in_) {
        err = "Channelizer 中途收到不同采样率的块";
        return Step::Error;
    }

    if (have_expect_ && src.meta.start_sample != expect_in_) {
        err = "Channelizer 的输入块不连续：期望首样点序号 " + numstr(expect_in_) +
              "，实际 " + numstr(src.meta.start_sample) +
              "；输出样点号由本组件自己数，丢块会静默错位（铁律 15）";
        return Step::Error;
    }
    if (have_expect_ && !src.meta.continuous_with_previous) {
        err = "Channelizer 收到标记为采集不连续的块：滤波器延迟线会把断点两侧混在一起，"
              "本期不做重对齐（铁律 3）";
        return Step::Error;
    }
    expect_in_ = src.meta.start_sample + static_cast<std::uint64_t>(src.size());
    have_expect_ = true;

    pend_clip_ += src.meta.clip_count;
    samples_in_ += static_cast<std::uint64_t>(src.size());
    status_.blocks_in++;
    status_.samples_in += src.size();

    // [历史 | 本块] 线性拼接，正序。内核收的是 work_ 的一段**连续切片**的指针，不拷贝。
    const std::size_t hn = hist_.size();
    const std::size_t n = src.samples.size();
    work_.resize(hn + n);
    for (std::size_t k = 0; k < hn; ++k) work_[k] = hist_[k];
    for (std::size_t i = 0; i < n; ++i) {
        work_[hn + i].re = static_cast<double>(src.samples[i].real());
        work_[hn + i].im = static_cast<double>(src.samples[i].imag());
    }

    outbuf_.clear();
    std::size_t p = next_;
    while (p < n) {
        // 锚在块内偏移 p 的那个输入样点；长 pad_to 的正序窗口以它结尾，起点正好是 work_[p]
        fn_(&work_[p], &taps_rev_[0], &ybuf_[0]);
        outbuf_.push_back(Complex(static_cast<float>(ybuf_[raw_bin_].re),
                                  static_cast<float>(ybuf_[raw_bin_].im)));
        p += static_cast<std::size_t>(channels_);
    }
    next_ = p - n;

    // 留史：work_ 的末 hn 项（n < hn 时同样正确）
    for (std::size_t k = 0; k < hn; ++k) hist_[k] = work_[n + k];

    if (outbuf_.empty()) {
        // 本轮攒不满一个输出样点。返回 Idle 是安全的：graph.cpp 在 process() 返回后无条件
        // 清空输入缓冲（与返回值无关），样点已经进了延迟线。空转有界：换向器相位每块减少
        // 一个块长，至多 ceil(gd / 块长) 轮之后必定出第一个输出样点（与 DDC 同）。
        return Step::Idle;
    }

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.meta = src.meta;                 // 四态、标定、时基、降级理由原样继承
    d.iq.samples.swap(outbuf_);
    d.iq.meta.sample_rate_Hz = fs_out_;
    d.iq.meta.center_frequency_Hz =
        src.meta.center_frequency_Hz +
        static_cast<double>(select_ - channels_ / 2) * fs_out_;
    d.iq.meta.start_sample = out_count_;  // 自 0 起、严格连续（08 §8 口径一）
    d.iq.meta.continuous_with_previous = true;
    d.iq.meta.clip_count = pend_clip_;
    pend_clip_ = 0;
    d.iq.meta.trace.model_id = "EM-B-11";
    d.iq.meta.trace.model_version = "0.1.0";
    d.iq.meta.trace.model_level = "E2";
    d.iq.meta.trace.model_layer = "M3";
    d.iq.meta.trace.credibility = "V2";
    // 口径四：下游与产品清单要能区分同一个信道化的不同原型版本与不同切法
    d.iq.meta.trace.parameter_version = std::string("chan-") + fir_version_ + "-m" +
                                        numstr(channels_) + "-j" + numstr(select_);
    d.iq.meta.trace.trace_id = "channelizer";
    if (out_count_ == 0) {
        // 口径四：变更采样率的组件要在块上留一条说明。记录性质，不是降级。
        d.iq.meta.state_reasons.push_back(
            "chan_rate:" + num(fs_in_) + "->" + num(fs_out_) + " Hz，" +
            numstr(channels_) + " 路子信道取第 " + numstr(select_) +
            " 路（原始 bin " + numstr(raw_bin_) + "），中心偏移 " +
            num(static_cast<double>(select_ - channels_ / 2) * fs_out_) + " Hz，群时延 " +
            numstr(group_delay_) + " 个输入样点已在时间锚里扣除");
    }
    out_count_ += static_cast<std::uint64_t>(d.iq.samples.size());
    status_.blocks_out++;
    status_.samples_out += d.iq.samples.size();
    status_.state = worst(status_.state, d.iq.meta.state);
    out["out"] = d;
    return Step::Produced;
}

Step Channelizer::flush(PortMap&, std::string& err) {
    (void)err;
    if (samples_in_ == 0) return Step::Finished;
    const std::uint64_t m = static_cast<std::uint64_t>(channels_);
    const std::uint64_t gd = static_cast<std::uint64_t>(group_delay_);
    const std::uint64_t used = out_count_ ? ((out_count_ - 1) * m + gd + 1) : 0;
    const std::uint64_t dropped = samples_in_ > used ? samples_in_ - used : 0;
    const std::uint64_t warm = (gd + m - 1) / m;
    status_.notes.push_back(
        "入 " + numstr(samples_in_) + " 样点 @ " + num(fs_in_) + " Hz，出 " +
        numstr(out_count_) + " 样点 @ " + num(fs_out_) + " Hz（" +
        numstr(channels_) + " 路取第 " + numstr(select_) + " 路）；群时延 " +
        numstr(gd) + " 个输入样点已在时间锚里扣除（输出 m ↔ 输入 m·" +
        numstr(channels_) + "）；起始 " + numstr(warm) +
        " 个输出样点含滤波器启动瞬态；收尾丢弃 " + numstr(dropped) +
        " 个输入样点（不足以再出一个输出样点）");
    // 收尾不补零冲刷延迟线，与 DDC 同一口径：补出来的输出是用根本没采到的数据算的（铁律 15）。
    if (pend_clip_ > 0) {
        status_.notes.push_back("收尾时尚有 " + numstr(pend_clip_) +
                                " 个上游削波样点未随块带出");
    }
    return Step::Finished;
}

void Channelizer::reset() {
    // 整体重建，不逐字段清：漏一个字节就可能让同种子两次运行不一致（铁律 9）
    work_.clear();
    hist_.clear();
    ybuf_.clear();
    outbuf_.clear();
    next_ = 0;
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
