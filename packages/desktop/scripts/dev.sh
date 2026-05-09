#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

echo "Starting Vite dev server..."
bunx vite --port 5173 &
VITE_PID=$!

echo "Waiting for Vite..."
for i in $(seq 1 30); do
  if curl -s http://localhost:5173 > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "Opening WebView..."
python3 "$SCRIPT_DIR/webview.py" "http://localhost:5173" || true

echo "Shutting down..."
kill $VITE_PID 2>/dev/null
wait
