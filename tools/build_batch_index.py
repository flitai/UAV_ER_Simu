#!/usr/bin/env python3
"""为一批 IQ 数据产物生成合并索引 `index.manifest.json`。

为什么要合并索引：CLAUDE.md 的规矩是「大文件不入 git，只入索引与元数据」。逐产物清单在
产物只有几个时直接入库没问题，到 4714 个就会给仓库塞进近五千个小文件、约 19 MB，
既不好查也不好比。合并索引把每个产物压成一行（标识、来源、真值摘要、样点数、内容哈希、
质量状态），**逐产物清单留在盘上不入库**——它们由转换脚本确定性生成，索引里的 `content_sha256`
足以证明盘上的产物与当初入库的是同一份。

用法：
    uv run --project tools python tools/build_batch_index.py data/iq/measured/dronerfb
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iq_format import manifest as M      # noqa: E402
from iq_format import store              # noqa: E402

VERSION = "0.1.0"


def build(directory: str) -> dict:
    rows = []
    quality = {}
    datasets = {}
    for p in store.list_products(directory):
        man = p.manifest or {}
        t = p.truth or {}
        q = man.get("quality", {}).get("status", "unknown")
        quality[q] = quality.get(q, 0) + 1
        ds = man.get("origin", {}).get("dataset")
        datasets[ds] = datasets.get(ds, 0) + 1
        rows.append({
            "data_id": p.stem,
            "source_file": man.get("origin", {}).get("source_file"),
            "channel_id": man.get("channel", {}).get("channel_id"),
            "center_frequency_Hz": man.get("frequency", {}).get("center_frequency_Hz"),
            "sample_count": man.get("sampling", {}).get("sample_count"),
            "segments": len(man.get("segments", [])),
            "content_sha256": man.get("identity", {}).get("content_sha256"),
            "quality": q,
            "truth": {k: t.get(k) for k in
                      ("class_code", "class_name", "split", "visibility", "individual",
                       "distance_bin", "distance_range_m", "distance_m", "band_state",
                       "original_name")
                      if t.get(k) is not None} or None,
        })
    rows.sort(key=lambda r: r["data_id"])
    return {
        "schema": "cuav-batch-index/1",
        "created_utc": M.utc_now(),
        "producer": f"tools/build_batch_index.py {VERSION}",
        "directory": os.path.relpath(directory, os.path.dirname(os.path.dirname(
            os.path.abspath(__file__)))),
        "product_count": len(rows),
        "datasets": datasets,
        "quality_distribution": quality,
        "note": "逐产物清单 <data_id>.manifest.json 与样点文件 <data_id>.iq 留在盘上不入库；"
                "本索引的 content_sha256 用于核对盘上产物与入库时是否一致。"
                "重建方式见 tools/iq_convert.py",
        "products": rows,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成批次合并索引")
    ap.add_argument("directory")
    ap.add_argument("-o", "--out", default=None)
    args = ap.parse_args(argv)
    doc = build(args.directory)
    out = args.out or os.path.join(args.directory, "index.manifest.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"已写 {out}：{doc['product_count']} 个产物，质量分布 {doc['quality_distribution']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
