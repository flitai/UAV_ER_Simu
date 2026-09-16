#include "cuav/components/rx_filter.h"

#include <cmath>
#include <cstdio>

#include "cuav/coder_provenance.h"

extern "C" {
#include "cuav_rx_fir_initialize.h"
}

namespace cuav {
namespace {

const char* kFirVersion = "rx_v1";

std::string num(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.10g", v);
    return buf;
}

// 表内最大抽头数：内核的接口是定长的，各档统一零填充到它。
// 给 FIR 末尾补零不改变 H(ω)，群时延仍由真实抽头数决定。
int max_ntaps() {
    int m = 0;
    for (std::size_t i = 0; i < dsp::rx_fir_v1_count(); ++i) {
        const int n = dsp::rx_fir_v1_at(i).ntaps;
        if (n > m) m = n;
    }
    return m;
}

std::string supported_rels() {
    std::string s;
    for (std::size_t i = 0; i < dsp::rx_fir_v1_count(); ++i) {
        if (i) s += " / ";
        s += num(dsp::rx_fir_v1_at(i).bw_rel);
    }
    return s;
}

// 当前采样率下能取到的 bw_Hz。查不到档位时把它列出来——不静默顶替也不取最近一档（铁律 15）。
std::string supported_bw(double fs) {
    std::string s;
    for (std::size_t i = 0; i < dsp::rx_fir_v1_count(); ++i) {
        if (i) s += " / ";
        s += num(dsp::rx_fir_v1_at(i).bw_rel * fs);
    }
    return s + " Hz";
}

}  // namespace

ComponentInfo RxFilter::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Receiver;
    i.display_name = "接收滤波";
    i.description =
        "接收机的模拟预选 / 中频滤波等效（04 §7.5、附录 A「滤波」）：线性相位 FIR，"
        "只做幅频响应与群时延，**不抽取**——输出采样率与中心频率都与输入相同。"
        "群时延 (N−1)/2 个输入样点在本层扣除（08 报告 §8 口径二），于是输出样点 m 对应输入样点 m，"
        "首样点序号自 0 起且严格连续；收尾不补零，末尾少 (N−1)/2 个输出样点。"
        "本组件排在接收机前端**之前**：前端注入的等效热噪声因此不被它整形，"
        "S2 的底噪仍是 −174 + nf + 10·log10(fs)。"
        "通带按 bw_Hz / 输入采样率查冻结抽头表，采样率要到第一块才知道，故该检查在运行时执行。";
    i.model_layer = "M3";
    i.model_level = "E2";
    i.model_id = "EM-B-11";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.scene_bindable = false;
    i.stateful = true;   // 滤波器状态跨块保持
    i.implementation = "coder";
    i.source_ref = coder_provenance::rx_source_ref();
    i.params = {
        ParamSpec::number("bw_Hz", "Hz",
                          "接收滤波的通带宽度（复基带双边占用）。"
                          "缺省由场景站点的 receiver.bw_Hz 带出")
            .req()
            .constrained("bw_Hz / 输入采样率须落在冻结抽头表内（" + supported_rels() + "）；"
                         "采样率要到第一块才知道，故在运行时校验并列出该采样率下可取的值"),
        ParamSpec::choice("fir_version", {"rx_v1"},
                          "接收滤波的抽头版本：过渡带 0.05·fs、阻带 ≥ 60 dB、奇数抽头")
            .def_text(kFirVersion),
    };
    return i;
}

bool RxFilter::configure(const std::map<std::string, double>& params,
                         const std::map<std::string, std::string>& text_params, std::string& err) {
    std::map<std::string, double>::const_iterator it = params.find("bw_Hz");
    if (it == params.end()) {
        err = "缺必填参数 bw_Hz";
        return false;
    }
    bw_Hz_ = it->second;
    if (!(bw_Hz_ > 0.0 && bw_Hz_ < 1e18)) {
        err = "bw_Hz 必须是正的有限值，收到 " + num(bw_Hz_);
        return false;
    }

    std::map<std::string, std::string>::const_iterator t = text_params.find("fir_version");
    fir_version_ = (t != text_params.end()) ? t->second : kFirVersion;
    if (fir_version_ != kFirVersion) {
        err = "未知的 fir_version：" + fir_version_ + "，本版本只有 " + kFirVersion;
        return false;
    }
    // 查表要等采样率，放到 process() 的首块（与 DDC 的 fs % decim 同一处置）。
    return true;
}

bool RxFilter::init(IRandom&, std::string& err) {
    (void)err;
    // 接收滤波没有随机性。reset() 整体重建状态，保证同种子两次运行的起点完全相同（铁律 9）。
    reset();
    cuav_rx_fir_initialize();
    return true;
}

