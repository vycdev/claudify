#!/bin/sh

# Restore Claude config from backup if missing
if [ ! -f /root/.claude.json ]; then
  BACKUP=$(ls -t /root/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
  if [ -n "$BACKUP" ]; then
    echo "[Entrypoint] Restoring Claude config from backup: $BACKUP"
    cp "$BACKUP" /root/.claude.json
  fi
fi

# Check if Claude CLI is authenticated
echo "[Entrypoint] Checking Claude CLI auth status..."
AUTH_OUTPUT=$(claude -p "hello" 2>&1)
if echo "$AUTH_OUTPUT" | grep -qi "auth\|login\|sign in\|unauthorized\|API key"; then
  echo ""
  echo "============================================"
  echo "  Claude CLI is NOT authenticated!"
  echo "  Run this command to log in:"
  echo ""
  echo "  docker exec -it \$(hostname) claude auth login"
  echo ""
  echo "  Or from the host machine:"
  echo "  docker exec -it <container_name> claude auth login"
  echo "============================================"
  echo ""
fi

exec node build/index.js
