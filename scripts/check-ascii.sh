#!/bin/sh
# 检查指定目录下是否存在非 ASCII 的文件名或目录名。
#
# 为什么必须检查（铁律 15）：Web 资源与数据包的文件名含非 ASCII 字符时，在 macOS 上打包、
# 到 Windows 上解压会乱码，导致运行时 404。这是继承自既有项目的已知坑。
#
# 用法：scripts/check-ascii.sh [目录...]
#       不给参数时默认检查 web/dist 与 data/scene。
#
# 返回值：0 表示全部合规；1 表示发现非 ASCII 名称（并列出）。

set -eu

if [ "$#" -eq 0 ]; then
  set -- web/dist data/scene
fi

status=0
for target in "$@"; do
  if [ ! -e "$target" ]; then
    printf '跳过（不存在）：%s\n' "$target"
    continue
  fi
  # LC_ALL=C 保证按字节比较；[^ -~] 匹配可打印 ASCII 之外的任何字节。
  bad=$(find "$target" | LC_ALL=C grep -n '[^ -~]' || true)
  if [ -n "$bad" ]; then
    printf '不合规：%s 下存在非 ASCII 名称\n' "$target"
    printf '%s\n' "$bad"
    status=1
  else
    printf '合规：%s\n' "$target"
  fi
done

if [ "$status" -eq 0 ]; then
  printf 'ASCII 检查通过。\n'
else
  printf 'ASCII 检查失败。出包前必须改名。\n'
fi
exit "$status"
