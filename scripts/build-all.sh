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

printf '=== ASCII 检查 ===\n'
sh scripts/check-ascii.sh

printf '\n全部子工程构建完成。\n'
