#!/usr/bin/env python3
"""正式集配套文档包（Q-7，D-106）：两份新文档 + 机器可读的基准结果 + 可信性验证报告 v1.4 + 一页说明，另成一个小包。

数据包（`cuav-eval-<集合>.zip`）与其 README 一字不动（用户 2026-10-12：已发或不想重传，文档另成一包）。

步骤：
1. 输入的入库文件（验证快照、基准结果、格子文件、真实感对照 JSON、本目录的生成器）有未提交改动即拒（`--allow-dirty` 跳过）；
2. 重新生成两份文档与机器可读结果，拷入可信性验证报告（核对它是 v1.4）；
3. 写说明 `README.md`（含对应数据包 zip 的 SHA-512）与 `SHA512SUMS`；
4. 出包前检查：文件名纯 ASCII、没有本机路径、正文没有决策编号与内部步骤号；
5. 用单机包同一个 `deploy/pack.py` 的 write_zip 出确定性 zip（时间戳取输入最后一次提交的时间），再写 `.sha512` 旁挂。

产物在 `data/eval/<集合>/docs/` 与 `data/eval/<集合>/cuav-eval-<集合>-docs.zip`（都不入 git，同一输入逐字节重出）。

用法：python3 scripts/q7/pack_docs.py [--set formal-v1] [--allow-dirty]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "deploy"))
import baseline_doc  # noqa: E402
import model_doc  # noqa: E402
import pack as P  # noqa: E402

REALISM_SRC = ("data", "eval", "realism-v2", "realism-report.html")
REALISM_VERSION = "v1.4"
INTERNAL = re.compile(r"D-\d{3}|\bQ-\d")

README = """# {name}：配套文档

本包是数据包 `{data_zip}` 的配套文档，不含 IQ 数据。数据包与其中的数据说明（`README.md`）不变。

| 文件 | 内容 |
|---|---|
| `model-verification.html` | 《仿真模型与实现验证说明》{model_v}：生成数据所用的模型、公式、参数出处与可信度等级，以及实现的校核结果 |
| `realism-report.html` | 《无人机射频 IQ 信号仿真方法与可信性验证报告》{realism_v}：仿真数据与公开实测数据的统计比较 |
| `baseline-results.html` | 《本方基准结果》{baseline_v}：本方检测识别算法在数据集观测点 S4 上的结果 |
| `baseline-results.json` | 《本方基准结果》的逐段结果，机器可读；字段定义见该报告附录 B |
| `SHA512SUMS` | 本包内其余文件的 SHA-512，可用 `shasum -a 512 -c SHA512SUMS` 核对 |

三份报告各为一个 HTML 文件，图片内嵌，可离线用浏览器打开。建议阅读顺序：先读《仿真模型与实现验证说明》，再读《无人机射频 IQ 信号仿真方法与可信性验证报告》，最后读《本方基准结果》。

对应的数据包：`{data_zip}`，SHA-512 为

```
{data_sha512}
```

本包内的全部数值为原型阶段结果。
"""


def rp(*p: str) -> str:
    return os.path.join(ROOT, *p)


def sha512(path: Path) -> str:
    h = hashlib.sha512()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--set", default="formal-v1")
    ap.add_argument("--allow-dirty", action="store_true")
    a = ap.parse_args(argv)
    base = Path(rp("data", "eval", a.set))
    docs = base / "docs"
    tracked = [f"data/eval/{a.set}/verification.json", f"data/eval/{a.set}/baseline.json",
               f"tests/regression/eval-dataset/{a.set}.json", "data/eval/realism-v2/realism.json", "scripts/q7"]
    st = subprocess.run(["git", "status", "--porcelain", "--", *tracked], cwd=ROOT, capture_output=True, text=True).stdout
    if st.strip() and not a.allow_dirty:
        raise SystemExit(f"文档包的输入有未提交改动，先提交再打包（--allow-dirty 跳过）：\n{st}")
    when_s = subprocess.run(["git", "log", "-1", "--format=%ct", "--", *tracked], cwd=ROOT, capture_output=True,
                            text=True).stdout.strip()
    if not when_s:
        raise SystemExit("文档包的输入还没有提交过")
    when = dt.datetime.fromtimestamp(int(when_s), dt.timezone.utc)

    if docs.exists():
        shutil.rmtree(docs)
    docs.mkdir(parents=True)
    model_doc.main(["--set", a.set, "--out", str(docs / "model-verification.html")])
    baseline_doc.main(["--set", a.set, "--out-dir", str(docs)])
    realism = Path(rp(*REALISM_SRC))
    text = realism.read_text(encoding="utf-8")
    if f"<td>版本</td><td>{REALISM_VERSION}</td>" not in text:
        raise SystemExit(f"真实感对照报告不是 {REALISM_VERSION}：先按机型参数 v2 重出它")
    shutil.copyfile(realism, docs / "realism-report.html")

    data_zip = base / f"cuav-eval-{a.set}.zip"
    side = Path(str(data_zip) + ".sha512")
    if not side.exists():
        raise SystemExit(f"没有数据包的 SHA-512 旁挂：{side.name}")
    data_sha = side.read_text(encoding="utf-8").split()[0]
    cells = model_doc.load("tests", "regression", "eval-dataset", f"{a.set}.json")
    (docs / "README.md").write_text(README.format(
        name=cells["name"], data_zip=data_zip.name, data_sha512=data_sha, model_v=model_doc.VERSION,
        baseline_v=baseline_doc.VERSION, realism_v=REALISM_VERSION), encoding="utf-8", newline="\n")

    files = sorted(p.relative_to(docs).as_posix() for p in docs.rglob("*") if p.is_file())
    nonascii = [f for f in files if not f.isascii()]
    leak = [f for f in files if P.MACHINE_PATH.search((docs / f).read_text(encoding="utf-8", errors="replace"))]
    internal = [f for f in files if INTERNAL.search((docs / f).read_text(encoding="utf-8", errors="replace"))]
    if nonascii or leak or internal:
        raise SystemExit(f"出包前检查不过：非 ASCII 文件名 {nonascii}、本机路径 {leak}、内部编号 {internal}")
    (docs / "SHA512SUMS").write_text("".join(f"{sha512(docs / f)}  {f}\n" for f in files), encoding="utf-8",
                                     newline="\n")
    stage = P.Stage(docs)
    for f in files + ["SHA512SUMS"]:
        stage.files[f] = ((docs / f).stat().st_size, "")
    name = f"cuav-eval-{a.set}-docs"
    zpath = P.write_zip(stage, name, when, base)
    Path(str(zpath) + ".sha512").write_text(f"{sha512(zpath)}  {zpath.name}\n", encoding="utf-8", newline="\n")
    print(f"写了 {os.path.relpath(zpath, ROOT)}（{zpath.stat().st_size} 字节，{len(files) + 1} 个文件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
