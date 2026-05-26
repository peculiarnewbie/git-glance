#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO_DIR/dist/git-glance-serve"
STATIC="$REPO_DIR/packages/desktop/dist"
SERVICE_FILE="/etc/systemd/system/git-glance.service"

echo "Building frontend..."
pnpm --filter @git-glance/desktop build

echo "Building Go server..."
go build -C "$REPO_DIR/packages/server-go" -o "$BIN" .

echo "Writing service file..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Git Glance
After=network.target

[Service]
ExecStart=$BIN --static=$STATIC --port=3456
Restart=on-failure
User=$(whoami)
Environment=CONFIG_DIR=%h/.git-glance
WorkingDirectory=$REPO_DIR

[Install]
WantedBy=default.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable git-glance
sudo systemctl restart git-glance

echo "Done. Check status with: systemctl status git-glance"
