#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if command -v python3 >/dev/null 2>&1; then
  python3 install.py
else
  print '需要 Python 3 来安装本地文件组件。'
  exit 1
fi
print '完成。可以关闭此窗口。'
