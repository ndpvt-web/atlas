#!/bin/bash
# capy-screenshot.sh v2 - TCC-aware screenshot for capy-bridge
# FIXED: Uses a persistent screenshot daemon instead of opening new Terminal windows.
#
# Architecture:
#   - Method 1: Direct screencapture (works if node has TCC)
#   - Method 2: Persistent daemon in a SINGLE Terminal.app tab (has TCC)
#     - Daemon watches /tmp/capy-screenshot-trigger for commands
#     - Only ONE Terminal window ever opened, reused for all screenshots
#     - Daemon auto-starts on first invocation, stays alive
#
# Usage: capy-screenshot.sh <output-path> [region-args]

OUTPUT="$1"
REGION_ARGS="$2"
TRIGGER="/tmp/capy-screenshot-trigger"
DAEMON_PID_FILE="/tmp/capy-screenshot-daemon.pid"
DAEMON_SCRIPT="/tmp/capy-screenshot-daemon.sh"

if [ -z "$OUTPUT" ]; then
  echo "Usage: capy-screenshot.sh <output.jpg> ['-R x,y,w,h']" >&2
  exit 1
fi

# Remove old file if exists
rm -f "$OUTPUT"

# Method 1: Direct screencapture (fastest if it works)
screencapture -x -C -t jpg $REGION_ARGS "$OUTPUT" 2>/dev/null
if [ -f "$OUTPUT" ] && [ "$(stat -f%z "$OUTPUT" 2>/dev/null || echo 0)" -gt 100 ]; then
  exit 0
fi

# Method 2: Use persistent screenshot daemon (runs in ONE Terminal.app window)
rm -f "$OUTPUT"

# Check if daemon is running
_daemon_alive() {
  if [ -f "$DAEMON_PID_FILE" ]; then
    local dpid=$(cat "$DAEMON_PID_FILE" 2>/dev/null)
    if [ -n "$dpid" ] && kill -0 "$dpid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# Start daemon if not running
if ! _daemon_alive; then
  # Create the daemon script
  cat > "$DAEMON_SCRIPT" << 'DAEMON_EOF'
#!/bin/bash
# Persistent screenshot daemon - runs in Terminal.app, watches trigger file
TRIGGER="/tmp/capy-screenshot-trigger"
PIDFILE="/tmp/capy-screenshot-daemon.pid"
echo $$ > "$PIDFILE"
rm -f "$TRIGGER"

# Clean exit
trap 'rm -f "$PIDFILE" "$TRIGGER"; exit 0' INT TERM

echo "[capy-screenshot-daemon] Started (PID $$), watching $TRIGGER"

while true; do
  # Wait for trigger file to appear
  if [ -f "$TRIGGER" ]; then
    # Read command from trigger
    CMD=$(cat "$TRIGGER" 2>/dev/null)
    rm -f "$TRIGGER"
    if [ -n "$CMD" ]; then
      # Execute the screencapture command
      eval "$CMD" 2>/dev/null
      # Signal completion
      touch "${TRIGGER}.done"
    fi
  fi
  sleep 0.05
done
DAEMON_EOF
  chmod +x "$DAEMON_SCRIPT"

  # Launch daemon in Terminal.app (ONE window, stays open)
  osascript -e "tell application \"Terminal\" to do script \"exec '$DAEMON_SCRIPT'\"" 2>/dev/null

  # Wait for daemon to start (up to 3s)
  for i in $(seq 1 30); do
    sleep 0.1
    if _daemon_alive; then
      break
    fi
  done

  if ! _daemon_alive; then
    echo "Screenshot daemon failed to start" >&2
    exit 1
  fi
fi

# Send screenshot command via trigger file
rm -f "${TRIGGER}.done"
echo "screencapture -x -C -t jpg $REGION_ARGS '$OUTPUT'" > "$TRIGGER"

# Wait for completion (up to 5s)
for i in $(seq 1 50); do
  sleep 0.1
  if [ -f "${TRIGGER}.done" ]; then
    rm -f "${TRIGGER}.done"
    if [ -f "$OUTPUT" ] && [ "$(stat -f%z "$OUTPUT" 2>/dev/null || echo 0)" -gt 100 ]; then
      exit 0
    fi
    # Daemon ran but screenshot failed
    break
  fi
done

# Cleanup
rm -f "${TRIGGER}.done" "$TRIGGER"

echo "Screenshot failed: daemon method produced no output" >&2
exit 1
