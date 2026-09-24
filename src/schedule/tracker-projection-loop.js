/**
 * Tracker-projection loop (T-C.3a) — the singleton driver behind the
 * persistent tracker projection NODES.
 *
 * Each tick calls one atomic Unruh reconcile (`tracker_project`) that
 * mints/updates/resolves ward-private schedule nodes:
 *   - a `reminder` per near-expiry pantry item (fires once, deduped on the
 *     item's entry — ward decision: banner the moment it enters the window),
 *   - one `hold` per predicted menses window (negative space; never fires).
 * All the date/count maths lives in Unruh (`tracker_projection.py`); this
 * file is just the tick, the gates, and the off-switch.
 *
 * **Rides `trackersEnabled` (default ON, inert until a tracker exists)** —
 * the projections are core trackers behaviour, like the T-C.1/T-C.2 derived
 * lines. Hard off-switches: PROTO_FAMILIAR_TRACKER_PROJECTION_DISABLED=1
 * (this loop only) and PROTO_FAMILIAR_TRACKERS_DISABLED=1 (whole feature).
 *
 * **Stands down at moderate+ threat** — a pantry banner must never fire into
 * a crisis; triage owns the moment (the same posture as needs-tracking and
 * warm reach-out). Dedup means a deferred item still fires exactly once when
 * the loop next runs.
 *
 * Mirrors the needs-tracking loop shape (30-min tick, reentrancy guard,
 * defer-during-call, clean shutdown).
 */

import { projectTrackerNodes } from '../../thalamus.js';
import { getThreat } from '../safety/threat-tracker.js';
import { isCallActiveFromFile } from '../voice/call-engine.js';
import { readSettingsSync } from '../../cerebellum.js';

const DEFAULT_TICK_MS = 30 * 60_000;   // 30 min — projections want no urgency
const STAND_DOWN_TIERS = new Set(['moderate', 'high', 'severe']);

let _started  = false;
let _interval = null;
let _active   = null;

function hardDisabled() {
  return process.env.PROTO_FAMILIAR_TRACKER_PROJECTION_DISABLED === '1'
      || process.env.PROTO_FAMILIAR_TRACKERS_DISABLED === '1';
}

function isEnabled() {
  if (hardDisabled()) return false;
  return readSettingsSync().trackersEnabled !== false;   // default ON
}

/**
 * One tick: stand down if the ward is in distress, else reconcile the
 * projection nodes. All selection/writes live in Unruh; this does the gating
 * and the I/O. Exported for tests with injectable deps.
 */
export async function runTrackerProjectionTick({
  project = projectTrackerNodes,
  threat  = getThreat,
  enabled,                        // test seam; defaults to the Settings/env gate
} = {}) {
  if (!(enabled ?? isEnabled())) return { reason: 'disabled' };

  // Crisis-defer: triage owns the moment at moderate+.
  const t = await threat().catch(() => null);
  if (t && STAND_DOWN_TIERS.has(t.tier)) return { reason: 'stood-down', tier: t.tier };

  let res;
  try { res = await project(); } catch { return { reason: 'unruh-unavailable' }; }
  if (!res || res.ok === false) return { reason: 'unruh-unavailable' };

  const minted = res.minted ?? 0, updated = res.updated ?? 0, resolved = res.resolved ?? 0;
  if (minted || updated || resolved) {
    console.log(`[tracker-projection] minted ${minted} · updated ${updated} · resolved ${resolved} projection node(s)`);
  }
  return { reason: 'ran', minted, updated, resolved };
}

export function startTrackerProjectionLoop({ tickMs = DEFAULT_TICK_MS } = {}) {
  if (_started) return { stop: stopTrackerProjectionLoop };
  if (hardDisabled()) {
    console.log('[tracker-projection] hard-disabled via env off-switch');
    return { stop: () => {} };
  }
  _started = true;
  console.log('[tracker-projection] loop armed (rides trackersEnabled; inert until a tracker exists)');
  _interval = setInterval(async () => {
    if (_active) return;                        // never overlap ticks
    if (await isCallActiveFromFile()) return;   // defer during a live call
    _active = runTrackerProjectionTick()
      .catch(err => console.warn('[tracker-projection] tick error:', err?.message ?? err))
      .finally(() => { _active = null; });
  }, tickMs);
  _interval.unref?.();
  return { stop: stopTrackerProjectionLoop };
}

export async function stopTrackerProjectionLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_active) { try { await _active; } catch { /* already logged */ } }
  _started = false;
}
