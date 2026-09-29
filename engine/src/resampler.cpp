#include "cuav/resampler.h"

#include <cstdio>

#include "cuav/dsp.h"

// Coder 产物：一个 initialize 管三个入口（以第一个入口命名），头文件自带 extern "C"。
#include "cuav_rsmp_m24.h"
#include "cuav_rsmp_m24_initialize.h"
#include "cuav_rsmp_m48.h"
#include "cuav_rsmp_m96.h"

namespace cuav {

const std::vector<int>& rsmp_supported_decim() {
    // 与 models/radiator/fir_rsmp_v1.json 的 spec.decim_M_supported 相同，
    // 也与 matlab/coder/build_coder.m 生成的三个入口一一对应（engine/tests/test_ofdm.cpp 核对）。
    static const std::vector<int> v = {24, 48, 96};
    return v;
}

RationalResampler::RationalResampler() : L_(0), M_(0), T_(0), gd_(0) {}

bool RationalResampler::init(int decim, std::string& err) {
    const std::vector<int>& ok = rsmp_supported_decim();
    bool found = false;
    for (std::size_t i = 0; i < ok.size(); ++i) found = found || ok[i] == decim;
    if (!found) {
        err = "有理重采样不支持抽取比 " + std::to_string(decim) + "（可取 24 / 48 / 96）";
        return false;
    }
    const dsp::RsmpTable& t = dsp::rsmp_fir_v1();
    L_ = t.interp;
    M_ = decim;
    T_ = t.taps_per_phase;
    gd_ = t.group_delay;
    std::vector<double> h;
    dsp::rsmp_fir_expand(t, h);
    hpad_.assign(static_cast<std::size_t>(L_) * static_cast<std::size_t>(T_ + 1), 0.0);
    for (std::size_t k = 0; k < h.size(); ++k) hpad_[k] = h[k];
    cuav_rsmp_m24_initialize();   // API 合同的一部分（08 §13.1 第 4 条）；当前生成的是空函数
    return true;
}

void RationalResampler::native_span(std::int64_t m, std::int64_t& lo, std::int64_t& hi) const {
    // y[m] = Σ_i h[r + L·i]·x[q − i]，q = floor((m·M + gd)/L)，i = 0…T
    const std::int64_t p = m * M_ + gd_;
    const std::int64_t q = p >= 0 ? p / L_ : -((-p + L_ - 1) / L_);
    hi = q;
    lo = q - T_;
}

void RationalResampler::cycle(const std::complex<double>* win, std::complex<double>* y) const {
    // std::complex<double> 与 creal_T 都是两个 double 并排（C++11 起对 std::complex 有布局保证），
    // 按数组重解释即可，一个样点都不用拷。
    const creal_T* w = reinterpret_cast<const creal_T*>(win);
    creal_T* out = reinterpret_cast<creal_T*>(y);
    switch (M_) {
    case 24: cuav_rsmp_m24(w, &hpad_[0], out); break;
    case 48: cuav_rsmp_m48(w, &hpad_[0], out); break;
    case 96: cuav_rsmp_m96(w, &hpad_[0], out); break;
    default: break;   // init() 已拦住，走不到
    }
}

}  // namespace cuav
