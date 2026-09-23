#!/usr/bin/env python3
"""把 web/public/favicon.svg 的图形光栅化成 32 × 32 的 PNG 后备图标。

为什么要后备：主图标是矢量的 favicon.svg，现代 Chromium 与 Edge 都认它；
但交付环境里可能出现用 IE 兼容内核的国产浏览器，那种内核不认 SVG 图标，
没有后备就会退回成一个空白方块。

为什么自己光栅化而不用现成的库：交付环境不联网、构建不得拉取依赖（CLAUDE.md 铁律 6），
而这张图只有三种形状（圆角矩形、圆弧、圆），用标准库的 zlib 写 PNG 比引一个图像库划算。
几何参数与 favicon.svg 逐项对应，改了那边就重跑这个脚本：

    uv run --quiet python scripts/gen_favicon_png.py

输出 web/public/favicon.png（确定性：同样的输入逐字节相同）。
"""
from __future__ import annotations

import math
import os
import struct
import zlib

SIZE = 32          # 输出边长，与 SVG 的 viewBox 一致
SS = 4             # 每个像素每方向的超采样数，4 × 4 = 16 个子样本
RADIUS = 6.0       # 圆角半径

NAVY = (30, 64, 175)     # #1e40af 站点蓝，取自 docs/display-route.md §4
WHITE = (255, 255, 255)
CRIMSON = (225, 29, 72)  # #e11d48 目标红

STATION = (8.0, 24.0)    # 侦察站位置，也是三道波束的圆心
TARGET = (24.0, 8.0)     # 被发现的目标
BEAMS = [                # (半径, 线宽, 不透明度)；两道而不是三道的缘由见 favicon.svg 的注释
    (8.5, 3.0, 1.0),
    (15.0, 2.5, 0.6),
]
BEAM_FROM, BEAM_TO = 12.0, 78.0  # 波束张角，度；0 度指向正右，逆时针为正


def in_round_rect(x: float, y: float) -> bool:
    dx = max(0.0, RADIUS - x, x - (SIZE - RADIUS))
    dy = max(0.0, RADIUS - y, y - (SIZE - RADIUS))
    return math.hypot(dx, dy) <= RADIUS


def in_disc(x: float, y: float, cx: float, cy: float, r: float) -> bool:
    return math.hypot(x - cx, y - cy) <= r


def in_beam(x: float, y: float, r: float, width: float) -> bool:
    """点是否落在圆弧带上。两端按圆头处理，与 SVG 的 stroke-linecap="round" 一致。"""
    cx, cy = STATION
    half = width / 2.0
    if abs(math.hypot(x - cx, y - cy) - r) <= half:
        # 屏幕坐标的 y 向下，取负号换回数学角度
        deg = math.degrees(math.atan2(-(y - cy), x - cx))
        if BEAM_FROM <= deg <= BEAM_TO:
            return True
    for deg in (BEAM_FROM, BEAM_TO):
        ex = cx + r * math.cos(math.radians(deg))
        ey = cy - r * math.sin(math.radians(deg))
        if math.hypot(x - ex, y - ey) <= half:
            return True
    return False


def sample(x: float, y: float) -> tuple[int, int, int, float]:
    """一个子样本的颜色与不透明度。图层自下而上叠，上层直接盖住下层。"""
    if not in_round_rect(x, y):
        return (0, 0, 0, 0.0)
    r, g, b = NAVY
    for radius, width, opacity in BEAMS:
        if in_beam(x, y, radius, width):
            r = round(r + (WHITE[0] - r) * opacity)
            g = round(g + (WHITE[1] - g) * opacity)
            b = round(b + (WHITE[2] - b) * opacity)
    if in_disc(x, y, *STATION, 2.6):
        r, g, b = WHITE
    if in_disc(x, y, *TARGET, 4.2):
        r, g, b = WHITE
    if in_disc(x, y, *TARGET, 2.8):
        r, g, b = CRIMSON
    return (r, g, b, 1.0)


def render() -> bytes:
    """返回按 PNG 扫描行格式（每行前缀一个过滤器字节 0）排好的 RGBA 像素。"""
    rows = bytearray()
    step = 1.0 / SS
    for py in range(SIZE):
        rows.append(0)
        for px in range(SIZE):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SS):
                y = py + (sy + 0.5) * step
                for sx in range(SS):
                    x = px + (sx + 0.5) * step
                    cr, cg, cb, ca = sample(x, y)
                    acc_r += cr * ca
                    acc_g += cg * ca
                    acc_b += cb * ca
                    acc_a += ca
            n = SS * SS
            if acc_a <= 0.0:
                rows.extend((0, 0, 0, 0))
            else:
                # 边缘像素按覆盖率给 alpha，颜色按覆盖到的部分平均（非预乘）
                rows.extend((
                    round(acc_r / acc_a), round(acc_g / acc_a),
                    round(acc_b / acc_a), round(acc_a / n * 255),
                ))
    return bytes(rows)


def chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF))


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, os.pardir, 'web', 'public', 'favicon.png')
    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)  # 8 位 RGBA
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(render(), 9)) + chunk(b'IEND', b''))
    with open(out, 'wb') as fh:
        fh.write(png)
    print(f'{os.path.normpath(out)}：{SIZE} × {SIZE}，{len(png)} 字节')


if __name__ == '__main__':
    main()
