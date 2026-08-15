#!/usr/bin/env bash
# Rebuild the web app and publish it to deploy.example.com.
#
# No service restart is involved: the published directory is a symlink that the
# the host site Vite server reads from disk on every request. See deploy/README.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/apps/web/dist"
LINK="$PUBLISH_LINK"
URL="https://deploy.example.com/spike/index.html"

echo "building for /spike/ ..."
cd "$REPO"
BASE_PATH=/spike/ pnpm --filter @spike/web build

# Re-point the symlink every time: cheap, and it self-heals if the target moved.
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "refusing to replace $LINK — it exists and is not a symlink" >&2
  exit 1
fi
ln -sfn "$DIST" "$LINK"

echo "verifying ..."
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
if [ "$code" != "200" ]; then
  echo "published but $URL returned HTTP $code" >&2
  exit 1
fi

# The SPA fallback owns the bare directory, so confirm we got OUR page back and
# not the host site's index with a 200.
if ! curl -s "$URL" | grep -q "SPIKE Control Studio"; then
  echo "$URL returned 200 but not this app — check the symlink and the SPA fallback" >&2
  exit 1
fi

echo "live: $URL"
