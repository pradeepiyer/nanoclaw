#!/bin/bash
# Runs 30 min after the remote auto-update agent (midnight PST + 30 min).
# The remote agent merges upstream changes and pushes to origin/main.
# This script pulls the result, rebuilds locally, restarts the service,
# and sends a WhatsApp notification with the outcome.

set -euo pipefail

REPO_DIR="/Users/piyer/code/nanoclaw"
NODE="/usr/local/bin/node"
NCL="$NODE $REPO_DIR/dist/cli/client.js"
DB="$REPO_DIR/data/v2.db"
LOG_FILE="$REPO_DIR/data/auto-update.log"
SOCKET="$REPO_DIR/data/ncl.sock"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

notify_whatsapp() {
    local msg="$1"
    # Poll until daemon socket is ready (up to 60s after restart)
    local waited=0
    while [ ! -S "$SOCKET" ] && [ "$waited" -lt 60 ]; do
        sleep 5
        waited=$((waited + 5))
    done
    local main_group
    main_group=$(sqlite3 "$DB" "SELECT id FROM agent_groups WHERE folder='main' LIMIT 1" 2>/dev/null || echo "")
    if [ -n "$main_group" ]; then
        $NCL tasks create \
            --group "$main_group" \
            --name "auto-update-notify" \
            --prompt "Send the user this exact notification, no additional commentary: $msg" \
            --process-after "$(date '+%Y-%m-%dT%H:%M:%S')" >> "$LOG_FILE" 2>&1 || true
    else
        log "WARNING: could not find main group for WhatsApp notification"
    fi
}

log "=== Auto-update pull started ==="
cd "$REPO_DIR"

PREV_VERSION=$($NODE -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
BEFORE_HASH=$(git rev-parse HEAD)

# Check if remote agent pushed anything new
git fetch origin >> "$LOG_FILE" 2>&1
ORIGIN_HASH=$(git rev-parse origin/main)

if [ "$BEFORE_HASH" = "$ORIGIN_HASH" ]; then
    log "No new commits on origin/main — already at v$PREV_VERSION"
    exit 0
fi

log "New commits detected. Pulling..."
if ! git pull origin main >> "$LOG_FILE" 2>&1; then
    log "git pull failed"
    notify_whatsapp "NanoClaw auto-update: git pull failed. Manual check needed."
    exit 1
fi

NEW_VERSION=$($NODE -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
log "Pulled: v$PREV_VERSION → v$NEW_VERSION"

# Reinstall dependencies if package.json changed
if git diff HEAD~1 --name-only 2>/dev/null | grep -q "package\.json"; then
    log "package.json changed — running npm install..."
    npm install --silent >> "$LOG_FILE" 2>&1 || log "npm install warning (non-fatal)"
fi

# Rebuild for local runtime
log "Building..."
if ! npm run build >> "$LOG_FILE" 2>&1; then
    log "Build failed — reverting to previous state..."
    git reset --hard "$BEFORE_HASH" >> "$LOG_FILE" 2>&1
    npm run build >> "$LOG_FILE" 2>&1 || true
    notify_whatsapp "NanoClaw auto-update FAILED: build error on v$PREV_VERSION → v$NEW_VERSION. Reverted automatically. Manual fix needed."
    exit 1
fi

# Restart service with new build
log "Restarting nanoclaw service..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" >> "$LOG_FILE" 2>&1

log "=== Auto-update complete: v$PREV_VERSION → v$NEW_VERSION ==="
