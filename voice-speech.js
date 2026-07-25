/**
 * Turning what I wrote into what I say (voice spec §11).
 *
 * What reaches the screen is markdown written to be READ: asterisks for
 * emphasis, backticks around identifiers, links with urls behind them,
 * headings made of hashes. Handing that to a speech model verbatim produces
 * "asterisk asterisk careful asterisk asterisk", which is not emphasis — it is
 * noise where the emphasis was.
 *
 * So there is a translation step, and it is lossy on purpose. The rule
 * throughout: keep what carries meaning aloud, drop what only carried
 * formatting on a screen.
 *
 * ── Code is summarised, not spelled out ─────────────────────────────────
 * A fenced block read character by character is unusable — minutes of
 * punctuation nobody can follow, with no way to skip. Saying that a code block
 * is there, and how long, lets someone decide to go look at it. Silently
 * skipping it would be worse than either: they would never know it existed.
 *
 * ── This is an accessibility surface ────────────────────────────────────
 * The people most likely to use read-aloud are the ones least able to fall
 * back on reading the screen when it goes wrong. That is why nothing here
 * throws, and why an empty result is reported as empty rather than sent to the
 * engine as a silent clip that looks like a failure.
 */

import { stripLlmTimestamps } from './message-sanitize.mjs';

/** Beyond this, one utterance is split even without punctuation to split on. */
const MAX_CHUNK_CHARS = 240;

/** Below this, a chunk is merged into its neighbour rather than spoken alone. */
const MIN_CHUNK_CHARS = 24;

/**
 * Abbreviations whose full stop does not end a sentence.
 *
 * Not exhaustive and cannot be — this is a heuristic, and its failure mode is
 * a pause in an odd place, which is survivable. Anything that tried harder
 * would be a sentence tokeniser, which is a large thing to own for a cosmetic
 * gain.
 */
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'no',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

/**
 * Emoji and pictographs. Speech models either mangle these or say the CLDR
 * name aloud ("grinning face with smiling eyes"), and neither is what the
 * emoji meant.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Markdown as spoken text.
 *
 * Returns `{ text, notes }` — `notes` names what was summarised rather than
 * read, so a caller can show it. Something removed silently is something my
 * human cannot know they missed.
 */
