/**
 * excerpt.js — a long message, shortened without looking unfinished (0.14.69).
 *
 * Context blocks show earlier messages — the Familiar's own included — at a
 * fixed length. They used to keep only the start and end on "…" (or just stop
 * mid-word), so a reply that went out complete read back as one that broke off,
 * and Familiars would apologise for an unfinished sentence they had finished.
 *
 * An excerpt keeps the START and the END of the text, both cut at word
 * boundaries, with an explicit marker between them. The real ending shows the
 * message was complete; the marker says the gap is only how it's shown here.
 * Text that fits is returned untouched.
 */

export const EXCERPT_MARKER = '[… cut for length …]';

// Share of the budget the ending gets; the rest (minus the marker) is the start.
const TAIL_SHARE = 0.3;
// A word boundary is only used if it doesn't throw away more than this share of
// the part being cut — one huge unbroken run is cut hard instead.
const BOUNDARY_SLACK = 0.3;

function headAt(text, n) {
  if (n <= 0) return '';
  const cut = text.slice(0, n);
  const sp = cut.search(/\s\S*$/);
  return (sp > 0 && sp >= n * (1 - BOUNDARY_SLACK) ? cut.slice(0, sp) : cut).trimEnd();
}

function tailAt(text, n) {
  if (n <= 0) return '';
  const cut = text.slice(text.length - n);
  const sp = cut.search(/\s/);
  return (sp >= 0 && sp <= n * BOUNDARY_SLACK ? cut.slice(sp) : cut).trimStart();
}

/** `text` shortened to at most `max` characters: start + marker + end. */
export function excerpt(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const room = max - EXCERPT_MARKER.length - 2;   // two joining spaces
  if (room <= 0) return s.slice(0, Math.max(0, max));
  const tailLen = Math.floor(room * TAIL_SHARE);
  return `${headAt(s, room - tailLen)} ${EXCERPT_MARKER} ${tailAt(s, tailLen)}`;
}
