"""每格的种子与载频偏差：由集合种子确定性派生（试样集，D-092）。

为什么不共用一个种子：同一个运行种子会让不同格的热噪声、相噪、衰落逐位相同；同一个场景种子会让
OFDM 突发表与载荷逐位相同（D-088 ⑤）。两段数据一比就露出是同一串随机数。

派生式与 OFDM 帧排布的键同族：key = mix64(集合种子 ^ mix64(fnv1a64("<格子>/<用途>")))，
取低 53 位（场景与框图的种子都要能被 JSON 的 double 精确表示，上限 2^53 − 1）。
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, os.path.join(_ROOT, "algos", "reference"))

from gfsk_ref import fnv1a64, mix64  # noqa: E402  与引擎同式的两个散列

SEED_MASK = (1 << 53) - 1


def derive(set_seed: int, cell_id: str, role: str) -> int:
    """格子 cell_id 的某个用途（run / scenario / cfo/<平台>）的种子，非负整数且 < 2^53。"""
    key = mix64((set_seed ^ mix64(fnv1a64(f"{cell_id}/{role}"))) & ((1 << 64) - 1))
    return key & SEED_MASK


def cfo_ppm(set_seed: int, cell_id: str, platform_id: str, max_ppm: float) -> float:
    """平台的载频偏差（ppm），在 [−max, +max] 上均匀，取到 1e-3 ppm。

    按**平台**抽：同一部电台的图传与 DroneID 共用一个晶振，偏差应相同。"""
    u = derive(set_seed, cell_id, f"cfo/{platform_id}") / float(SEED_MASK)
    return round((2.0 * u - 1.0) * max_ppm, 3)
