/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: filter.h
 *
 * MATLAB Coder version            : 25.1
 */

#ifndef FILTER_H
#define FILTER_H

/* Include Files */
#include "rtwtypes.h"
#include <stddef.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Function Declarations */
void filter(const double b[57], const creal_T x[1024], const creal_T zi[56],
            creal_T y[1024], creal_T zf[56]);

#ifdef __cplusplus
}
#endif

#endif
/*
 * File trailer for filter.h
 *
 * [EOF]
 */
