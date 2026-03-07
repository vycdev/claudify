#!/bin/sh

# Restore Claude config from backup if missing
if [ ! -f /root/.claude.json ]; then
  BACKUP=$(ls -t /root/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
  if [ -n "$BACKUP" ]; then
    echo "[Entrypoint] Restoring Claude config from backup: $BACKUP"
    cp "$BACKUP" /root/.claude.json
  fi
fi

exec node build/index.js
