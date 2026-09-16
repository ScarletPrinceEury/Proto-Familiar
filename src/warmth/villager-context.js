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

// What this villager and I have been talking about lately — thin recent memories
// where they're a subject. The memoryReader is expected to have ALREADY gated the
// read (subject + audience floor + content-tag), so anything reaching here is
// clear to surface to them. Pure (takes the fetched items). '' when empty.
export function formatVillagerMemoryRecall(villagerName, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const who = (villagerName || '').trim() || 'them';
  const lines = [`[What ${who} and I have been talking about lately]`];
  for (const it of items) {
    const brief = String(it?.brief ?? '').trim();
    if (brief) lines.push(`- ${brief}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

// What I've been meaning to bring up with them (Stage 3) — the gated,
// show-once villager tells. Plain, no hedge. Pure (takes the fetched items).
export function formatVillagerTells(villagerName, tells) {
  if (!Array.isArray(tells) || tells.length === 0) return '';
  const who = (villagerName || '').trim() || 'them';
  const lines = [`[What I've been meaning to bring up with ${who}]`];
  for (const t of tells) {
    const c = String(t?.content ?? '').trim();
    if (c) lines.push(`- ${c}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

// Fetch + build the block for a villager DM turn. Async; the readers are
// injectable for tests. Returns '' on any miss so it never blocks the turn.
// `memoryReader` (Stage 2) and `tellsReader` (Stage 3) are optional; when given
// they must already be gated — the caller bakes the villager's audience + topic
// grants into them, fail-closed.
export async function buildVillagerContextBlock({
  focalVillager, grants, settings = {},
  reader = recentReachOuts, memoryReader = null, tellsReader = null, tomesDir = undefined,
} = {}) {
  if (!villagerContextOn(settings)) return '';
  if (!villagerContextEligible({ focalVillager, grants })) return '';
  const parts = [];
  // What I've been meaning to bring up (Stage 3) — leads, because it's the thing
  // I actively want to DO this turn, not just background continuity.
  if (tellsReader) {
    try {
      const res = await tellsReader({ villagerId: focalVillager.id });
      const tells = res && Array.isArray(res.items) ? res.items : [];
      const tellBlock = formatVillagerTells(focalVillager.name, tells);
      if (tellBlock) parts.push(tellBlock);
    } catch { /* skip — a tells read never blocks the turn */ }
  }
  // What I last said to them (Stage 1) — reach-out recall.
  try {
    const knocks = await reader({
      recipientId: focalVillager.id, markSurfaced: true,
      ...(tomesDir ? { tomesDir } : {}),
    });
    const recall = formatVillagerReachRecall(focalVillager.name, knocks);
    if (recall) parts.push(recall);
  } catch { /* skip — never blocks the turn */ }
  // What we've been talking about (Stage 2) — gated recent memory.
  if (memoryReader) {
    try {
      const res = await memoryReader({ villagerId: focalVillager.id });
      const items = res && Array.isArray(res.items) ? res.items : [];
      const memBlock = formatVillagerMemoryRecall(focalVillager.name, items);
      if (memBlock) parts.push(memBlock);
    } catch { /* skip — a memory read never blocks the turn */ }
  }
  return parts.join('\n\n');
}
