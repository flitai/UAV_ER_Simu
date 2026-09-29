function gen_gfsk_golden(repo)
%GEN_GFSK_GOLDEN  GFSK / 2-FSK 调制核的 MATLAB 一方黄金向量（Q-3，D-089）。
%
%   写出 engine/tests/golden/gfsk.matlab.json —— 三方互证里的 MATLAB 一方，另两方是
%   algos/reference/gfsk_ref.py（mpmath 不截断全和，写 gfsk.json）与引擎 engine/src/gfsk.cpp
%   （窗口裂项的闭式）。比特与时刻取 gfsk.json 里的显式数据（三方共享比特不共享公式）。
%
%   三件：
%   ① 闭式：基础 MATLAB 的 erf，全部符号直接求和（不截窗口、不裂项），与 Python 参考比，判据 1e-9 圈；
%   ② 2-FSK 对通信工具箱 comm.CPFSKModulator（矩形相位脉冲、整数每符号样点数），判据 1e-9 圈；
%   ③ GFSK 对 comm.CPMModulator（高斯频率脉冲、截断到 L 个符号）：两边差一个起点常数加一个只在
%      比特跃变附近出现的局部差（≤ 4.5e-5 圈），后者与采样密度、截断长度都无关，来源在工具箱内部、
%      未查明（规划时以为是离散化、会随采样加密下降，实测不是），所以**不作判据**；断言的是能证明
%      「同一个信号」的三件事：BT 扫描在 1.00 处最小、符号中心处差 < 1e-6 圈、残差与采样密度无关。
%
%   用法：gen_gfsk_golden('<仓库根>')；随 matlab/run_all.m 一起跑。可选，CI 与 build-all.sh 不调用。
%   依据：14 号报告 §3.2 的三方参考；06 备忘录 §9K Q-3。
goldenDir = fullfile(repo, 'engine', 'tests', 'golden');
inPath = fullfile(goldenDir, 'gfsk.json');
if ~isfile(inPath)
    error('cuav:golden:missing', ['缺 %s：先跑 uv run --quiet --with numpy --with mpmath python ' ...
        'algos/reference/gen_engine_golden.py --mode gfsk -o %s'], inPath, inPath);
end
g = jsondecode(fileread(inPath));
cases = local_list(g.cases);
tol = 1e-9;

% ---------------------------------------------------------------- ① 闭式
closed = cell(1, numel(cases));
worstPython = 0;
for ci = 1:numel(cases)
    c = cases{ci};
    a = 2 * (c.bits(:) == '1') - 1;
    tau = double(c.tau_s(:));
    psi = zeros(size(tau));
    for i = 1:numel(tau)
        psi(i) = local_phase(double(c.gaussian), double(c.bt), double(c.symbol_rate_Hz), ...
                             double(c.deviation_Hz), a, tau(i));
    end
    worstPython = max(worstPython, max(abs(psi - double(c.phase_cycles(:)))));
    closed{ci} = struct('name', c.name, 'phase_cycles', psi);
end
if worstPython > tol
    error('cuav:golden:python', ...
        'MATLAB 闭式与 Python 参考不一致，最大差 %.3e 圈（判据 %.0e）—— 这是发现，查根因，不许放宽判据', ...
        worstPython, tol);
end

% ---------------------------------------------------------------- ② 2-FSK 对 comm.CPFSKModulator
c = cases{2};
if double(c.gaussian) ~= 0
    error('cuav:golden:case', 'gfsk.json 第 2 个算例应是 2-FSK（futaba-sfhss）');
end
a = 2 * (c.bits(:) == '1') - 1;
R = double(c.symbol_rate_Hz);
fdev = double(c.deviation_Hz);
h = 2 * fdev / R;
sps = 16;
mod2 = comm.CPFSKModulator('ModulationOrder', 2, 'ModulationIndex', h, 'SamplesPerSymbol', sps, ...
                           'InitialPhaseOffset', 0);
