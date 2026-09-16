/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: flipud.c
 *
 * MATLAB Coder version            : 25.1
 */

/* Include Files */
#include "flipud.h"

/* Function Definitions */
/*
 * Arguments    : creal_T x[4]
 * Return Type  : void
 */
void b_flipud(creal_T x[4])
{
  double xtmp_im;
  double xtmp_re;
  xtmp_re = x[0].re;
  xtmp_im = x[0].im;
  x[0] = x[3];
  x[3].re = xtmp_re;
  x[3].im = xtmp_im;
  xtmp_re = x[1].re;
  xtmp_im = x[1].im;
  x[1] = x[2];
  x[2].re = xtmp_re;
  x[2].im = xtmp_im;
}

/*
 * Arguments    : creal_T x[8]
 * Return Type  : void
 */
void c_flipud(creal_T x[8])
{
  double xtmp_im;
  double xtmp_re;
  xtmp_re = x[0].re;
  xtmp_im = x[0].im;
  x[0] = x[7];
  x[7].re = xtmp_re;
  x[7].im = xtmp_im;
  xtmp_re = x[1].re;
  xtmp_im = x[1].im;
  x[1] = x[6];
  x[6].re = xtmp_re;
  x[6].im = xtmp_im;
  xtmp_re = x[2].re;
  xtmp_im = x[2].im;
  x[2] = x[5];
  x[5].re = xtmp_re;
  x[5].im = xtmp_im;
  xtmp_re = x[3].re;
  xtmp_im = x[3].im;
  x[3] = x[4];
  x[4].re = xtmp_re;
  x[4].im = xtmp_im;
}

/*
 * Arguments    : creal_T x[16]
 * Return Type  : void
 */
void d_flipud(creal_T x[16])
{
  int i;
  for (i = 0; i < 8; i++) {
    double xtmp_im;
    double xtmp_re;
    xtmp_re = x[i].re;
    xtmp_im = x[i].im;
    x[i] = x[15 - i];
    x[15 - i].re = xtmp_re;
    x[15 - i].im = xtmp_im;
  }
}

/*
 * Arguments    : creal_T x[32]
 * Return Type  : void
 */
void e_flipud(creal_T x[32])
{
  int i;
  for (i = 0; i < 16; i++) {
    double xtmp_im;
    double xtmp_re;
    xtmp_re = x[i].re;
    xtmp_im = x[i].im;
    x[i] = x[31 - i];
    x[31 - i].re = xtmp_re;
    x[31 - i].im = xtmp_im;
  }
}

/*
 * Arguments    : creal_T x[64]
 * Return Type  : void
 */
void f_flipud(creal_T x[64])
{
  int i;
  for (i = 0; i < 32; i++) {
    double xtmp_im;
    double xtmp_re;
    xtmp_re = x[i].re;
    xtmp_im = x[i].im;
    x[i] = x[63 - i];
    x[63 - i].re = xtmp_re;
    x[63 - i].im = xtmp_im;
  }
}

/*
 * Arguments    : creal_T x[2]
 * Return Type  : void
 */
void flipud(creal_T x[2])
{
  double xtmp_im;
  double xtmp_re;
  xtmp_re = x[0].re;
  xtmp_im = x[0].im;
  x[0] = x[1];
  x[1].re = xtmp_re;
  x[1].im = xtmp_im;
}

/*
 * File trailer for flipud.c
 *
 * [EOF]
 */
