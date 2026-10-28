// The Familiar can take things OUT of its own identity files (0.14.72).
//
// Found in the first identity review with a live Familiar: update_identity only
// appends, so "moving" a line out added a pointer under it; rewrite_identity_section
// can't reach a file without ## headings, and on a misnamed heading it appended a
// new section while answering "ok" (the thalamus wrapper read Phylactery's reply
// as success whatever it said); and nothing could cut a single line. These run
// the real executors through the real thalamus wrappers into a stub Phylactery.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { BUILTIN_TOOLS, executeToolCall } = await import('../cerebellum.js');
const { __setPhylacteryClientForTest, setIdentityGraduationPaused } = await import('../thalamus.js');
const { TOOL_MODULES } = await import('../tool-surfacing.js');

let calls = [];
let reply = () => ({ ok: true });
beforeEach(() => {
  calls = [];
  reply = () => ({ ok: true });
  __setPhylacteryClientForTest({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify(reply(name, args)) }] };
    },
  });
});

const sent = (name) => calls.find(c => c.name === name)?.args;
const run = (tool, args) => executeToolCall(tool, JSON.stringify(args));

test('remove_from_identity cuts a quoted passage through identity_remove_text', async () => {
  reply = () => ({ ok: true, removed_chars: 45, chars: 780 });
  const out = await run('remove_from_identity', { category: 'ward', filename: 'user_notes.md', passage: '**Pets:** two cats.' });
  assert.deepEqual(sent('identity_remove_text'), { category: 'ward', filename: 'user_notes.md', passage: '**Pets:** two cats.', instanceId: 'proto-familiar' });
  assert.equal(out, 'Cut 45 characters from ward/user_notes.md (now 780). read_identity_file shows it now.');
});

test('a passage Phylactery refuses comes back as "Nothing removed", never ok', async () => {
  reply = (name) => name === 'identity_remove_text'
    ? { ok: false, error: "that passage is in ward/user_notes.md 2 times; quote more around it so it's one place" }
    : { ok: true };
  const out = await run('remove_from_identity', { category: 'ward', filename: 'user_notes.md', passage: '- tea' });
  assert.match(out, /^Nothing removed: that passage is in .* 2 times/);
});

test('rewrite_identity_section never appends a section that is not there; it names the real headings', async () => {
  reply = (name) => name === 'identity_rewrite_section'
    ? { ok: false, error: "no section headed 'Pets' in ward/user_identity.md", sections: ['Who They Are', 'Places'] }
    : { ok: true };
  const out = await run('rewrite_identity_section', { category: 'ward', filename: 'user_identity.md', section: 'Pets', content: '' });
  assert.equal(sent('identity_rewrite_section').create_if_missing, false);
  assert.match(out, /^Nothing rewritten: /);
  assert.match(out, /"Who They Are", "Places"/);
});

test('a file with no headings points me at remove_from_identity', async () => {
  reply = (name) => name === 'identity_rewrite_section'
    ? { ok: false, error: "no section headed 'Habits' in ward/user_notes.md", sections: [] }
    : { ok: true };
  const out = await run('rewrite_identity_section', { category: 'ward', filename: 'user_notes.md', section: 'Habits', content: 'x' });
  assert.match(out, /no ## headings, so I cut lines with remove_from_identity/);
});

test('a section that is there is rewritten, and the result says so (A1: no more quiet ok)', async () => {
  reply = () => ({ ok: true, replaced: true, chars: 412 });
  const out = await run('rewrite_identity_section', { category: 'ward', filename: 'user_identity.md', section: 'Places', content: 'Lisbon' });
  assert.equal(out, 'Rewrote "Places" in ward/user_identity.md (now 412 chars). read_identity_file shows it now.');
});

test('delete_identity_section removes a whole section, and says so when it cannot', async () => {
  const ok = await run('delete_identity_section', { category: 'ward', filename: 'user_identity.md', section: 'Pets' });
  assert.deepEqual(sent('identity_delete_section'), { category: 'ward', filename: 'user_identity.md', section: 'Pets', instanceId: 'proto-familiar' });
  assert.equal(ok, 'Removed the section "Pets" from ward/user_identity.md. read_identity_file shows it now.');
  reply = (name) => name === 'identity_delete_section' ? { ok: false, error: "section not found: 'Nope'" } : { ok: true };
  assert.match(await run('delete_identity_section', { category: 'ward', filename: 'user_identity.md', section: 'Nope' }), /^Nothing deleted: section not found/);
});

test('the pause on automatic identity cleanup reaches Phylactery as a boolean', async () => {
  await setIdentityGraduationPaused(true);
  assert.deepEqual(sent('identity_graduation_pause'), { paused: true });
  calls = [];
  await setIdentityGraduationPaused(undefined);
  assert.deepEqual(sent('identity_graduation_pause'), { paused: false });
});

test('I can find these tools and know update_identity only adds', () => {
  const fn = (n) => BUILTIN_TOOLS.find(t => t.function.name === n)?.function;
  assert.ok(fn('remove_from_identity') && fn('delete_identity_section'));
  // 0.14.75: core, beside update_identity (see the test below).
  assert.equal(TOOL_MODULES.remove_from_identity, 'core');
  assert.equal(TOOL_MODULES.delete_identity_section, 'core');
  assert.match(fn('update_identity').description, /only ADDS; it can't take anything out/);
  assert.match(fn('update_identity').description, /remove_from_identity/);
});

test('a turn that can add to my identity can always cut, delete and rewrite too', async () => {
  // Found live: with only update_identity in core, a turn without the memory-edit
  // group "removed" a duplicate section by appending it twice. The edit tools
  // now travel together, whatever modules a turn surfaces.
  const { composeActiveTools } = await import('../cerebellum.js');
  const coreOnly = composeActiveTools([], {}, { modules: new Set() }).map(t => t.function.name);
  for (const n of ['update_identity', 'remove_from_identity', 'delete_identity_section', 'rewrite_identity_section']) {
    assert.ok(coreOnly.includes(n), `${n} is offered with core alone`);
  }
  const { VILLAGER_WRITE_TOOLS } = await import('../cerebellum.js');
  for (const n of ['remove_from_identity', 'delete_identity_section', 'rewrite_identity_section']) {
    assert.ok(!VILLAGER_WRITE_TOOLS.has(n), `${n} is never a villager tool`);
  }
});
