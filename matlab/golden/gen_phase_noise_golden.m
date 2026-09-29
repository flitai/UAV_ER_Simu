function gen_phase_noise_golden(repo)
%GEN_PHASE_NOISE_GOLDEN  本振相位噪声的 MATLAB 一方（Q-4，D-091）。
%
%   写出 engine/tests/golden/phase_noise.matlab.json。三方互证里的 MATLAB 一方，
%   另两方是 algos/reference/phase_noise.py（phase_noise.json）与引擎 ReceiverFrontEnd。
%
%   **共享比特不共享公式**（M-3 的教训）：随机数发生器各家不同，这里不重新抽样，而是读
%   phase_noise.json 第一个算例里显式存下的驱动正态序列 w，用 MATLAB 自己写的离散化系数与
%   工具箱的 filter 复算 φ，再与 Python 参考的 φ 比。于是验的是「系数的闭式」与「递推的语义」
%   （含平稳起点）——正是引擎与参考可能写错的两处。
%
%   comm.PhaseNoise 不作第三方：它按掩模设计 FIR 滤白噪声，是另一种生成算法，只能比统计量，
%   比不出逐值（D-091）。
%
%   用法：gen_phase_noise_golden('<仓库根>')；随 matlab/run_all.m 一起跑。
goldenDir = fullfile(repo, 'engine', 'tests', 'golden');
inPath = fullfile(goldenDir, 'phase_noise.json');
if ~isfile(inPath)
    error('cuav:golden:missing', ['缺 %s：先跑 uv run --quiet --with numpy python ' ...
        'algos/reference/gen_engine_golden.py --mode phase_noise -o %s'], inPath, inPath);
end
g = jsondecode(fileread(inPath));
% 各算例字段不同（只有第一个带 drive），jsondecode 给的是元胞；字段相同时给结构体数组
if iscell(g.cases)
    c = g.cases{1};
else
    c = g.cases(1);
end
fs = double(c.fs_Hz);
fc = double(c.corner_Hz);
L0 = 10 ^ (double(c.level_dBc_Hz) / 10);

% 奥恩斯坦—乌伦贝克精确离散（与 ReceiverFrontEnd::phase_noise_coeffs 独立书写）
a = exp(-2 * pi * fc / fs);
sw = sqrt(pi * fc * L0 * (1 - a^2));
sp = sqrt(pi * fc * L0);

w = double(c.drive.w(:));
phiPy = double(c.drive.phi_head(:));
n = numel(phiPy);
if numel(w) ~= n + 1
    error('cuav:golden:shape', '驱动序列长度 %d 与 φ 头部长度 %d 对不上（应多一个平稳起点）', numel(w), n);
end
% φ[−1] = σφ·w(1)；φ[n] = a·φ[n−1] + σw·w(n+1)。filter 的初态 zi = a·φ[−1]（转置直接 II 型）
phi = filter(sw, [1, -a], w(2:end), a * sp * w(1));

tol = 1e-9;
relA = abs(a - double(c.a)) / abs(double(c.a));
relW = abs(sw - double(c.sigma_w)) / double(c.sigma_w);
relP = abs(sp - double(c.sigma_phi)) / double(c.sigma_phi);
worstPhi = max(abs(phi - phiPy)) / sp;
if max([relA, relW, relP]) > tol
    error('cuav:golden:coeff', '离散化系数与 Python 参考不一致：a %.2e / σw %.2e / σφ %.2e（判据 %.0e）', ...
        relA, relW, relP, tol);
end
if worstPhi > tol
    error('cuav:golden:python', ...
        'φ 与 Python 参考不一致，最大差 %.3e·σφ（判据 %.0e）—— 这是发现，查根因，不许放宽判据', worstPhi, tol);
end

out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_phase_noise_golden.m';
out.scope = 'kernel';
out.for_input = 'phase_noise.json 第一个算例的 drive：驱动正态取自那里的显式数据，三方共享比特不共享公式';
out.input_sha256 = cuav_sha256(inPath);
out.matlab_version = version;
out.method = '离散化系数独立书写；递推用工具箱 filter(σw, [1, −a], w, a·φ[−1])';
out.case = c.name;
out.a = a;
out.sigma_w = sw;
out.sigma_phi = sp;
out.coeff_max_rel = max([relA, relW, relP]);
out.matlab_vs_python_phi_max_over_sigma = worstPhi;
out.phi = phi;
out.tolerance = struct('kernel_rel', tol, 'note', ...
    '算法核尺度：double 进 double 出。jsonencode 的十进制位数有限，本文件的数值自带约 1e-16 的量化底。');

outPath = fullfile(goldenDir, 'phase_noise.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf('写出 %s：%d 个样点，系数最大相对差 %.2e，φ 对 Python %.2e·σφ（判据 %.0e）\n', ...
    outPath, n, out.coeff_max_rel, worstPhi, tol);
end
