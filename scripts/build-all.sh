#!/bin/sh
# 依次构建全部子工程并跑测试。
#
# 注意：本脚本在 macOS 开发机上的运行结果**不作为验收依据**（决策 D-015、D-016）。
# 打包与性能数字只认目标平台的原生验证：客户端与单机包用 Windows x64，
# 集中部署的服务端用 Windows 或 Linux x64。
#
# 用法：scripts/build-all.sh

set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

printf '=== web ===\n'
(cd web && npm run build)

printf '=== server ===\n'
(cd server && npm run build)

for proj in engine geo; do
  printf '=== %s ===\n' "$proj"
  cmake -S "$proj" -B "$proj/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$proj/build"
  ctest --test-dir "$proj/build" --output-on-failure
done

printf '=== 跨层一致性算例 ①：典型链路实例（C-5，D-067）===\n'
# 解析检出率（EM-S-02，D-026）对典型链路跑出的帧级检出率，差 ≤ 0.05；超差是发现不是失败——脚本退出码 1 会让本脚本停下。
if command -v uv >/dev/null 2>&1 && [ -x "$root/engine/build/cuav_run" ]; then
  uv run --quiet --with numpy python tests/regression/crosslayer_pd_chain.py
else
  echo "跳过：需要 uv 与 engine/build/cuav_run（两者缺一）" >&2
fi

printf '=== 04 §15.2 标准算例：从保存的典型链路核对（C-11）===\n'
# 十二项里覆盖 1、2、3、6、9、10、11 七项；5 / 7 / 8 由 C-10 的三级夹具与引擎单测覆盖，4 / 12 随后续。
# 实测回放与混合增强两项要 data/iq/measured/（不入 git），缺数据时脚本自己明说跳过、不当作通过。
if command -v uv >/dev/null 2>&1 && [ -x "$root/engine/build/cuav_run" ]; then
  uv run --quiet --with numpy python tests/regression/standard_cases.py
else
  echo "跳过：需要 uv 与 engine/build/cuav_run（两者缺一）" >&2
fi

printf '=== E3 建筑遮挡：从保存的典型链路核对（D3-5，D-074）===\n'
# 视距由建筑几何给出、刀口损耗只进 extra_loss_dB、恒等式照旧成立、07 §1.5 的起飞点锚点。
# 要真实建筑集 data/scene/<aoi>/buildings.geojson（不入 git），缺数据时脚本自己明说跳过、不当作通过。
if command -v uv >/dev/null 2>&1 && [ -x "$root/engine/build/cuav_run" ]; then
  uv run --quiet python tests/regression/e3_occlusion_chain.py
else
  echo "跳过：需要 uv 与 engine/build/cuav_run（两者缺一）" >&2
fi

echo "=== 常数策略守卫（D-009）==="
# `geo::legacy::` 里是自 emcore 移植时保留的旧常数（111320 投影、10 MHz 标称带宽等），
# 它们存在的唯一理由是守住那几份黄金基准。新写代码一律用严格 ENU 与精确光速，
# 所以这些符号只允许出现在 golden 与 legacy 文件里——顺手在别处用了，这里就拦下来。
#
# **一条写明理由的窄例外（D3-3，D-074 / 07 报告 §6.4）**：`geo/src/occlusion.cpp` 允许调
# `legacy::fresnel_v` 与 `legacy::knife_edge_loss_dB`，引擎实际运行也走它们。理由是刀口衍射
# 这一整套（两式 + 适配器几何）是被 tests/golden/occlusion.json 的 148 例**整体**钉住的一个模块，
# 只把其中的光速常数换成精确值会让模块内部自相矛盾——几何走严格站心坐标、波长却走旧光速。
# 量级：两个光速常数在刀口损耗上差约 3e-3 dB（07 §14.3 修正过这个数），物理无关紧要，
# 1e-9 的黄金基准上却是硬伤。例外只此一处一文件两符号，别处照拦。
bad_legacy=$(grep -rn 'legacy::' "$root/engine/src" "$root/engine/tools" "$root/geo/src" 2>/dev/null \
  | grep -v '/legacy_' | grep -v '_golden' | grep -v 'namespace legacy' \
  | grep -vE 'geo/src/occlusion\.cpp:[0-9]+:.*legacy::(fresnel_v|knife_edge_loss_dB)' || true)
if [ -n "$bad_legacy" ]; then
  echo "$bad_legacy"
  echo "错误：geo::legacy 只允许在 golden 回放与 legacy_*.cpp 里用（D-009）。" >&2
  exit 1
fi
echo "常数策略检查通过：legacy 常数没有渗进新代码。"

echo "=== 渲染—物理同源守卫（铁律 11，D4 / D-076）==="
# 遮挡这一侧（web/src/scene/occlusion/ 与 geo/）**不认识地图**：不引 maplibre、不查渲染要素、
# 不碰瓦片源。这样「瓦片 buildings 层永不进遮挡计算」（铁律 11、D-002）是结构上成立的，
# 而不是「目前碰巧没人这么写」。要同时读地图与桶网格的胶水放在 web/src/scene/sameSourceProbe.ts，
# 那是开发者模式的核对命令，不参与任何物理计算。
bad_render=$(grep -rn "maplibre\|queryRenderedFeatures\|getStyle\|source-layer" \
  "$root/web/src/scene/occlusion" "$root/geo/include" "$root/geo/src" 2>/dev/null || true)
if [ -n "$bad_render" ]; then
  echo "$bad_render"
  echo "错误：遮挡侧不得引用地图渲染（铁律 11：同源指同一份数据，不是同一份内存）。" >&2
  exit 1
fi
echo "同源守卫通过：遮挡侧没有引用地图渲染。"

printf '=== 路径检查 ===\n'
sh scripts/check-paths.sh

printf '=== ASCII 检查 ===\n'
sh scripts/check-ascii.sh

printf '\n全部子工程构建完成。\n'
