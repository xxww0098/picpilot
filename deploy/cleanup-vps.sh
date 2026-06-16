#!/bin/bash
# PicPilot VPS 遗留存档清理：旧镜像、废弃卷、构建缓存、历史数据目录。
# 默认保留当前运行版本 + 上一版 auth 镜像（回滚用）。
set -euo pipefail

DRY_RUN=false
KEEP_VERSIONS=2
PROJECT_DIR="/root/picpilot"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --keep) KEEP_VERSIONS="$2"; shift 2 ;;
    -h|--help)
      echo "用法: cleanup-vps.sh [--dry-run] [--keep N]"
      echo "  --dry-run  只打印将删除的内容，不执行"
      echo "  --keep N   保留最近 N 个 picpilot-api 版本镜像（默认 2）"
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

run() {
  if $DRY_RUN; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}

current_picpilot_image() {
  docker inspect picpilot --format '{{.Config.Image}}' 2>/dev/null | sed -E 's/^picpilot-(api|auth)://'
}

echo ">>> PicPilot VPS 清理"
$DRY_RUN && echo "    （预览模式，不实际删除）"

# --- 确定要保留的 picpilot-api 版本 ---
CURRENT="$(current_picpilot_image)"
if [[ -z "$CURRENT" ]]; then
  CURRENT="$(node -p "require('$PROJECT_DIR/package.json').version" 2>/dev/null || true)"
fi

KEEP_TAGS=()
if [[ -n "$CURRENT" ]]; then
  KEEP_TAGS+=("$CURRENT")
fi
# 按版本号排序，额外保留最近的 N-1 个
mapfile -t ALL_TAGS < <(docker images picpilot-api --format '{{.Tag}}' 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n -r || true)
for tag in "${ALL_TAGS[@]}"; do
  [[ " ${KEEP_TAGS[*]} " == *" $tag "* ]] && continue
  KEEP_TAGS+=("$tag")
  [[ ${#KEEP_TAGS[@]} -ge $KEEP_VERSIONS ]] && break
done

echo ">>> 保留 picpilot-api 镜像: ${KEEP_TAGS[*]:-(无)}"

# --- 1. 删除废弃 frontend 镜像（双层架构已移除）---
if [[ -n "$(docker images picpilot-frontend -q 2>/dev/null)" ]]; then
  echo ">>> 删除 picpilot-frontend 镜像..."
  if $DRY_RUN; then
    docker images picpilot-frontend --format '  {{.Repository}}:{{.Tag}}'
  else
    docker rmi -f $(docker images picpilot-frontend -q) 2>/dev/null || true
  fi
fi

# --- 2. 删除测试/临时镜像 ---
echo ">>> 删除测试/临时镜像..."
while read -r img; do
  [[ -z "$img" ]] && continue
  run "docker rmi -f '$img' 2>/dev/null || true"
done < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'picpilot-api-.*-test|picpilot-auth-.*-test|picpilot-frontend-check|picpilot-api:latest|picpilot-auth:latest' || true)

# --- 3. 删除旧版 picpilot-api 镜像（保留 KEEP_TAGS）---
echo ">>> 删除旧版 picpilot-api 镜像..."
while read -r tag; do
  [[ -z "$tag" ]] && continue
  keep=false
  for k in "${KEEP_TAGS[@]}"; do
    [[ "$tag" == "$k" ]] && keep=true
  done
  $keep && continue
  run "docker rmi -f 'picpilot-api:$tag' 2>/dev/null || true"
done < <(docker images picpilot-api --format '{{.Tag}}' 2>/dev/null || true)

# --- 3b. 清理旧镜像名 picpilot-auth（已改名为 picpilot-api）---
echo ">>> 删除遗留 picpilot-auth 镜像..."
while read -r tag; do
  [[ -z "$tag" ]] && continue
  run "docker rmi -f 'picpilot-auth:$tag' 2>/dev/null || true"
done < <(docker images picpilot-auth --format '{{.Tag}}' 2>/dev/null || true)

# --- 4. 遗留数据目录（已迁移到 /opt/cliproxyapi）---
LEGACY_DATA=(
  /opt/picpilot/data/cliproxy
  /opt/picpilot/data/cliproxyapiapi
  /opt/picpilot/data/auth.db
)
echo ">>> 清理遗留数据目录..."
for p in "${LEGACY_DATA[@]}"; do
  [[ -e "$p" ]] || continue
  run "rm -rf '$p'"
done
# 应用内 _deleted_backup_* 目录
while read -r p; do
  [[ -z "$p" ]] && continue
  run "rm -rf '$p'"
done < <(find /opt/picpilot/data/picpilot -maxdepth 1 -type d -name '_deleted_backup_*' 2>/dev/null || true)

# --- 5. 废弃 Docker 卷（保留 picpilot_caddy_data）---
echo ">>> 清理悬空卷..."
if $DRY_RUN; then
  docker volume ls -qf dangling=true 2>/dev/null | while read -r v; do
    [[ "$v" == "picpilot_caddy_data" ]] && continue
    echo "  volume: $v"
  done
  while read -r v; do
    [[ "$v" == "picpilot_caddy_data" ]] && continue
    if ! docker ps -a --filter volume="$v" --format '{{.Names}}' 2>/dev/null | grep -q .; then
      echo "  unused volume: $v"
    fi
  done < <(docker volume ls --format '{{.Name}}' | grep -v '^picpilot_caddy_data$' || true)
else
  docker volume rm docker_file_caddy_data 2>/dev/null || true
  docker volume prune -f
fi

# --- 6. 构建缓存 ---
echo ">>> 清理构建缓存..."
run "docker builder prune -af"

# --- 7. 仓库 deploy 遗留日志 ---
echo ">>> 清理仓库 deploy/cliproxyapi/logs 中的 .log 文件..."
run "find '$PROJECT_DIR/deploy/cliproxyapi/logs' -maxdepth 1 -name '*.log' -delete 2>/dev/null || true"

echo ""
if $DRY_RUN; then
  echo ">>> 预览完成。去掉 --dry-run 执行实际清理。"
else
  echo ">>> 清理完成。运行健康检查..."
  bash /opt/picpilot/verify-vps.sh 2>/dev/null || bash "$PROJECT_DIR/deploy/verify-vps.sh"
  echo ""
  docker system df
fi