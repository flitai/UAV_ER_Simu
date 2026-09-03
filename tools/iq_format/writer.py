"""复 int16 交织写盘器：无损断言、流式分段、哈希、回读对拍。

规范是 `docs/iq-format.md` 第 3 节。

设计要点：**流式**。DroneRFa 单片每通道 1.5 亿点 float64，I 与 Q 合计 2.4 GB，整片进内存不
现实，所以写盘器按块接收、按段落盘，回读对拍靠逐段 sha256 比对而不是把数据再读回内存。
"""
from __future__ import annotations

import hashlib
import os
from typing import BinaryIO

import numpy as np

FULL_SCALE = 32768
BYTES_PER_SAMPLE = 4
# 单段上限 67108864 复样点 = 256 MiB（docs/iq-format.md 第 3.3 节）
DEFAULT_SEGMENT_SAMPLES = 67_108_864
READBACK_CHUNK_BYTES = 32 << 20

ASCII_SAFE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")


class LossyConversionError(RuntimeError):
    """源数据不是满量程倒数的整数倍，转换会静默改变数据（铁律 10），必须中止。"""


def check_ascii_name(name: str) -> None:
    bad = sorted(set(name) - ASCII_SAFE)
    if bad:
        raise ValueError(f"文件名含非法字符 {bad}，只允许 A-Z a-z 0-9 . _ -（铁律 15）：{name!r}")


def assert_lossless(x: np.ndarray, full_scale: int = FULL_SCALE) -> dict:
    """断言浮点样点是 1/full_scale 的整数倍，且落在 int16 值域内。

    返回实测摘要（峰值码、峰值 dBFS、最大量化偏差），供清单与质检引用。
    失败抛 LossyConversionError —— 调用方不得捕获后继续写盘。
    """
    scaled = np.asarray(x, dtype=np.float64) * full_scale
    rounded = np.round(scaled)
    max_dev = float(np.max(np.abs(scaled - rounded))) if scaled.size else 0.0
    if max_dev > 1e-6:
        raise LossyConversionError(
            f"源样点不是 1/{full_scale} 的整数倍（最大偏差 {max_dev:.3e} 个量化码），"
            "说明底层不是 16 位整数；四舍五入会静默改变数据，已中止转换"
        )
    peak = float(np.max(np.abs(rounded))) if rounded.size else 0.0
    if peak > full_scale - 1:
        raise LossyConversionError(f"源样点峰值码 {peak:.0f} 超出 int16 值域，已中止转换")
    return {
        "peak_code": int(peak),
        "peak_dBFS": float(20 * np.log10(peak / full_scale)) if peak > 0 else float("-inf"),
        "max_quantisation_deviation": max_dev,
    }


def interleave(i: np.ndarray, q: np.ndarray, full_scale: int = FULL_SCALE) -> np.ndarray:
    """浮点 I、Q 转复 int16 交织。调用前必须先过 assert_lossless。"""
    if i.shape != q.shape:
        raise ValueError(f"I 与 Q 样点数不同：{i.shape} 对 {q.shape}")
    out = np.empty(2 * i.size, dtype="<i2")
    out[0::2] = np.round(np.asarray(i, dtype=np.float64) * full_scale).astype("<i2")
    out[1::2] = np.round(np.asarray(q, dtype=np.float64) * full_scale).astype("<i2")
    return out


class SegmentedWriter:
    """按块接收交织流，按段写出 `<stem>.iq` 或 `<stem>_segNNN.iq`。

    用法：`write_chunk()` 若干次 → `close()` → `verify_readback()` → `segment_index()`。
    段数事先未知，因此单段与多段的命名在 `close()` 时才定：只有一段就用 `<stem>.iq`。
    """

    def __init__(self, out_dir: str, stem: str,
                 segment_samples: int = DEFAULT_SEGMENT_SAMPLES) -> None:
        check_ascii_name(stem)
        if segment_samples <= 0:
            raise ValueError("segment_samples 必须大于 0")
        self.out_dir = out_dir
        self.stem = stem
        self.segment_samples = segment_samples
        os.makedirs(out_dir, exist_ok=True)
        self._content = hashlib.sha256()
        self._seg_hash = None
        self._fh: BinaryIO | None = None
        self._paths: list[str] = []
        self._counts: list[int] = []
        self._hashes: list[str] = []
        self._cur = 0          # 当前段已写样点
        self._total = 0
        self._closed = False

    # ---- 内部 ----
    def _open_next(self) -> None:
        path = os.path.join(self.out_dir, f"{self.stem}_seg{len(self._paths):03d}.iq")
        check_ascii_name(os.path.basename(path))
        self._fh = open(path, "wb")
        self._paths.append(path)
        self._counts.append(0)
        self._seg_hash = hashlib.sha256()
        self._cur = 0

    def _close_segment(self) -> None:
        if self._fh is None:
            return
        self._fh.close()
        self._fh = None
        self._counts[-1] = self._cur
        self._hashes.append(self._seg_hash.hexdigest())

    # ---- 外部 ----
    def write_chunk(self, ci16: np.ndarray) -> None:
        if self._closed:
            raise RuntimeError("写盘器已关闭")
        if ci16.dtype != np.dtype("<i2"):
            raise ValueError(f"期望小端 int16，收到 {ci16.dtype}")
        if ci16.size % 2:
            raise ValueError("交织流长度必须是偶数（I、Q 成对）")
        pos = 0
        n_samples = ci16.size // 2
        while pos < n_samples:
            if self._fh is None or self._cur >= self.segment_samples:
                self._close_segment()
                self._open_next()
            take = min(self.segment_samples - self._cur, n_samples - pos)
            raw = np.ascontiguousarray(ci16[2 * pos:2 * (pos + take)])
            buf = raw.tobytes()
            self._fh.write(buf)
            self._seg_hash.update(buf)
            self._content.update(buf)
            self._cur += take
            self._total += take
            pos += take

    def close(self) -> None:
        if self._closed:
            return
        self._close_segment()
        self._closed = True
        # 只有一段时改名为 <stem>.iq（docs/iq-format.md 第 3.3 节）
        if len(self._paths) == 1:
            single = os.path.join(self.out_dir, f"{self.stem}.iq")
            os.replace(self._paths[0], single)
            self._paths[0] = single

    def verify_readback(self) -> bool:
        """逐段回读并比对 sha256。与把数据读回内存等价，但内存占用是常数。"""
        if not self._closed:
            raise RuntimeError("先 close() 再回读对拍")
        for path, want, count in zip(self._paths, self._hashes, self._counts):
            if os.path.getsize(path) != count * BYTES_PER_SAMPLE:
                return False
            h = hashlib.sha256()
            with open(path, "rb") as fh:
                while True:
                    b = fh.read(READBACK_CHUNK_BYTES)
                    if not b:
                        break
                    h.update(b)
            if h.hexdigest() != want:
                return False
        return True

    @property
    def content_sha256(self) -> str:
        return self._content.hexdigest()

    @property
    def sample_count(self) -> int:
        return self._total

    def segment_index(self) -> list[dict]:
        out = []
        start = 0
        for path, n, h in zip(self._paths, self._counts, self._hashes):
            out.append({
                "file": os.path.basename(path),
                "start_sample": start,
                "sample_count": n,
                "bytes": n * BYTES_PER_SAMPLE,
                "sha256": h,
            })
            start += n
        return out

    def paths(self) -> list[str]:
        return list(self._paths)
