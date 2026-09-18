function y = cuav_pfb_m64(w, hr) %#codegen
%CUAV_PFB_M64  M = 64 的换向器一拍。窗口与抽头都是 P = 29·M = 1856。
%   子信道数必须是 codegen 时的常量：reshape 的行数与 ifft 的长度都靠它。
%   于是每个 M 一个入口，C 里也就是一个符号（生成的函数名跟着 .m 的名字走）。
%   算法全在 cuav_pfb_cycle.m，本文件只钉死 M。
y = cuav_pfb_cycle(w, hr, 64);
end
