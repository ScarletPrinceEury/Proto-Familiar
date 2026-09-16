// Villager proactive context — the villager-side mirror of the continuity the
// ward's own turns get. When the Familiar is in a DM with a warm villager whose
// category grants `proactiveContext`, it walks in already knowing what it last
// said to THEM, so a reply days later lands as an answer instead of a
// non-sequitur — the same reason the ward gets "[I reached out first]".
//
// v1 surfaces reach-out recall only (what I last said to this person). The gated
// recent-memory reader ("what we've been talking about") is a later stage.
//
// Gated three ways, all required: the room grants `proactiveContext`
// (isGranted), it's a 1:1 with a known villager (a focal person to be about),
// and the off-switch is on. Empty string whenever any of that isn't met.

import { recentReachOuts, formatReachOutBlock } from './reach-out-log.js';
import { isGranted } from '../village/audience.js';

export function villagerContextOn(settings = {}) {
  if (process.env.PROTO_FAMILIAR_VILLAGER_CONTEXT_DISABLED === '1') return false;
  return settings?.villagerContextEnabled !== false;
}

// Whether this turn should carry villager proactive context: a 1:1 with a known
// villager whose room grants proactiveContext. Pure.
export function villagerContextEligible({ focalVillager, grants } = {}) {
  return !!(focalVillager && focalVillager.id && isGranted('proactiveContext', grants));
}

// The reach-out recall block for one villager, or '' when there's nothing to
// recall. Reuses the ward formatter's shape but names the villager and drops the
// ward-specific closing line. Pure (takes the already-fetched knocks).
export function formatVillagerReachRecall(villagerName, knocks) {
  if (!Array.isArray(knocks) || knocks.length === 0) return '';
  const who = (villagerName || '').trim() || 'them';
  // Reuse the ward block body (the "- N ago I said …" lines), swap the header
  // and the my-human framing for this villager. formatReachOutBlock returns the
  // whole ward block; we take its middle lines and reframe.
  const wardBlock = formatReachOutBlock(knocks);
  if (!wardBlock) return '';
  const bodyLines = wardBlock
    .split('\n')
    // Keep the "- N ago I said …" lines and the about/why detail; DROP the
    // "where this came from" provenance line — its session id / roster is ward
    // bookkeeping and must never ride into a villager-facing turn.
    .filter(l => (l.startsWith('- ') || l.startsWith('  ')) && !l.includes('where this came from'));
  return [
    `[What I last said to ${who}]`,
    ...bodyLines,
    `If ${who} replies to something I did not just say here, it is probably this — I answer from it rather than making them explain.`,
  ].join('\n');
}

// Fetch + build the block for a villager DM turn. Async; the reader is injectable
// for tests. Returns '' on any miss so it never blocks the turn.
export async function buildVillagerContextBlock({
  focalVillager, grants, settings = {},
  reader = recentReachOuts, tomesDir = undefined,
} = {}) {
  if (!villagerContextOn(settings)) return '';
  if (!villagerContextEligible({ focalVillager, grants })) return '';
  try {
    const knocks = await reader({
      recipientId: focalVillager.id, markSurfaced: true,
      ...(tomesDir ? { tomesDir } : {}),
    });
    return formatVillagerReachRecall(focalVillager.name, knocks);
  } catch {
    return ''; // a Village-context read never blocks the turn
  }
}
