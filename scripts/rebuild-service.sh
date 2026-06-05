#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO_DIR/dist/git-glance-serve"
STATIC="$REPO_DIR/packages/desktop/dist"

echo "Building frontend..."
pnpm --filter @git-glance/desktop build

echo "Building Rust server..."
cargo build --release --manifest-path "$REPO_DIR/packages/server-rust/Cargo.toml"
mkdir -p "$REPO_DIR/dist"
cp "$REPO_DIR/packages/server-rust/target/release/git-glance-serve" "$BIN"
chmod +x "$BIN"

echo "Restarting service..."
sudo systemctl restart git-glance

echo "Done. Server at http://git-glance.local:3451"
