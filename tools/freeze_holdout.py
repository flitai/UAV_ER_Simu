#!/usr/bin/env python3
"""DS-4 / DA-4：冻结验收子集并记哈希，以及事后检查调参输入集是否与它相交。

规矩来自 06 备忘录 §11.2 第 2 条：「按设备/日期/地点/架次划出冻结验收子集，记 sha256，
清单入库；此后任何调参输入集须证明与其无交集」。以及项目记忆 `holdout-freeze-at-ingest`：
**入库当天冻结，事后再补即已泄漏**。

## 两个数据集的划分规则不同，理由也不同

**DroneRFb-DIR**：直接用出版方划好的测试集。出版方划分的好处是不会把同一架次同时放进训练
与验收。但要减去**已经在本项目实验里用过的片子**——DS-6 与 DS-7 用了测试集里的 25 片纯背景
做门限标定与检测概率测量，它们已经参与过参数选择，不能再当验收集。另单列 6 架从未在训练集
出现的个体（A3/C3/D3/E3/F3/G3），它们是个体识别泛化能力的关键子集。

**DroneRFa**：**本地 22 片全部已被用于探索与拟合**（路损指数 DA-6、正交不平衡 DA-7、
DS-6/DS-7 的背景源），因此**没有一片可以充当验收集**。这不是疏忽，是入手时还没有冻结机制的
直接后果，正是 `holdout-freeze-at-ingest` 那条记忆讲的事。DroneRFa 的验收集只能来自后续按
`data/iq/measured/dronerfa/download-list.md` 补下的片，**下载当天立即冻结，下载前不得先看**。

用法：
    # 冻结（生成清单）
    uv run --project tools python tools/freeze_holdout.py --freeze
    # 追加后续批次（冻结后补下的片；只追加，不改已有条目）
    uv run --project tools python tools/freeze_holdout.py --add-batches
    # 检查一批将要用于调参的产物是否与验收集相交
    uv run --project tools python tools/freeze_holdout.py --check data/iq/measured/dronerfb/*.iq
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iq_format import manifest as M      # noqa: E402
from iq_format import store              # noqa: E402

VERSION = "0.1.0"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data/iq/measured/holdout.manifest.json")

# 已在本项目实验里用过、因此不能进验收集的产物（数据来源：WORKLOG 2026-09-04 两条日志）
USED_IN_EXPERIMENTS = {
    "dronerfb": {
        "reason": "DS-6 虚警率标定与 DS-7 检测概率测量用作背景源与门限标定数据",
        "match": lambda t: t.get("split") == "test" and t.get("class_code") == "B",
    },
    "dronerfb_smoke": {
        "reason": "转换脚本首次跑通时的验证样本，虽未参与任何参数选择，仍按保守原则排除",
        "match": lambda t: t.get("original_name") == "D1_IN_S2_slice_47",
    },
}
NEVER_IN_TRAIN = {"A3", "C3", "D3", "E3", "F3", "G3"}

# DroneRFa 后续补下的批次（冻结清单只做一次，之后的批次**只追加、不改已有条目**，`--add-batches`）。
# 每批的划分规则必须在看信号之前写定；看过信号的片如实列进 seen，不得追认为验收集。
DRONERFA_BATCHES = [
    {
        "batch_id": "dronerfa-2026-09-28",
        "date": "2026-09-28",
        "rule": "FrSky X20（T10010）新到 9 片只做过文件完整性检查、未看信号：按源文件名排序每三取一"
                "（第 3、6、9 个）进验收集，两个通道（RF0 915 MHz / RF1 2440 MHz）同进同出。"
                "Mavic 3（T1010）、AVATA（T1110）、DJI 通信模块自组机（T1111）三批在冻结前已被实测"
                "（突发帧占比、带宽、时长，为核实 5.8 GHz 通道有无图传），按规矩不能进验收集",
        "holdout_sources": ["T10010_S0011.mat", "T10010_S0111.mat", "T10010_S1010.mat"],
        "seen_before_freeze": {
            "prefixes": ["T1010_", "T1110_", "T1111_"],
            "reason": "冻结前已做信号分析（2026-09-28 核实 5.8 GHz 通道），流程失误：应先冻结再看",
        },
    },
]


def collect(directory: str) -> list[store.Product]:
    if not os.path.isdir(directory):
        return []
    return store.list_products(directory)


def freeze() -> dict:
    rfb_dir = os.path.join(ROOT, "data/iq/measured/dronerfb")
    rfa_dir = os.path.join(ROOT, "data/iq/measured/dronerfa")

    rfb = collect(rfb_dir)
    rfa = collect(rfa_dir)

    holdout, excluded = [], []
    for p in rfb:
        t = p.truth or {}
        if t.get("split") != "test":
            continue
        why = None
        for key, rule in USED_IN_EXPERIMENTS.items():
            if not key.startswith("dronerfb"):
                continue
            if rule["match"](t):
                why = rule["reason"]
                break
        row = {
            "data_id": p.stem,
            "dataset": (p.manifest or {}).get("origin", {}).get("dataset"),
            "source_file": (p.manifest or {}).get("origin", {}).get("source_file"),
            "class_code": t.get("class_code"),
            "individual": t.get("individual"),
            "visibility": t.get("visibility"),
            "original_name": t.get("original_name"),
            "sample_count": (p.manifest or {}).get("sampling", {}).get("sample_count"),
            "content_sha256": (p.manifest or {}).get("identity", {}).get("content_sha256"),
        }
        if why:
            excluded.append({**row, "excluded_because": why})
        else:
            holdout.append(row)

    never = [r for r in holdout if r["class_code"] in NEVER_IN_TRAIN]

    doc = {
        "schema": "cuav-holdout-manifest/1",
        "created_utc": M.utc_now(),
        "producer": f"tools/freeze_holdout.py {VERSION}",
        "rule": "此后任何用于调参、拟合或门限标定的输入集，须证明与本清单的 data_id 与 "
                "content_sha256 均无交集。检查方式：tools/freeze_holdout.py --check <产物...>",
        "datasets": {
            "DroneRFb-DIR": {
                "basis": "出版方已划分的测试集，减去已在本项目实验中使用过的片",
                "holdout_count": len(holdout),
                "excluded_count": len(excluded),
                "never_in_train_individuals": sorted(NEVER_IN_TRAIN),
                "never_in_train_count": len(never),
                "note": "出版方划分的好处是不会把同一架次同时放进训练与验收",
            },
            "DroneRFa": {
                "basis": "无可用验收集",
                "holdout_count": 0,
                "reason": "本地 22 片全部已用于探索与拟合（DA-6 路损、DA-7 正交不平衡、"
                          "DS-6/DS-7 背景源），按 holdout-freeze-at-ingest 的规矩不能追认为验收集",
                "next_action": "验收集只能来自后续按 download-list.md 补下的片，"
                               "下载当天立即冻结，冻结前不得用于任何分析",
                "local_products_now": len(rfa),
            },
        },
        "holdout": sorted(holdout, key=lambda r: r["data_id"]),
        "excluded_from_holdout": sorted(excluded, key=lambda r: r["data_id"]),
    }
    return doc


def add_batches(path: str) -> int:
    """把 DRONERFA_BATCHES 里尚未登记的批次追加进已冻结的清单；已有条目一个字节不动。"""
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    rfa = doc["datasets"]["DroneRFa"]
    done = {b["batch_id"] for b in rfa.get("additions", [])}
    products = collect(os.path.join(ROOT, "data/iq/measured/dronerfa"))
    added = 0
    for b in DRONERFA_BATCHES:
        if b["batch_id"] in done:
            continue
        rows, seen = [], []
        for p in products:
            src = (p.manifest or {}).get("origin", {}).get("source_file") or ""
            t = p.truth or {}
            row = {
                "data_id": p.stem, "dataset": "DroneRFa", "source_file": src, "batch": b["batch_id"],
                "class_code": t.get("class_code"), "individual": t.get("individual"),
                "visibility": t.get("visibility"), "original_name": t.get("original_name"),
                "sample_count": (p.manifest or {}).get("sampling", {}).get("sample_count"),
                "content_sha256": (p.manifest or {}).get("identity", {}).get("content_sha256"),
            }
            if src in b["holdout_sources"]:
                rows.append(row)
            elif any(src.startswith(x) for x in b["seen_before_freeze"]["prefixes"]):
                seen.append({**row, "excluded_because": b["seen_before_freeze"]["reason"]})
        want = 2 * len(b["holdout_sources"])
        if len(rows) != want:
            print(f"{b['batch_id']}：验收集应有 {want} 个产物（每片两个通道），实得 {len(rows)}；"
                  "先把这批转换完再追加", file=sys.stderr)
            return 2
        doc["holdout"] = doc["holdout"] + sorted(rows, key=lambda r: r["data_id"])
        doc["excluded_from_holdout"] = doc["excluded_from_holdout"] + sorted(seen, key=lambda r: r["data_id"])
        rfa.setdefault("additions", []).append({
            "batch_id": b["batch_id"], "date": b["date"], "added_utc": M.utc_now(),
            "producer": f"tools/freeze_holdout.py {VERSION}", "rule": b["rule"],
            "holdout_count": len(rows), "seen_before_freeze_count": len(seen),
        })
        rfa["holdout_count"] = rfa.get("holdout_count", 0) + len(rows)
        added += 1
        print(f"追加 {b['batch_id']}：验收集 +{len(rows)}，冻结前已看过而排除 {len(seen)}")
    if added:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    else:
        print("没有待追加的批次")
    return 0


def check(paths: list[str]) -> int:
    if not os.path.exists(OUT):
        print(f"没有冻结清单 {OUT}，先跑 --freeze", file=sys.stderr)
        return 2
    with open(OUT, encoding="utf-8") as fh:
        doc = json.load(fh)
    ids = {r["data_id"] for r in doc["holdout"]}
    hashes = {r["content_sha256"] for r in doc["holdout"] if r["content_sha256"]}

    hits = []
    checked = 0
    for path in paths:
        for f in glob.glob(path):
            p = store.open_product(f)
            checked += 1
            h = (p.manifest or {}).get("identity", {}).get("content_sha256")
            if p.stem in ids:
                hits.append((p.stem, "data_id 命中"))
            elif h and h in hashes:
                hits.append((p.stem, "内容哈希命中（换名也拦得住）"))
    print(f"检查 {checked} 个产物，验收集 {len(ids)} 个")
    if hits:
        print(f"**相交 {len(hits)} 个，不得用于调参**：")
        for stem, why in hits[:20]:
            print(f"  {stem}  ← {why}")
        if len(hits) > 20:
            print(f"  …… 另有 {len(hits) - 20} 个")
        return 1
    print("无交集，可用于调参")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DS-4 / DA-4 冻结验收子集")
    ap.add_argument("--freeze", action="store_true")
    ap.add_argument("--check", nargs="*", default=None)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--add-batches", action="store_true", help="往已冻结的清单追加 DRONERFA_BATCHES 里的新批次（已有条目不动）")
    args = ap.parse_args(argv)

    if args.check is not None:
        return check(args.check)
    if args.add_batches:
        return add_batches(args.out)
    if not args.freeze:
        ap.print_help()
        return 2

    if os.path.exists(args.out):
        print(f"清单已存在：{args.out}\n**冻结只做一次**。要重做须先说明理由并留档，"
              "否则等于事后调整验收集。", file=sys.stderr)
        return 2

    doc = freeze()
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    d = doc["datasets"]["DroneRFb-DIR"]
    print(f"已冻结 {args.out}")
    print(f"  DroneRFb-DIR：验收集 {d['holdout_count']} 片，"
          f"其中从未在训练集出现的 6 架个体 {d['never_in_train_count']} 片；"
          f"排除 {d['excluded_count']} 片（已用于实验）")
    print(f"  DroneRFa：{doc['datasets']['DroneRFa']['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
