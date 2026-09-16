/*
 * Academic License - for use in teaching, academic research, and meeting
 * course requirements at degree granting institutions only.  Not for
 * government, commercial, or other organizational use.
 * File: ifft.c
 *
 * MATLAB Coder version            : 25.1
 */

/* Include Files */
#include "ifft.h"

/* Function Definitions */
/*
 * Arguments    : const creal_T x[4]
 *                creal_T y[4]
 * Return Type  : void
 */
void b_ifft(const creal_T x[4], creal_T y[4])
{
  int ju;
  int n;
  bool tst;
  ju = 0;
  y[0] = x[0];
  n = 4;
  tst = true;
  while (tst) {
    n >>= 1;
    ju ^= n;
    tst = ((ju & n) == 0);
  }
  y[ju] = x[1];
  n = 4;
  tst = true;
  while (tst) {
    n >>= 1;
    ju ^= n;
    tst = ((ju & n) == 0);
  }
  y[ju] = x[2];
  n = 4;
  tst = true;
  while (tst) {
    n >>= 1;
    ju ^= n;
    tst = ((ju & n) == 0);
  }
  double d;
  double re;
  double temp_im;
  double temp_re;
  y[ju] = x[3];
  temp_re = y[1].re;
  temp_im = y[1].im;
  y[1].re = y[0].re - y[1].re;
  y[1].im = y[0].im - y[1].im;
  y[0].re += temp_re;
  y[0].im += temp_im;
  temp_im = y[3].im;
  d = y[2].re - y[3].re;
  y[3].im = y[2].im - y[3].im;
  re = y[2].re + y[3].re;
  temp_re = y[2].im + temp_im;
  y[2].re = y[0].re - re;
  y[2].im = y[0].im - temp_re;
  y[0].re += re;
  y[0].im += temp_re;
  temp_re = 0.0 - y[3].im;
  y[3].re = y[1].re - (0.0 - y[3].im);
  y[3].im = y[1].im - d;
  y[1].re += temp_re;
  y[1].im += d;
  y[0].re *= 0.25;
  y[0].im *= 0.25;
  y[1].re *= 0.25;
  y[1].im *= 0.25;
  y[2].re *= 0.25;
  y[2].im *= 0.25;
  y[3].re *= 0.25;
  y[3].im *= 0.25;
}

/*
 * Arguments    : const creal_T x[8]
 *                creal_T y[8]
 * Return Type  : void
 */
void c_ifft(const creal_T x[8], creal_T y[8])
{
  static const double dv[5] = {1.0, 0.70710678118654757, 0.0,
                               -0.70710678118654757, -1.0};
  static const double dv1[5] = {0.0, 0.70710678118654757, 1.0,
                                0.70710678118654757, 0.0};
  double temp_im;
  double temp_re;
  int b_i;
  int i;
  int iDelta;
  int iDelta2;
  int iheight;
  int iy;
  int ju;
  int k;
  iy = 0;
  ju = 0;
  for (i = 0; i < 7; i++) {
    bool tst;
    y[iy] = x[i];
    iy = 8;
    tst = true;
    while (tst) {
      iy >>= 1;
      ju ^= iy;
      tst = ((ju & iy) == 0);
    }
    iy = ju;
  }
  y[iy] = x[7];
  temp_re = y[1].re;
  temp_im = y[1].im;
  y[1].re = y[0].re - y[1].re;
  y[1].im = y[0].im - y[1].im;
  y[0].re += temp_re;
  y[0].im += temp_im;
  temp_re = y[3].re;
  temp_im = y[3].im;
  y[3].re = y[2].re - y[3].re;
  y[3].im = y[2].im - y[3].im;
  y[2].re += temp_re;
  y[2].im += temp_im;
  temp_re = y[5].re;
  temp_im = y[5].im;
  y[5].re = y[4].re - y[5].re;
  y[5].im = y[4].im - y[5].im;
  y[4].re += temp_re;
  y[4].im += temp_im;
  temp_re = y[7].re;
  temp_im = y[7].im;
  y[7].re = y[6].re - y[7].re;
  y[7].im = y[6].im - y[7].im;
  y[6].re += temp_re;
  y[6].im += temp_im;
  iDelta = 2;
  iDelta2 = 4;
  k = 2;
  iheight = 5;
  while (k > 0) {
    for (b_i = 0; b_i < iheight; b_i += iDelta2) {
      iy = b_i + iDelta;
      temp_re = y[iy].re;
      temp_im = y[iy].im;
      y[iy].re = y[b_i].re - temp_re;
      y[iy].im = y[b_i].im - temp_im;
      y[b_i].re += temp_re;
      y[b_i].im += temp_im;
    }
    iy = 1;
    for (ju = k; ju < 4; ju += k) {
      double twid_im;
      double twid_re;
      int ihi;
      twid_re = dv[ju];
      twid_im = dv1[ju];
      b_i = iy;
      ihi = iy + iheight;
      while (b_i < ihi) {
        double b_temp_re_tmp;
        int temp_re_tmp;
        temp_re_tmp = b_i + iDelta;
        temp_im = y[temp_re_tmp].im;
        b_temp_re_tmp = y[temp_re_tmp].re;
        temp_re = twid_re * b_temp_re_tmp - twid_im * temp_im;
        temp_im = twid_re * temp_im + twid_im * b_temp_re_tmp;
        y[temp_re_tmp].re = y[b_i].re - temp_re;
        y[temp_re_tmp].im = y[b_i].im - temp_im;
        y[b_i].re += temp_re;
        y[b_i].im += temp_im;
        b_i += iDelta2;
      }
      iy++;
    }
    k >>= 1;
    iDelta = iDelta2;
    iDelta2 += iDelta2;
    iheight -= iDelta;
  }
  for (i = 0; i < 8; i++) {
    y[i].re *= 0.125;
    y[i].im *= 0.125;
  }
}

