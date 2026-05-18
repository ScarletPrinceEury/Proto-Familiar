#!/usr/bin/env bash
# Proto-Familiar - macOS double-click launcher.
# Finder runs .command files in Terminal. Closing the window with Cmd-W (or Ctrl-C, then Cmd-W)
# cleanly shuts everything down because we exec node in the foreground.

set -e
cd "$(dirname "$0")"

PORT="${PORT:-8742}"
URL="http://localhost:$PORT"
# TAILSCALE=1 seeds the in-UI "Access from other devices" toggle to ON when
# .proto-familiar-config.json doesn't exist yet. Once you've used the in-UI
# toggle, that file is the source of truth and this env var is ignored.
export TAILSCALE="${TAILSCALE:-0}"

# First-run install
if [ ! -d "node_modules" ]; then
  echo "First run - installing dependencies..."
  bash ./install.sh
elif [ -f "unruh/pyproject.toml" ] && [ ! -d "unruh/.venv" ]; then
  # Unruh ships in-tree; after a git pull that introduces it, the venv
  # needs to be materialised before Thalamus can connect. Run installer.
  echo "Unruh dependencies missing - running installer..."
  bash ./install.sh
fi

# Prime PATH for uv (Astral's installer writes to ~/.local/bin); same
# pattern start.sh uses for deno. thalamus.js has its own resolver but
# this means a fresh shell after install.sh sees uv without restart.
if ! command -v uv >/dev/null 2>&1 && [ -x "$HOME/.local/bin/uv" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Open browser after the server is listening
(
  for i in $(seq 1 30); do
    if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      open "$URL" 2>/dev/null || true
      break
    fi
    sleep 0.5
  done
) &

clear
cat <<EOF
========================================
  Proto-Familiar
========================================

  URL:    $URL
  Stop:   press Ctrl-C, then close this window (Cmd-W)
  Help:   docs/troubleshooting.md

  Logs print below. Closing this window
  will shut down Proto-Familiar and entity-core.

========================================

EOF

PORT="$PORT" TAILSCALE="$TAILSCALE" exec node server.js
