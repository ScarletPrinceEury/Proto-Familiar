"""Unruh MCP server.

Minimal first cut: exposes the tools Thalamus needs to wire Unruh in
as a second specialist alongside entity-core, without yet returning
real data.

Tools:
  - health_check: liveness ping (boot diagnostic for the launcher and
    for the Knowledge editor when it grows an Unruh tab).
  - temporal_context: placeholder for the per-message section that
    Thalamus injects as [Temporal Context]. Returns an empty payload
    until Milestone 3 wires the schedule graph in.

Both tools are stable shapes — Thalamus depends on them — so prefer
extending the returned dict over renaming fields.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP

from unruh import __version__

mcp = FastMCP("unruh")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@mcp.tool()
def health_check() -> dict[str, Any]:
    """Return liveness info. No side effects."""
    return {
        "ok": True,
        "service": "unruh",
        "version": __version__,
        "ts": _now_iso(),
    }


@mcp.tool()
def temporal_context(now: str | None = None) -> dict[str, Any]:
    """Return the per-message temporal context payload.

    Empty until Milestone 3 (schedule layer) and Milestone 4 (interest
    layer) populate it. The shape is intentionally stable so Thalamus
    can render it without branching on version.

    Args:
        now: Optional ISO-8601 timestamp Thalamus considers "now".
            Ignored at this stage; reserved for deterministic
            rendering once graph reads land.
    """
    return {
        "ts": now or _now_iso(),
        "schedule": {"window": [], "phase": None},
        "interests": {"standing": [], "live": []},
        "handoff": {"intent": None, "open_threads": []},
    }


def main() -> None:
    """Run the server on stdio. Blocks until the parent closes stdin."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
