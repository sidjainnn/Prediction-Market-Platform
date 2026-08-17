#!/usr/bin/env bash
# Start the whole exchange from a clean clone.
#
#   ./start.sh          # everything in Docker, app on http://localhost:5050
#   ./start.sh --ngrok  # ... and expose it publicly
#
# No external services required: standalone/ provides the order path.
set -euo pipefail
cd "$(dirname "$0")"
C="docker compose -f docker-compose.yml -f docker-compose.app.yml"

echo "==> building and starting"
$C up -d --build

echo "==> waiting for the app on :5050"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null http://localhost:5050 2>/dev/null; then
    echo "==> up: http://localhost:5050"
    break
  fi
  [ "$i" = 60 ] && { echo "app did not come up; logs:"; $C logs --tail=40 app; exit 1; }
  sleep 2
done

if [ "${1:-}" = "--ngrok" ]; then
  command -v ngrok >/dev/null || { echo "ngrok not installed: brew install ngrok"; exit 1; }
  echo "==> exposing :5050 via ngrok"
  ngrok http 5050
else
  echo
  echo "Share it:   ngrok http 5050"
  echo "Logs:       $C logs -f app"
  echo "Stop:       $C down          (add -v to wipe data)"
fi
