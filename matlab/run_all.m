function run_all()
%RUN_ALL  MATLAB 内部工具链入口：生成全部黄金向量（M-4），后续加 Coder 生成（M-2、M-3）。
%   路径一律从本文件位置推导（CLAUDE.md 铁律 17）。不进交付包。
here = fileparts(mfilename('fullpath'));
repo = fileparts(here);
addpath(fullfile(here, 'ref'));
addpath(fullfile(here, 'golden'));
gen_spectrum_golden(fullfile(repo, 'engine', 'tests', 'golden', 'spectrum_welch.json'));
end
