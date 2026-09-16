function h = cuav_sha256(path)
%CUAV_SHA256  文件的 SHA-256（小写 64 位十六进制）。
%   黄金文件里的防陈旧字段用它算：改了 .m 或改了冻结表却没重跑 MATLAB，
%   引擎单测据此当场红（CLAUDE.md 铁律 10）。
%
%   走 JVM 自带的 java.security.MessageDigest —— MATLAB 没有内置的 SHA-256，
%   而 Simulink.getFileChecksum 是 MD5、且要 Simulink。`matlab -batch` 默认带 JVM。
fid = fopen(path, 'r');
if fid < 0
    error('cuav:sha256:open', '打不开 %s', path);
end
c = onCleanup(@() fclose(fid));
b = fread(fid, Inf, '*uint8');
md = java.security.MessageDigest.getInstance('SHA-256');
md.update(b);
d = typecast(md.digest(), 'uint8');      % digest() 返回 int8，转成 uint8 再转十六进制
h = lower(reshape(dec2hex(d, 2).', 1, []));
end
