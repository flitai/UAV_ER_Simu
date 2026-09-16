function run_all()
%RUN_ALL  MATLAB 内部工具链入口：Coder 生成（M-3）与全部黄金向量（M-4）。
%   路径一律从本文件位置推导（CLAUDE.md 铁律 17）。不进交付包。
here = fileparts(mfilename('fullpath'));
repo = fileparts(here);
addpath(fullfile(here, 'ref'));
addpath(fullfile(here, 'golden'));
addpath(fullfile(here, 'design'));
addpath(fullfile(here, 'coder'));
% M-3（D-071）：先生成 Coder 产物。去日期的文件头模板使重生成逐字节相同，
% 所以这一步每次都跑是安全的，还顺带证明产物没有漂（铁律 10）。
build_coder(repo);
gen_spectrum_golden(fullfile(repo, 'engine', 'tests', 'golden', 'spectrum_welch.json'));
% DDC 的抗混叠低通：冻结表由 scripts/design_ddc_fir.py 生产，这里只独立校验一遍（M-2，D-070）
check_ddc_fir(fullfile(repo, 'models', 'adc-ddc', 'fir_lp_v1.json'));
end
