/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: cuav_rsmp_m96.c
 *
 * MATLAB Coder version            : 25.1
 */

/* Include Files */
#include "cuav_rsmp_m96.h"
#include <math.h>

/* Function Definitions */
/*
 * CUAV_RSMP_M96  抽取比 M = 96 的换向器一拍（Q-2，D-088）。窗口 M+T
 * 个原生样点，出 125 个站点样点。 抽取比必须是 codegen
 * 时的常量：窗口长度靠它。于是每个 M 一个入口，C 里也就是一个符号。 算法全在
 * cuav_rsmp_cycle.m，本文件只钉死 M。
 *
 * Arguments    : const creal_T win[116]
 *                const double h[2625]
 *                creal_T y[125]
 * Return Type  : void
 */
void cuav_rsmp_m96(const creal_T win[116], const double h[2625], creal_T y[125])
{
  int i;
  int t;
  /* CUAV_RSMP_CYCLE  OFDM 有理重采样的换向器一拍：M+T 个原生样点 -> L = 125
   * 个站点采样率样点。 */
  /*  */
  /*    本函数是 MATLAB Coder 的算法核（08 报告 §13
   * 三层分工的中间层；Q-2，D-088），**不做任何 */
  /*    参数校验、不写日志、不访问文件**；参数校验、样点序号换算、突发拼窗、频点与功率、溯源与
   */
  /*    四态都在封装层 engine/src/resampler.cpp 与 engine/src/scenario.cpp
   * 里（§13 五项职责）。 */
  /*  */
  /*    入参 */
  /*      win  (M+T)×1 复列向量，原生样点的**正序**连续窗口：win(j+1) = x[c·M −
   * T/2 + j]， */
  /*           c 是本拍的序号（本拍产出站点样点 125c … 125c+124）。 */
  /*      h    L·(T+1)×1 实列向量：原型抽头（models/radiator/fir_rsmp_v1.json
   * 展开后）末尾补 L−1 个零， */
  /*           让每一相都是 T+1 个抽头；给 FIR 末尾补零不改变 H(ω)。 */
  /*      M    抽取比，codegen 时是 coder.Constant（每个 M 一个入口）。 */
  /*  */
  /*    出参 */
  /*      y    L×1 复列向量，y(t+1) = 站点样点 125c + t。 */
  /*  */
  /*    代数（时间锚「输出 m ↔ 原型序号 m·M + gd」，gd = L·T/2，08 报告 §8
   * 口径二）： */
  /*      v[p] = Σ_i h[r + L·i]·x[q − i]，p = L·q + r，i = 0…T */
  /*      y[m] = v[m·M + gd] */
  /*    本拍内 p = L·(c·M) + (t·M + gd)，于是 (q − c·M, r) 只随 t
   * 变。显式循环、按 i 升序累加， */
  /*    不调 sum / filter 一类工具箱函数：那样会生成与信道化、接收滤波同名的公用
   * C 文件（08 §13.1）。 */
  for (t = 0; t < 125; t++) {
    double acc_im;
    double acc_re;
    int p;
    int q;
    p = t * 96 + 1250;
    q = (int)floor((double)p / 125.0);
    p -= q * 125;
    acc_re = 0.0;
    acc_im = 0.0;
    for (i = 0; i < 21; i++) {
      double acc_re_tmp;
      int b_acc_re_tmp;
      acc_re_tmp = h[p + 125 * i];
      b_acc_re_tmp = (q - i) + 10;
      acc_re += acc_re_tmp * win[b_acc_re_tmp].re;
      acc_im += acc_re_tmp * win[b_acc_re_tmp].im;
    }
    y[t].re = acc_re;
    y[t].im = acc_im;
  }
}

/*
 * File trailer for cuav_rsmp_m96.c
 *
 * [EOF]
 */
