"""场景示例与 schema 的一致性测试（06 备忘录 §9C G-0）。

校验 data/scene/<aoi>/scenarios/*.scenario.json 全部满足 docs/schemas/scenario.schema.json，
并核对几条 schema 表达不了的约束：观测区域清单哈希对得上、航线引用的辐射源存在、
航线总时长不短于仿真时长、航点全部落在观测区域范围内。

schema 校验用 jsonschema（只在开发期用，不进交付包；运行时的语义校验由引擎 cuav_run 做）。

运行：
    uv run --quiet --with jsonschema python -m unittest discover -s tests/unit -p 'test_scenario*' -v
"""
from __future__ import annotations

import glob
import hashlib
import json
import math
import os
import unittest

import jsonschema

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SCHEMA = os.path.join(_ROOT, "docs", "schemas", "scenario.schema.json")
_PATTERN = os.path.join(_ROOT, "data", "scene", "*", "scenarios", "*.scenario.json")

# WGS-84，与 geo/ 新写代码同口径（决策 D-009：新代码统一 c = 299792458 与严格 ENU）
_A = 6378137.0
_F = 1.0 / 298.257223563
_E2 = _F * (2.0 - _F)


def _ecef(lon_deg: float, lat_deg: float, alt_m: float):
    lon = math.radians(lon_deg)
    lat = math.radians(lat_deg)
    n = _A / math.sqrt(1.0 - _E2 * math.sin(lat) ** 2)
    return (
        (n + alt_m) * math.cos(lat) * math.cos(lon),
        (n + alt_m) * math.cos(lat) * math.sin(lon),
        (n * (1.0 - _E2) + alt_m) * math.sin(lat),
    )


def _chord_m(a, b) -> float:
    """ECEF 弦长。与 geo/ 的 chord_distance_m 同式（08 报告 §9、决策 D-049）。"""
    pa = _ecef(a["lon"], a["lat"], a["alt_m"])
    pb = _ecef(b["lon"], b["lat"], b["alt_m"])
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(pa, pb)))


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class ScenarioExampleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(_SCHEMA, encoding="utf-8") as fh:
            cls.schema = json.load(fh)
        cls.files = sorted(glob.glob(_PATTERN))

    def test_at_least_one_example_exists(self):
        self.assertTrue(self.files, f"没有找到任何场景文件：{_PATTERN}")

    def test_all_scenarios_match_schema(self):
        for path in self.files:
            with self.subTest(path=os.path.relpath(path, _ROOT)):
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                jsonschema.validate(doc, self.schema)

    def test_filename_matches_scenario_id(self):
        for path in self.files:
            with self.subTest(path=os.path.relpath(path, _ROOT)):
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                stem = os.path.basename(path)[: -len(".scenario.json")]
                self.assertEqual(stem, doc["scenario_id"])

    def test_aoi_manifest_hash_matches(self):
        """aoi.manifest_sha256 必须是同目录上级 manifest.json 的真哈希，不留占位符。"""
        for path in self.files:
            with self.subTest(path=os.path.relpath(path, _ROOT)):
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                manifest = os.path.join(os.path.dirname(os.path.dirname(path)), "manifest.json")
                self.assertTrue(os.path.exists(manifest), f"缺观测区域清单：{manifest}")
                self.assertEqual(_sha256(manifest), doc["aoi"]["manifest_sha256"])
                with open(manifest, encoding="utf-8") as fh:
                    self.assertEqual(json.load(fh)["aoi"]["id"], doc["aoi"]["id"])

    def test_routes_reference_existing_emitters(self):
        for path in self.files:
            with self.subTest(path=os.path.relpath(path, _ROOT)):
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                ids = {e["id"] for e in doc["emitters"]}
                seen = set()
                for route in doc["routes"]:
                    self.assertIn(route["emitter_id"], ids)
                    self.assertNotIn(route["emitter_id"], seen, "一个辐射源至多一条航线")
                    seen.add(route["emitter_id"])
                for act in doc.get("activities", []):
                    self.assertIn(act["emitter_id"], ids)

    def test_emitter_position_matches_first_waypoint(self):
        """有航线时以航线第一个航点为准（docs/scenario-format.md §4）。"""
        for path in self.files:
            with self.subTest(path=os.path.relpath(path, _ROOT)):
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                by_id = {e["id"]: e for e in doc["emitters"]}
                for route in doc["routes"]:
                    self.assertEqual(by_id[route["emitter_id"]]["position"],
                                     route["waypoints"][0]["position"])

    def test_route_duration_covers_simulation(self):
        """航线走完的时刻不得早于仿真时长——否则后半段无人机停在末航点，演示里看着像卡住。"""
        for path in self.files:
            with self.subTest(path=os.path.relpath(path, _ROOT)):
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                for route in doc["routes"]:
                    wps = route["waypoints"]
                    total = sum(wp.get("loiter_s", 0.0) for wp in wps)
                    for i in range(len(wps) - 1):
                        total += _chord_m(wps[i]["position"], wps[i + 1]["position"]) / wps[i]["speed_mps"]
                    self.assertGreaterEqual(total, doc["time"]["duration_s"],
                                            f"航线 {route['emitter_id']} 只够 {total:.1f} s，"
                                            f"仿真要 {doc['time']['duration_s']} s")

    def test_all_positions_inside_aoi(self):
        """站点、辐射源与航点都要落在观测区域范围内：框外没有建筑数据，视距判定不可信。"""
        for path in self.files:
            with self.subTest(path=os.path.relpath(path, _ROOT)):
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                manifest = os.path.join(os.path.dirname(os.path.dirname(path)), "manifest.json")
                with open(manifest, encoding="utf-8") as fh:
                    west, south, east, north = json.load(fh)["aoi"]["bbox"]
                points = [s["position"] for s in doc["sites"]]
                points += [e["position"] for e in doc["emitters"]]
                for route in doc["routes"]:
                    points += [wp["position"] for wp in route["waypoints"]]
                for p in points:
                    self.assertTrue(west <= p["lon"] <= east and south <= p["lat"] <= north,
                                    f"({p['lon']}, {p['lat']}) 在观测区域之外")


if __name__ == "__main__":
    unittest.main()
