#!/bin/bash
set -euo pipefail

COMPOSE_DIR="${CLIPROXYAPI_COMPOSE_DIR:-/opt/cliproxyapi}"
SERVICE="cliproxyapi"

if [ ! -f "$COMPOSE_DIR/compose.yml" ]; then
  echo "Missing $COMPOSE_DIR/compose.yml; set CLIPROXYAPI_COMPOSE_DIR to the cliproxyapi compose directory." >&2
  exit 1
fi

cd "$COMPOSE_DIR"

echo "[$(date)] Pulling latest $SERVICE image..."
docker compose pull "$SERVICE"

echo "[$(date)] Recreating $SERVICE if updated..."
docker compose up -d "$SERVICE"

echo "[$(date)] Pruning old images..."
docker image prune -f --filter "until=24h"

echo "[$(date)] Done."
docker compose ps "$SERVICE"
