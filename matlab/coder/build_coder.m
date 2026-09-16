function build_coder(repo)
%BUILD_CODER  用 MATLAB Coder 生成信道化与接收滤波的 C 算法核（06 §9D M-3；08 §13）。
%
%   用法：随 matlab/run_all.m 走，或 build_coder('<仓库根>')。
%   路径一律从本文件位置推导（铁律 17）；不接受任何机器相关的写死路径。
%
%   产物落点、配置理由、入库清单与两处用法陷阱都记在 matlab/coder/README.md。
%   接口尺寸**从冻结的系数表里读**，不在这里写死：表改了尺寸跟着改，不会悄悄对不上。
here = fileparts(mfilename('fullpath'));
if nargin < 1 || isempty(repo)
    repo = fileparts(fileparts(here));
end
addpath(fullfile(repo, 'matlab', 'ref'));

staging = fullfile(here, '_staging');
if exist(staging, 'dir'), rmdir(staging, 's'); end
mkdir(staging);

% ---- 接口尺寸从真理源来 ---------------------------------------------------
pfb = jsondecode(fileread(fullfile(repo, 'models', 'channelizer', 'fir_pfb_v1.json')));
rx  = jsondecode(fileread(fullfile(repo, 'models', 'receiver',    'fir_rx_v1.json')));
chans = arrayfun(@(e) double(e.channels), pfb.entries);
pads  = arrayfun(@(e) double(e.pad_to),   pfb.entries);
rxN   = max(arrayfun(@(e) double(e.ntaps), rx.entries));   % 各档零填充到同一个长度
RX_BLOCK = 1024;                                           % 接收滤波每次喂的样点数

cfg = local_cfg(here);

% ---- 信道化：每个 M 一个入口（reshape 的行数与 ifft 的长度都要 codegen 常量）----
args = {}; names = {};
for i = 1:numel(chans)
    m = chans(i); p = pads(i);
    names{end+1} = sprintf('cuav_pfb_m%d', m); %#ok<AGROW>
    args{end+1}  = { coder.typeof(complex(0), [p 1]), coder.typeof(0, [p 1]) }; %#ok<AGROW>
end
out_chan = fullfile(staging, 'channelizer');
local_codegen(cfg, names, args, out_chan);

% ---- 接收滤波：一个入口，定长块 -------------------------------------------
out_rx = fullfile(staging, 'receiver');
local_codegen(cfg, {'cuav_rx_fir'}, ...
    {{ coder.typeof(complex(0), [RX_BLOCK 1]), coder.typeof(0, [rxN 1]), ...
       coder.typeof(complex(0), [rxN-1 1]) }}, out_rx);

% ---- 分发到 models/<环节>/coder/，只搬该入库的那几类 -----------------------
n1 = local_install(out_chan, fullfile(repo, 'models', 'channelizer', 'coder'));
n2 = local_install(out_rx,   fullfile(repo, 'models', 'receiver',    'coder'));

% ---- 溯源：记下来源、版本与 codegen 参数，哈希由 Python 侧算（那边有 stdlib）----
prov = struct();
prov.schema = 'cuav-coder-provenance/1';
prov.generator = 'MATLAB_ROOT=<安装目录> sh matlab/run_matlab.sh（matlab/coder/build_coder.m）';
prov.matlab_version = version;
prov.coder_version = local_coder_version();
prov.entry_points = local_entries(chans, pads, rxN, RX_BLOCK);
% 共享实现也是源：六个 cuav_pfb_mN.m 都只是把 M 钉死，算法全在 cuav_pfb_cycle.m 里。
% 不记它，改了算法而没改任何入口文件时溯源哈希会纹丝不动。
prov.shared_m = struct('pfb', {{'matlab/ref/cuav_pfb_cycle.m'}}, 'rx', {{}});
prov.config = local_cfg_record(cfg);
prov.note = ['接口尺寸取自 models/channelizer/fir_pfb_v1.json 与 models/receiver/fir_rx_v1.json；' ...
             '各字段的 sha256 由 scripts/gen_coder_provenance.py 补齐并编进 engine/src/coder_provenance.cpp。'];
local_write_json(fullfile(repo, 'models', 'channelizer', 'coder', 'PROVENANCE.json'), ...
                 local_pick(prov, 'pfb'));
local_write_json(fullfile(repo, 'models', 'receiver', 'coder', 'PROVENANCE.json'), ...
                 local_pick(prov, 'rx'));

rmdir(staging, 's');
fprintf('Coder 产物：信道化 %d 个文件、接收滤波 %d 个文件\n', n1, n2);
fprintf('下一步：uv run --quiet python scripts/gen_coder_provenance.py\n');
end

% =========================================================================

