function y = cuav_rsmp_cycle(win, h, M) %#codegen
%CUAV_RSMP_CYCLE  OFDM 有理重采样的换向器一拍：M+T 个原生样点 -> L = 125 个站点采样率样点。
%
%   本函数是 MATLAB Coder 的算法核（08 报告 §13 三层分工的中间层；Q-2，D-088），**不做任何
%   参数校验、不写日志、不访问文件**；参数校验、样点序号换算、突发拼窗、频点与功率、溯源与
%   四态都在封装层 engine/src/resampler.cpp 与 engine/src/scenario.cpp 里（§13 五项职责）。
%
%   入参
%     win  (M+T)×1 复列向量，原生样点的**正序**连续窗口：win(j+1) = x[c·M − T/2 + j]，
%          c 是本拍的序号（本拍产出站点样点 125c … 125c+124）。
%     h    L·(T+1)×1 实列向量：原型抽头（models/radiator/fir_rsmp_v1.json 展开后）末尾补 L−1 个零，
%          让每一相都是 T+1 个抽头；给 FIR 末尾补零不改变 H(ω)。
%     M    抽取比，codegen 时是 coder.Constant（每个 M 一个入口）。
%
%   出参
%     y    L×1 复列向量，y(t+1) = 站点样点 125c + t。
%
%   代数（时间锚「输出 m ↔ 原型序号 m·M + gd」，gd = L·T/2，08 报告 §8 口径二）：
%     v[p] = Σ_i h[r + L·i]·x[q − i]，p = L·q + r，i = 0…T
%     y[m] = v[m·M + gd]
%   本拍内 p = L·(c·M) + (t·M + gd)，于是 (q − c·M, r) 只随 t 变。显式循环、按 i 升序累加，
%   不调 sum / filter 一类工具箱函数：那样会生成与信道化、接收滤波同名的公用 C 文件（08 §13.1）。
L = 125;
T = numel(h) / L - 1;
gd = L * T / 2;
y = complex(zeros(L, 1));
for t = 0:L-1
    p = t * M + gd;
    q = floor(p / L);
    r = p - q * L;
    acc = complex(0, 0);
    for i = 0:T
        acc = acc + h(r + L * i + 1) * win(q - i + T / 2 + 1);
    end
    y(t + 1) = acc;
end
end
