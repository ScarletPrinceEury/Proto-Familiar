/**
 * Reading an identity file, and edits that act on one section (known-issues A1).
 *
 * Before: no tool read an identity file, so after an edit I only had the copy
 * loaded at the start of the turn; rewrite and delete acted on EVERY section
 * with a matching heading; a rewrite whose new text carried the next section
 * left it in twice; and appendIdentity reported a failed append as ok.
 *
 * The pure result texts are tested here, and one run goes through my own tool
 * calls into the real Phylactery child, on a throwaway store.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'pf-identity-'));
mkdirSync(path.join(tmp, 'phylactery'), { recursive: true });
process.env.PHYLACTERY_DB_PATH = path.join(tmp, 'phylactery', 'phylactery.db');
process.env.UNRUH_DB_PATH = path.join(tmp, 'unruh.db');

const { formatIdentityRead, identityRefusal, appendedText, removeRefusal, CHECK_TAIL } = await import('../src/memory/identity-results.js');
const { executeToolCall, TOOL_EXECUTORS, BUILTIN_TOOLS } = await import('../cerebellum.js');
const { TOOL_MODULES } = await import('../tool-surfacing.js');
const thalamus = await import('../thalamus.js');

after(() => {
  try { thalamus.shutdownPhylactery?.(); } catch { /* best-effort */ }
  try { thalamus.shutdownUnruh?.(); } catch { /* best-effort */ }
  delete process.env.PHYLACTERY_DB_PATH;
  delete process.env.UNRUH_DB_PATH;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── What I hear back ─────────────────────────────────────────────────────────

test('a read shows size, how the category sits against its share, numbered headings, and the text', () => {
  const content = '# P\n\n## Tone\nwarm\n\n## Tone\nblunt\n';
  const out = formatIdentityRead({
    category: 'self', filename: 'my_persona.md', content, chars: content.length,
    outline: [{ heading: 'P', level: 1, chars: 5 }, { heading: 'Tone', level: 2, chars: 13, occurrence: 1, of: 2 }, { heading: 'Tone', level: 2, chars: 14, occurrence: 2, of: 2 }],
  }, { self: [{ content }, { content: 'x'.repeat(4000) }] }, 6000);
  assert.match(out, /^self\/my_persona\.md: 33 chars\. My self files together are about 1,000 of the ~3,500 tokens I keep for them\./);
  assert.match(out, /## Tone \(1 of 2\) · 13 chars\n## Tone \(2 of 2\) · 14 chars/);
  assert.ok(out.endsWith(content));
});

test('refusals say what to do next, plainly', () => {
  const at = { category: 'self', filename: 'my_persona.md', section: 'Tone' };
  assert.equal(identityRefusal('rewritten', { code: 'duplicate', count: 2 }, at),
    'Nothing rewritten: there are 2 sections headed "Tone" in self/my_persona.md. I pass occurrence (1 or 2) to say which one; read_identity_file numbers them.');
  assert.match(identityRefusal('rewritten', { code: 'includes_heading', headings: ['Habits'] }, at), /already has as its own section\. I can rewrite "Habits" on its own/);
  assert.match(identityRefusal('deleted', { error: "section not found: 'X'", sections: ['A', 'B'] }, at), /Its headings are: "A", "B"\./);
  assert.match(removeRefusal({ code: 'not_found' }, at), /It may already be gone \(read_identity_file shows the file now\)/);
  assert.equal(appendedText({ category: 'self', filename: 'my_wants.md', added: 312, chars: 1840, under: "Things I'm curious about" }),
    'Added 312 chars at the end of self/my_wants.md, under "Things I\'m curious about" (now 1,840).');
});

test('read_identity_file is a core tool, and stays out of shared rooms', async () => {
  assert.equal(TOOL_MODULES.read_identity_file, 'core');
  assert.ok(BUILTIN_TOOLS.some(t => t.function.name === 'read_identity_file'));
  const refusal = /^I read my identity files in my own conversations with my human, not here\.$/;
  // A gated Discord room, and the web chat with others present.
  assert.match(await TOOL_EXECUTORS.read_identity_file({ category: 'self', filename: 'my_persona.md' }, { discord: true, wardPrivate: false, audiences: ['cat-friends'] }), refusal);
  assert.match(await TOOL_EXECUTORS.read_identity_file({ category: 'self', filename: 'my_persona.md' }, { wardPrivate: false, audienceTag: 'cat-friends' }), refusal);
});

// ── Through the real Phylactery child ────────────────────────────────────────

let up = null;
async function phylacteryUp() {
  if (up !== null) return up;
  await thalamus.startThalamus();
  const probe = await thalamus.readIdentityFile({ category: 'self', filename: 'nope.md' });
  up = !(probe?.ok === false && /not connected/i.test(probe.error ?? ''));
  return up;
}
const call = async (name, args) => String(await executeToolCall(name, JSON.stringify(args), {}));

test('cross-process: append, read, refuse a duplicate, pick one, refuse a carried section, delete one', { timeout: 120_000 }, async (t) => {
  if (!(await phylacteryUp())) return t.skip('Phylactery not connected (uv/venv absent)');
  const f = { category: 'custom', filename: 'test_persona.md' };

  let out = await call('update_identity', { ...f, content: '# Test\n\n## Tone\nwarm\n\n## Habits\n#nightowl\nlate nights\n\n## Tone\nblunt' });
  assert.match(out, /^Started custom\/test_persona\.md with \d+ chars\. read_identity_file shows it now\./);
  out = await call('update_identity', { ...f, content: '- naps' });
  assert.match(out, /^Added 6 chars at the end of custom\/test_persona\.md, under "Tone" \(now \d+\)\./);

  out = await call('read_identity_file', f);
  assert.match(out, /## Tone \(1 of 2\)/);
  assert.match(out, /## Tone \(2 of 2\)/);
  assert.match(out, /#nightowl/);

  out = await call('rewrite_identity_section', { ...f, section: 'Tone', content: 'calm' });
  assert.match(out, /^Nothing rewritten: there are 2 sections headed "Tone"/);
  out = await call('rewrite_identity_section', { ...f, section: 'Tone', content: 'calm', occurrence: 2 });
  assert.match(out, new RegExp(`^Rewrote "Tone" \\(number 2\\) in custom/test_persona\\.md \\(now \\d+ chars\\)\\. ${CHECK_TAIL.replace('.', '\\.')}`));
  out = await call('rewrite_identity_section', { ...f, section: 'Habits', content: 'early now\n\n## Tone\nwarm' });
  assert.match(out, /^Nothing rewritten: the new text has "Tone" in it/);

  out = await call('delete_identity_section', { ...f, section: 'Tone', occurrence: 1 });
  assert.match(out, /^Removed the section "Tone" \(number 1\)/);
  const read = await thalamus.readIdentityFile(f);
  assert.equal(read.ok, true);
  assert.equal(read.content.split('## Tone').length - 1, 1, 'one Tone left');
  assert.match(read.content, /## Tone\ncalm/);
  assert.match(read.content, /#nightowl\nlate nights/, 'the hashtag line stayed inside Habits');

  out = await call('remove_from_identity', { ...f, passage: 'this was never there' });
  assert.match(out, /^Nothing removed: that passage isn't in custom\/test_persona\.md as quoted\./);
});
