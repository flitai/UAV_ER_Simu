/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: filter.c
 *
 * MATLAB Coder version            : 25.1
 */

/* Include Files */
#include "filter.h"
#include <string.h>

/* Function Definitions */
/*
 * Arguments    : const double b[57]
 *                const creal_T x[1024]
 *                const creal_T zi[56]
 *                creal_T y[1024]
 *                creal_T zf[56]
 * Return Type  : void
 */
void filter(const double b[57], const creal_T x[1024], const creal_T zi[56],
            creal_T y[1024], creal_T zf[56])
{
  double d;
  int j;
  int k;
  for (k = 0; k < 56; k++) {
    zf[k].re = 0.0;
    zf[k].im = 0.0;
    y[k] = zi[k];
  }
  memset(&y[56], 0, 968U * sizeof(creal_T));
  for (k = 0; k < 57; k++) {
    int b_k;
    b_k = k + 1;
    d = b[k];
    for (j = b_k; j < 1025; j++) {
      int i;
      i = (j - k) - 1;
      y[j - 1].re += d * x[i].re;
      y[j - 1].im += d * x[i].im;
    }
  }
  for (k = 0; k < 56; k++) {
    for (j = 0; j <= k; j++) {
      d = b[(j - k) + 56];
      zf[j].re += x[k + 968].re * d;
      zf[j].im += x[k + 968].im * d;
    }
  }
}

/*
 * File trailer for filter.c
 *
 * [EOF]
 */
