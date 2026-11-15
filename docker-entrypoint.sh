#!/bin/sh
# 容器启动脚本：
#   1. 修正 /app/data 权限（宿主机挂载目录可能属于别的 uid）
#   2. 没有索引时先扫描
#   3. 降权到 app 用户启动服务
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
LIB="${LIBRARY_PATH:-$DATA_DIR/library.json}"
RUN_AS_ROOT=0
[ "$(id -u)" = "0" ] && RUN_AS_ROOT=1

if [ "$RUN_AS_ROOT" = "1" ]; then
  mkdir -p "$DATA_DIR"
  chown -R app:app "$DATA_DIR" 2>/dev/null || echo "[entrypoint] 警告：无法修改 $DATA_DIR 权限，扫描可能因权限不足失败"
fi

# --- 首次扫描 ---
MODE="${SCAN_ON_START:-auto}"
should_scan=0
case "$MODE" in
  always) should_scan=1 ;;
  never) should_scan=0 ;;
  *) [ -f "$LIB" ] || should_scan=1 ;;
esac

run_node() {
  if [ "$RUN_AS_ROOT" = "1" ]; then
    su-exec app "$@"
  else
    "$@"
  fi
}

if [ "$should_scan" = "1" ]; then
  echo "[entrypoint] 未找到节目库索引 ${LIB}，开始扫描 WebDAV…"
  echo "[entrypoint] 大库首次扫描可能几十分钟；也可另开终端执行：docker compose run --rm anime-rotator node src/cli/scan.mjs"
  run_node node src/cli/scan.mjs || echo "[entrypoint] 扫描失败：请检查 WEBDAV_* 环境变量与网络连通性"
fi

[ -f "$LIB" ] || echo "[entrypoint] 警告：仍无索引文件，接口会报错；可稍后手动扫描后重启容器"

# --- 降权启动 ---
run_node "$@"
