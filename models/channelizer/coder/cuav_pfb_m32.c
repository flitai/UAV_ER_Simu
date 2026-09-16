/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: cuav_pfb_m32.c
 *
 * MATLAB Coder version            : 25.1
 */

/* Include Files */
#include "cuav_pfb_m32.h"
#include "flipud.h"
#include "ifft.h"
#include "sum.h"

/* Function Definitions */
/*
 * CUAV_PFB_M32  M = 32 的换向器一拍。窗口与抽头都是 P = 29·M = 928。
 *    子信道数必须是 codegen 时的常量：reshape 的行数与 ifft 的长度都靠它。
 *    于是每个 M 一个入口，C 里也就是一个符号（生成的函数名跟着 .m 的名字走）。
 *    算法全在 cuav_pfb_cycle.m，本文件只钉死 M。
 *
 * Arguments    : const creal_T w[928]
 *                const double hr[928]
 *                creal_T y[32]
 * Return Type  : void
 */
void cuav_pfb_m32(const creal_T w[928], const double hr[928], creal_T y[32])
{
  creal_T b_hr[928];
  int i;
  /* CUAV_PFB_CYCLE  多相 FFT 信道化的换向器一拍：P 个输入样点 -> M
   * 路子信道各一个输出样点。 */
  /*  */
  /*    本函数是 MATLAB Coder 的算法核（08 报告 §13
   * 三层分工的中间层），**不做任何参数校验、 */
  /*    不写日志、不访问文件**；参数校验、样点序号换算与群时延扣除、状态持有、溯源填充、
   */
  /*    四态传播这五项都在封装层 engine/src/channelizer.cpp 里（§13 五项职责）。
   */
  /*  */
  /*    入参 */
  /*      w   P×1 复列向量。**正序**连续窗口，w(P) = x[n0]
   * 是本拍锚定的那个输入样点， */
  /*          w(j) = x[n0-P+j]。正序是有意的：封装层的工作缓冲本来就是正序的，
   */
  /*          于是这里收到的可以是它的一段**连续切片**，一个样点都不用拷。 */
  /*      hr  P×1 实列向量。零填充到 P
   * 再**整体反转**后的原型抽头（封装层算一次、反复用）。 */
  /*      M   子信道数，codegen 时是 coder.Constant。 */
  /*  */
  /*    出参 */
  /*      y   M×1 复列向量。y(k+1) 是原始 FFT 下标 k 那一路，中心频率 k·fs/M。
   */
  /*          界面上的 select_channel = j 与它的对应关系 k = mod(j + M/2, M)
   * 在封装层里换算。 */
  /*  */
  /*    代数（推导与逐位验证见 08 报告 §8、模型卡
   * models/channelizer/README.md）： */
  /*      y_k[m] = Σ_n h[n]·x[n0-n]·exp(-j2πk(n0-n)/M),  n0 = m·M + gd */
  /*    因为抽头表保证 gd 是 M 的整数倍，常数相位 exp(-j2πk·gd/M) 恒为
   * 1，**不需要任何修正**。 */
  /*    换成正序下标 j = P-n（P 是 M 的整数倍）后分组键变成 (j-1) mod
   * M，于是比倒序形式多一次 */
  /*    flipud —— 这一次翻转只有 M 个元素，比每拍拷 P 个样点便宜得多。 */
  for (i = 0; i < 928; i++) {
    double d;
    d = hr[i];
    b_hr[i].re = d * w[i].re;
    b_hr[i].im = d * w[i].im;
  }
  creal_T dcv[32];
  e_sum(b_hr, dcv);
  e_flipud(dcv);
  e_ifft(dcv, y);
  for (i = 0; i < 32; i++) {
    y[i].re *= 32.0;
    y[i].im *= 32.0;
  }
}

/*
 * File trailer for cuav_pfb_m32.c
 *
 * [EOF]
 */
