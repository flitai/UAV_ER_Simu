function gen_spectrum_golden(jsonPath)
%GEN_SPECTRUM_GOLDEN  读 Python 生成的黄金文件，用 pwelch 与手写参考各算一遍功率谱，
%   写出同目录的 spectrum_welch.matlab.json（只写 MATLAB 一方的结果，不改写原文件：
%   jsonencode 只保留 15 位有效数字，会破坏原文件里 float32 精确值的十进制表示）。
%
%   用法：gen_spectrum_golden('<仓库>/engine/tests/golden/spectrum_welch.json')
%   依据：06 备忘录 §9D M-4；CLAUDE.md 铁律 10。
g = jsondecode(fileread(jsonPath));
iq = g.input.iq(:);
% 输入值都是 float32 精确可表示的，double(single(.)) 与直接用 double 相同；这里显式过一遍 single，
% 把「引擎内部是 float32」这一事实写进代码。
xi = double(single(iq(1:2:end)));
xq = double(single(iq(2:2:end)));
x = xi + 1j * xq;
p = g.params;
nfft = double(p.nfft);
hop = double(p.hop);
fs = double(p.sample_rate_Hz);
noverlap = nfft - hop;
w = hann(nfft, 'periodic');

% 不用 'centered'：pwelch 的 'centered' 对偶数 nfft 给 (−fs/2, fs/2]，把奈奎斯特频点放在正端，
% 与 numpy.fft.fftshift / MATLAB fftshift 的 [−fs/2, fs/2) 差一格。这里取 'twosided' 再 fftshift，
% 与 Python 参考、引擎 dsp::fftshift 同一约定（零频在 0 基下标 nfft/2）。
[pxx2, f2] = pwelch(x, w, noverlap, nfft, fs, 'twosided', 'power');
pxx = fftshift(pxx2);
f = f2 - fs/2;                          % twosided 的 f 是 [0, fs)，移位后即 [−fs/2, fs/2)
[pref, fref] = cuav_welch_power(x, nfft, hop, w, fs);

peak = max(pxx);
relerr = max(abs(pxx(:) - pref(:)) ./ max(pxx(:), 1e-12 * peak));
if relerr > 1e-12
    error('cuav:golden:mismatch', 'pwelch 与手写 Welch 不一致，最大相对误差 %.3e', relerr);
end
if max(abs(f(:) - fref(:))) > 1e-9
    error('cuav:golden:freq', '频率轴不一致');
end

out = struct();
out.schema = 'cuav-engine-golden/1';
out.source = 'matlab/golden/gen_spectrum_golden.m';
out.for_input = 'spectrum_welch.json 的 input.iq';
out.matlab_version = version;
out.method = "fftshift(pwelch(x, hann(nfft,'periodic'), nfft-hop, nfft, fs, 'twosided', 'power'))，并与 matlab/ref/cuav_welch_power.m 互证；不用 'centered'（偶数 nfft 时其范围为 (-fs/2, fs/2]，与 fftshift 差一格）";
out.pwelch_vs_handwritten_max_rel = relerr;
out.power = pxx(:)';
out.psd_dB = 10 * log10(max(pxx(:)', 1e-30));
out.freq_Hz = f(:)';
[peakv, peaki] = max(out.psd_dB);
out.peak_dB = peakv;
out.peak_bin = peaki - 1;   % 0 基，与 Python、C++ 一致

[dir_, ~, ~] = fileparts(jsonPath);
outPath = fullfile(dir_, 'spectrum_welch.matlab.json');
fid = fopen(outPath, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(out, 'PrettyPrint', true), 'char');
fclose(fid);
fprintf('写出 %s：峰值 %.4f dBFS @ bin %d，pwelch 与手写参考最大相对误差 %.2e\n', outPath, peakv, peaki - 1, relerr);
end