y = mod2(a);
phCpfsk = unwrap(angle(y)) / (2 * pi);
n = (0:numel(y) - 1)';
ours = arrayfun(@(t) local_phase(0, 0, R, fdev, a, t), n / (sps * R));
worstCpfsk = max(abs(phCpfsk - ours));
if worstCpfsk > tol
    error('cuav:golden:cpfsk', ...
        'comm.CPFSKModulator 与闭式不一致，最大差 %.3e 圈（判据 %.0e）—— 查时间锚与符号映射', worstCpfsk, tol);
end

% ---------------------------------------------------------------- ③ GFSK 对 comm.CPMModulator
% 2026-09-29 实测：两边差一个常数（工具箱多算了一个符号的相位 h/2，是起点约定不同）加一个只出现在
% 比特跃变附近的局部差（≤ 4.5e-5 圈），后者与每符号样点数、脉冲截断长度 L 都无关——不是离散化误差，
% 来源在工具箱内部，没有查明。所以不拿它当判据，只断言三件能证明「同一个信号」的事：
%   (a) BT 在 0.99 / 1.00 / 1.01 三档里，1.00 的残差最小（同一个 BT 口径）；
%   (b) 符号中心处（频率脉冲已走平）去均值后的差 < 1e-6 圈（同一个 h、同一个符号映射、同一个时间锚）；
%   (c) 残差与每符号样点数无关（16 与 64 两档之差 < 1e-7 圈），记录跃变附近的最大差。
c = cases{1};
a = 2 * (c.bits(:) == '1') - 1;
R = double(c.symbol_rate_Hz);
fdev = double(c.deviation_Hz);
bt = double(c.bt);
h = 2 * fdev / R;
L = 3;                                   % 奇数：工具箱的脉冲中心比本项目晚 (L−1)/2 = 1 个符号
spsList = [16 64];
cpmEdge = zeros(size(spsList));
cpmCentre = zeros(size(spsList));
for si = 1:numel(spsList)
    [d, fr] = local_cpm_resid(a, R, fdev, bt, h, L, spsList(si), bt);
    cpmCentre(si) = max(abs(d(abs(fr - 0.5) < 0.05)));
    cpmEdge(si) = max(abs(d));
end
btScan = [0.99 1.00 1.01];
btStd = zeros(size(btScan));
for bi = 1:numel(btScan)
    d = local_cpm_resid(a, R, fdev, bt, h, L, 32, btScan(bi));
    btStd(bi) = std(d);
end
if ~(btStd(2) < btStd(1) && btStd(2) < btStd(3))
    error('cuav:golden:cpm_bt', 'comm.CPMModulator 的残差在 BT = 1 处不是最小：%s', mat2str(btStd, 3));
end
if any(cpmCentre > 1e-6)
    error('cuav:golden:cpm_centre', '符号中心处与工具箱差 %s 圈（线 1e-6）：查 h、符号映射与时间锚', mat2str(cpmCentre, 3));
end
if abs(cpmEdge(1) - cpmEdge(2)) > 1e-7
    error('cuav:golden:cpm_sps', '残差随每符号样点数变了（%s 圈）：先查离散化', mat2str(cpmEdge, 3));
end

% ---------------------------------------------------------------- 写出
out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_gfsk_golden.m';
out.scope = 'kernel';
out.for_input = 'gfsk.json 的比特与时刻：显式数据，三方共享比特不共享公式';
out.input_sha256 = cuav_sha256(inPath);
out.matlab_version = version;
out.method = ['① 基础 MATLAB erf 的闭式（全部符号直接求和、不截窗口不裂项）；' ...
              '② 2-FSK 对 comm.CPFSKModulator（每符号 16 个样点）；③ GFSK 对 comm.CPMModulator 的收敛'];
