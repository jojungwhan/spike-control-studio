#!/usr/bin/env bash
# Rebuild the web app and publish the static bundle to a host you configure.
#
# Host-specific values are NOT in this repo. Copy deploy/publish.env.example to
# deploy/publish.env (git-ignored) and fill it in. See deploy/README.md.
#
# Publishing points PUBLISH_LINK at apps/web/dist as a symlink, so a web server
# that reads its static root from disk on each request picks up a new build with
# no restart of anything.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/apps/web/dist"
ENV_FILE="$REPO/deploy/publish.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE — copy deploy/publish.env.example and fill it in" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

: "${PUBLISH_LINK:?PUBLISH_LINK is not set in $ENV_FILE}"
: "${PUBLISH_URL:?PUBLISH_URL is not set in $ENV_FILE}"
BASE="${PUBLISH_BASE_PATH:-/spike/}"

echo "building for $BASE ..."
cd "$REPO"
BASE_PATH="$BASE" pnpm --filter @spike/web build

# Re-point the symlink every time: cheap, and it self-heals if the target moved.
if [ -e "$PUBLISH_LINK" ] && [ ! -L "$PUBLISH_LINK" ]; then
  echo "refusing to replace $PUBLISH_LINK — it exists and is not a symlink" >&2
  exit 1
fi
ln -sfn "$DIST" "$PUBLISH_LINK"

echo "verifying ..."
code=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLISH_URL")
if [ "$code" != "200" ]; then
  echo "published but $PUBLISH_URL returned HTTP $code" >&2
  exit 1
fi

# A host with an SPA fallback can answer 200 with its own index, so confirm the
# response is actually this app.
if ! curl -s "$PUBLISH_URL" | grep -q "SPIKE Control Studio"; then
  echo "$PUBLISH_URL returned 200 but not this app — check the symlink and any SPA fallback" >&2
  exit 1
fi

echo "live: $PUBLISH_URL"