function cfg = local_cfg(here)
cfg = coder.config('lib');
cfg.TargetLang = 'C';
cfg.GenCodeOnly = true;                 % 只出源码：交付环境与 CI 都不装 MATLAB
cfg.EnableDynamicMemoryAllocation = false;   % R2025a 的名字；DynamicMemoryAllocation 是旧名
cfg.EnableVariableSizing = false;       % 接口全定长，无 emxArray（08 §13 第 3 条）
cfg.EnableOpenMP = false;               % 确定性；静态库不该拖 OpenMP
cfg.InstructionSetExtensions = 'None';  % 不含 SSE/AVX intrinsic，三平台同源
cfg.UseBuiltinFFTWLibrary = false;      % 显式设：为真会去链 FFTW，为假则自带基 2 实现
cfg.SupportNonFinite = false;           % 省掉四个 rt_nonfinite 文件
cfg.GenerateExampleMain = 'DoNotGenerate';
cfg.FilePartitionMethod = 'MapMFileToCFile';  % 一文件一入口：SingleFile 会把六个 M 全塞进以第一个入口命名的那个 .c，名不副实
cfg.GenerateReport = false;
% 去掉文件头的生成时间戳，否则每次重生成都 diff（铁律 10）。要对象不要路径字符串。
cfg.CodeTemplate = coder.MATLABCodeTemplate(fullfile(here, 'cuav_banner.cgt'));
% 自定义硬件：缺省的 MATLAB Host Computer 会让 rtwtypes.h 去 include MATLAB 的 tmwtypes.h。
% long 取 32 使 int64_T 由 long long 定义，Windows LLP64 与 Linux/macOS LP64 上都是 64 位。
h = cfg.HardwareImplementation;
h.ProdHWDeviceType = 'Generic->Custom';
h.ProdBitPerChar = 8;  h.ProdBitPerShort = 16;  h.ProdBitPerInt = 32;
h.ProdBitPerLong = 32; h.ProdBitPerLongLong = 64;  h.ProdBitPerPointer = 64;
h.ProdLongLongMode = true;
h.ProdIntDivRoundTo = 'Zero';
h.ProdEndianess = 'LittleEndian';
end

function local_codegen(cfg, names, args, outdir)
% 多入口一次生成：共用一份 rtwtypes.h，函数名跟着各自的 .m 走，符号不撞。
% -d 必须走函数式：命令形式会把变量名当字面目录名。
a = {'-config', cfg};
for i = 1:numel(names)
    a = [a, {names{i}, '-args', args{i}}]; %#ok<AGROW>
end
a = [a, {'-d', outdir}];
codegen(a{:});
end

function n = local_install(src, dst)
if ~exist(dst, 'dir'), mkdir(dst); end
% 先清掉旧产物，免得改了入口清单之后留下没人引用的孤儿文件
old = [dir(fullfile(dst, '*.c')); dir(fullfile(dst, '*.h'))];
for i = 1:numel(old), delete(fullfile(dst, old(i).name)); end
n = 0;
f = [dir(fullfile(src, '*.c')); dir(fullfile(src, '*.h'))];
for i = 1:numel(f)
    copyfile(fullfile(src, f(i).name), fullfile(dst, f(i).name));
    n = n + 1;
end
end

function v = local_coder_version()
% ver('coder') 返回空；产品名是 'MATLAB Coder'
a = ver; k = find(strcmp({a.Name}, 'MATLAB Coder'), 1);
if isempty(k), v = 'unknown'; else, v = sprintf('%s %s', a(k).Version, a(k).Release); end
end

function e = local_entries(chans, pads, rxN, rxBlock)
e = struct('name', {}, 'source_m', {}, 'kind', {}, 'args', {});
for i = 1:numel(chans)
    e(end+1) = struct( ...
        'name', sprintf('cuav_pfb_m%d', chans(i)), ...
        'source_m', sprintf('matlab/ref/cuav_pfb_m%d.m', chans(i)), ...
        'kind', 'pfb', ...
        'args', sprintf('w: complex double [%d 1]; hr: double [%d 1]; M = %d (coder.Constant)', ...
                        pads(i), pads(i), chans(i))); %#ok<AGROW>
end
e(end+1) = struct('name', 'cuav_rx_fir', 'source_m', 'matlab/ref/cuav_rx_fir.m', 'kind', 'rx', ...
                  'args', sprintf('x: complex double [%d 1]; h: double [%d 1]; zi: complex double [%d 1]', ...
                                  rxBlock, rxN, rxN - 1));
end

function c = local_cfg_record(cfg)
keys = {'TargetLang','GenCodeOnly','EnableDynamicMemoryAllocation','EnableVariableSizing', ...
        'EnableOpenMP','InstructionSetExtensions','UseBuiltinFFTWLibrary','SupportNonFinite', ...
        'GenerateExampleMain','FilePartitionMethod'};
c = struct();
for i = 1:numel(keys)
    v = cfg.(keys{i});
    if islogical(v), v = char(string(v)); end
    c.(keys{i}) = v;
end
h = cfg.HardwareImplementation;
c.ProdHWDeviceType = h.ProdHWDeviceType;
c.ProdBits = sprintf('char %d short %d int %d long %d longlong %d pointer %d', ...
    h.ProdBitPerChar, h.ProdBitPerShort, h.ProdBitPerInt, ...
    h.ProdBitPerLong, h.ProdBitPerLongLong, h.ProdBitPerPointer);
c.CodeTemplate = 'matlab/coder/cuav_banner.cgt（默认模板去掉 %<SourceGeneratedOn>）';
end

function p = local_pick(prov, kind)
p = prov;
p.entry_points = prov.entry_points(strcmp({prov.entry_points.kind}, kind));
p.shared_m = prov.shared_m.(kind);
end

function local_write_json(path, s)
fid = fopen(path, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(s, 'PrettyPrint', true), 'char');
fwrite(fid, newline, 'char');
fclose(fid);
end
