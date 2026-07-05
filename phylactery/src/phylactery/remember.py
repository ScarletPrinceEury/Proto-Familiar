"""Remember-consent map — governs how the ward's information is stored.

Stored as a JSON file alongside the Phylactery database so it survives
across DB snapshots and is directly observable on disk.

Map values: true → store freely, false → never store (drop silently),
"ask" → store as consent_pending and surface for confirmation.

Default: basics=true (safe to remember basic facts), everything else "ask"
(never silently discard — surfacing for consent is always preferable to
losing information the Familiar should have but wasn't allowed to keep).
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

CATEGORIES = ("basics", "emotional_content", "health_info", "relationships", "whereabouts")
VALID_VALUES = (True, False, "ask")

DEFAULT_MAP: dict[str, Any] = {
    "basics":           True,
    "emotional_content": "ask",
    "health_info":       "ask",
    "relationships":     "ask",
    "whereabouts":       "ask",
}


def _map_path() -> Path:
    from phylactery.db import default_db_path
    return default_db_path().parent / "remember_map.json"


# ── Standing consent (time-boxed "trust his judgment" per category) ────────────
#
# The middle tier between "ask about every single one" and flipping a whole
# category to permanent "Store freely". While a category's window is open, an
# 'ask' fact in it is auto-confirmed (stored, not queued) — the ward has said
# "keep this kind of thing for now without checking with me each time".
#
# Stored as an ABSOLUTE expiry in epoch milliseconds (UTC instant) — no local
# time, no offset, no DST: whoever reads it compares against their own
# now-in-epoch-ms. Machine value produced by code from a preset duration, never
# typed. Windows always expire; an indefinite grant is what "Store freely" is for.

def _standing_path() -> Path:
    from phylactery.db import default_db_path
    return default_db_path().parent / "remember_standing.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def get_standing() -> dict[str, Any]:
    """Return the currently-ACTIVE standing-consent grants, keyed by category.

    Expired windows are omitted (filtered against the current instant), so the
    caller sees only categories that are trusted right now. Each value is
    {"until": <epoch_ms>, "window": <label>, "grantedAt": <epoch_ms>}."""
    path = _standing_path()
    if not path.exists():
        return {}
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    now = _now_ms()
    active: dict[str, Any] = {}
    for cat, entry in (stored or {}).items():
        if cat not in CATEGORIES or not isinstance(entry, dict):
            continue
        until = entry.get("until")
        if isinstance(until, (int, float)) and until > now:
            active[cat] = entry
    return active


def set_standing(category: str, until: Any, window: str | None = None) -> dict[str, Any]:
    """Open or clear a standing-consent window for one category.

    until: epoch-ms expiry (int/float > now) to open the window, or None/0 to
    clear it. window: an optional human label for the chosen duration ('6h',
    '7d', …) — display only. Returns {"ok": True, "standing": <active grants>}.
    """
    if category not in CATEGORIES:
        return {"ok": False, "error": f"unknown category: {category!r}"}
    path = _standing_path()
    try:
        stored = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(stored, dict):
            stored = {}
    except Exception:
        stored = {}

    if not until:  # clear the window
        stored.pop(category, None)
    else:
        if not isinstance(until, (int, float)) or until <= _now_ms():
            return {"ok": False, "error": "until must be an epoch-ms instant in the future"}
        stored[category] = {"until": int(until), "window": window or None, "grantedAt": _now_ms()}

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(stored, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"ok": True, "standing": get_standing()}


def get() -> dict[str, Any]:
    """Return the current remember map, filling any missing categories with defaults."""
    result = dict(DEFAULT_MAP)
    path = _map_path()
    if not path.exists():
        return result
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
        for cat in CATEGORIES:
            if cat in stored and stored[cat] in VALID_VALUES:
                result[cat] = stored[cat]
    except Exception:
        pass  # corrupt file → use defaults rather than failing
    return result


def set_map(new_map: dict[str, Any]) -> dict[str, Any]:
    """Validate and persist a new remember map.

    Only recognised categories are written. Unrecognised keys are rejected.
    Returns {"ok": True, "map": ...} or {"ok": False, "errors": [...]}.
    """
    errors: list[str] = []
    result = dict(DEFAULT_MAP)
    for k, v in new_map.items():
        if k not in CATEGORIES:
            errors.append(f"unknown category: {k!r}")
            continue
        if v not in VALID_VALUES:
            errors.append(f"invalid value for {k!r}: {v!r} — must be true/false/ask")
            continue
        result[k] = v
    if errors:
        return {"ok": False, "errors": errors}
    path = _map_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"ok": True, "map": result}
