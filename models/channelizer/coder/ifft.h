/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: ifft.h
 *
 * MATLAB Coder version            : 25.1
 */

#ifndef IFFT_H
#define IFFT_H

/* Include Files */
#include "rtwtypes.h"
#include <stddef.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Function Declarations */
void b_ifft(const creal_T x[4], creal_T y[4]);

void c_ifft(const creal_T x[8], creal_T y[8]);

void d_ifft(const creal_T x[16], creal_T y[16]);

void e_ifft(const creal_T x[32], creal_T y[32]);

void f_ifft(const creal_T x[64], creal_T y[64]);

void ifft(const creal_T x[2], creal_T y[2]);

#ifdef __cplusplus
}
#endif

#endif
/*
 * File trailer for ifft.h
 *
 * [EOF]
 */
