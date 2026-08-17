#!/bin/bash
# Rollback the persistent-worker conversion (2026-07-30) back to the
# pre-change spawn-per-cycle quoting behavior. Restores both modified files
# from their pre-change backups, then tells you what to restart manually
# (kills nothing itself — restarting processes is left to you/the operator).
set -e
STAMP="20260730-123608"
BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$BACKUP_DIR/../.." && pwd)"

cp "$BACKUP_DIR/server.mjs.pre-persistent-worker.$STAMP" "$ROOT/app/server.mjs"
cp "$BACKUP_DIR/mmp-pricing-index.mjs.pre-persistent-worker.$STAMP" "$ROOT/drivers/mmp-pricing/index.mjs"

echo "Restored app/server.mjs and drivers/mmp-pricing/index.mjs to pre-persistent-worker state."
echo "Now: kill the persistent mmp-pricing worker process and app/server.mjs, then restart server.mjs normally."
echo "  ps aux | grep -E 'app/server.mjs|mmp-pricing/index.mjs' | grep -v grep"
echo "  kill <pids>"
echo "  cd $ROOT && nohup node app/server.mjs > /tmp/bitbull-server.log 2>&1 &"
