function gen_channelizer_golden(repo)
%GEN_CHANNELIZER_GOLDEN  多相 FFT 信道化的 MATLAB 一方黄金向量（M-3，D-071）。
%
%   写出 engine/tests/golden/channelizer.matlab.json —— 三方互证里的 MATLAB 一方，
%   另两方是 algos/reference/channelizer.py（channelizer.json）与 Coder 产物
%   models/channelizer/coder/（引擎单测里直接调）。
%
%   **只做算法核尺度**。判据 06 §9D 写的「rel ≤ 1e-9」只在 double 进 double 出的算法核上
%   成立：组件输出存 complex64，float32 的 eps 就是 1.2e-7，套 1e-9 套不上（见
%   channelizer.json 的 tolerance.note）。组件尺度那一层由 Python 一方兜住。
%
%   **输入不自己造**：窗口与抽头直接取 channelizer.json 的 kernel_check —— 那里是显式数据。
%   共享输入必须共享比特不能共享公式，这是 M-3 第 5 步踩实过的教训（三方各按同一个闭式
%   算输入，编译器把多项式收缩成 FMA，一个样点差一个 ulp，经滤波器的相消放大成 1.5e-9）。
%
%   用法：gen_channelizer_golden('<仓库根>')；随 matlab/run_all.m 一起跑。
%   依据：06 备忘录 §9D M-3 / M-4；08 报告 §13；CLAUDE.md 铁律 10。
goldenDir = fullfile(repo, 'engine', 'tests', 'golden');
inPath = fullfile(goldenDir, 'channelizer.json');
if ~isfile(inPath)
    error('cuav:golden:missing', ['缺 %s：先跑 uv run --quiet --with numpy python ' ...
        'algos/reference/gen_engine_golden.py --mode channelizer -o %s'], inPath, inPath);
end
g = jsondecode(fileread(inPath));
kc = local_list(g.kernel_check);

blocks = cell(1, numel(kc));
worstDirect = 0;
worstPython = 0;
for i = 1:numel(kc)
    e = kc{i};
    M = double(e.channels);
    P = double(e.pad_to);
    hr = double(e.taps_reversed(:));
    w = double(e.window_forward(:, 1)) + 1j * double(e.window_forward(:, 2));
    if numel(hr) ~= P || numel(w) ~= P
        error('cuav:golden:shape', '第 %d 条窗口的长度与 pad_to 对不上', i);
    end

    y = local_entry(w, hr, M);              % 走 codegen 用的同一份入口

    % 独立第二路：直接式 DFT 求和，不走 reshape 也不走 ifft。
    %   y_k = Σ_n h[n]·x[p−n]·exp(−j2πk(p−n)/M)，换成正序下标 j = P−n 后
    %   （p 与 P 都是 M 的整数倍，两处 exp 的整周期部分各自为 1）收成
    %   y_k = Σ_j hr(j)·w(j)·exp(−j2πk·j/M)。推导见 08 报告 §8 与 cuav_pfb_cycle.m 头注。
    v = hr .* w;
    jj = (1:P).';
    yd = zeros(M, 1);
    for k = 0:M-1
        yd(k + 1) = sum(v .* exp(-2j * pi * k * jj / M));
    end
    scale = max(abs(y));
    worstDirect = max(worstDirect, max(abs(y - yd)) / scale);

    % 与 Python 一方当场对一遍：对不上就不写文件（宁可没有黄金向量，不要一份错的）
    exp_py = double(e.expected_bins(:, 1)) + 1j * double(e.expected_bins(:, 2));
    worstPython = max(worstPython, max(abs(y - exp_py)) / scale);

    blocks{i} = struct('channels', M, 'm_out', double(e.m_out), 'p_in', double(e.p_in), ...
                       'pad_to', P, 'expected_bins', [real(y), imag(y)]);
end

tol = 1e-9;
if worstDirect > tol
    error('cuav:golden:direct', '入口与直接式不一致，最大相对差 %.3e（判据 %.0e）', worstDirect, tol);
end
if worstPython > tol
    error('cuav:golden:python', ...
        'MATLAB 与 Python 参考不一致，最大相对差 %.3e（判据 %.0e）—— 这是发现，查根因，不许放宽判据', ...
        worstPython, tol);
end

srcs = {'matlab/ref/cuav_pfb_cycle.m', 'matlab/ref/cuav_pfb_m2.m', 'matlab/ref/cuav_pfb_m4.m', ...
        'matlab/ref/cuav_pfb_m8.m', 'matlab/ref/cuav_pfb_m16.m', 'matlab/ref/cuav_pfb_m32.m', ...
        'matlab/ref/cuav_pfb_m64.m'};

out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_channelizer_golden.m';
out.scope = 'kernel';
out.for_input = 'channelizer.json 的 kernel_check：窗口与抽头取自那里的显式数据，三方共享比特不共享公式';
out.matlab_version = version;
out.method = ['matlab/ref/cuav_pfb_mN.m（codegen 用的同一份入口，算法在 cuav_pfb_cycle.m）；' ...
              '另用直接式 DFT 求和在 MATLAB 内互证'];
out.entry_vs_direct_max_rel = worstDirect;
out.matlab_vs_python_max_rel = worstPython;
out.guards = struct();
out.guards.source_m_sha256 = local_hashes(repo, srcs);
out.guards.table_sha256 = cuav_sha256(fullfile(repo, 'models', 'channelizer', 'fir_pfb_v1.json'));
out.guards.note = ['改了来源 .m 或改了冻结表却没重跑 MATLAB，引擎单测据此当场红。' ...
                   'codegen 参数哈希不在这里 —— MATLAB 一方是照 .m 的语义算的，与生成的 C 无关；' ...
                   '那条线由 engine/tests/test_coder_provenance.cpp 守着，接口尺寸变了' ...
                   '窗口长度当场对不上。'];
out.kernel_check = blocks;
out.tolerance = struct('kernel_rel', tol, 'note', ...
    ['算法核尺度：double 进 double 出，判据是 06 §9D 的 1e-9。' ...
     '**不承诺逐位相同**：MATLAB 的 fft 走 FFTW、Coder 生成的是自带的基 2 实现、' ...
     'numpy 走 pocketfft，三家的蝶形次序与旋转因子求值各不相同。' ...
     '另外 jsonencode 的十进制位数有限，本文件的数值本身还带约 1e-16 的量化底。']);

outPath = fullfile(goldenDir, 'channelizer.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf('写出 %s：%d 条窗口，入口对直接式 %.2e，对 Python 参考 %.2e（判据 %.0e）\n', ...
    outPath, numel(blocks), worstDirect, worstPython, tol);
end

function y = local_entry(w, hr, M)
%LOCAL_ENTRY  按子信道数分派到对应入口。每个 M 一个入口是 codegen 的要求
%   （reshape 的行数与 ifft 的长度必须是编译期常量），这里照同一张表走。
switch M
    case 2,  y = cuav_pfb_m2(w, hr);
    case 4,  y = cuav_pfb_m4(w, hr);
    case 8,  y = cuav_pfb_m8(w, hr);
    case 16, y = cuav_pfb_m16(w, hr);
    case 32, y = cuav_pfb_m32(w, hr);
    case 64, y = cuav_pfb_m64(w, hr);
    otherwise
        error('cuav:golden:channels', '没有 M = %d 的入口', M);
end
end

function c = local_list(v)
%LOCAL_LIST  jsondecode 对同构对象数组给结构体数组、异构的给元胞，这里统一成元胞。
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
