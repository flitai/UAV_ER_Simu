#!/bin/sh
# 在命令行跑 matlab/run_all.m。MATLAB 的位置由环境变量 MATLAB_ROOT 给入（铁律 17；Windows 同法）：
#   MATLAB_ROOT=/path/to/MATLAB_R2025a.app sh matlab/run_matlab.sh
set -eu
: "${MATLAB_ROOT:?请设置 MATLAB_ROOT 为 MATLAB 安装目录（含 bin/matlab）}"
cd "$(dirname "$0")"
"$MATLAB_ROOT/bin/matlab" -batch "run_all"