export function speakableText(input) {
  if (typeof input !== 'string' || !input.trim()) return { text: '', notes: [] };

  const notes = [];
  // Timestamps first: the repo rule is that an LLM-emitted [HH:MM] is a
  // hallucination artifact, and speaking one aloud would state a time nothing
  // measured.
  let s = stripLlmTimestamps(input);

  // Fenced code — summarised, never spelled out.
  s = s.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const lines = body.replace(/\n+$/, '').split('\n').length;
    const what = String(lang || '').trim();
    notes.push(`a code block (${plural(lines, 'line')}${what ? `, ${what}` : ''}) was not read out`);
    return ` (${what ? `${what} ` : ''}code block, ${plural(lines, 'line')}) `;
  });

  // Indented code blocks are ambiguous with wrapped prose, so they are left
  // alone deliberately — guessing wrong would mangle ordinary text.

  s = s
    // Images: the alt text is the only part that was ever meant for a person.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt ? `image, ${alt}` : 'an image'))
    // Links: say the label, drop the url. Reading a url aloud is punctuation soup.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Inline code: keep the contents. These are usually a name worth hearing.
    .replace(/`([^`]+)`/g, '$1')
    // Emphasis markers, not the words inside them.
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    // Headings: the text is the point, the hashes were a size.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // Blockquote markers.
    .replace(/^\s{0,3}>\s?/gm, '')
    // Horizontal rules say nothing aloud.
    .replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, '')
    // Bullets: the marker is visual. A line break already reads as a pause.
    .replace(/^\s*[-*+]\s+/gm, '')
    // Numbered lists keep their numbers — "1." is information, not decoration.
    .replace(EMOJI, '')
    // Table pipes would otherwise be read as stray punctuation.
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' ').trim())
    .replace(/[ \t]+/g, ' ')
    // Removing something mid-sentence — an emoji, an image, a marker — leaves
    // its spacing behind, and " ." is heard as a pause in the wrong place.
    // Close the gap rather than letting the removal be audible.
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: s, notes };
}

/** Does this full stop end a sentence, or an abbreviation? */
function endsAbbreviation(text, dotIndex) {
  const before = text.slice(0, dotIndex).toLowerCase();
  const word = before.match(/([a-z.]+)$/)?.[1] ?? '';
  if (ABBREVIATIONS.includes(word)) return true;
  // A single letter before a dot is an initial: "J. R. R."
  return /(^|\s)[a-z]$/.test(before);
}

/**
 * Split into utterances the engine speaks one at a time.
 *
 * The engine is configured `maxNumSentences: 1`, and splitting here is what
 * makes streaming possible at all: measured RTF is below 1, so while one
 * utterance plays the next has time to render. Handing over the whole message
 * would mean waiting for all of it before hearing any of it.
 */
export function splitForSpeech(text, { maxChars = MAX_CHUNK_CHARS, minChars = MIN_CHUNK_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];

  const out = [];
  let buf = '';

  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;

    const sentenceEnd = (ch === '.' || ch === '!' || ch === '?')
      && !(ch === '.' && endsAbbreviation(text, i))
      && (i + 1 >= text.length || /[\s"')\]]/.test(text[i + 1]));

    // A blank line is a paragraph break and a real pause.
    const paragraphEnd = ch === '\n' && text[i + 1] === '\n';

    if (sentenceEnd || paragraphEnd) {
      if (buf.trim().length >= minChars) flush();
      continue;
    }

    if (buf.length >= maxChars) {
      // No sentence boundary in reach. Break at the last clause boundary or
      // space rather than mid-word — a word cut in half is heard as an error,
      // while a slightly early pause is not.
      const cut = Math.max(buf.lastIndexOf(', '), buf.lastIndexOf('; '), buf.lastIndexOf(' — '), buf.lastIndexOf(' '));
      if (cut > minChars) {
        const rest = buf.slice(cut + 1);
        buf = buf.slice(0, cut + 1);
        flush();
        buf = rest;
      } else {
        flush();
      }
    }
  }
  flush();

  return out;
}

/**
 * How much text one generation may carry.
 *
 * Deliberately large. A whole message SHOULD be one generation — PocketTTS
 * clones zero-shot per call with no seed, so every extra generation is
 * another roll of the dice on what the voice sounds like. This cap exists
 * only so that a pathologically long message cannot ask the engine to hold
 * minutes of audio in memory at once, not to chop ordinary messages up.
 */
const MAX_GENERATION_CHARS = 3000;

/**
 * Split for GENERATION, which is a different question from splitting for
 * playback.
 *
 * Almost always returns one part. When it cannot, it breaks at paragraph
 * boundaries and then at sentences — a seam where the voice may shift is far
 * less jarring between paragraphs than mid-thought, and a seam is exactly
 * what a second generation costs.
 */
export function splitForGeneration(text, { maxChars = MAX_GENERATION_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  if (text.length <= maxChars) return [text.trim()];

  const parts = [];
  let buf = '';
  for (const para of text.split(/\n{2,}/)) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (candidate.length <= maxChars) { buf = candidate; continue; }
    if (buf) { parts.push(buf.trim()); buf = ''; }

    if (para.length <= maxChars) { buf = para; continue; }
    // A single paragraph over the cap: fall back to sentences, packed as
    // full as they will go so there are as few seams as possible.
    let sub = '';
    for (const sentence of splitForSpeech(para, { maxChars: maxChars, minChars: 1 })) {
      const next = sub ? `${sub} ${sentence}` : sentence;
      if (next.length <= maxChars) sub = next;
      else { if (sub) parts.push(sub.trim()); sub = sentence; }
    }
    if (sub) buf = sub;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

/**
 * Everything at once: markdown in, generation units out.
 *
 * `spoken` is the text actually sent to the engine, kept so a caller can show
 * what was said rather than what was written — they differ, and that
 * difference is the whole point of this module.
 *
 * `parts` is normally length 1. `seams` counts the places where a second
 * generation had to start, which is the number of points a listener might
 * hear the voice shift. Reported rather than hidden: an unavoidable seam is
 * survivable, an unexplained one sounds like a bug.
 */
export function prepareForSpeech(input, opts = {}) {
  const { text, notes } = speakableText(input);
  const parts = splitForGeneration(text, opts);
  return {
    parts,
    seams: Math.max(0, parts.length - 1),
    spoken: text,
    notes,
    empty: parts.length === 0,
  };
}
