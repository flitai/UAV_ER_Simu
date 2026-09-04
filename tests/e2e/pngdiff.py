#!/usr/bin/env python3
"""比较两张 PNG 的像素差异。只用标准库（zlib），不引入图像库。

用法：python3 tests/e2e/pngdiff.py A.png B.png [--tol 8] [--out 差异图.png]

输出：尺寸、逐像素在容差内的比例、平均绝对差、差异最大的区域。
容差存在的理由：两侧若用不同版本的渲染库，抗锯齿与文字排布会有亚像素差别，
逐位相等不是合理判据；要判的是"看起来是不是同一张图"。
"""
import sys, zlib, struct


def read_png(path):
    d = open(path, "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", f"{path} 不是 PNG"
    i, idat, w = 8, [], None
    while i < len(d):
        ln = struct.unpack(">I", d[i:i+4])[0]
        typ = d[i+4:i+8]
        body = d[i+8:i+8+ln]
        if typ == b"IHDR":
            w, h, depth, color, comp, filt, inter = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and inter == 0, "只支持 8 位非隔行 PNG"
            ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
        elif typ == b"IDAT":
            idat.append(body)
        elif typ == b"IEND":
            break
        i += 12 + ln
    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:
            for x in range(ch, stride): line[x] = (line[x] + line[x-ch]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x-ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x-ch] if x >= ch else 0
                b = prev[x]; c = prev[x-ch] if x >= ch else 0
                pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y*stride:(y+1)*stride] = line
        prev = line
    return w, h, ch, bytes(out)


def main():
    a_path, b_path = sys.argv[1], sys.argv[2]
    tol = int(sys.argv[sys.argv.index("--tol") + 1]) if "--tol" in sys.argv else 8
    wa, ha, ca, A = read_png(a_path)
    wb, hb, cb, B = read_png(b_path)
    print(f"A {wa}x{ha} 通道 {ca}   B {wb}x{hb} 通道 {cb}   容差 {tol}")
    if (wa, ha) != (wb, hb):
        print("尺寸不同，无法逐像素比较"); return 2
    n = wa * ha
    same = 0; total = 0
    worst_rows = [0] * ha
    for y in range(ha):
        ra, rb = y*wa*ca, y*wb*cb
        bad = 0
        for x in range(wa):
            pa, pb = ra + x*ca, rb + x*cb
            d = max(abs(A[pa]-B[pb]), abs(A[pa+1]-B[pb+1]), abs(A[pa+2]-B[pb+2]))
            total += d
            if d <= tol: same += 1
            else: bad += 1
        worst_rows[y] = bad
    print(f"容差内的像素 {same}/{n} = {same/n*100:.2f}%")
    print(f"平均绝对差 {total/n:.2f}（0 至 255）")
    band = max(range(0, ha, 50), key=lambda y: sum(worst_rows[y:y+50]))
    print(f"差异最集中的横带：第 {band} 至 {band+50} 行，{sum(worst_rows[band:band+50])} 个像素超容差")
    return 0


if __name__ == "__main__":
    sys.exit(main())
