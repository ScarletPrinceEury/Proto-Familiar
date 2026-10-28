// outgoing-filter.js — Pillar D outgoing message gate
//
// Runs post-response, pre-send in non-streaming paths. Embeds the draft reply,
// queries Phylactery for ward-private memories that match above threshold, and
// replaces the draft if a hit is found — retrying up to FILTER_RETRY_BUDGET
// times before falling back to a safe refusal.
//
// Always fails open: a search error or network blip never blocks the reply.
// Only a confirmed semantic hit (score ≥ FILTER_THRESHOLD) triggers a retry.
//
// Signed off by the human (build-spec §7):
//   threshold=0.70, retry budget=3,
//   safe-refusal="I can't share that here…"

import { searchMemoryRestricted } from '../../thalamus.js';
import { redactProtected } from '../village/outgoing-tripwire.js';

export const FILTER_THRESHOLD    = 0.70;
export const FILTER_RETRY_BUDGET = 3;
export const FILTER_SAFE_REFUSAL =
  "I can't share that here — something in what I was about to say isn't cleared for this room. If you need that information, ask me somewhere private.";

// Sanctioned second-person exception (build-spec §3): this prompt is addressed
// to the LLM describing its own draft, not to the Familiar as an entity.
function rejectionPrompt(topic) {
  return `Your message wasn't sent because it contained content you are not permitted to disclose here${topic ? ': ' + topic : ''}. Someone in this room is not cleared for that. Please say something different.`;
}

async function defaultCheckRestricted(draftText, audienceTag) {
  if (!draftText || audienceTag === 'ward-private') return { hit: false };
  const result = await searchMemoryRestricted({
    query:        draftText.slice(0, 2000),
    roomAudience: audienceTag,
    threshold:    FILTER_THRESHOLD,
  });
  return result?.hit ? { hit: true, topic: result.topic ?? null } : { hit: false };
}

/**
 * Filter a draft reply before it leaves the server.
 *
 * Fast-path: if audienceTag is 'ward-private', returns immediately with no check.
 *
 * @param {object}   opts
 * @param {string}   opts.draftText    — The reply to gate.
 * @param {string}   opts.audienceTag  — Room tag; 'ward-private' → skip filter.
 * @param {Function} opts.callUpstream — async (messages) → string; called for each retry.
 * @param {Array}    opts.baseMessages — Messages array the original reply was generated from.
 * @param {Function} [opts.checkRestricted] — async (draft, tag) → { hit, topic }; injectable for tests (defaults to the Phylactery-backed check).
 * @returns {Promise<{text: string, blocked: boolean}>}
 */
export async function filterOutgoingReply({ draftText, audienceTag, callUpstream, baseMessages, checkRestricted = defaultCheckRestricted }) {
  if (audienceTag === 'ward-private') return { text: draftText, blocked: false };
  let draft = draftText;
  let msgs  = baseMessages;
  for (let i = 0; i <= FILTER_RETRY_BUDGET; i++) {
    const { hit, topic } = await checkRestricted(draft, audienceTag);
    if (!hit) return { text: draft, blocked: false };
    if (i === FILTER_RETRY_BUDGET) return { text: FILTER_SAFE_REFUSAL, blocked: true };
    msgs = [
      ...msgs,
      { role: 'assistant', content: draft },
      { role: 'system',    content: rejectionPrompt(topic) },
    ];
    try {
      draft = await callUpstream(msgs);
    } catch {
      return { text: FILTER_SAFE_REFUSAL, blocked: true };
    }
  }
  return { text: FILTER_SAFE_REFUSAL, blocked: true };
}

/**
 * Everything a reply goes through before it reaches a room that isn't my
 * human's own: the semantic filter above (stored private content), then my
 * human's keep-between-us list, with each match swapped for "[private]"
 * (outgoing-tripwire.js). The list catches what was never stored as private —
 * a name in an identity file, a code pasted in chat. One function so every
 * room path (Discord replies, the web/voice non-stream paths) runs both.
 *
 * A filter error passes the draft through (as before); the list swap always
 * runs, on whatever text goes out, including the safe refusal.
 *
 * @returns {Promise<{text: string, blocked: boolean, rewritten: boolean, swapped: number}>}
 */
export async function gateRoomReply({ draftText, audienceTag, callUpstream, baseMessages, privateList = [], checkRestricted, log = console }) {
  if (audienceTag === 'ward-private' || !draftText) return { text: draftText, blocked: false, rewritten: false, swapped: 0 };
  let filtered;
  try {
    filtered = await filterOutgoingReply({ draftText, audienceTag, callUpstream, baseMessages, ...(checkRestricted ? { checkRestricted } : {}) });
  } catch (err) {
    log.error?.(`[outgoing] filter failed (passing through): ${err?.message ?? err}`);
    filtered = { text: draftText, blocked: false };
  }
  const { text, hits } = redactProtected(filtered.text, privateList);
  if (hits.length) log.log?.(`[outgoing] swapped ${hits.length} keep-between-us match${hits.length === 1 ? '' : 'es'} for "[private]" (audience=${audienceTag})`);
  return { text, blocked: filtered.blocked, rewritten: filtered.text !== draftText, swapped: hits.length };
}
