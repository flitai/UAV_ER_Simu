function y = cuav_rsmp_m48(win, h) %#codegen
%CUAV_RSMP_M48  抽取比 M = 48 的换向器一拍（Q-2，D-088）。窗口 M+T 个原生样点，出 125 个站点样点。
%   抽取比必须是 codegen 时的常量：窗口长度靠它。于是每个 M 一个入口，C 里也就是一个符号。
%   算法全在 cuav_rsmp_cycle.m，本文件只钉死 M。
y = cuav_rsmp_cycle(win, h, 48);
end
