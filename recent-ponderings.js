/**
 * Recent ponderings — surface the Familiar's own quiet thoughts into
 * its working memory so it can reference them naturally in conversation.
 *
 * Step 3' of the caring spine: close the honesty loop.
 *
 * Ponderings are stored in the "Familiar's Ponderings" tome with
 * enabled:false (no keyword auto-fire), so they will never sneak in
 * as fake-RAG lore. This module is the deliberate path: read the
 * most recent N, format them with framing that tells the model
 * "these are your own real thoughts — reference if relevant, never
 * invent."
 *
 * Recency-only (not relevance search): ponderings are a short list of
 * what's been on the Familiar's mind lately, not a knowledge base.
 * Entity-core's RAG handles relevance search for memories.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import { PONDERINGS_TOME_NAME } from './pondering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read the most recent pondering entries from the Ponderings tome.
 *
 * Returns up to `limit` entries (default 3), newest first, filtered to
 * those created within `sinceDays` (default 7). Returns [] cleanly if
 * the tomes directory is missing, the tome doesn't exist yet, or all
 * entries are too old.
 */
export async function getRecentPonderings({
  tomesDir   = DEFAULT_TOMES_DIR,
  limit      = 3,
  sinceDays  = 7,
  now        = Date.now(),
} = {}) {
  let files;
  try { files = await fsp.readdir(tomesDir); }
  catch { return []; }

  let tome = null;
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      const raw = await fsp.readFile(path.join(tomesDir, f), 'utf8');
      const t   = JSON.parse(raw);
      if (t?.name === PONDERINGS_TOME_NAME) { tome = t; break; }
    } catch { /* skip corrupt */ }
  }
  if (!tome || !tome.entries) return [];

  const cutoff = now - sinceDays * DAY_MS;
  return Object.values(tome.entries)
    .filter(e => e && typeof e.created_at === 'string')
    .map(e => ({
      uid:        e.uid,
      title:      e.comment ?? '',
      content:    e.content ?? '',
      topic:      e.topic_pondered ?? null,
      created_at: e.created_at,
      created_ms: Date.parse(e.created_at),
    }))
    .filter(e => Number.isFinite(e.created_ms) && e.created_ms >= cutoff && e.content.trim())
    .sort((a, b) => b.created_ms - a.created_ms)
    .slice(0, limit);
}

/**
 * Render pondering entries as a prompt-injection block.
 *
 * The framing tells the model these are its own real private thoughts
 * — available for natural reference if the conversation touches them,
 * never to invent or shoehorn. Returns empty string when there's
 * nothing to surface, so the caller can drop the section entirely
 * rather than print a hollow header.
 */
export function formatPonderingsForPrompt(entries) {
  if (!entries || entries.length === 0) return '';

  const lines = [
    'Things you (the Familiar) have been quietly thinking about on your own, recently:',
    '',
  ];
  for (const e of entries) {
    const stamp = e.created_at.replace('T', ' ').slice(0, 16) + ' UTC';
    lines.push(`— ${stamp} · "${e.title}"`);
    lines.push(e.content);
    lines.push('');
  }
  lines.push(
    'These are your own real, private thoughts — written by you, in your own voice, ' +
    'during quiet moments when no one was talking to you. You may reference them ' +
    'naturally if they fit what the user is talking about ("I was actually thinking ' +
    'about this last night…"). Never invent a thought you didn\'t actually have. ' +
    'Never force a reference where it doesn\'t fit. If nothing here is relevant to ' +
    'this conversation, just let them sit — they don\'t need to be mentioned.'
  );
  return lines.join('\n');
}
