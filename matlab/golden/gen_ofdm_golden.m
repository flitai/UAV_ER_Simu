function gen_ofdm_golden(repo)
%GEN_OFDM_GOLDEN  原生采样率 OFDM 调制的 MATLAB 一方黄金向量（Q-2，D-088）。
%
%   写出 engine/tests/golden/ofdm.matlab.json —— 三方互证里的 MATLAB 一方，另两方是
%   algos/reference/ofdm_ref.py（numpy ifft，写 ofdm.json）与引擎 engine/src/ofdm.cpp。
%
%   子载波值取 ofdm.json 里的显式数据（三方共享比特不共享公式），这里用通信工具箱的
%   ofdmmod 调制：它的子载波按 fftshift 顺序（最负频率在前）、变换带 1/N，与本项目的
%   x[n] = g·Σ X_k·e^{+j2πkn/N} 只差常数 N·g（2026-09-29 实测，见 probe 记录于 D-088）。
%   另用一次普通 ifft 在 MATLAB 内互证。**只做算法核尺度**（double 进 double 出，判据 1e-9）。
%
%   用法：gen_ofdm_golden('<仓库根>')；随 matlab/run_all.m 一起跑。
%   依据：14 号报告 §2.4 的三方参考；06 备忘录 §9K Q-2。
goldenDir = fullfile(repo, 'engine', 'tests', 'golden');
inPath = fullfile(goldenDir, 'ofdm.json');
if ~isfile(inPath)
    error('cuav:golden:missing', ['缺 %s：先跑 uv run --quiet --with numpy python ' ...
        'algos/reference/gen_engine_golden.py --mode ofdm -o %s'], inPath, inPath);
end
g = jsondecode(fileread(inPath));
cases = local_list(g.cases);

outCases = cell(1, numel(cases));
worstIfft = 0;
worstPython = 0;
for ci = 1:numel(cases)
    c = cases{ci};
    N = double(c.fft_size);
    K = double(c.half_subcarriers);
    gain = double(c.gain);
    k = [-K:-1, 1:K];
    idx = N/2 + 1 + k;                              % fftshift 顺序里的 1 起下标
    nullIdx = setdiff(1:N, idx)';
    syms = local_list(c.symbols);
    outSyms = cell(1, numel(syms));
    for si = 1:numel(syms)
        s = syms{si};
        cp = double(s.cp);
        X = double(s.carriers(:, 1)) + 1j * double(s.carriers(:, 2));
        y = ofdmmod(X, N, cp, nullIdx) * (N * gain);
        % 独立第二路：普通 ifft，按 k mod N 放子载波
        bins = zeros(N, 1);
        bins(mod(k, N) + 1) = X;
        r = ifft(bins) * (N * gain);
        r = [r(end-cp+1:end); r];
        rms = sqrt(mean(abs(r).^2));
        worstIfft = max(worstIfft, max(abs(y - r)) / rms);
        py = double(s.samples(:, 1)) + 1j * double(s.samples(:, 2));
        worstPython = max(worstPython, max(abs(y - py)) / rms);
        outSyms{si} = struct('symbol', double(s.symbol), 'start', double(s.start), ...
                             'cp', cp, 'samples', [real(y), imag(y)]);
    end
    outCases{ci} = struct('preset', c.preset, 'variant', double(c.variant), ...
                          'seed', double(c.seed), 'symbols', {outSyms});
end

tol = 1e-9;
if worstIfft > tol
    error('cuav:golden:ifft', 'ofdmmod 与 ifft 不一致，最大相对差 %.3e（判据 %.0e）', worstIfft, tol);
end
if worstPython > tol
    error('cuav:golden:python', ...
        'MATLAB 与 Python 参考不一致，最大相对差 %.3e（判据 %.0e）—— 这是发现，查根因，不许放宽判据', ...
        worstPython, tol);
end

out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_ofdm_golden.m';
out.scope = 'kernel';
out.for_input = 'ofdm.json 的子载波值：显式数据，三方共享比特不共享公式';
out.matlab_version = version;
out.method = '通信工具箱 ofdmmod（fftshift 顺序、带 1/N），乘 N·g 对齐本项目口径；另用普通 ifft 在 MATLAB 内互证';
out.ofdmmod_vs_ifft_max_rel = worstIfft;
out.matlab_vs_python_max_rel = worstPython;
out.guards = struct();
out.guards.source_m_sha256 = {struct('path', 'matlab/golden/gen_ofdm_golden.m', ...
    'sha256', cuav_sha256(fullfile(repo, 'matlab', 'golden', 'gen_ofdm_golden.m')))};
out.guards.presets_sha256 = cuav_sha256(fullfile(repo, 'models', 'radiator', 'presets-v1.json'));
out.guards.note = '改了预设表或本脚本却没重跑 MATLAB，引擎单测据此当场红。';
out.cases = outCases;
out.tolerance = struct('kernel_rel', tol, 'note', ...
    ['算法核尺度：double 进 double 出，判据 1e-9。MATLAB 的 ifft 走 FFTW，与 numpy 的 pocketfft、' ...
     '引擎的基 2 实现蝶形次序各不相同，不承诺逐位相同。']);

outPath = fullfile(goldenDir, 'ofdm.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf('写出 %s：%d 个算例，ofdmmod 对 ifft %.2e、对 Python 参考 %.2e（判据 %.0e）\n', ...
    outPath, numel(outCases), worstIfft, worstPython, tol);
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
