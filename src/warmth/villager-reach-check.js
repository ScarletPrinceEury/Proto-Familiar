/**
 * villager-reach-check.js — whether a warm reach-out may go to a villager
 * (0.14.125, ward decision 2026-11-06).
 *
 * A reach-out leaves my human's room like a relay does, so before it goes the
 * draft is searched against what's stored as private for that person (the
 * Pillar D search). A match holds it. So does a check that couldn't run (the
 * village list or the memory search didn't answer): it used to go out anyway
 * with only the keep-between-us swap. A held reach-out is logged as a failed
 * delivery, and the next deliberation starts fresh.
 *
 * The keep-between-us swap still runs on whatever does go out (server.js).
 */

import { audienceTagFor } from '../village/audience.js';

const COULDNT_CHECK = "held: the privacy check couldn't run";

/**
 * @param {object}   opts
 * @param {{id: string, name: string}} opts.villager
 * @param {string}   opts.draft
 * @param {() => Promise<object>} opts.loadRegistry      the village list
 * @param {(q: {query: string, roomAudience: string}) => Promise<object>} opts.searchRestricted
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}  never throws
 */
export async function checkVillagerReach({ villager, draft, loadRegistry, searchRestricted }) {
  let found;
  try {
    const registry = await loadRegistry();
    const roomAudience = audienceTagFor({ participants: [{ id: villager.id, name: villager.name }] }, registry);
    found = await searchRestricted({ query: String(draft ?? '').slice(0, 2000), roomAudience });
  } catch (err) {
    return { ok: false, error: `${COULDNT_CHECK} (${err?.message ?? err})` };
  }
  if (!found || typeof found.hit !== 'boolean' || found.failed) {
    return { ok: false, error: `${COULDNT_CHECK} (the memory search didn't answer)` };
  }
  if (found.hit) return { ok: false, error: `held: something in it isn't cleared for ${villager.name}` };
  return { ok: true };
}
