/**
 * claimed-actions.js — a reply that says a tool action happened when no tool ran.
 *
 * Seen live three times on the Claude Code bridge (2026-10-28 18:43 on glm-5.3,
 * 2026-10-29 14:33 and 14:35 on deepseek-v4-pro): the whole turn was one round,
 * finish "stop", no calls, save_to_tome offered, and the reply read "Reading the
 * newest copy, then fixing. … Re-filed." The last one even named an entry id
 * that doesn't exist. Nothing was saved. The app only said so on the NEXT turn
 * ("[Last turn: no tools used.]"), and in the meantime my human (or the bridge)
 * took the claim at its word.
 *
 * So both tool loops check the round that would end the turn: when no tool ran
 * at all this turn, tools were on offer, and the reply announces or claims a
 * tool-shaped action, the loop gives me one more round with CLAIM_CHECK_NOTE
 * (a plain app fact) and tools still on. One retry per turn, never on the
 * closing round, and the reply I then give is the one that goes out.
 *
 * Matching is deliberately narrow (CLAUDE.md verification error #8): first
 * person, immediate ("let me read…", "now filing", "re-filed."), and tied to
 * the verbs that only tools carry out. A promise about later ("I'll remind you
 * tonight") is promise-catch's job, not this one. A false hit costs one round;
 * the note says what to do if I meant something from before.
 *
 * Pure.
 */

// Write actions only a tool carries out here (my stores, the schedule).
const WRITE = 're-?file|file|save|store|log|write (?:it|that|this) down|schedule|delete';
// Reading only counts when it's one of my stores, so "let me read that again"
// about a message already in front of me doesn't.
const READ = 're-?read|read|open|pull up|look up|search|fetch|grab|check';
const STORE = '(?:tome|entry|entries|note|notes|memory|memories|file|files|log|logs|report|draft|section|FINAL|schedule|calendar|reminder|copy|version|list)';
const DONE = 're-?filed|filed|saved|stored|logged|updated|edited|scheduled|deleted|removed|written|added|created|set up';
// A sentence of its own ("Re-filed."). Narrower than DONE: "Noted." and
// "Added." are everyday chat.
const SOLO = 're-?filed|filed|saved|stored|logged|scheduled|deleted';
// What a done-claim is about, so "I've saved up" or "I saved you a seat" don't count.
const OBJ = '(?:it|that|this|them|both|everything|the \\w+|my \\w+|a \\w+|an \\w+|entry|note|memory|reminder|report|section|draft|file|tome|event|task)';

const PATTERNS = [
  // "let me file it" / "let me save that"
  new RegExp(`\\blet me (?:just |quickly |now |actually )?(?:${WRITE})\\b`, 'i'),
  // "let me read the current FINAL" / "let me check my notes"
  new RegExp(`\\blet me (?:just |quickly |now |actually )?(?:${READ})\\b(?:\\s+\\S+){0,3}?\\s+${STORE}\\b`, 'i'),
  // "Now filing for real" / "filing it now" / "saving that first"
  /\bnow (?:actually )?(?:re-?filing|filing|saving|storing|logging|reading|re-?reading|updating|editing|writing|scheduling|deleting)\b/i,
  /\b(?:re-?filing|filing|saving|storing|logging|updating|scheduling|deleting) (?:it |that |this |them )?(?:now|first|for real)\b/i,
  // "Reading the newest copy, then fixing." / "…, then actually filing"
  /\b(?:reading|re-?reading|opening|pulling up|checking) [^.!?\n]{1,60}?,? then (?:actually )?(?:fixing|filing|re-?filing|saving|updating|editing|writing|adding)\b/i,
  // "Re-filed." / "Saved." / "All seven fixed and re-filed" as a sentence of its own
  new RegExp(`(?:^|[.!?\\n]\\s*|[—–-]\\s+)(?:(?:all|both) \\w+ )?(?:fixed and )?(?:${SOLO})(?: (?:it|that|this|them|both|everything))?(?: (?:now|again|for real|this time))?\\s*[.!](?=\\s|$)`, 'im'),
  // "I've re-filed it" / "I just saved the entry"
  new RegExp(`\\bI(?:'ve| have| just|'ve just| have just)? (?:${DONE}) ${OBJ}\\b`, 'i'),
  // "fixed and re-filed" mid-sentence
  /\b(?:fixed|done|updated) and (?:re-?filed|filed|saved)\b/i,
  // "Real save this time"
  /\b(?:real|actual) (?:save|filing)\b/i,
];

/** The claim phrases in `text`, in order, deduped, at most `max`. */
export function findClaimedActions(text, { max = 3 } = {}) {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) return [];
  const hits = [];
  for (const re of PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    const phrase = m[0].replace(/^[\s.!?—–-]+/, '').trim();
    if (phrase && !hits.some(h => h.toLowerCase() === phrase.toLowerCase())) hits.push(phrase);
  }
  // In the order they appear in the reply.
  hits.sort((a, b) => s.indexOf(a) - s.indexOf(b));
  return hits.slice(0, max);
}

/**
 * The gate both loops run on the round that would end the turn. Returns the
 * claim phrases when a retry is due, else null.
 * - toolsRanThisTurn: any tool executed in an earlier round of this turn.
 * - callsThisRound: the round's own (structured or recovered) calls.
 * - toolsOffered: the tools this round had (array); none → no check.
 */
export function unbackedClaims({ content, toolsRanThisTurn = false, callsThisRound = 0, toolsOffered = null, closing = false, retried = false }) {
  if (closing || retried || toolsRanThisTurn || callsThisRound > 0) return null;
  if (!Array.isArray(toolsOffered) || toolsOffered.length === 0) return null;
  const hits = findClaimedActions(content);
  return hits.length ? hits : null;
}

/** The app note I get for the one retry (first person; plain fact, no verdict). */
export function claimCheckNote(phrases = []) {
  const quoted = phrases.length ? ` ("${phrases.join('", "')}")` : '';
  return `[App note: my reply says I'm doing or did something${quoted}, but no tool ran this turn, so it hasn't happened yet. If I meant to do it, I make the calls now. If I was talking about something from before, I just say that.]`;
}

/** What my human sees when the retry still ran nothing. */
export const UNBACKED_CLAIM_DISPLAY = 'The reply above says something was done, but no tool ran this turn.';
