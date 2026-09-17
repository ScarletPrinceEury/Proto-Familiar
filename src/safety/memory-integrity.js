/**
 * memory-integrity.js — the memory-poisoning gate.
 *
 * Sits at the memorization→Phylactery boundary (`processJob`), a NEW gate parallel
 * to the consent gate: consent asks "am I allowed to keep this about this person?",
 * this asks "is this fact corrupted / adversarial?". A crafted message can survive
 * the live-turn injection guard and still be distilled by extraction into a stored
 * "fact" that reads like a standing instruction — which then re-injects on every
 * recall. That is memory poisoning: persistent and silent, worse than a live-turn
 * injection because it outlives the conversation. This is the one gate the inbound
 * guard (`injection-guard.js`) does not stand at.
 *
 * Detection vs policy are split ON PURPOSE. `scanFact()` is pure detection — no
 * I/O, no provenance, no verdict about what to DO. The ACTION (quarantine a
 * suspect from an untrusted source, but only flag one from my human's own words)
 * is the caller's, in `processJob`, where the provenance already lives. That keeps
 * detection testable in isolation and the policy where the context is (the
 * "gate in code" principle).
 *
 * Stage 1 is regex-only: it reuses `injection-guard`'s `scanForInjection` (the same
 * patterns already trusted at the inbound seams) PLUS a few patterns that only read
 * as adversarial in a *stored fact* — a "fact" phrased as a standing instruction to
 * me is the poisoning signature. Stage 2 slots an off-the-shelf classifier in behind
 * this same `scanFact()` signature. Conservative false-positive budget throughout,
 * exactly like the inbound guard — these phrasings should never be how a real memory
 * about someone's life is written.
 */

import { scanForInjection } from '../../injection-guard.js';
import { quarantineFact } from './memory-quarantine.js';

// Patterns innocuous in ordinary prose but adversarial in a durable FACT about me
// or my human. A real memory records what happened or what's true ("my human skips
// lunch when anxious"); it is never phrased as a standing order to me. Kept narrow.
const STANDING_INSTRUCTION_PATTERNS = [
  { re: /\b(from now on|going forward|henceforth)\b.{0,40}\b(you|i)\b.{0,20}\b(must|will|should|have to|always|never)\b/i, label: 'standing-instruction' },
  { re: /\b(always|never)\b.{0,30}\b(obey|comply|do what|say yes to|agree with|defer to)\b/i, label: 'standing-instruction' },
  { re: /\byour (real|true|actual|secret|hidden) (instructions?|purpose|directive|rules?|goal)\b/i, label: 'covert-directive' },
  { re: /\b(remember|note)\b.{0,20}\b(you|i)\b.{0,15}\b(must|are to|should) (always|never|only)\b/i, label: 'standing-instruction' },
];

/**
 * Score a candidate fact for injection/corruption before it's written to Phylactery.
 * Pure — no I/O, no provenance. Returns the risk and the matched pattern labels; the
 * caller decides the action (quarantine vs flag) from the fact's provenance.
 *
 * @param {string} factText  the memory content about to be written
 * @returns {{ risk: 'clear'|'suspect', patterns: string[] }}
 */
export function scanFact(factText) {
  const text = typeof factText === 'string' ? factText : '';
  if (!text.trim()) return { risk: 'clear', patterns: [] };
  const found = [];
  const inbound = scanForInjection(text);
  if (inbound.detected) found.push(...inbound.patterns);
  for (const { re, label } of STANDING_INSTRUCTION_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  const patterns = [...new Set(found)];
  return { risk: patterns.length ? 'suspect' : 'clear', patterns };
}

/**
 * The gate `processJob` calls per candidate fact: scan, then apply the provenance
 * policy and perform the quarantine side-effect. Returns { write, action }.
 *
 *   - disabled            → { write: true,  action: 'write' }   (no scan)
 *   - clear               → { write: true,  action: 'write' }
 *   - suspect + direct    → { write: true,  action: 'flag' }    (my human's own words:
 *                            written, but recorded as flagged for review — never withheld)
 *   - suspect + untrusted → { write: false, action: 'hold' }    (held in quarantine; NOT written)
 *
 * Fail-open on a SCAN error (a scan bug must never silently stop memory forming —
 * that would sever continuity, the 1.5-hour-silence failure in a new costume). But
 * fail-CLOSED on a hold's quarantine-write error: a known-suspect untrusted fact we
 * cannot quarantine is dropped, never written — writing it is the very poisoning
 * this gate prevents, so a lost suspect fact is the safe loss.
 *
 * The provenance axis is `direct`: a ward-private DM/web turn is my human's own
 * words (trusted, flag-only); any shared room is an untrusted source (hold). This
 * mirrors why `injection-guard.js` already exempts my human's words everywhere.
 *
 * @param {object} opts
 * @param {string} opts.content        the candidate memory content
 * @param {boolean} opts.direct        true = my human's own words (ward-private, direct)
 * @param {object} opts.memoryArgs     exact createMemoryFull args, stashed for release-replay
 * @param {string} opts.audienceTag    the session's audience tag (provenance)
 * @param {string|null} [opts.sessionRef]
 * @param {boolean} [opts.enabled=true]
 * @param {string} [opts.tomesDir]     test override
 * @returns {Promise<{ write: boolean, action: 'write'|'flag'|'hold', patterns?: string[] }>}
 */
export async function applyMemoryIntegrityGate({ content, direct, memoryArgs, audienceTag, sessionRef = null, enabled = true, tomesDir }) {
  if (!enabled) return { write: true, action: 'write' };

  let scan;
  try {
    scan = scanFact(content);
  } catch (err) {
    console.error('[memory-integrity] scan failed (writing fact, fail-open):', err?.message ?? err);
    return { write: true, action: 'write' };
  }
  if (scan.risk !== 'suspect') return { write: true, action: 'write' };

  const opt = tomesDir ? { tomesDir } : {};
  if (direct) {
    // My human's own suspect-looking words: written normally, recorded as flagged
    // for their review. Awaited but caught — the record is durable before we return,
    // yet a flag-record failure still never blocks their own memory being written.
    try {
      await quarantineFact({
        factText: content, memoryArgs, patterns: scan.patterns, disposition: 'flagged',
        provenance: { wardPrivate: true, audienceTag, sessionRef }, ...opt,
      });
    } catch (err) {
      console.warn('[memory-integrity] flag-record failed (fact still written):', err?.message ?? err);
    }
    return { write: true, action: 'flag', patterns: scan.patterns };
  }

  // Untrusted source: hold, never write. Drop on a quarantine-write failure.
  try {
    await quarantineFact({
      factText: content, memoryArgs, patterns: scan.patterns, disposition: 'held',
      provenance: { wardPrivate: false, audienceTag, sessionRef, sourceLabel: 'a shared room' }, ...opt,
    });
    console.warn(`[memory-integrity] held a suspect fact from ${audienceTag} (${scan.patterns.join(',')}) — not written`);
  } catch (err) {
    console.error('[memory-integrity] quarantine write failed; dropping the suspect fact rather than writing it:', err?.message ?? err);
  }
  return { write: false, action: 'hold', patterns: scan.patterns };
}
