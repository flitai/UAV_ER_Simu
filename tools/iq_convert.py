#!/usr/bin/env python3
"""DS-2 / DA-2：把公开数据集的 HDF5 转成本项目的复 int16 交织格式加旁挂清单。

规范：`docs/iq-format.md` 第 3、4 节。步骤：06 备忘录 §11.4 DS-2/DS-3、§11.5 DA-2/DA-3。

两条不可违反的规矩：
1. 无损断言失败即中止，不四舍五入蒙混（铁律 10）。
2. 缺元数据判 degraded，不拿默认值顶替（铁律 15）；两个数据集文件内都零元数据，
   采集参数一律标 field_sources=paper。

用法：
    uv run --project tools python tools/iq_convert.py <源.mat> -o <输出目录>
    uv run --project tools python tools/iq_convert.py <目录> -o <输出目录> --glob '*.mat'
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iq_format import manifest as M
from iq_format import calibration as CAL          # noqa: E402
from iq_format import readers, writer        # noqa: E402

VERSION = "0.1.0"
PRODUCER = f"tools/iq_convert.py {VERSION}"


def convert_one(src_path: str, out_dir: str, channel: str | None = None,
                segment_samples: int = writer.DEFAULT_SEGMENT_SAMPLES,
                overwrite: bool = False, verbose: bool = True,
                calibration: dict | None = None) -> list[str]:
    """转换一个源文件的一条或多条通道。返回写出的清单路径列表。

    calibration 是 iq_format.calibration.load_table() 读出的常数表；给了就把估算常数写进清单（D-047），
    不给则清单标 uncalibrated。标准命令带 --calibration data/iq/measured/calibration.json。
    """
    written: list[str] = []
    for src in readers.open_source(src_path, channel=channel):
        man_path = os.path.join(out_dir, f"{src.stem}.manifest.json")
        if os.path.exists(man_path) and not overwrite:
            if verbose:
                print(f"  跳过（清单已存在，加 --overwrite 可覆盖）：{src.stem}")
            continue

        t0 = time.time()
        w = writer.SegmentedWriter(out_dir, src.stem, segment_samples=segment_samples)
        peak_code = 0
        max_dev = 0.0
        n_done = 0
        for i_chunk, q_chunk in src.chunks():
            # 无损断言：任一块失败即中止，已写文件删除，不留半成品
            try:
                s_i = writer.assert_lossless(i_chunk)
                s_q = writer.assert_lossless(q_chunk)
            except writer.LossyConversionError:
                w.close()
                for p in w.paths():
                    os.path.exists(p) and os.remove(p)
                raise
            peak_code = max(peak_code, s_i["peak_code"], s_q["peak_code"])
            max_dev = max(max_dev, s_i["max_quantisation_deviation"],
                          s_q["max_quantisation_deviation"])
            w.write_chunk(writer.interleave(i_chunk, q_chunk))
            n_done += i_chunk.size
            if verbose and n_done % (40 * readers.CHUNK_SAMPLES) == 0:
                print(f"    {n_done / src.sample_count:5.0%}", end="\r", flush=True)
        w.close()

        ok = w.verify_readback()
        if not ok:
            raise RuntimeError(f"逐段回读对拍失败：{src.stem}，已写文件保留供排查")

        man = _build_manifest(src, w, peak_code, max_dev, ok, time.time() - t0)
        if calibration is not None:
            CAL.apply(man, calibration)
        problems = M.validate(man)
        if problems:
            raise RuntimeError("清单未通过 docs/iq-format.md 第 4 节校验：\n  - "
                               + "\n  - ".join(problems))
        with open(man_path, "w", encoding="utf-8") as fh:
            json.dump(man, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        written.append(man_path)
        if verbose:
            peak_dbfs = 20 * np.log10(peak_code / writer.FULL_SCALE) if peak_code else float("-inf")
            print(f"  {src.stem}: {w.sample_count} 样点、{len(w.paths())} 段、"
                  f"峰值码 {peak_code}（{peak_dbfs:.1f} dBFS）、回读对拍通过、"
                  f"质量 {man['quality']['status']}、{time.time() - t0:.1f} s")
    return written


def _build_manifest(src: readers.SourceRead, w: writer.SegmentedWriter,
                    peak_code: int, max_dev: float, readback_ok: bool,
                    elapsed_s: float) -> dict:
    man = M.new_manifest("S4")
    man["identity"].update({
        "data_id": src.stem,
        "content_sha256": w.content_sha256,
        "producer": PRODUCER,
    })
    man["sampling"].update({
        "sample_rate_Hz": src.sample_rate_Hz,
        "sample_count": w.sample_count,
    })
    man["frequency"].update({
        "center_frequency_Hz": src.center_frequency_Hz,
        "effective_bandwidth_Hz": src.effective_bandwidth_Hz,
    })
    man["time"].update({
        "start_time": None,
        "time_basis": src.time_basis,
        "continuity": {"flag": src.continuity_flag, "note": src.continuity_note},
    })
    man["channel"].update({
        "station_id": "unknown",
        "channel_id": src.channel_id,
        "antenna": src.antenna,
    })
    man["power"].update({
        "scale": None,
        "gain_dB": src.gain_dB,
        "agc": "unknown",
        "absolute_power": "uncalibrated",
        "reason": "缺馈线损耗与一次功率标定常数，量化码无法换算 dBm",
    })
    man["origin"].update({
        "kind": "measured",
        "dataset": src.dataset,
        "doi": src.doi,
        "source_file": src.source_file,
        "source_sha256": None,
        "conversion": {
            "tool": PRODUCER,
            "lossless": True,
            "assertion": "每样点为 2^-15 的整数倍，最大量化偏差 "
                         f"{max_dev:.3e} 个量化码",
            "readback_bitexact": readback_ok,
            "peak_code": peak_code,
            "peak_dBFS": (float(20 * np.log10(peak_code / writer.FULL_SCALE))
                          if peak_code else None),
            "source_channel": src.channel_id,
            "elapsed_s": round(elapsed_s, 1),
            "note": "源为 HDF5 分离 I/Q 浮点数组，转复 int16 交织；数值无损，未做任何滤波或重采样",
        },
    })
    man["model_trace"].update({
        # 实测数据不经模型产生，model_id 记为 measured:<数据集>（docs/iq-format.md 第 4.2 节）
        "model_id": f"measured:{src.dataset}",
        "model_version": "dataset-as-published",
        "model_level": "E4",          # 实测融合档（01 号方案 E 精度）
        "model_layer": "M3",          # IQ 级
        "credibility": src.credibility,
        "parameter_version": "paper-2026-09-03",
        "confidence": None,
        "trace_id": f"convert:{src.stem}",
    })
    man["truth"] = src.truth
    man["permission"].update(src.permission)
    man["segments"] = w.segment_index()
    man["field_sources"] = dict(src.field_sources)

    # 转换阶段能定的四项质检；其余四项留给 iq_survey.py 跑样点检查后回填
    checks = man["quality"]["checks"]
    checks["length_format_metadata"] = M.VALID if readback_ok else M.INVALID
    checks["iq_order_endian_range"] = M.VALID
    checks["hash_duplicate"] = M.VALID
    checks["multichannel_alignment"] = M.NOT_APPLICABLE   # 单通道；不适用不等于通过
    # 元数据必填项：文件内零元数据、采集参数来自论文，按铁律 15 判 degraded
    checks["metadata_required_units"] = M.DEGRADED

    reasons = list(src.quality_reasons)
    if src.truth is None:
        reasons.append("真值缺失，未能从数据集标签文件解析")
    man["quality"]["reasons"] = reasons
    man["quality"]["status"] = M.worst(*checks.values())
    return man


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DS-2 / DA-2 转换脚本")
    ap.add_argument("source", help="源 .mat 文件或目录")
    ap.add_argument("-o", "--out", required=True, help="输出目录")
    ap.add_argument("--channel", default=None,
                    help="DroneRFa 通道，默认 RF0（RF1 实测无内容，见 D-018）")
    ap.add_argument("--glob", default="*.mat", help="源为目录时的匹配式")
    ap.add_argument("--segment-samples", type=int, default=writer.DEFAULT_SEGMENT_SAMPLES)
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--limit", type=int, default=None, help="只转前 N 个文件")
    ap.add_argument("--calibration", default=None,
                    help="功率标定常数表（data/iq/measured/calibration.json）；给了就写估算常数进清单（D-047）")
    args = ap.parse_args(argv)
    table = CAL.load_table(args.calibration) if args.calibration else None

    if os.path.isdir(args.source):
        import glob as _glob
        srcs = sorted(_glob.glob(os.path.join(args.source, args.glob)))
    else:
        srcs = [args.source]
    if args.limit:
        srcs = srcs[:args.limit]
    if not srcs:
        print("没有匹配到源文件", file=sys.stderr)
        return 2

    print(f"待转换 {len(srcs)} 个源文件 → {args.out}")
    n_ok = 0
    for i, s in enumerate(srcs, 1):
        print(f"[{i}/{len(srcs)}] {os.path.basename(s)}")
        try:
            convert_one(s, args.out, channel=args.channel,
                        segment_samples=args.segment_samples, overwrite=args.overwrite,
                        calibration=table)
            n_ok += 1
        except (writer.LossyConversionError, ValueError, RuntimeError) as e:
            print(f"  失败：{e}", file=sys.stderr)
    print(f"完成 {n_ok}/{len(srcs)}")
    return 0 if n_ok == len(srcs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