/*
 * Arguments    : const creal_T x[16]
 *                creal_T y[16]
 * Return Type  : void
 */
void d_ifft(const creal_T x[16], creal_T y[16])
{
  static const double dv[9] = {
      1.0, 0.92387953251128674,  0.70710678118654757,  0.38268343236508978,
      0.0, -0.38268343236508978, -0.70710678118654757, -0.92387953251128674,
      -1.0};
  static const double dv1[9] = {
      0.0, 0.38268343236508978, 0.70710678118654757, 0.92387953251128674,
      1.0, 0.92387953251128674, 0.70710678118654757, 0.38268343236508978,
      0.0};
  double re;
  double temp_im;
  double temp_re;
  double temp_re_tmp;
  double twid_re;
  int b_i;
  int i;
  int iDelta;
  int iDelta2;
  int iheight;
  int iy;
  int ju;
  int k;
  iy = 0;
  ju = 0;
  for (i = 0; i < 15; i++) {
    bool tst;
    y[iy] = x[i];
    iy = 16;
    tst = true;
    while (tst) {
      iy >>= 1;
      ju ^= iy;
      tst = ((ju & iy) == 0);
    }
    iy = ju;
  }
  y[iy] = x[15];
  for (i = 0; i <= 14; i += 2) {
    temp_re = y[i + 1].re;
    temp_re_tmp = y[i + 1].im;
    temp_im = temp_re_tmp;
    re = y[i].re;
    twid_re = y[i].im;
    y[i + 1].re = re - temp_re;
    temp_re_tmp = twid_re - temp_re_tmp;
    y[i + 1].im = temp_re_tmp;
    re += temp_re;
    y[i].re = re;
    y[i].im = twid_re + temp_im;
  }
  iDelta = 2;
  iDelta2 = 4;
  k = 4;
  iheight = 13;
  while (k > 0) {
    for (b_i = 0; b_i < iheight; b_i += iDelta2) {
      iy = b_i + iDelta;
      temp_re = y[iy].re;
      temp_im = y[iy].im;
      y[iy].re = y[b_i].re - temp_re;
      y[iy].im = y[b_i].im - temp_im;
      y[b_i].re += temp_re;
      y[b_i].im += temp_im;
    }
    iy = 1;
    for (ju = k; ju < 8; ju += k) {
      double twid_im;
      int ihi;
      twid_re = dv[ju];
      twid_im = dv1[ju];
      b_i = iy;
      ihi = iy + iheight;
      while (b_i < ihi) {
        int b_temp_re_tmp;
        b_temp_re_tmp = b_i + iDelta;
        temp_re_tmp = y[b_temp_re_tmp].im;
        re = y[b_temp_re_tmp].re;
        temp_re = twid_re * re - twid_im * temp_re_tmp;
        temp_im = twid_re * temp_re_tmp + twid_im * re;
        y[b_temp_re_tmp].re = y[b_i].re - temp_re;
        y[b_temp_re_tmp].im = y[b_i].im - temp_im;
        y[b_i].re += temp_re;
        y[b_i].im += temp_im;
        b_i += iDelta2;
      }
      iy++;
    }
    k >>= 1;
    iDelta = iDelta2;
    iDelta2 += iDelta2;
    iheight -= iDelta;
  }
  for (i = 0; i < 16; i++) {
    y[i].re *= 0.0625;
    y[i].im *= 0.0625;
  }
}

/*
 * Arguments    : const creal_T x[32]
 *                creal_T y[32]
 * Return Type  : void
 */
