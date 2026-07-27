#!/usr/bin/env bash
# Manual deployment helper — mirrors the pipeline in services/deploy.service.js
# for cases where you want to trigger a deploy from the command line instead
# of the dashboard.
#
# Usage: ./scripts/deploy.sh <slug> <repo_url> <branch> <host_port> <container_port>

set -euo pipefail

SLUG="${1:?Usage: deploy.sh <slug> <repo_url> <branch> <host_port> <container_port>}"
REPO_URL="${2:?repo url required}"
BRANCH="${3:-main}"
HOST_PORT="${4:-4000}"
CONTAINER_PORT="${5:-3000}"

APPS_ROOT="${APPS_ROOT:-/opt/firebox/apps}"
APP_DIR="${APPS_ROOT}/${SLUG}"
IMAGE_TAG="firebox/${SLUG}:latest"
CONTAINER_NAME="firebox-${SLUG}"
NETWORK="${DOCKER_NETWORK:-firebox_net}"

echo "→ [1/7] Cloning ${REPO_URL} (${BRANCH})…"
rm -rf "$APP_DIR"
git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"

echo "→ [2/7] Detecting Node.js project…"
if [ ! -f "$APP_DIR/package.json" ]; then
  echo "✗ No package.json found — aborting." >&2
  exit 1
fi

echo "→ [3/7] Building Docker image ${IMAGE_TAG}…"
if [ ! -f "$APP_DIR/Dockerfile" ]; then
  cp "$(dirname "$0")/../docker/Dockerfile.node" "$APP_DIR/Dockerfile"
  sed -i "s/{{INSTALL_CMD}}/npm install/; s/{{BUILD_CMD}}//; s/{{START_CMD}}/npm start/; s/{{PORT}}/${CONTAINER_PORT}/" "$APP_DIR/Dockerfile"
fi
docker build -t "$IMAGE_TAG" "$APP_DIR"

echo "→ [4/7] Starting container ${CONTAINER_NAME}…"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker network create "$NETWORK" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER_NAME" --network "$NETWORK" \
  -p "${HOST_PORT}:${CONTAINER_PORT}" --restart unless-stopped "$IMAGE_TAG"

echo "→ [5/7] Configuring Nginx…"
bash "$(dirname "$0")/setup-nginx.sh" "$SLUG" "$HOST_PORT"

echo "→ [6/7] Generating SSL certificate…"
bash "$(dirname "$0")/generate-ssl.sh" "${SLUG}.${BASE_DOMAIN:-localhost}"

echo "→ [7/7] Done. App is live on port ${HOST_PORT}."
