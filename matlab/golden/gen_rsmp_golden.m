function gen_rsmp_golden(repo)
%GEN_RSMP_GOLDEN  OFDM 有理重采样的 MATLAB 一方黄金向量（Q-2，D-088）。
%
%   写出 engine/tests/golden/rsmp.matlab.json —— 三方互证里的 MATLAB 一方，另两方是
%   algos/reference/resampler.py（直接型，rsmp.json）与 Coder 产物 models/radiator/coder/
%   （引擎单测里经封装直接调）。
%
%   **只做算法核尺度**（double 进 double 出，判据 1e-9）。窗口取 rsmp.json 的 kernel_check
%   （显式数据，三方共享比特不共享公式），两路在 MATLAB 内互证：
%     ① codegen 用的同一份入口 cuav_rsmp_mNN.m；
%     ② 信号处理工具箱 upfirdn：把窗口放回原生序号 c·M − T/2 处、前面补零，整段插 L 滤波，
%        取原型序号 m·M + gd（时间锚，08 报告 §8 口径二）。这一路与 ① 的下标走法完全不同。
%
%   用法：gen_rsmp_golden('<仓库根>')；随 matlab/run_all.m 一起跑。
goldenDir = fullfile(repo, 'engine', 'tests', 'golden');
inPath = fullfile(goldenDir, 'rsmp.json');
if ~isfile(inPath)
    error('cuav:golden:missing', ['缺 %s：先跑 uv run --quiet --with numpy python ' ...
        'algos/reference/gen_engine_golden.py --mode rsmp -o %s'], inPath, inPath);
end
g = jsondecode(fileread(inPath));
tab = jsondecode(fileread(fullfile(repo, 'models', 'radiator', 'fir_rsmp_v1.json')));
e = tab.entries(1);
L = double(e.interp_L);
T = double(e.taps_per_phase);
gd = double(e.group_delay_proto);
half = double(e.half(:));
h = [half; flipud(half(1:end-1))];
hpad = [h; zeros(L * (T + 1) - numel(h), 1)];

kc = local_list(g.kernel_check);
out_kc = cell(1, numel(kc));
worstUpfirdn = 0;
worstPython = 0;
for i = 1:numel(kc)
    k = kc{i};
    M = double(k.M);
    c = double(k.cycle);
    win = double(k.window(:, 1)) + 1j * double(k.window(:, 2));
    fn = str2func(sprintf('cuav_rsmp_m%d', M));
    y = fn(win, hpad);
    % ② upfirdn：窗口放回原生序号 ws 处（ws = c·M − T/2 ≥ 0），前面补零
    ws = double(k.window_start);
    x = [zeros(ws, 1); win];
    v = upfirdn(x, h, L, 1);                         % 插 L、滤波、不抽取；v(p+1) 是原型序号 p
    m = (L * c:L * c + L - 1)';
    y2 = v(m * M + gd + 1);
    scale = sqrt(mean(abs(y2).^2));
    worstUpfirdn = max(worstUpfirdn, max(abs(y - y2)) / scale);
    py = double(k.expected(:, 1)) + 1j * double(k.expected(:, 2));
    worstPython = max(worstPython, max(abs(y - py)) / scale);
    out_kc{i} = struct('M', M, 'cycle', c, 'expected', [real(y), imag(y)]);
end

tol = 1e-9;
if worstUpfirdn > tol
    error('cuav:golden:upfirdn', '入口与 upfirdn 不一致，最大相对差 %.3e（判据 %.0e）', worstUpfirdn, tol);
end
if worstPython > tol
    error('cuav:golden:python', ...
        'MATLAB 与 Python 参考不一致，最大相对差 %.3e（判据 %.0e）—— 这是发现，查根因，不许放宽判据', ...
        worstPython, tol);
end

srcs = {'matlab/ref/cuav_rsmp_cycle.m', 'matlab/ref/cuav_rsmp_m24.m', ...
        'matlab/ref/cuav_rsmp_m48.m', 'matlab/ref/cuav_rsmp_m96.m'};
out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_rsmp_golden.m';
out.scope = 'kernel';
out.for_input = 'rsmp.json 的 kernel_check：窗口取自那里的显式数据，三方共享比特不共享公式';
out.matlab_version = version;
out.method = 'codegen 用的同一份入口 cuav_rsmp_mNN.m；另用 upfirdn 整段插值滤波后按时间锚取样在 MATLAB 内互证';
out.entry_vs_upfirdn_max_rel = worstUpfirdn;
out.matlab_vs_python_max_rel = worstPython;
out.guards = struct();
out.guards.source_m_sha256 = local_hashes(repo, srcs);
out.guards.table_sha256 = cuav_sha256(fullfile(repo, 'models', 'radiator', 'fir_rsmp_v1.json'));
out.guards.note = '改了来源 .m 或冻结表却没重跑 MATLAB，引擎单测据此当场红。';
out.kernel_check = out_kc;
out.tolerance = struct('kernel_rel', tol, 'note', '算法核尺度：double 进 double 出，判据 1e-9；不承诺逐位相同。');

outPath = fullfile(goldenDir, 'rsmp.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf('写出 %s：%d 拍，入口对 upfirdn %.2e、对 Python 参考 %.2e（判据 %.0e）\n', ...
    outPath, numel(out_kc), worstUpfirdn, worstPython, tol);
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
