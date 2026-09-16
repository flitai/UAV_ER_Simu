/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: flipud.h
 *
 * MATLAB Coder version            : 25.1
 */

#ifndef FLIPUD_H
#define FLIPUD_H

/* Include Files */
#include "rtwtypes.h"
#include <stddef.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Function Declarations */
void b_flipud(creal_T x[4]);

void c_flipud(creal_T x[8]);

void d_flipud(creal_T x[16]);

void e_flipud(creal_T x[32]);

void f_flipud(creal_T x[64]);

void flipud(creal_T x[2]);

#ifdef __cplusplus
}
#endif

#endif
/*
 * File trailer for flipud.h
 *
 * [EOF]
 */
