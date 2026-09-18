#include "cuav/dsp.h"

// `std::rotate` / `std::swap` 在 <algorithm> 里。macOS 的 libc++ 与 MSVC 都把它传递包含了进来，
// 只有 libstdc++ 没有——D3-8 第一次在 Linux / GCC 上编时当场报「'rotate' is not a member of 'std'」。
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace cuav {
namespace dsp {

void fft_inplace(std::vector<Complex>& x) {
    const std::size_t n = x.size();
    if (n == 0) return;
    if ((n & (n - 1)) != 0) throw std::invalid_argument("FFT 长度必须是 2 的幂");
    // 位反转置换
    for (std::size_t i = 1, j = 0; i < n; ++i) {
        std::size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(x[i], x[j]);
    }
    for (std::size_t len = 2; len <= n; len <<= 1) {
        const double ang = -2.0 * 3.14159265358979323846 / static_cast<double>(len);
        const Complex wl(static_cast<float>(std::cos(ang)), static_cast<float>(std::sin(ang)));
        for (std::size_t i = 0; i < n; i += len) {
            Complex w(1.0f, 0.0f);
            for (std::size_t k = 0; k < len / 2; ++k) {
                Complex u = x[i + k];
                Complex v = x[i + k + len / 2] * w;
                x[i + k] = u + v;
                x[i + k + len / 2] = u - v;
                w *= wl;
            }
        }
    }
}

void fftshift(std::vector<Complex>& x) {
    const std::size_t n = x.size();
    if (n < 2) return;
    std::rotate(x.begin(), x.begin() + static_cast<long>((n + 1) / 2), x.end());
}

void fft_inplace(std::vector<std::complex<double>>& x) {
    const std::size_t n = x.size();
    if (n == 0) return;
    if ((n & (n - 1)) != 0) throw std::invalid_argument("FFT 长度必须是 2 的幂");
    for (std::size_t i = 1, j = 0; i < n; ++i) {
        std::size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(x[i], x[j]);
    }
    const double kTwoPi = 6.28318530717958647692;
    for (std::size_t len = 2; len <= n; len <<= 1) {
        const std::size_t half = len / 2;
        // 旋转因子逐点直接求值：递推乘法在 double 里也会积累 1e-13 量级的误差
        std::vector<std::complex<double>> tw(half);
        for (std::size_t k = 0; k < half; ++k) {
            const double ang = -kTwoPi * static_cast<double>(k) / static_cast<double>(len);
            tw[k] = std::complex<double>(std::cos(ang), std::sin(ang));
        }
        for (std::size_t i = 0; i < n; i += len) {
            for (std::size_t k = 0; k < half; ++k) {
                const std::complex<double> u = x[i + k];
                const std::complex<double> v = x[i + k + half] * tw[k];
                x[i + k] = u + v;
                x[i + k + half] = u - v;
            }
        }
    }
}

void fftshift(std::vector<std::complex<double>>& x) {
    const std::size_t n = x.size();
    if (n < 2) return;
    std::rotate(x.begin(), x.begin() + static_cast<long>((n + 1) / 2), x.end());
}

void fftshift(std::vector<double>& x) {
    const std::size_t n = x.size();
    if (n < 2) return;
    std::rotate(x.begin(), x.begin() + static_cast<long>((n + 1) / 2), x.end());
}

double regularized_gamma_q(double a, double x) {
    if (x < 0 || a <= 0) throw std::invalid_argument("参数越界");
    if (x == 0) return 1.0;
    if (x < a + 1.0) {
        double ap = a;
        double total = 1.0 / a;
        double term = total;
        for (int i = 0; i < 10000; ++i) {
            ap += 1.0;
            term *= x / ap;
            total += term;
            if (std::fabs(term) < std::fabs(total) * 1e-16) break;
        }
        return 1.0 - total * std::exp(-x + a * std::log(x) - std::lgamma(a));
    }
    const double tiny = 1e-300;
    double b = x + 1.0 - a;
    double c = 1.0 / tiny;
    double d = 1.0 / b;
    double h = d;
    for (int i = 1; i < 10000; ++i) {
        const double an = -static_cast<double>(i) * (static_cast<double>(i) - a);
        b += 2.0;
        d = an * d + b;
        if (std::fabs(d) < tiny) d = tiny;
        c = b + an / c;
        if (std::fabs(c) < tiny) c = tiny;
        d = 1.0 / d;
        const double delta = d * c;
        h *= delta;
        if (std::fabs(delta - 1.0) < 1e-16) break;
    }
    return std::exp(-x + a * std::log(x) - std::lgamma(a)) * h;
}

double threshold_for_pfa(int m_bins, double pfa) {
    if (!(pfa > 0.0 && pfa < 1.0)) throw std::invalid_argument("目标虚警率必须在 (0,1)");
    double lo = 1e-6, hi = 1.0;
    const double m = static_cast<double>(m_bins);
    while (regularized_gamma_q(m, m * hi) > pfa) {
        hi *= 2.0;
        if (hi > 1e6) throw std::runtime_error("门限求解发散");
    }
    for (int i = 0; i < 200; ++i) {
        const double mid = 0.5 * (lo + hi);
        if (regularized_gamma_q(m, m * mid) > pfa) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}


// --- 带限用的双二阶节（C-8 / G-6，D-069）------------------------------------

namespace {
// 巴特沃斯 4 阶的两对共轭极点：2·sin((2i+1)·π/8)，i = 0, 1
const double kButterQ[2] = {0.76536686473017956, 1.8477590650225735};
const double kPiD = 3.14159265358979323846;
}  // namespace

bool butterworth_lp4(double fc_Hz, double fs_Hz, Biquad out[2], std::string& err) {
    if (!(fs_Hz > 0.0)) { err = "带限滤波器需要正的采样率"; return false; }
    if (!(fc_Hz > 0.0) || !(fc_Hz < fs_Hz / 2.0)) {
        err = "带限滤波器的截止频率必须落在 (0, Fs/2) 内";
        return false;
    }
    const double K = std::tan(kPiD * fc_Hz / fs_Hz);        // 双线性变换的频率预畸变
    const double K2 = K * K;
    for (int i = 0; i < 2; ++i) {
        const double D = 1.0 + kButterQ[i] * K + K2;
        out[i].b0 = K2 / D;
        out[i].b1 = 2.0 * K2 / D;
        out[i].b2 = K2 / D;
        out[i].a1 = 2.0 * (K2 - 1.0) / D;
        out[i].a2 = (1.0 - kButterQ[i] * K + K2) / D;
    }
    return true;
}

std::complex<double> biquad2_step(const Biquad f[2], std::complex<double> state[4],
                                  std::complex<double> x) {
    for (int i = 0; i < 2; ++i) {
        // 转置直接 II 型。三行的次序是契约，Python 参考逐字同序（铁律 10）。
        const std::complex<double> y = f[i].b0 * x + state[2 * i];
        state[2 * i] = f[i].b1 * x - f[i].a1 * y + state[2 * i + 1];
        state[2 * i + 1] = f[i].b2 * x - f[i].a2 * y;
        x = y;
    }
    return x;
}

bool impulse_power_gain(const Biquad f[2], double& gain, std::size_t& n_settle, std::string& err) {
    const std::size_t kMax = 1u << 22;
    std::complex<double> st[4];
    for (int i = 0; i < 4; ++i) st[i] = std::complex<double>(0.0, 0.0);
    double acc = 0.0;
    std::size_t quiet = 0;
    for (std::size_t n = 0; n < kMax; ++n) {
        const std::complex<double> x = (n == 0) ? std::complex<double>(1.0, 0.0)
                                                : std::complex<double>(0.0, 0.0);
        const std::complex<double> y = biquad2_step(f, st, x);
        const double p = y.real() * y.real();      // 实系数滤波器：冲激响应是实的
        acc += p;
        if (n >= 16 && p <= 1e-20 * acc) {
            if (++quiet >= 16) { gain = acc; n_settle = n + 1; return true; }
        } else {
            quiet = 0;
        }
    }
    err = "带限滤波器的冲激响应在 4194304 个样点内没有收敛：截止频率相对采样率太小，"
          "请提高 emission.bw_Hz 或降低站点 fs_Hz（铁律 15）";
    return false;
}


// --- DDC：数控振荡混频 + 抗混叠低通 + 抽取（M-2，D-070）----------------------
//
// 系数表在 engine/src/ddc_taps.cpp（生成物）。这里只有三件事：相位增量、建状态、逐块推进。
// 与 algos/reference/ddc.py 逐字同序（铁律 10）。

double ddc_phase_step(double f_shift_Hz, double fs_Hz) {
    if (!(fs_Hz > 0.0)) return 0.0;
    const double r = f_shift_Hz / fs_Hz;
    // 归到 [0,1)：exp(-j2πk) = 1，去掉整数圈不改变结果，却让相位累加器永远待在
    // 减一次 1.0 就能回卷的区间里（那一步是精确的，见 dsp.h 的契约 ①）。
    return r - std::floor(r);
}

bool ddc_init(DdcState& st, int decim, std::string& err) {
    const FirTable* t = ddc_fir_lp_v1(decim);
    if (t == 0) {
        std::string list;
        for (std::size_t i = 0; i < ddc_fir_lp_v1_count(); ++i) {
            if (i) list += " / ";
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%d", ddc_fir_lp_v1_at(i).decim);
            list += buf;
        }
        err = "抽取比不在冻结抽头表内，支持的取值是 " + list;
        return false;
    }
    if ((t->ntaps % 2) == 0 || t->group_delay * 2 != t->ntaps - 1) {
        // 08 报告 §8 口径二：群时延不是整数样点就拒绝该抽头组合，不做半样点插值。
        err = "抽头表内部不一致：抽头数必须是奇数且群时延等于 (N-1)/2";
        return false;
    }
    st.decim = t->decim;
    st.ntaps = t->ntaps;
    st.group_delay = t->group_delay;
    ddc_fir_expand(*t, st.h);
    st.hist.assign(static_cast<std::size_t>(t->ntaps - 1), std::complex<double>(0.0, 0.0));
    st.work.clear();
    st.phase = 0.0;
    // next 的初值 = 群时延：于是第一个输出取在绝对输入样点 gd，其对称窗口覆盖输入
    // [-gd, +gd]，即「在输入时刻 0 处施加的零相位滤波」，输出样点 m ↔ 输入样点 m·D。
    st.next = static_cast<std::size_t>(t->group_delay);
    return true;
}

void ddc_block(DdcState& st, const Complex* x, std::size_t n, std::vector<Complex>& out) {
    const std::size_t nt = static_cast<std::size_t>(st.ntaps);
    const std::size_t hn = nt - 1;                 // 历史长度
    const std::size_t D = static_cast<std::size_t>(st.decim);
    const double two_pi = 6.28318530717958647692;

    // ① 历史 + 本块线性拼接。work[j] 对应的绝对输入样点号是「本块首样点 + j - hn」。
    st.work.resize(hn + n);
    for (std::size_t j = 0; j < hn; ++j) st.work[j] = st.hist[j];

    // ② 混频：乘 exp(-j2π·f_shift·t)，把 center_in + f_shift 搬到零频（04 §7.7 步骤 1-2）
    double ph = st.phase;
    for (std::size_t i = 0; i < n; ++i) {
        const double th = -two_pi * ph;
        const double c = std::cos(th);
        const double sn = std::sin(th);
        const double xr = static_cast<double>(x[i].real());
        const double xi = static_cast<double>(x[i].imag());
        st.work[hn + i] = std::complex<double>(xr * c - xi * sn, xr * sn + xi * c);
        ph += st.dphi;
        if (ph >= 1.0) ph -= 1.0;                  // [1,2) 减 1.0 精确，无舍入（契约 ①）
    }
    st.phase = ph;

    // ③ 低通 + 抽取（步骤 3-4）。窗口最新一点是 work[hn + p]，最旧是 work[p]；
    //    抽头升序累加是契约 ②。
    std::size_t p = st.next;
    while (p < n) {
        const std::size_t top = hn + p;
        double ar = 0.0;
        double ai = 0.0;
        for (std::size_t k = 0; k < nt; ++k) {
            const std::complex<double>& v = st.work[top - k];
            ar += st.h[k] * v.real();
            ai += st.h[k] * v.imag();
        }
        out.push_back(Complex(static_cast<float>(ar), static_cast<float>(ai)));
        p += D;
    }
    st.next = p - n;                               // 抽取相位跨块递延

    // ④ 留史：work 的末 hn 项。n < hn 时这一式同样正确（老历史自然被保留）。
    for (std::size_t j = 0; j < hn; ++j) st.hist[j] = st.work[n + j];
}

}  // namespace dsp
}  // namespace cuav
