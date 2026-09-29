function gen_fading_golden(repo)
%GEN_FADING_GOLDEN  小尺度衰落生成核的 MATLAB 一方（Q-4，D-091）。
%
%   写出 engine/tests/golden/fading.matlab.json。三方互证里的 MATLAB 一方，另两方是
%   algos/reference/fading.py（fading.json）与引擎 engine/src/fading.cpp。
%
%   **共享比特不共享公式**：不重新抽随机数，读 fading.json 里显式存下的 θ、φ、θ0，
%   用 MATLAB 自己写的向量化求和复算抽头布局与散射复增益 D_d(Φ)，再与 Python 参考比。
%   验的是正弦和、时延谱与合并规则这三处语义。
%
%   comm.RicianChannel / comm.RayleighChannel 不作第三方：它们的正弦和取角规则（GMEDS）与随机数都不同，
%   只能比统计量，比不出逐值（D-091）。
%
%   用法：gen_fading_golden('<仓库根>')；随 matlab/run_all.m 一起跑。
goldenDir = fullfile(repo, 'engine', 'tests', 'golden');
inPath = fullfile(goldenDir, 'fading.json');
if ~isfile(inPath)
    error('cuav:golden:missing', ['缺 %s：先跑 uv run --quiet --with numpy python ' ...
        'algos/reference/gen_engine_golden.py --mode fading -o %s'], inPath, inPath);
end
g = jsondecode(fileread(inPath));
nTaps = 8;
nSin = 16;
theta = double(g.draws.theta(:));
phi = double(g.draws.phi);                       % nTaps × nSin
cosAlpha = cos(2 * pi * ((0:nSin-1) + theta) / nSin);   % 独立书写，不读 fading.json 的 cos_alpha

% 离散时延谱：τ_l = l·τ0/2、p_l ∝ exp(−τ_l/τ0)
l = (0:nTaps-1).';
p = exp(-0.5 * l) / sum(exp(-0.5 * l));
m = sum(p .* (0.5 * l));
ratio = sqrt(sum(p .* (0.5 * l).^2) - m^2);

spread = double(g.diffuse.delay_spread_ns) * 1e-9;
fs = double(g.diffuse.fs_Hz);
tau0 = spread / ratio;
dl = floor(0.5 * l * tau0 * fs + 0.5);
[delays, ~, grp] = unique(dl, 'stable');

Phis = double(g.diffuse.Phi(:));
vals = zeros(numel(Phis), numel(delays));
for j = 1:numel(Phis)
    gl = sum(exp(1j * (Phis(j) * cosAlpha + phi)), 2) / sqrt(nSin);    % 每个抽头一个
    vals(j, :) = accumarray(grp, sqrt(p) .* gl).';
end

want = double(g.diffuse.values);                % numel(Phis) × numel(delays) × 2
wantC = squeeze(want(:, :, 1)) + 1j * squeeze(want(:, :, 2));
worst = max(abs(vals(:) - wantC(:)));
relRatio = abs(ratio - double(g.rms_ratio)) / double(g.rms_ratio);
tol = 1e-9;
if relRatio > tol || worst > tol
    error('cuav:golden:python', ...
        'MATLAB 与 Python 参考不一致：均方根比 %.2e、散射复增益 %.2e（判据 %.0e）—— 这是发现，查根因', ...
        relRatio, worst, tol);
end

out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_fading_golden.m';
out.scope = 'kernel';
out.for_input = 'fading.json 的 draws：随机量取自那里的显式数据，三方共享比特不共享公式';
out.input_sha256 = cuav_sha256(inPath);
out.matlab_version = version;
out.method = 'cos α、时延谱、取整合并与正弦和全部独立书写（向量化 + accumarray）';
out.rms_ratio = ratio;
out.delays = delays;
out.Phi = Phis;
out.values_re = real(vals);
out.values_im = imag(vals);
out.matlab_vs_python_max_abs = worst;
out.tolerance = struct('kernel_abs', tol, 'note', '单位平均功率的量，按绝对差判');

outPath = fullfile(goldenDir, 'fading.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf('写出 %s：%d 个相位 × %d 个时延，对 Python 参考 %.2e（判据 %.0e）\n', ...
    outPath, numel(Phis), numel(delays), worst, tol);
end
