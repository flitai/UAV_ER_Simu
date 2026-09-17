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

echo "=== 常数策略守卫（D-009）==="
# `geo::legacy::` 里是自 emcore 移植时保留的旧常数（111320 投影、10 MHz 标称带宽等），
# 它们存在的唯一理由是守住那几份黄金基准。新写代码一律用严格 ENU 与精确光速，
# 所以这些符号只允许出现在 golden 与 legacy 文件里——顺手在别处用了，这里就拦下来。
bad_legacy=$(grep -rn 'legacy::' "$root/engine/src" "$root/engine/tools" "$root/geo/src" 2>/dev/null \
  | grep -v '/legacy_' | grep -v '_golden' | grep -v 'namespace legacy' || true)
if [ -n "$bad_legacy" ]; then
  echo "$bad_legacy"
  echo "错误：geo::legacy 只允许在 golden 回放与 legacy_*.cpp 里用（D-009）。" >&2
  exit 1
fi
echo "常数策略检查通过：legacy 常数没有渗进新代码。"

printf '=== 路径检查 ===\n'
sh scripts/check-paths.sh

printf '=== ASCII 检查 ===\n'
sh scripts/check-ascii.sh

printf '\n全部子工程构建完成。\n'
