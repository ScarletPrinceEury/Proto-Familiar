/**
 * text-normalize.js — shared normaliser for MATCHING, never for storage/display.
 *
 * It only ever WIDENS what a matcher catches: the stored and displayed message
 * is untouched; callers normalise a *copy* purely to score or key against it. So
 * the crisis regex floor (`scoreMessage`), tome-key matching, and the shipped
 * condition-tome rewrite can all read the same shape of a message — a curly
 * apostrophe or a "wanna" never silently slips past a safety pattern again.
 *
 * Kept deliberately separate from `normalizeForMl` (the ML head's byte-for-byte
 * mirror of the Python trainer): that one must NOT change, this one is free to.
 *
 * What it does:
 *   - curly / prime apostrophes and quotes → straight
 *   - expand slang contractions: wanna→want to, gonna→going to, gotta→got to
 *   - restore the apostrophe on common un-apostrophed contractions
 *     (dont→don't, cant→can't, wont→won't, didnt→didn't, im→i'm, ive→i've,
 *     isnt→isn't, doesnt→doesn't) — whole words only
 *   - collapse runs of whitespace
 */

// Un-apostrophed contractions → their apostrophised form. Whole-word only, so
// "him"/"limb"/"import" are never touched. Expansions are lowercase; every
// matcher that reads this is case-insensitive, so case is not load-bearing.
const APOSTROPHE_RESTORE = {
  dont: "don't", cant: "can't", wont: "won't", didnt: "didn't",
  im: "i'm", ive: "i've", isnt: "isn't", doesnt: "doesn't",
};
const APOSTROPHE_RE = /\b(dont|cant|wont|didnt|im|ive|isnt|doesnt)\b/gi;

// Slang contractions → the literal form the patterns/keys are written in.
const SLANG = { wanna: 'want to', gonna: 'going to', gotta: 'got to' };
const SLANG_RE = /\b(wanna|gonna|gotta)\b/gi;

/**
 * Normalise text for matching. Returns a new string; the input is never mutated.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  let t = String(text ?? '');
  // Curly / prime apostrophes → straight, BEFORE the contraction restores so a
  // curly "don’t" becomes straight "don't" and the restore never double-fires.
  t = t.replace(/[‘’ʼ′]/g, "'");   // ‘ ’ ʼ ′ → '
  t = t.replace(/[“”″]/g, '"');          // “ ” ″ → "
  t = t.replace(SLANG_RE, (m) => SLANG[m.toLowerCase()]);
  t = t.replace(APOSTROPHE_RE, (m) => APOSTROPHE_RESTORE[m.toLowerCase()]);
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
