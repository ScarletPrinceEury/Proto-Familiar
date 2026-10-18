/**
 * Boot-time tome migrations for the room gate (0.14.95, ward decisions).
 * Applied in code to the live tome files, never by editing the shipped JSON:
 * installs customise the shipped condition tomes (often under git
 * skip-worktree), and any upstream edit to those files blocks `git pull`.
 *
 *   1. The shipped condition tomes' diagnosis lines move from "just between
 *      us" (`wardOnly`, 0.14.89) to Village gating: `mental-health:sensitive`,
 *      so a circle my human trusts with mental health at the sensitive level
 *      gets them and no one else does. Only the shipped flag is converted: an
 *      entry my human set themselves (`contentTagSource` present) is left alone.
 *   2. Session Memories stops being private as a whole tome. New ones were
 *      created with a tome-level `wardOnly` (0.14.89); its entries are now gated
 *      one by one like any other tome's.
 *
 * Idempotent: a converted entry carries `contentTagSource: 'shipped'` and is
 * never touched again. Never throws; returns what it changed.
 */
import { readTomeFiles } from './tome-store.js';

export const SHIPPED_DIAGNOSIS_LINES = Object.freeze({
  'a0000000-a000-4000-a000-a00000000000': 'a0000001-a000-4000-a000-a00000000000', // ADHD Support
  'e0000000-e000-4000-e000-e00000000000': 'e0000001-e000-4000-e000-e00000000000', // Agoraphobia Support
  'b0000000-b000-4000-b000-b00000000000': 'b0000001-b000-4000-b000-b00000000000', // Bipolar Support
  'd0000000-d000-4000-d000-d00000000000': 'd0000001-d000-4000-d000-d00000000000', // Depression Support
  'c0000000-c000-4000-c000-c00000000000': 'c0000001-c000-4000-c000-c00000000000', // OCD Support
});
export const DIAGNOSIS_TAG = 'mental-health:sensitive';
const SESSION_MEMORIES = 'Session Memories';

/** What a tome needs changed (pure): { diagnosis: uid|null, unprivate: bool }. */
export function plannedMigrations(tome) {
  const uid = SHIPPED_DIAGNOSIS_LINES[tome?.id];
  const e = uid ? tome?.entries?.[uid] : null;
  return {
    diagnosis: (e && e.wardOnly === true && !e.contentTagSource) ? uid : null,
    unprivate: tome?.name === SESSION_MEMORIES && tome?.wardOnly === true,
  };
}

export async function migrateTomeSharing(tomesDir, { modifyTomeFile, now = () => new Date().toISOString() } = {}) {
  const changed = { diagnosis: [], unprivate: [] };
  if (typeof modifyTomeFile !== 'function') return changed;
  let files;
  try { files = await readTomeFiles(tomesDir); } catch { return changed; }
  for (const { tome, file } of files) {
    const plan = plannedMigrations(tome);
    if (!plan.diagnosis && !plan.unprivate) continue;
    try {
      await modifyTomeFile(file, (fresh) => {
        const p = plannedMigrations(fresh);   // re-check under the lock
        if (p.diagnosis) {
          const e = { ...fresh.entries[p.diagnosis] };
          delete e.wardOnly;
          e.contentTag = DIAGNOSIS_TAG;
          e.contentTagSource = 'shipped';
          e.contentTagAt = now();
          fresh.entries[p.diagnosis] = e;
          changed.diagnosis.push(String(fresh.name ?? fresh.id));
        }
        if (p.unprivate) {
          delete fresh.wardOnly;
          changed.unprivate.push(String(fresh.name));
        }
        return fresh;
      });
    } catch (err) {
      console.error('[tomes] room-gate migration skipped a tome:', err?.message ?? err);
    }
  }
  return changed;
}