// 把 xbuf_ 前 n_real 个真实样点（其余已置零）过一遍内核，把该保留的因果输出追加到 sink。
bool RxFilter::crunch(std::size_t n_real, std::vector<Complex>& sink) {
    cuav_rx_fir(&xbuf_[0], &taps_[0], &zi_[0], &ybuf_[0], &zf_[0]);
    zi_ = zf_;
    for (std::size_t i = 0; i < n_real; ++i) {
        if (skip_ > 0) { --skip_; continue; }   // 群时延：丢掉最前面 gd 个因果输出
        sink.push_back(Complex(static_cast<float>(ybuf_[i].re),
                               static_cast<float>(ybuf_[i].im)));
    }
    return true;
}

Step RxFilter::process(PortMap& in, PortMap& out, std::string& err) {
    PortMap::iterator it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const Block& src = it->second.iq;

    if (!have_fs_) {
        fs_in_ = src.meta.sample_rate_Hz;
        if (!(fs_in_ > 0.0)) {
            err = "RxFilter 收到的块没有采样率";
            return Step::Error;
        }
        bw_rel_ = bw_Hz_ / fs_in_;
        const dsp::RxFirTable* tab = dsp::rx_fir_v1(bw_rel_);
        if (tab == 0) {
            err = "bw_Hz = " + num(bw_Hz_) + " 与输入采样率 " + num(fs_in_) +
                  " Hz 的比值 " + num(bw_rel_) + " 不在冻结抽头表内；"
                  "该采样率下可取的 bw_Hz 是 " + supported_bw(fs_in_) +
                  "（铁律 15：不静默顶替，也不取最近一档）";
            return Step::Error;
        }
        ntaps_ = tab->ntaps;
        group_delay_ = tab->group_delay;
        const int nmax = max_ntaps();
        std::vector<double> h;
        dsp::rx_fir_expand(*tab, h);
        taps_.assign(static_cast<std::size_t>(nmax), 0.0);   // 零填充到定长接口的长度
        for (std::size_t k = 0; k < h.size(); ++k) taps_[k] = h[k];
        zi_.assign(static_cast<std::size_t>(nmax - 1), creal_T());
        zf_ = zi_;
        for (std::size_t k = 0; k < zi_.size(); ++k) { zi_[k].re = 0.0; zi_[k].im = 0.0; }
        xbuf_.assign(static_cast<std::size_t>(kBlock), creal_T());
        for (std::size_t k = 0; k < xbuf_.size(); ++k) { xbuf_[k].re = 0.0; xbuf_[k].im = 0.0; }
        ybuf_ = xbuf_;
        fill_ = 0;
        skip_ = static_cast<std::uint64_t>(group_delay_);
        center_Hz_ = src.meta.center_frequency_Hz;
        have_fs_ = true;
    } else if (src.meta.sample_rate_Hz != fs_in_) {
        err = "RxFilter 中途收到不同采样率的块";
        return Step::Error;
    }

    if (have_expect_ && src.meta.start_sample != expect_in_) {
        err = "RxFilter 的输入块不连续：期望首样点序号 " + std::to_string(expect_in_) +
              "，实际 " + std::to_string(src.meta.start_sample) +
              "；输出样点号由本组件自己数，丢块会静默错位（铁律 15）";
        return Step::Error;
    }
    if (have_expect_ && !src.meta.continuous_with_previous) {
        err = "RxFilter 收到标记为采集不连续的块：滤波器状态会把断点两侧混在一起，"
              "本期不做重对齐（铁律 3）";
        return Step::Error;
    }
    expect_in_ = src.meta.start_sample + static_cast<std::uint64_t>(src.size());
    have_expect_ = true;

    pend_clip_ += src.meta.clip_count;
    samples_in_ += static_cast<std::uint64_t>(src.size());
    status_.blocks_in++;
    status_.samples_in += src.size();
    last_meta_ = src.meta;
    have_meta_ = true;

    outbuf_.clear();
    for (std::size_t i = 0; i < src.samples.size(); ++i) {
        xbuf_[fill_].re = static_cast<double>(src.samples[i].real());
        xbuf_[fill_].im = static_cast<double>(src.samples[i].imag());
        ++fill_;
        if (fill_ == static_cast<std::size_t>(kBlock)) {
            crunch(fill_, outbuf_);
            fill_ = 0;
        }
    }

    if (outbuf_.empty()) {
        // 还没攒满一个内核块，或攒满的那些全被群时延吃掉了。返回 Idle 是安全的：
        // graph.cpp 在 process() 返回后无条件清空输入缓冲（与返回值无关），样点已经进了缓冲。
        // 这段空转有界：至多 ceil((kBlock + gd) / 块长) 轮之后必定出第一个输出样点。
        return Step::Idle;
    }

    PortData d;
    d.type = PortType::IQStream;
    d.has_data = true;
    d.iq.meta = src.meta;                 // 四态、标定、时基、降级理由原样继承
    d.iq.samples.swap(outbuf_);
    d.iq.meta.start_sample = out_count_;  // 自 0 起、严格连续（08 §8 口径一）
    d.iq.meta.continuous_with_previous = true;
    d.iq.meta.clip_count = pend_clip_;
    pend_clip_ = 0;
    d.iq.meta.trace.model_id = "EM-B-11";
    d.iq.meta.trace.model_version = "0.1.0";
    d.iq.meta.trace.model_level = "E2";
    d.iq.meta.trace.model_layer = "M3";
    d.iq.meta.trace.credibility = "V2";
    d.iq.meta.trace.parameter_version = std::string("rxfilt-") + fir_version_ + "-bw" +
                                        num(bw_rel_);
    d.iq.meta.trace.trace_id = "rx_filter";
    if (out_count_ == 0) {
        // 记录性质，不是降级：本组件不改采样率，但改了时间锚（扣了群时延）
        d.iq.meta.state_reasons.push_back(
            "rxfilt:通带 " + num(bw_Hz_) + " Hz（bw_rel " + num(bw_rel_) + "），抽头 " +
            std::to_string(ntaps_) + "，群时延 " + std::to_string(group_delay_) +
            " 个输入样点已在时间锚里扣除");
    }
    out_count_ += static_cast<std::uint64_t>(d.iq.samples.size());
    status_.blocks_out++;
    status_.samples_out += d.iq.samples.size();
    status_.state = worst(status_.state, d.iq.meta.state);
    out["out"] = d;
    return Step::Produced;
}