void e_ifft(const creal_T x[32], creal_T y[32])
{
  static const double dv[17] = {1.0,
                                0.98078528040323043,
                                0.92387953251128674,
                                0.83146961230254524,
                                0.70710678118654757,
                                0.55557023301960218,
                                0.38268343236508978,
                                0.19509032201612825,
                                0.0,
                                -0.19509032201612825,
                                -0.38268343236508978,
                                -0.55557023301960218,
                                -0.70710678118654757,
                                -0.83146961230254524,
                                -0.92387953251128674,
                                -0.98078528040323043,
                                -1.0};
  static const double dv1[17] = {0.0,
                                 0.19509032201612825,
                                 0.38268343236508978,
                                 0.55557023301960218,
                                 0.70710678118654757,
                                 0.83146961230254524,
                                 0.92387953251128674,
                                 0.98078528040323043,
                                 1.0,
                                 0.98078528040323043,
                                 0.92387953251128674,
                                 0.83146961230254524,
                                 0.70710678118654757,
                                 0.55557023301960218,
                                 0.38268343236508978,
                                 0.19509032201612825,
                                 0.0};
  double re;
  double temp_im;
  double temp_re;
  double temp_re_tmp;
  double twid_re;
  int b_i;
  int i;
  int iDelta;
  int iDelta2;
  int iheight;
  int iy;
  int ju;
  int k;
  iy = 0;
  ju = 0;
  for (i = 0; i < 31; i++) {
    bool tst;
    y[iy] = x[i];
    iy = 32;
    tst = true;
    while (tst) {
      iy >>= 1;
      ju ^= iy;
      tst = ((ju & iy) == 0);
    }
    iy = ju;
  }
  y[iy] = x[31];
  for (i = 0; i <= 30; i += 2) {
    temp_re = y[i + 1].re;
    temp_re_tmp = y[i + 1].im;
    temp_im = temp_re_tmp;
    re = y[i].re;
    twid_re = y[i].im;
    y[i + 1].re = re - temp_re;
    temp_re_tmp = twid_re - temp_re_tmp;
    y[i + 1].im = temp_re_tmp;
    re += temp_re;
    y[i].re = re;
    y[i].im = twid_re + temp_im;
  }
  iDelta = 2;
  iDelta2 = 4;
  k = 8;
  iheight = 29;
  while (k > 0) {
    for (b_i = 0; b_i < iheight; b_i += iDelta2) {
      iy = b_i + iDelta;
      temp_re = y[iy].re;
      temp_im = y[iy].im;
      y[iy].re = y[b_i].re - temp_re;
      y[iy].im = y[b_i].im - temp_im;
      y[b_i].re += temp_re;
      y[b_i].im += temp_im;
    }
    iy = 1;
    for (ju = k; ju < 16; ju += k) {
      double twid_im;
      int ihi;
      twid_re = dv[ju];
      twid_im = dv1[ju];
      b_i = iy;
      ihi = iy + iheight;
      while (b_i < ihi) {
        int b_temp_re_tmp;
        b_temp_re_tmp = b_i + iDelta;
        temp_re_tmp = y[b_temp_re_tmp].im;
        re = y[b_temp_re_tmp].re;
        temp_re = twid_re * re - twid_im * temp_re_tmp;
        temp_im = twid_re * temp_re_tmp + twid_im * re;
        y[b_temp_re_tmp].re = y[b_i].re - temp_re;
        y[b_temp_re_tmp].im = y[b_i].im - temp_im;
        y[b_i].re += temp_re;
        y[b_i].im += temp_im;
        b_i += iDelta2;
      }
      iy++;
    }
    k >>= 1;
    iDelta = iDelta2;
    iDelta2 += iDelta2;
    iheight -= iDelta;
  }
  for (i = 0; i < 32; i++) {
    y[i].re *= 0.03125;
    y[i].im *= 0.03125;
  }
}

/*
 * Arguments    : const creal_T x[64]
 *                creal_T y[64]
 * Return Type  : void
 */
