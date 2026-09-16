/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: cuav_rx_fir.c
 *
 * MATLAB Coder version            : 25.1
 */

/* Include Files */
#include "cuav_rx_fir.h"
#include "filter.h"

/* Function Definitions */
/*
 * CUAV_RX_FIR  接收滤波的分块带状态 FIR：一次处理 L 个样点，状态由封装层持有。
 *
 *    本函数是 MATLAB Coder 的算法核（08 报告
 * §13），只做运算；参数校验、群时延扣除、 四态传播在封装层
 * engine/src/rx_filter.cpp 里。
 *
 *    直接用工具箱的
 * filter：初末条件（zi/zf）的语义由它定义，分块喂与整段喂逐样点一致，
 *    这正是「重新实现等于重新承担一次验证成本」要避免的那部分（D-036）。
 *
 *    入参
 *      x   L×1 复列向量，本块的输入样点（正序）。
 *      h   N×1
 * 实列向量，抽头（升序）。各档抽头数不同，统一**零填充到表里的最大值**： 给 FIR
 * 末尾补零不改变 H(ω)，群时延仍是真实抽头数决定的 (N_actual-1)/2。 zi  (N-1)×1
 * 复列向量，上一块留下的状态；第一块传零。
 *
 *    出参
 *      y   L×1 复列向量，因果输出：y(n) = Σ_k h(k)·x(n-k+1)。
 *          群时延**不在这里扣**——封装层丢掉前 gd 个输出，于是输出样点 m
 * 对应输入样点 m （08 报告 §8 口径二）。 zf  (N-1)×1 复列向量，交给下一块。
 *
 * Arguments    : const creal_T x[1024]
 *                const double h[57]
 *                const creal_T zi[56]
 *                creal_T y[1024]
 *                creal_T zf[56]
 * Return Type  : void
 */
void cuav_rx_fir(const creal_T x[1024], const double h[57],
                 const creal_T zi[56], creal_T y[1024], creal_T zf[56])
{
  filter(h, x, zi, y, zf);
}

/*
 * File trailer for cuav_rx_fir.c
 *
 * [EOF]
 */
