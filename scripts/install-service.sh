#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO_DIR/dist/git-glance-serve"
STATIC="$REPO_DIR/packages/desktop/renderer-dist"
SERVICE_FILE="/etc/systemd/system/git-glance.service"
HOSTNAME_ENTRY="127.0.0.1 git-glance.local"

echo "Building frontend..."
pnpm --filter @git-glance/desktop build

echo "Building Rust server..."
cargo build --release --manifest-path "$REPO_DIR/packages/server-rust/Cargo.toml"
mkdir -p "$REPO_DIR/dist"
cp "$REPO_DIR/packages/server-rust/target/release/git-glance-serve" "$BIN"
chmod +x "$BIN"

echo "Writing service file..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Git Glance
After=network.target

[Service]
ExecStart=$BIN --static=$STATIC --port=3451
Restart=on-failure
User=$(whoami)
Environment=CONFIG_DIR=%h/.git-glance
WorkingDirectory=$REPO_DIR

[Install]
WantedBy=default.target
EOF

echo "Configuring git-glance.local hostname..."
if ! grep -q "git-glance.local" /etc/hosts 2>/dev/null; then
  echo "$HOSTNAME_ENTRY" | sudo tee -a /etc/hosts > /dev/null
  echo "  Added $HOSTNAME_ENTRY to /etc/hosts"
else
  echo "  git-glance.local already in /etc/hosts"
fi

if command -v avahi-publish &>/dev/null; then
  echo "Publishing mDNS via Avahi..."
  # Create Avahi service so git-glance._http._tcp resolves on the LAN
  sudo tee /etc/avahi/services/git-glance.service > /dev/null <<'AVAHI'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Git Glance on %h</name>
  <service>
    <type>_http._tcp</type>
    <port>3451</port>
  </service>
</service-group>
AVAHI
  sudo systemctl reload avahi-daemon 2>/dev/null || true
fi

sudo systemctl daemon-reload
sudo systemctl enable git-glance
sudo systemctl restart git-glance

echo "Done. Server running at http://git-glance.local:3451"
echo "Check status with: systemctl status git-glance"
