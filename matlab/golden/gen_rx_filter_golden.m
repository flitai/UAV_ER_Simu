function gen_rx_filter_golden(repo)
%GEN_RX_FILTER_GOLDEN  接收滤波的 MATLAB 一方黄金向量（M-3，D-071）。
%
%   写出 engine/tests/golden/rx_filter.matlab.json —— 三方互证里的 MATLAB 一方，
%   另两方是 algos/reference/rx_filter.py（rx_filter.json）与 Coder 产物
%   models/receiver/coder/（引擎单测里直接调）。
%
%   与 gen_channelizer_golden 同口径：**只做算法核尺度**（double 进 double 出，判据 1e-9），
%   组件尺度那一层由 Python 一方兜住（complex64 存不下 1e-9，见 rx_filter.json 的 tolerance.note）；
%   输入块与抽头直接取 rx_filter.json 的 kernel_check —— 那里是显式数据，三方共享比特不共享公式。
%
%   顺带把**状态交接**也钉住：filter 的末态 zf 就是卷积结果落在本块之后的那一截
%   （zf(j) = conv(x,h)(L+j)），封装层的分块无关性靠它。两条路在这里当场互证。
%
%   用法：gen_rx_filter_golden('<仓库根>')；随 matlab/run_all.m 一起跑。
%   依据：04 §15.2 算例 5（接收滤波和群时延）；06 备忘录 §9D；08 报告 §8 口径二、§13。
goldenDir = fullfile(repo, 'engine', 'tests', 'golden');
inPath = fullfile(goldenDir, 'rx_filter.json');
if ~isfile(inPath)
    error('cuav:golden:missing', ['缺 %s：先跑 uv run --quiet --with numpy python ' ...
        'algos/reference/gen_engine_golden.py --mode rx_filter -o %s'], inPath, inPath);
end
g = jsondecode(fileread(inPath));
kc = local_list(g.kernel_check);

blocks = cell(1, numel(kc));
worstConv = 0;
worstZf = 0;
worstPython = 0;
for i = 1:numel(kc)
    e = kc{i};
    L = double(e.block);
    N = double(e.ntaps_padded);
    h = double(e.taps_padded(:));
    x = double(e.input_block(:, 1)) + 1j * double(e.input_block(:, 2));
    if numel(h) ~= N || numel(x) ~= L
        error('cuav:golden:shape', '第 %d 条核对块的长度与声明对不上', i);
    end

    zi = complex(zeros(N - 1, 1));          % 第一块，零初态
    [y, zf] = cuav_rx_fir(x, h, zi);        % 走 codegen 用的同一份入口

    % 独立第二路：整段卷积。前 L 个就是因果输出，之后那一截就是末态 zf。
    full = conv(x, h);
    scale = max(abs(y));
    worstConv = max(worstConv, max(abs(y - full(1:L))) / scale);
    worstZf = max(worstZf, max(abs(zf - full(L+1:L+N-1))) / scale);

    exp_py = double(e.expected_causal(:, 1)) + 1j * double(e.expected_causal(:, 2));
    worstPython = max(worstPython, max(abs(y - exp_py)) / scale);

    blocks{i} = struct('bw_rel', double(e.bw_rel), 'ntaps', double(e.ntaps), ...
                       'ntaps_padded', N, 'group_delay_in', double(e.group_delay_in), ...
                       'block', L, 'expected_causal', [real(y), imag(y)], ...
                       'zf_tail', [real(zf), imag(zf)]);
end

tol = 1e-9;
if worstConv > tol
    error('cuav:golden:conv', 'filter 与整段卷积不一致，最大相对差 %.3e（判据 %.0e）', worstConv, tol);
end
if worstZf > tol
    error('cuav:golden:zf', '末态 zf 与卷积尾段不一致，最大相对差 %.3e（判据 %.0e）', worstZf, tol);
end
if worstPython > tol
    error('cuav:golden:python', ...
        'MATLAB 与 Python 参考不一致，最大相对差 %.3e（判据 %.0e）—— 这是发现，查根因，不许放宽判据', ...
        worstPython, tol);
end

srcs = {'matlab/ref/cuav_rx_fir.m'};

out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_rx_filter_golden.m';
out.scope = 'kernel';
out.for_input = 'rx_filter.json 的 kernel_check：输入块与抽头取自那里的显式数据，三方共享比特不共享公式';
out.matlab_version = version;
out.method = 'matlab/ref/cuav_rx_fir.m（codegen 用的同一份入口，内里是工具箱的 filter）；另用整段 conv 在 MATLAB 内互证，并核对末态 zf 等于卷积尾段';
out.entry_vs_conv_max_rel = worstConv;
out.zf_vs_conv_tail_max_rel = worstZf;
out.matlab_vs_python_max_rel = worstPython;
out.guards = struct();
out.guards.source_m_sha256 = local_hashes(repo, srcs);
out.guards.table_sha256 = cuav_sha256(fullfile(repo, 'models', 'receiver', 'fir_rx_v1.json'));
out.guards.note = ['改了来源 .m 或改了冻结表却没重跑 MATLAB，引擎单测据此当场红。' ...
                   'codegen 参数哈希不在这里 —— MATLAB 一方是照 .m 的语义算的，与生成的 C 无关；' ...
                   '那条线由 engine/tests/test_coder_provenance.cpp 守着。'];
out.kernel_check = blocks;
out.tolerance = struct('kernel_rel', tol, 'note', ...
    ['算法核尺度：double 进 double 出，判据是 06 §9D 的 1e-9。' ...
     '本件三方都是实数抽头的定点积，没有 FFT，实测差比信道化那件还小；' ...
     '仍不承诺逐位相同 —— jsonencode 的十进制位数有限，本文件的数值自带约 1e-16 的量化底。']);

outPath = fullfile(goldenDir, 'rx_filter.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf('写出 %s：%d 条核对块，入口对卷积 %.2e、末态 %.2e、对 Python 参考 %.2e（判据 %.0e）\n', ...
    outPath, numel(blocks), worstConv, worstZf, worstPython, tol);
end

function c = local_list(v)
if iscell(v)
    c = v;
elseif isstruct(v)
    c = num2cell(v);
else
    c = {v};
end
end

function h = local_hashes(repo, rels)
h = cell(1, numel(rels));
for i = 1:numel(rels)
    p = fullfile(repo, strrep(rels{i}, '/', filesep));
    h{i} = struct('path', rels{i}, 'sha256', cuav_sha256(p));
end
end
