/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: sum.h
 *
 * MATLAB Coder version            : 25.1
 */

#ifndef SUM_H
#define SUM_H

/* Include Files */
#include "rtwtypes.h"
#include <stddef.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Function Declarations */
void b_sum(const creal_T x[116], creal_T y[4]);

void c_sum(const creal_T x[232], creal_T y[8]);

void d_sum(const creal_T x[464], creal_T y[16]);

void e_sum(const creal_T x[928], creal_T y[32]);

void f_sum(const creal_T x[1856], creal_T y[64]);

void sum(const creal_T x[58], creal_T y[2]);

#ifdef __cplusplus
}
#endif

#endif
/*
 * File trailer for sum.h
 *
 * [EOF]
 */
