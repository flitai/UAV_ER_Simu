% 读取本数据集的一段 SigMF 文件，并画峰值保持时频图。只用 MATLAB 基础函数（jsondecode 需 R2016b 及以上）。
%
% 用法：
%   [x, meta] = read_sigmf('data/sv1-s02_s3');
%
% 样点是复 int16 交织、小端（ci16_le）：I0 Q0 I1 Q1 ……
% 换成物理量：x = 码 / 32768 * 10^(cuav:full_scale_dBm / 20)，abs(x).^2 的单位是 mW。
% 本方命名空间的键在 jsondecode 之后，冒号变成下划线：cuav:full_scale_dBm -> cuav_full_scale_dBm。

function [x, meta] = read_sigmf(stem)
    meta = jsondecode(fileread([stem '.sigmf-meta']));
    g = meta.global;
    if ~strcmp(g.core_datatype, 'ci16_le')
        error('本示例只读 ci16_le，文件是 %s', g.core_datatype);
    end
    fid = fopen([stem '.sigmf-data'], 'r', 'ieee-le');
    raw = fread(fid, Inf, 'int16=>double');
    fclose(fid);
    amp = 10 ^ (g.cuav_full_scale_dBm / 20);
    x = complex(raw(1:2:end), raw(2:2:end)) * (amp / 32768);

    fs = g.core_sample_rate;
    fc = meta.captures(1).core_frequency;
    fprintf('%s：%s，%g MS/s @ %g MHz，%d 个样点，平均功率 %.2f dBm\n', stem, ...
        g.cuav_observation_point, fs / 1e6, fc / 1e6, numel(x), 10 * log10(mean(abs(x) .^ 2)));
    % 注记的键不全相同时 jsondecode 给元胞数组，全相同时给结构体数组；两种都能用 numel 计数
    fprintf('注记 %d 条\n', numel(meta.annotations));

    % 峰值保持时频图：1024 点 Hann 窗（基础函数手写，不用工具箱）
    nfft = 1024;
    w = 0.5 - 0.5 * cos(2 * pi * (0:nfft - 1)' / (nfft - 1));
    n_frames = floor(numel(x) / nfft);
    rows = min(600, n_frames);
    grp = floor(n_frames / rows);
    img = zeros(rows, nfft);
    for r = 1:rows
        blk = reshape(x(nfft * grp * (r - 1) + 1 : nfft * grp * r), nfft, grp);
        p = abs(fftshift(fft(blk .* w, nfft, 1), 1)) .^ 2 / sum(w) ^ 2;
        img(r, :) = 10 * log10(max(p, [], 2) + 1e-30)';
    end
    f = ((0:nfft - 1) - nfft / 2) * fs / nfft + fc;
    t = (0:rows - 1) * grp * nfft / fs;
    figure;
    imagesc(f / 1e6, t, img);
    xlabel('Frequency (MHz)');
    ylabel('Time (s)');
    title(sprintf('%s  %s', stem, g.cuav_observation_point), 'Interpreter', 'none');
    colorbar;
end
