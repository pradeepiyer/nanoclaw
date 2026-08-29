#!/bin/bash
# Truncates NanoClaw's launchd-redirected stdout/stderr logs once they cross
# MAX_BYTES. launchd opens StandardOutPath/StandardErrorPath O_APPEND, so
# truncating the file in place (not deleting/renaming it) makes the next
# write land at the new end-of-file (0) with no service restart needed.
set -euo pipefail

REPO_DIR="/Users/piyer/code/nanoclaw"
LOG_DIR="$REPO_DIR/logs"
MAX_BYTES=$((50 * 1024 * 1024)) # 50MB

rotate() {
    local file="$1"
    [ -f "$file" ] || return 0
    local size
    size=$(stat -f%z "$file" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_BYTES" ]; then
        local archive="${file}.1.gz"
        rm -f "$archive"
        gzip -c "$file" >"$archive" 2>/dev/null || true
        : >"$file"
        echo "$(date '+%Y-%m-%d %H:%M:%S') rotated $file (was $size bytes)"
    fi
}

rotate "$LOG_DIR/nanoclaw.log"
rotate "$LOG_DIR/nanoclaw.error.log"
