#!/usr/bin/env bash
# Proto-Familiar installer (macOS / Linux)
# Installs Node dependencies and clones entity-core-alpha as a sibling directory.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PARENT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
ENTITY_CORE_DIR="$PARENT_DIR/entity-core-alpha"
ENTITY_CORE_REPO="https://github.com/PsycherosAI/Psycheros.git"
ENTITY_CORE_TAG="entity-core-v0.2.2"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*"; exit 1; }

say "Proto-Familiar installer"
say "Working dir: $SCRIPT_DIR"

# --- Node.js check ---
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed. Install Node 18+ from https://nodejs.org/ and re-run."
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js $NODE_MAJOR detected. Proto-Familiar needs Node 18 or newer."
fi
say "Node.js $(node -v) found."

# --- Deno check (auto-install if missing) ---
# Look in PATH first, then in the common install location the official
# script writes to. We add ~/.deno/bin to PATH for the rest of this
# install run so the post-install steps see it without needing a shell
# restart; start.sh does the same probe at launch time.
if [ -d "$HOME/.deno/bin" ]; then PATH="$HOME/.deno/bin:$PATH"; fi
if command -v deno >/dev/null 2>&1; then
  say "Deno $(deno --version | head -n1) found."
  HAVE_DENO=1
else
  if command -v curl >/dev/null 2>&1; then
    say "Deno not found — installing via the official script (writes to ~/.deno)..."
    if curl -fsSL https://deno.land/install.sh | sh -s -- --yes >/dev/null 2>&1; then
      PATH="$HOME/.deno/bin:$PATH"
      if command -v deno >/dev/null 2>&1; then
        say "Deno $(deno --version | head -n1) installed."
        HAVE_DENO=1
      else
        warn "Deno install ran but 'deno' is still not on PATH. Open a new terminal and re-run, or install manually from https://deno.com/."
        HAVE_DENO=0
      fi
    else
      warn "Deno auto-install failed. entity-core will be disabled until you install Deno 2+ from https://deno.com/."
      HAVE_DENO=0
    fi
  else
    warn "Neither 'deno' nor 'curl' available. entity-core needs Deno 2+; install from https://deno.com/ if you want the identity layer."
    HAVE_DENO=0
  fi
fi

# --- npm install ---
say "Installing Proto-Familiar dependencies (npm install)..."
( cd "$SCRIPT_DIR" && npm install )

# --- entity-core clone ---
if [ -d "$ENTITY_CORE_DIR" ]; then
  say "entity-core-alpha already present at $ENTITY_CORE_DIR — skipping clone."
else
  if command -v git >/dev/null 2>&1; then
    say "Cloning entity-core-alpha into $ENTITY_CORE_DIR ..."
    if git clone --depth 1 --branch "$ENTITY_CORE_TAG" "$ENTITY_CORE_REPO" "$ENTITY_CORE_DIR"; then
      say "entity-core-alpha cloned at tag $ENTITY_CORE_TAG."
    else
      warn "Tag clone failed; falling back to default branch."
      git clone --depth 1 "$ENTITY_CORE_REPO" "$ENTITY_CORE_DIR" || warn "Clone failed. You can clone it manually later."
    fi
  else
    warn "git not found — skipping entity-core clone. Install git or place entity-core-alpha at $ENTITY_CORE_DIR manually."
  fi
fi

# --- entity-core dependency pre-cache ---
# Psycheros is a Deno workspace, so the entity-core package lives at
# packages/entity-core/ (older releases kept it at the repo root). Probe
# both; the workspace path wins. Pre-cache the Deno graph so the user's
# first server start doesn't stall for several minutes on first download.
ENTITY_CORE_PKG_DIR=""
if [ -f "$ENTITY_CORE_DIR/packages/entity-core/src/mod.ts" ]; then
  ENTITY_CORE_PKG_DIR="$ENTITY_CORE_DIR/packages/entity-core"
elif [ -f "$ENTITY_CORE_DIR/src/mod.ts" ]; then
  ENTITY_CORE_PKG_DIR="$ENTITY_CORE_DIR"
fi

if [ -n "$ENTITY_CORE_PKG_DIR" ] && [ "$HAVE_DENO" = "1" ]; then
  say "Pre-caching entity-core dependencies (one-time; can take several minutes)..."
  if ( cd "$ENTITY_CORE_PKG_DIR" && deno cache src/mod.ts >/dev/null 2>&1 ); then
    say "entity-core dependencies cached."
  else
    warn "deno cache failed — first server start will download deps before entity-core comes up."
  fi
elif [ -n "$ENTITY_CORE_PKG_DIR" ]; then
  warn "Skipping entity-core dep pre-cache (Deno not available). First server start will download them."
fi

# --- Platform-specific launcher polish ---
UNAME="$(uname -s 2>/dev/null || echo unknown)"
case "$UNAME" in
  Linux)
    if [ -f "$SCRIPT_DIR/scripts/linux/install-desktop-entry.sh" ]; then
      say "Installing application-menu entry..."
      bash "$SCRIPT_DIR/scripts/linux/install-desktop-entry.sh" || warn "Desktop entry install failed (non-fatal)."
    fi
    ;;
  Darwin)
    if [ -f "$SCRIPT_DIR/Proto-Familiar.command" ]; then
      chmod +x "$SCRIPT_DIR/Proto-Familiar.command" || true
      say "macOS launcher ready: double-click Proto-Familiar.command in Finder."
    fi
    ;;
esac

say "Install complete."
echo
echo "  Launch:"
case "$UNAME" in
  Darwin) echo "    - Double-click Proto-Familiar.command in Finder";;
  Linux)  echo "    - Search 'Proto-Familiar' in your app launcher, or run ./start.sh";;
  *)      echo "    - ./start.sh";;
esac
echo "  Stop:   ./stop.sh  (or close the launcher window on macOS)"
echo
if [ "$HAVE_DENO" = "0" ]; then
  warn "Reminder: install Deno before first start if you want entity-core enrichment."
fi
