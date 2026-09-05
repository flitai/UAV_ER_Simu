function [P, f] = cuav_welch_power(x, nfft, hop, w, fs)
%CUAV_WELCH_POWER  Welch 平均功率谱（不是功率谱密度），零频居中。
%   P[k] = mean_over_segments |FFT(w .* x_seg)[k]|^2 / (sum(w))^2，再 fftshift。
%   复单音的峰值等于其功率 A^2；满量程单音读 0 dBFS。
%   与 pwelch(x, w, nfft-hop, nfft, fs, 'centered', 'power') 同口径，
%   写成独立函数是为了三方互证时有一份不依赖 Signal Processing Toolbox 的手写参考。
%
%   依据：docs/display-products.md（scale = dBFS）；algos/reference/gen_spectrum_golden.py。
%   本文件是 M-4 三方互证的 MATLAB 参考之一；改动即为基准变化（CLAUDE.md 铁律 10）。
x = x(:);
w = w(:);
K = floor((numel(x) - nfft) / hop) + 1;
if K < 1
    error('cuav:welch:tooShort', '样点数 %d 不足一段 nfft = %d', numel(x), nfft);
end
acc = zeros(nfft, 1);
for k = 1:K
    seg = x((k - 1) * hop + (1:nfft)) .* w;
    X = fft(seg);
    acc = acc + abs(X) .^ 2;
end
P = fftshift(acc / K / sum(w)^2);
f = (-nfft/2 : nfft/2 - 1)' * (fs / nfft);
end
