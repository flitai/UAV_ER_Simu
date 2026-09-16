/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: cuav_rx_fir.h
 *
 * MATLAB Coder version            : 25.1
 */

#ifndef CUAV_RX_FIR_H
#define CUAV_RX_FIR_H

/* Include Files */
#include "rtwtypes.h"
#include <stddef.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Function Declarations */
extern void cuav_rx_fir(const creal_T x[1024], const double h[57],
                        const creal_T zi[56], creal_T y[1024], creal_T zf[56]);

#ifdef __cplusplus
}
#endif

#endif
/*
 * File trailer for cuav_rx_fir.h
 *
 * [EOF]
 */
