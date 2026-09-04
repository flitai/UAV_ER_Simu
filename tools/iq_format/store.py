"""读取本项目格式的 IQ 数据产物（`docs/iq-format.md` 第 3 节）。

写盘在 `writer.py`，读取在这里。分段、字节偏移、跨段拼接的规则只在这两个文件里实现，
别处一律通过本模块读，不要再手写 `np.fromfile`。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Iterator

import numpy as np

BYTES_PER_SAMPLE = 4
FULL_SCALE = 32768


def segment_paths(any_path: str, manifest: dict | None = None) -> list[str]:
    """给定 `.iq` 或清单路径，返回按顺序排列的段文件路径。"""
    d = os.path.dirname(os.path.abspath(any_path))
    if manifest and manifest.get("segments"):
        return [os.path.join(d, s["file"]) for s in manifest["segments"]]
    if any_path.endswith(".iq"):
        return [any_path]
    stem = os.path.basename(any_path).replace(".manifest.json", "")
    single = os.path.join(d, stem + ".iq")
    if os.path.exists(single):
        return [single]
    segs = sorted(f for f in os.listdir(d)
                  if f.startswith(stem + "_seg") and f.endswith(".iq"))
    return [os.path.join(d, f) for f in segs]


@dataclass
class Product:
    """一个数据产物：样点文件加清单。"""

    stem: str
    paths: list[str]
    manifest: dict | None

    @property
    def sample_count(self) -> int:
        return sum(os.path.getsize(p) for p in self.paths) // BYTES_PER_SAMPLE

    @property
    def sample_rate_Hz(self) -> float:
        return float(self.manifest["sampling"]["sample_rate_Hz"]) if self.manifest else 0.0

    @property
    def center_frequency_Hz(self) -> float:
        return float(self.manifest["frequency"]["center_frequency_Hz"]) if self.manifest else 0.0

    @property
    def truth(self) -> dict | None:
        return self.manifest.get("truth") if self.manifest else None

    def read(self, start: int, count: int) -> np.ndarray:
        """读 count 个复样点，返回 complex64（量化码，未标定）。"""
        chunks: list[np.ndarray] = []
        remaining, pos, offset = count, start, 0
        for p in self.paths:
            n_p = os.path.getsize(p) // BYTES_PER_SAMPLE
            if pos >= offset + n_p:
                offset += n_p
                continue
            local = pos - offset
            take = min(n_p - local, remaining)
            chunks.append(np.fromfile(p, dtype="<i2", count=2 * take,
                                      offset=local * BYTES_PER_SAMPLE))
            remaining -= take
            pos += take
            offset += n_p
            if remaining <= 0:
                break
        if not chunks:
            return np.empty(0, dtype=np.complex64)
        raw = np.concatenate(chunks).astype(np.float32)
        return (raw[0::2] + 1j * raw[1::2]).astype(np.complex64)

    def chunks(self, chunk_samples: int) -> Iterator[np.ndarray]:
        n = self.sample_count
        for start in range(0, n, chunk_samples):
            yield self.read(start, min(chunk_samples, n - start))


def open_product(path: str) -> Product:
    """按 `.iq` 路径或清单路径打开产物。清单缺失不报错，字段按 None 处理（铁律 15）。"""
    d = os.path.dirname(os.path.abspath(path))
    base = os.path.basename(path)
    stem = base[:-3] if base.endswith(".iq") else base.replace(".manifest.json", "")
    stem = stem.rsplit("_seg", 1)[0] if "_seg" in stem else stem
    man_path = os.path.join(d, stem + ".manifest.json")
    manifest = None
    if os.path.exists(man_path):
        try:
            with open(man_path, encoding="utf-8") as fh:
                manifest = json.load(fh)
        except (json.JSONDecodeError, OSError):
            manifest = None
    return Product(stem=stem, paths=segment_paths(path, manifest), manifest=manifest)


def list_products(directory: str) -> list[Product]:
    """列出目录下的所有产物，按 stem 排序，分段产物只出现一次。"""
    stems = set()
    for f in os.listdir(directory):
        if f.endswith(".manifest.json"):
            stems.add(f.replace(".manifest.json", ""))
        elif f.endswith(".iq"):
            stems.add(f[:-3].rsplit("_seg", 1)[0])
    out = []
    for s in sorted(stems):
        p = open_product(os.path.join(directory, s + ".manifest.json"))
        if p.paths:
            out.append(p)
    return out
