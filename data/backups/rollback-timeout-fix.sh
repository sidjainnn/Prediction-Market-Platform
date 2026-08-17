#!/bin/bash
# Rollback JUST the placeBid-timeout + per-market error-isolation fix
# (2026-07-30), keeping the persistent-worker conversion in place. Use
# rollback-persistent-worker.sh instead for a full rollback to the original
# spawn-per-cycle model (that one predates pricing.mjs's timeout addition,
# so it doesn't touch pricing.mjs — this script's backup is the only copy
# of pricing.mjs's pre-timeout state).
set -e
STAMP="20260730-130447"
BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$BACKUP_DIR/../.." && pwd)"

cp "$BACKUP_DIR/pricing.mjs.pre-timeout-fix.$STAMP" "$ROOT/drivers/lib/pricing.mjs"
cp "$BACKUP_DIR/mmp-pricing-index.mjs.pre-timeout-fix.$STAMP" "$ROOT/drivers/mmp-pricing/index.mjs"

echo "Restored drivers/lib/pricing.mjs and drivers/mmp-pricing/index.mjs to pre-timeout-fix state."
echo "Now: kill app/server.mjs (which will also stop the persistent quoter it spawned), then restart."
echo "  ps aux | grep 'app/server.mjs' | grep -v grep"
echo "  kill <pid>"
echo "  cd $ROOT && nohup node app/server.mjs > /tmp/bitbull-server.log 2>&1 &"
