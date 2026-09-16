/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: sum.c
 *
 * MATLAB Coder version            : 25.1
 */

/* Include Files */
#include "sum.h"
#include <string.h>

/* Function Definitions */
/*
 * Arguments    : const creal_T x[116]
 *                creal_T y[4]
 * Return Type  : void
 */
void b_sum(const creal_T x[116], creal_T y[4])
{
  double d;
  double d1;
  double d2;
  double d3;
  double d4;
  double d5;
  double d6;
  double d7;
  int k;
  d = x[0].re;
  d1 = x[0].im;
  d2 = x[1].re;
  d3 = x[1].im;
  d4 = x[2].re;
  d5 = x[2].im;
  d6 = x[3].re;
  d7 = x[3].im;
  for (k = 0; k < 28; k++) {
    int xoffset;
    xoffset = (k + 1) << 2;
    d += x[xoffset].re;
    d1 += x[xoffset].im;
    d2 += x[xoffset + 1].re;
    d3 += x[xoffset + 1].im;
    d4 += x[xoffset + 2].re;
    d5 += x[xoffset + 2].im;
    d6 += x[xoffset + 3].re;
    d7 += x[xoffset + 3].im;
  }
  y[3].im = d7;
  y[3].re = d6;
  y[2].im = d5;
  y[2].re = d4;
  y[1].im = d3;
  y[1].re = d2;
  y[0].im = d1;
  y[0].re = d;
}

/*
 * Arguments    : const creal_T x[232]
 *                creal_T y[8]
 * Return Type  : void
 */
void c_sum(const creal_T x[232], creal_T y[8])
{
  int k;
  int xj;
  memcpy(&y[0], &x[0], 8U * sizeof(creal_T));
  for (k = 0; k < 28; k++) {
    int xoffset;
    xoffset = (k + 1) << 3;
    for (xj = 0; xj < 8; xj++) {
      int i;
      i = xoffset + xj;
      y[xj].re += x[i].re;
      y[xj].im += x[i].im;
    }
  }
}

/*
 * Arguments    : const creal_T x[464]
 *                creal_T y[16]
 * Return Type  : void
 */
void d_sum(const creal_T x[464], creal_T y[16])
{
  int k;
  int xj;
  memcpy(&y[0], &x[0], 16U * sizeof(creal_T));
  for (k = 0; k < 28; k++) {
    int xoffset;
    xoffset = (k + 1) << 4;
    for (xj = 0; xj < 16; xj++) {
      int i;
      i = xoffset + xj;
      y[xj].re += x[i].re;
      y[xj].im += x[i].im;
    }
  }
}

/*
 * Arguments    : const creal_T x[928]
 *                creal_T y[32]
 * Return Type  : void
 */
void e_sum(const creal_T x[928], creal_T y[32])
{
  int k;
  int xj;
  memcpy(&y[0], &x[0], 32U * sizeof(creal_T));
  for (k = 0; k < 28; k++) {
    int xoffset;
    xoffset = (k + 1) << 5;
    for (xj = 0; xj < 32; xj++) {
      int i;
      i = xoffset + xj;
      y[xj].re += x[i].re;
      y[xj].im += x[i].im;
    }
  }
}

/*
 * Arguments    : const creal_T x[1856]
 *                creal_T y[64]
 * Return Type  : void
 */
void f_sum(const creal_T x[1856], creal_T y[64])
{
  int k;
  int xj;
  memcpy(&y[0], &x[0], 64U * sizeof(creal_T));
  for (k = 0; k < 28; k++) {
    int xoffset;
    xoffset = (k + 1) << 6;
    for (xj = 0; xj < 64; xj++) {
      int i;
      i = xoffset + xj;
      y[xj].re += x[i].re;
      y[xj].im += x[i].im;
    }
  }
}

/*
 * Arguments    : const creal_T x[58]
 *                creal_T y[2]
 * Return Type  : void
 */
void sum(const creal_T x[58], creal_T y[2])
{
  double d;
  double d1;
  double d2;
  double d3;
  int k;
  d = x[0].re;
  d1 = x[0].im;
  d2 = x[1].re;
  d3 = x[1].im;
  for (k = 0; k < 28; k++) {
    int xoffset;
    xoffset = (k + 1) << 1;
    d += x[xoffset].re;
    d1 += x[xoffset].im;
    d2 += x[xoffset + 1].re;
    d3 += x[xoffset + 1].im;
  }
  y[1].im = d3;
  y[1].re = d2;
  y[0].im = d1;
  y[0].re = d;
}

/*
 * File trailer for sum.c
 *
 * [EOF]
 */