void f_ifft(const creal_T x[64], creal_T y[64])
{
  static const double dv[33] = {1.0,
                                0.99518472667219693,
                                0.98078528040323043,
                                0.95694033573220882,
                                0.92387953251128674,
                                0.881921264348355,
                                0.83146961230254524,
                                0.773010453362737,
                                0.70710678118654757,
                                0.63439328416364549,
                                0.55557023301960218,
                                0.47139673682599764,
                                0.38268343236508978,
                                0.29028467725446233,
                                0.19509032201612825,
                                0.0980171403295606,
                                0.0,
                                -0.0980171403295606,
                                -0.19509032201612825,
                                -0.29028467725446233,
                                -0.38268343236508978,
                                -0.47139673682599764,
                                -0.55557023301960218,
                                -0.63439328416364549,
                                -0.70710678118654757,
                                -0.773010453362737,
                                -0.83146961230254524,
                                -0.881921264348355,
                                -0.92387953251128674,
                                -0.95694033573220882,
                                -0.98078528040323043,
                                -0.99518472667219693,
                                -1.0};
  static const double dv1[33] = {0.0,
                                 0.0980171403295606,
                                 0.19509032201612825,
                                 0.29028467725446233,
                                 0.38268343236508978,
                                 0.47139673682599764,
                                 0.55557023301960218,
                                 0.63439328416364549,
                                 0.70710678118654757,
                                 0.773010453362737,
                                 0.83146961230254524,
                                 0.881921264348355,
                                 0.92387953251128674,
                                 0.95694033573220882,
                                 0.98078528040323043,
                                 0.99518472667219693,
                                 1.0,
                                 0.99518472667219693,
                                 0.98078528040323043,
                                 0.95694033573220882,
                                 0.92387953251128674,
                                 0.881921264348355,
                                 0.83146961230254524,
                                 0.773010453362737,
                                 0.70710678118654757,
                                 0.63439328416364549,
                                 0.55557023301960218,
                                 0.47139673682599764,
                                 0.38268343236508978,
                                 0.29028467725446233,
                                 0.19509032201612825,
                                 0.0980171403295606,
                                 0.0};
  double re;
  double temp_im;
  double temp_re;
  double temp_re_tmp;
  double twid_re;
  int b_i;
  int i;
  int iDelta;
  int iDelta2;
  int iheight;
  int iy;
  int ju;
  int k;
  iy = 0;
  ju = 0;
  for (i = 0; i < 63; i++) {
    bool tst;
    y[iy] = x[i];
    iy = 64;
    tst = true;
    while (tst) {
      iy >>= 1;
      ju ^= iy;
      tst = ((ju & iy) == 0);
    }
    iy = ju;
  }
  y[iy] = x[63];
  for (i = 0; i <= 62; i += 2) {
    temp_re = y[i + 1].re;
    temp_re_tmp = y[i + 1].im;
    temp_im = temp_re_tmp;
    re = y[i].re;
    twid_re = y[i].im;
    y[i + 1].re = re - temp_re;
    temp_re_tmp = twid_re - temp_re_tmp;
    y[i + 1].im = temp_re_tmp;
    re += temp_re;
    y[i].re = re;
    y[i].im = twid_re + temp_im;
  }
  iDelta = 2;
  iDelta2 = 4;
  k = 16;
  iheight = 61;
  while (k > 0) {
    for (b_i = 0; b_i < iheight; b_i += iDelta2) {
      iy = b_i + iDelta;
      temp_re = y[iy].re;
      temp_im = y[iy].im;
      y[iy].re = y[b_i].re - temp_re;
      y[iy].im = y[b_i].im - temp_im;
      y[b_i].re += temp_re;
      y[b_i].im += temp_im;
    }
    iy = 1;
    for (ju = k; ju < 32; ju += k) {
      double twid_im;
      int ihi;
      twid_re = dv[ju];
      twid_im = dv1[ju];
      b_i = iy;
      ihi = iy + iheight;
      while (b_i < ihi) {
        int b_temp_re_tmp;
        b_temp_re_tmp = b_i + iDelta;
        temp_re_tmp = y[b_temp_re_tmp].im;
        re = y[b_temp_re_tmp].re;
        temp_re = twid_re * re - twid_im * temp_re_tmp;
        temp_im = twid_re * temp_re_tmp + twid_im * re;
        y[b_temp_re_tmp].re = y[b_i].re - temp_re;
        y[b_temp_re_tmp].im = y[b_i].im - temp_im;
        y[b_i].re += temp_re;
        y[b_i].im += temp_im;
        b_i += iDelta2;
      }
      iy++;
    }
    k >>= 1;
    iDelta = iDelta2;
    iDelta2 += iDelta2;
    iheight -= iDelta;
  }
  for (i = 0; i < 64; i++) {
    y[i].re *= 0.015625;
    y[i].im *= 0.015625;
  }
}

/*
 * Arguments    : const creal_T x[2]
 *                creal_T y[2]
 * Return Type  : void
 */
void ifft(const creal_T x[2], creal_T y[2])
{
  y[1].re = x[0].re - x[1].re;
  y[1].im = x[0].im - x[1].im;
  y[0].re = x[0].re + x[1].re;
  y[0].im = x[0].im + x[1].im;
  y[0].re *= 0.5;
  y[0].im *= 0.5;
  y[1].re *= 0.5;
  y[1].im *= 0.5;
}

/*
 * File trailer for ifft.c
 *
 * [EOF]
 */
