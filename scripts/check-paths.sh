#!/bin/sh
# 检查入库文件里有没有**机器相关的绝对路径**。
#
# 为什么必须检查：写死 `/Users/...` 这类路径的代码，在项目整体迁移、换一台机器、或者换到
# Windows 之后全部失效；产物清单里写死绝对路径则会让清单不再可核对。所有路径都必须从文件
# 自身位置推导（Python 用 `__file__`，Node 用 `import.meta.url`，CMake 用
# `CMAKE_CURRENT_SOURCE_DIR`），或者由命令行参数与环境变量给入。
#
# 判据：出现 `/Users/`、`/home/<用户名>`、`X:\Users\` 即为不合规。
# 系统目录（`/Applications/`、`/usr/bin/`、`C:/Program Files/`）不在此列——那是查找浏览器、
# 编译器这类系统件的正当位置，不随项目迁移而变。
#
# 唯一的例外：数据产物清单里记录**外部历史来源**的 `origin` 与 `dev_link_target` 字段。
# 它们是"这份副本当初从哪里拷来"的留档，不是可解析的位置，任何代码都不得去解析它们。
#
# 用法：scripts/check-paths.sh
# 返回值：0 合规；1 发现机器相关的绝对路径。

set -eu
cd "$(dirname "$0")/.."

PATTERN='/Users/|/home/[a-z]|[A-Za-z]:\\Users\\'
FILES='*.py *.ts *.tsx *.js *.mjs *.sh *.json *.toml *.cmake *.cpp *.h *.hpp *.txt *.bat'

# shellcheck disable=SC2086
hits=$(git grep -nE "$PATTERN" -- $FILES 2>/dev/null \
  | grep -vE '^data/[^:]*\.manifest\.json:[0-9]+: *"(origin|origin_note|dev_link_target)"' \
  || true)

if [ -n "$hits" ]; then
  printf '不合规：入库文件里存在机器相关的绝对路径\n\n'
  printf '%s\n' "$hits"
  printf '\n改法：路径从文件自身位置推导（Python 用 __file__，Node 用 import.meta.url），\n'
  printf '或由命令行参数、环境变量给入。产物清单里仓库内的路径写成相对仓库根目录的形式。\n'
  exit 1
fi

printf '路径检查通过：入库文件里没有机器相关的绝对路径。\n'
