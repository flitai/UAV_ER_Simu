"""把 data/iq/measured/calibration.json 的功率标定常数刷进一批已有的旁挂清单（DS-8 / DA-8，决策 D-047）。

只改清单的 power / field_sources / quality 三处，不读 .iq、不改 content_sha256；与 tools/iq_convert.py
--calibration 重新转换得到的清单逐字节相同（同一个 iq_format.calibration.apply()）。

用法：uv run --quiet --with numpy python tools/apply_calibration.py data/iq/measured/dronerfb [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iq_format import calibration as C   # noqa: E402
from iq_format import manifest as M      # noqa: E402
from iq_format import store              # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def refresh(directory: str, table: dict, dry_run: bool = False) -> dict:
    counts = {"seen": 0, "applied": 0, "skipped_no_entry": 0, "unchanged": 0, "invalid": 0}
    for p in store.list_products(directory):
        man_path = os.path.join(directory, p.stem + ".manifest.json")
        with open(man_path, encoding="utf-8") as fh:
            before = fh.read()
        man = json.loads(before)
        counts["seen"] += 1
        if not C.apply(man, table):
            counts["skipped_no_entry"] += 1
            continue
        problems = M.validate(man)
        if problems:
            counts["invalid"] += 1
            print(f"  {p.stem}: 施加后清单未通过校验：{problems[0]}", file=sys.stderr)
            continue
        after = json.dumps(man, ensure_ascii=False, indent=2) + "\n"
        if after == before:
            counts["unchanged"] += 1
            continue
        counts["applied"] += 1
        if not dry_run:
            tmp = man_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(after)
            os.replace(tmp, man_path)
    return counts


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="刷新旁挂清单里的功率标定常数（D-047）")
    ap.add_argument("directory", help="批目录，如 data/iq/measured/dronerfb")
    ap.add_argument("--calibration", default=os.path.join(ROOT, C.TABLE_REL_PATH))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    table = C.load_table(args.calibration)
    counts = refresh(args.directory, table, dry_run=args.dry_run)
    print(f"{os.path.relpath(args.directory, ROOT)}：共 {counts['seen']} 份，"
          f"写入 {counts['applied']}，已是最新 {counts['unchanged']}，"
          f"无对应常数 {counts['skipped_no_entry']}，校验失败 {counts['invalid']}"
          f"{'（试运行，未写盘）' if args.dry_run else ''}")
    return 0 if counts["invalid"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
