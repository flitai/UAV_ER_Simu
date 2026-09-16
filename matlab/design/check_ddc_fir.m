function check_ddc_fir(tablePath)
%CHECK_DDC_FIR  用 Signal Toolbox 的 firpm 独立重设计一遍 DDC 的抗混叠低通，与冻结表比对。
%
%   这是**校验**，不是生产：冻结表由 scripts/design_ddc_fir.py（scipy.signal.remez，BSD）
%   设计并入库，本脚本只回答「换一家 Parks-McClellan 实现，结果对不对得上」。
%   之所以不让 MATLAB 当主设计：开发机的 MATLAB 是学术许可，其产物带
%   「不得用于政府 / 商业 / 组织用途」的条款，交付路径上不该有它（D-070 修订 D-036）。
%   缺 MATLAB 不影响构建与验收 —— scripts/build-all.sh 不调用本脚本。
%
%   两家都是等波纹设计，抽头数相同时系数应当吻合到 1e-9 量级；真正的验收判据是
%   指标本身（阻带 >= 60 dB、通带纹波、群时延为整数样点），系数逐位相同不是要求。
%
%   用法：check_ddc_fir('<仓库>/models/adc-ddc/fir_lp_v1.json')
%   依据：06 备忘录 §9D M-2；10 报告 §3.6；CLAUDE.md 铁律 10。
t = jsondecode(fileread(tablePath));
fprintf('冻结表 %s，版本 %s，%d 档\n', tablePath, t.version, numel(t.entries));

worstCoeff = 0;
for i = 1:numel(t.entries)
    e = t.entries(i);
    D = double(e.decim);
    n = double(e.ntaps);
    half = e.half(:);
    % 镜像展开，与 C++ ddc_fir_expand / Python expand 逐字同法
    h = zeros(n, 1);
    m = (n + 1) / 2;
    for k = 1:m
        h(k) = half(k);
        h(n + 1 - k) = half(k);
    end

    % 指标：阻带与通带纹波（这才是验收判据）
    if D == 1
        assert(n == 1 && abs(h(1) - 1) < 1e-15, 'D = 1 应当是 h = [1]');
        fprintf('  D = %3d  抽头 %5d  纯频移，无滤波\n', D, n);
        continue
    end
    fp = 0.4 / D;                      % 周/样点：0.4·fs_out / fs_in
    fst = 0.5 / D;
    H = freqz(h, 1, linspace(2*pi*fst, pi, 8192));
    att = -20*log10(max(abs(H)));
    Hp = abs(freqz(h, 1, linspace(0, 2*pi*fp, 4096)));
    rip = 20*log10(max(Hp)/min(Hp));
    assert(mod(n, 2) == 1, 'D = %d 的抽头数必须是奇数（群时延要整数样点）', D);
    assert(abs(sum(h) - 1) < 1e-12, 'D = %d 的通带增益没有归一', D);
    assert(att >= 60, 'D = %d 的阻带只有 %.2f dB', D, att);

    % 独立重设计：firpm 的频带用**归一化到奈奎斯特**的量程（0…1），是 2·周/样点
    hm = firpm(n - 1, [0 2*fp 2*fst 1], [1 1 0 0], [1 10]);
    hm = hm(:) / sum(hm);
    rel = max(abs(hm - h)) / max(abs(h));
    worstCoeff = max(worstCoeff, rel);
    fprintf('  D = %3d  抽头 %5d  阻带 %6.2f dB  纹波 %.4f dB  对 firpm 最大相对差 %.3e\n', ...
            D, n, att, rip, rel);
end
fprintf('全部档位指标达标；与 firpm 的最大系数相对差 %.3e\n', worstCoeff);
end
