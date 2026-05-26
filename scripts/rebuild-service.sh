#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO_DIR/dist/git-glance-serve"

echo "Building frontend..."
pnpm --filter @git-glance/desktop build

echo "Building Go server..."
go build -C "$REPO_DIR/packages/server-go" -o "$BIN" .

echo "Restarting service..."
sudo systemctl restart git-glance

echo "Done."
