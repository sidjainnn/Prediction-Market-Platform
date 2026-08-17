#!/bin/bash
# Roll back the directional-lockout tau gate (2026-07-31): restores the
# previous behaviour where directional mode could fire at ANY tau (observed
# firing as early as tau=213s of a 300s market).
set -e
BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$BACKUP_DIR/../.." && pwd)"
cp "$BACKUP_DIR/mmp-pricing-index.mjs.pre-directional-tau-gate.20260731-123325" "$ROOT/drivers/mmp-pricing/index.mjs"
echo "Restored drivers/mmp-pricing/index.mjs to pre-tau-gate state."
echo "Restart: kill \$(pgrep -f 'app/server.mjs'); pkill -f mmp-pricing; cd $ROOT && nohup node app/server.mjs > /tmp/bitbull-server.log 2>&1 &"
echo "NOTE: a live rollback needs no file change at all — set MMP_DIRECTIONAL_MAX_TAU=99999 and restart."
