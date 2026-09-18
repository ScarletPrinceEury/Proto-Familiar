"""Village registry canonical store.

The Village registry is machine-readable ROUTING + GATING state — categories,
villagers, locations — synced from Proto-Familiar's village.js. It is NOT
identity prose: it must never appear in ``identity_get_all`` (and therefore
never in the always-injected identity block, nor in the Knowledge editor's
Identity tab). It lives in the ``meta`` key-value table as one opaque JSON
string, alongside ``schema_version`` and the scheduler's bookkeeping.

History: the registry used to piggyback on identity storage as the identity
file ``custom/village-registry.md`` (a convenient write-through target, but the
wrong home — machine JSON sitting in the Identity tab, one filter string away
from leaking into the prompt). ``_migrate_from_identity`` heals those installs:
the first get or set moves the content into ``meta`` and DELETES the identity
row, so it disappears from the Identity tab and can never render again.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

META_KEY = "village_registry"
_LEGACY_CATEGORY = "custom"
_LEGACY_FILENAME = "village-registry.md"
# The legacy identity file wrapped the JSON in a ```json fenced block under a
# "## Registry" heading; pull it back out on migration.
_FENCE_RE = re.compile(r"```json\s*\n(.*?)\n```", re.DOTALL)


def _migrate_from_identity(conn: sqlite3.Connection) -> None:
    """One-time heal (idempotent): if the registry still lives as an identity
    file, move its JSON into ``meta`` and delete the identity row. Safe to call
    on every get/set — a no-op once the legacy row is gone."""
    row = conn.execute(
        "SELECT id, content FROM identity_files WHERE category=? AND filename=?",
        (_LEGACY_CATEGORY, _LEGACY_FILENAME),
    ).fetchone()
    if row is None:
        return
    # Seed meta from the legacy row only if meta has nothing yet — a live meta
    # value is always newer than the frozen identity copy, never overwrite it.
    have = conn.execute("SELECT value FROM meta WHERE key=?", (META_KEY,)).fetchone()
    if have is None:
        content = row["content"] or ""
        m = _FENCE_RE.search(content)
        json_str = (m.group(1) if m else content).strip()
        if json_str:
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
                (META_KEY, json_str),
            )
    # Retire the identity row either way, so it stops rendering in the Identity
    # tab and can never be swept into the identity prompt again.
    conn.execute("DELETE FROM identity_files WHERE id=?", (row["id"],))
    conn.commit()


def get(conn: sqlite3.Connection) -> str | None:
    """Return the canonical registry JSON string, or ``None`` if unset. Heals a
    legacy identity-file copy first."""
    _migrate_from_identity(conn)
    row = conn.execute("SELECT value FROM meta WHERE key=?", (META_KEY,)).fetchone()
    return row["value"] if row else None


def set_registry(conn: sqlite3.Connection, registry_json: str) -> dict[str, Any]:
    """Persist the canonical registry JSON (an opaque string). Also retires any
    lingering legacy identity-file copy on every write."""
    if not isinstance(registry_json, str) or not registry_json.strip():
        return {"ok": False, "error": "registry_json must be a non-empty string"}
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
        (META_KEY, registry_json),
    )
    conn.execute(
        "DELETE FROM identity_files WHERE category=? AND filename=?",
        (_LEGACY_CATEGORY, _LEGACY_FILENAME),
    )
    conn.commit()
    return {"ok": True}