Step RxFilter::flush(PortMap& out, std::string& err) {
    (void)err;
    if (!have_fs_ || samples_in_ == 0) return Step::Finished;

    // 缓冲里还剩不满一块的真实样点。零填充到定长接口再调一次，**只取前 fill_ 个输出**：
    // 因果滤波器里补的零只影响下标 >= fill_ 的输出，所以这 fill_ 个是精确的。
    // 这一次的 zf 反映了那些零，但后面不再有块，用不上。
    outbuf_.clear();
    if (fill_ > 0) {
        for (std::size_t k = fill_; k < xbuf_.size(); ++k) { xbuf_[k].re = 0.0; xbuf_[k].im = 0.0; }
        crunch(fill_, outbuf_);
        fill_ = 0;
    }
    if (!outbuf_.empty()) {
        PortData d;
        d.type = PortType::IQStream;
        d.has_data = true;
        d.iq.meta = last_meta_;
        d.iq.samples.swap(outbuf_);
        d.iq.meta.start_sample = out_count_;
        d.iq.meta.continuous_with_previous = true;
        d.iq.meta.clip_count = pend_clip_;
        pend_clip_ = 0;
        d.iq.meta.trace.model_id = "EM-B-11";
        d.iq.meta.trace.model_version = "0.1.0";
        d.iq.meta.trace.model_level = "E2";
        d.iq.meta.trace.model_layer = "M3";
        d.iq.meta.trace.credibility = "V2";
        d.iq.meta.trace.parameter_version = std::string("rxfilt-") + fir_version_ + "-bw" +
                                            num(bw_rel_);
        d.iq.meta.trace.trace_id = "rx_filter";
        out_count_ += static_cast<std::uint64_t>(d.iq.samples.size());
        status_.blocks_out++;
        status_.samples_out += d.iq.samples.size();
        status_.state = worst(status_.state, d.iq.meta.state);
        out["out"] = d;
    }

    const std::uint64_t gd = static_cast<std::uint64_t>(group_delay_);
    const std::uint64_t want = samples_in_ > gd ? samples_in_ - gd : 0;
    status_.notes.push_back(
        "入 " + std::to_string(samples_in_) + " 样点 @ " + num(fs_in_) + " Hz，出 " +
        std::to_string(out_count_) + " 样点（期望 " + std::to_string(want) +
        " = 入 − 群时延）；通带 " + num(bw_Hz_) + " Hz、抽头 " + std::to_string(ntaps_) +
        "、群时延 " + std::to_string(gd) + " 个输入样点已在时间锚里扣除（输出 m ↔ 输入 m）；"
        "起始 " + std::to_string(gd) + " 个输出样点含滤波器启动瞬态；"
        "末尾少 " + std::to_string(gd) + " 个输出样点（收尾不补零）");
    if (pend_clip_ > 0) {
        status_.notes.push_back("收尾时尚有 " + std::to_string(pend_clip_) +
                                " 个上游削顶样点未随块带出");
    }
    return out.empty() ? Step::Finished : Step::Produced;
}

void RxFilter::reset() {
    // 整体重建，不逐字段清：漏一个字节就可能让同种子两次运行不一致（铁律 9）
    taps_.clear();
    xbuf_.clear();
    ybuf_.clear();
    zi_.clear();
    zf_.clear();
    outbuf_.clear();
    fill_ = 0;
    skip_ = 0;
    ntaps_ = 0;
    group_delay_ = 0;
    bw_rel_ = 0.0;
    fs_in_ = 0.0;
    have_fs_ = false;
    expect_in_ = 0;
    have_expect_ = false;
    out_count_ = 0;
    samples_in_ = 0;
    pend_clip_ = 0;
    center_Hz_ = 0.0;
    have_meta_ = false;
    last_meta_ = BlockMeta();
    status_ = ComponentStatus();
}

}  // namespace cuav