out.closed_form = closed;
out.matlab_vs_python_max_cycles = worstPython;
out.cpfsk = struct('case', 'futaba-sfhss', 'samples_per_symbol', 16, 'phase_cycles', phCpfsk, ...
                   'max_diff_cycles', worstCpfsk);
out.cpm = struct('case', 'frsky-d16v2-fcc', 'pulse_length', L, 'samples_per_symbol', spsList, ...
                 'max_diff_cycles', cpmEdge, 'centre_max_diff_cycles', cpmCentre, ...
                 'bt_scan', btScan, 'bt_scan_resid_std_cycles', btStd, 'note', ...
                 ['去掉常数（工具箱的起点约定多一个符号的 h/2）后，差只出现在比特跃变附近，' ...
                  '与每符号样点数、脉冲截断长度都无关，来源在工具箱内部、未查明；不作判据。' ...
                  '证明同一个信号的是：BT 扫描在 1.00 处残差最小、符号中心处差 < 1e-6 圈']);
out.guards = struct();
out.guards.source_m_sha256 = {struct('path', 'matlab/golden/gen_gfsk_golden.m', ...
    'sha256', cuav_sha256(fullfile(repo, 'matlab', 'golden', 'gen_gfsk_golden.m')))};
out.guards.presets_sha256 = cuav_sha256(fullfile(repo, 'models', 'radiator', 'gfsk-presets-v1.json'));
out.tolerance = struct('phase_cycles_abs', tol, 'note', ...
    '算法核尺度：double 进 double 出，判据 1e-9 圈。MATLAB、numpy、C++ 的 erf 各家实现，不承诺逐位相同。');

outPath = fullfile(goldenDir, 'gfsk.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf(['写出 %s：闭式对 Python %.2e 圈、2-FSK 对 CPFSKModulator %.2e 圈（判据 %.0e）；' ...
         'CPMModulator 跃变附近最大差 %s 圈、符号中心 %s 圈、BT 扫描残差 %s\n'], outPath, worstPython, ...
         worstCpfsk, tol, mat2str(cpmEdge, 3), mat2str(cpmCentre, 3), mat2str(btStd, 3));
end

function [d, fr] = local_cpm_resid(a, R, fdev, btTool, h, L, sps, btOurs)
% comm.CPMModulator 的相位减本项目闭式（按 btOurs），去掉均值；fr 是该样点在符号内的位置
m = comm.CPMModulator('ModulationOrder', 2, 'FrequencyPulse', 'Gaussian', ...
                      'BandwidthTimeProduct', btTool, 'PulseLength', L, ...
                      'ModulationIndex', h, 'SamplesPerSymbol', sps, 'InitialPhaseOffset', 0);
y = m([a; ones(L, 1)]);                  % 尾部补 L 个符号把最后一个真比特的脉冲推完（比较时截掉）
ph = unwrap(angle(y)) / (2 * pi);
n = (0:numel(y) - 1)';
t = n / (sps * R) - (L - 1) / 2 / R;
keep = t >= 8 / R & t <= (numel(a) - 8) / R;           % 两端各让开 8 个符号
tk = t(keep);
ours = arrayfun(@(tt) local_phase(1, btOurs, R, fdev, a, tt), tk);
d = ph(keep) - ours;
d = d - mean(d);
s = tk * R;
fr = s - floor(s);
end

function psi = local_phase(gaussian, bt, R, fdev, a, tau)
% 独立写的闭式：全部符号直接求 a_k·P(s − k)，不截窗口、不裂项（与 C++ 的写法刻意不同）
s = tau * R;
x = s - (0:numel(a) - 1)';
if gaussian
    sig = sqrt(log(2)) / (2 * pi * bt);
    I = @(u) u .* erf(u / (sqrt(2) * sig)) + sig * sqrt(2 / pi) * exp(-u .^ 2 / (2 * sig ^ 2));
    P = (I(x) - I(x - 1)) / 2 + 1 / 2;
else
    P = min(max(x, 0), 1);
end
psi = fdev / R * sum(a .* P);
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
