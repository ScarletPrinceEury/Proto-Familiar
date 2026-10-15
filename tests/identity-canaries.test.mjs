// Identity canary stamps (0.14.79): the app checks them, I hear when one breaks.
//
// From the identity review: my Familiar keeps exact "canary" lines in its
// identity files and checked them by eye after every rewrite. A stamp's job is
// being matched character for character, which is the one check the app does
// strictly better. These pin the check (room-aware, so a file a group room
// doesn't get never reads as "missing"), the block I see only when something's
// off, the warning an identity edit returns when it just broke a stamp, and a
// pipeline case through the real enrich().
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { BUILTIN_TOOLS, executeToolCall, composeActiveTools, villagerToolNames } = await import('../cerebellum.js');
const { __setPhylacteryClientForTest, enrich, listIdentityCanaries } = await import('../thalamus.js');
const { TOOL_MODULES, selectModules } = await import('../tool-surfacing.js');
const { canaryStateInFile, checkCanaries, checkCanariesInFiles, formatCanaryBlock, formatCanaryEditNote, CANARY_BLOCK_TITLE } =
  await import('../src/memory/identity-canaries.js');

const PERSONA = '[canary v1 — persona: if I can read this line, my persona file loaded whole]';
const TAIL = '[canary v1 — tail: if I can read this line, my identity reached its end]';
const C_PERSONA = { id: 'canary-persona-a1', category: 'self', filename: 'my_persona.md', text: PERSONA, label: 'persona', at_end: false };
const C_TAIL = { id: 'canary-tail-b2', category: 'custom', filename: 'notes.md', text: TAIL, label: 'tail', at_end: true };

const files = (persona = `I'm blunt.\n${PERSONA}\nMore.`, notes = `Odds and ends.\n${TAIL}`) => ({
  self: [{ filename: 'my_persona.md', content: persona }],
  ward: [], relationship: [],
  custom: [{ filename: 'notes.md', content: notes }],
});
const block = (f) => `<my_persona>\n${f.self[0].content}\n</my_persona>\n---\n<notes>\n${f.custom[0].content}\n</notes>`;

test('a stamp in its own file: ok, missing, changed, duplicated, not last', () => {
  assert.equal(canaryStateInFile(C_PERSONA, `a\n${PERSONA}\nb`), 'ok');
  assert.equal(canaryStateInFile(C_PERSONA, 'a\nb'), 'missing');
  assert.equal(canaryStateInFile(C_PERSONA, `a\n${PERSONA.replace(' — ', '  —\n')}`), 'changed', 'same words, different spacing');
  assert.equal(canaryStateInFile(C_PERSONA, 'a\n[canary v1 — persona: edited by a cleanup]'), 'changed', 'starts the same, says something else');
  assert.equal(canaryStateInFile(C_PERSONA, 'a\n[canary v1 — tail: other]', ['[canary v1 — tail: other]']), 'missing', 'another registered stamp is not a lookalike');
  assert.equal(canaryStateInFile(C_PERSONA, `${PERSONA}\n${PERSONA}`), 'duplicated');
  assert.equal(canaryStateInFile(C_TAIL, `${TAIL}\nappended after`), 'not-last');
  assert.equal(canaryStateInFile(C_TAIL, `x\n${TAIL}\n\n`), 'ok', 'trailing whitespace is fine');
});

test('the per-turn check is room-aware and reads the identity that actually went out', () => {
  const f = files();
  const ok = checkCanaries({ canaries: [C_PERSONA, C_TAIL], files: f, staticBlock: block(f) });
  assert.deepEqual(ok.map(r => r.state), ['ok', 'ok']);
  assert.equal(formatCanaryBlock(ok), '', 'silent when everything checks out');

  // A group room without identityBasic gets only my self files: not missing.
  const room = checkCanaries({ canaries: [C_PERSONA, C_TAIL], files: f, staticBlock: `<my_persona>\n${f.self[0].content}\n</my_persona>`, layersIncluded: false });
  assert.deepEqual(room.map(r => r.state), ['ok', 'not-in-room']);
  assert.equal(formatCanaryBlock(room), '');

  // A gate marker that strips the stamp's section in this room: not missing either.
  const gated = checkCanaries({ canaries: [C_TAIL], files: f, staticBlock: '', stripGated: (s) => s.replace(TAIL, '') });
  assert.equal(gated[0].state, 'gated');

  // In the file but not in what went out: that is the injection failing.
  const lost = checkCanaries({ canaries: [C_PERSONA], files: f, staticBlock: '<my_persona>\nI\'m blunt.\n</my_persona>' });
  assert.equal(lost[0].state, 'not-injected');

  // The end marker with something after it in the outgoing block.
  const after = checkCanaries({ canaries: [C_TAIL], files: f, staticBlock: `${block(f)}\n---\n<zz_later>\nnew file\n</zz_later>` });
  assert.equal(after[0].state, 'not-last');

  // My identity didn't load at all: that's not the stamp leaving its file.
  assert.equal(checkCanaries({ canaries: [C_PERSONA], files: {}, staticBlock: '' })[0].state, 'not-injected');
});

test('the block names what broke in plain words and never prints the stamp', () => {
  const f = files('I\'m blunt.\nMore.');
  const out = formatCanaryBlock(checkCanaries({ canaries: [C_PERSONA, C_TAIL], files: f, staticBlock: block(f) }));
  assert.ok(out.startsWith(CANARY_BLOCK_TITLE));
  assert.match(out, /- "persona" isn't in self\/my_persona\.md any more\./);
  assert.doesNotMatch(out, /tail/, 'only the broken one');
  assert.ok(!out.includes(PERSONA), 'the stamp text stays out of the block');
  assert.match(out, /add_identity_canary .* retire_identity_canary/);
});

let calls = [];
let identity = files();
let canaries = [C_PERSONA, C_TAIL];
beforeEach(async () => {
  calls = [];
  identity = files();
  canaries = [C_PERSONA, C_TAIL];
  __setPhylacteryClientForTest({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      const reply = name === 'identity_get_all' ? identity
        : name === 'identity_canary_list' ? { items: canaries }
        : name === 'identity_remove_text' ? { ok: true, removed_chars: 10, chars: 100 }
        : name === 'identity_canary_add' ? { ok: true, existed: false, canary: { ...C_TAIL, ...args, label: args.label ?? 'notes' } }
        : { ok: true, items: [], results: [] };
      return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
    },
  });
  await listIdentityCanaries({ force: true });
});
const run = (tool, args, ctx) => executeToolCall(tool, JSON.stringify(args), ctx);

test('an identity edit that breaks a stamp says so right away; one that does not stays quiet', async () => {
  assert.equal(await run('remove_from_identity', { category: 'self', filename: 'my_persona.md', passage: 'More.' }), 'ok');
  identity = files('I\'m blunt.\nMore.');   // the edit took the stamp with it
  const out = await run('remove_from_identity', { category: 'self', filename: 'my_persona.md', passage: PERSONA });
  assert.match(out, /^Cut 10 characters from self\/my_persona\.md \(now 100\)\. Heads up: after that edit my canary stamp "persona" isn't in self\/my_persona\.md any more\./);
  assert.match(out, /add_identity_canary/);
  const appended = await run('update_identity', { category: 'custom', filename: 'notes.md', content: 'x' });
  assert.equal(appended, 'ok', 'appending to a file whose end marker is still last is fine');
  identity = files(undefined, `Odds.\n${TAIL}\nappended after the tail`);
  assert.match(await run('update_identity', { category: 'custom', filename: 'notes.md', content: 'appended after the tail' }),
    /canary stamp "tail" isn't the last thing in my identity any more/);
  assert.equal(formatCanaryEditNote(checkCanariesInFiles({ canaries, files: files() })), '');
});

test('registering and retiring a stamp reach Phylactery', async () => {
  const out = await run('add_identity_canary', { category: 'custom', filename: 'notes.md', stamp: TAIL, label: 'tail', marks_end: true });
  assert.deepEqual(calls.find(c => c.name === 'identity_canary_add').args, { category: 'custom', filename: 'notes.md', text: TAIL, at_end: true, label: 'tail' });
  assert.match(out, /^Registered canary stamp "tail" \[id: canary-tail-b2\] in custom\/notes\.md, as the end of my identity\./);
  assert.equal(await run('retire_identity_canary', { id: 'canary-tail-b2' }), 'ok');
  assert.deepEqual(calls.find(c => c.name === 'identity_canary_remove').args, { id: 'canary-tail-b2' });
  assert.match(await run('list_identity_canaries', {}), /My canary stamps \(2\):\n- "persona" \[id: canary-persona-a1\] in self\/my_persona\.md: fine/);
});

test('the tools travel with the block, and never to a villager', () => {
  for (const n of ['add_identity_canary', 'list_identity_canaries', 'retire_identity_canary']) {
    assert.ok(BUILTIN_TOOLS.find(t => t.function.name === n), `${n} exists`);
    assert.equal(TOOL_MODULES[n], 'maintenance');
    assert.ok(!villagerToolNames({ schedule: 'full', memories: true, contacts: true }).has(n));
  }
  const mods = selectModules({ dynamicBlock: `${CANARY_BLOCK_TITLE} — x]` });
  assert.ok(mods.has('maintenance'));
  assert.ok(composeActiveTools([], {}, { modules: mods }).some(t => t.function.name === 'add_identity_canary'));
  assert.ok(selectModules({ turnText: 'are both canaries still there?' }).has('maintenance'));
});

test('pipeline: a broken stamp reaches my turn; an intact one and a group room stay quiet', async () => {
  const mine = await enrich('hello', { liveTurn: true });
  assert.ok(mine.static.includes(PERSONA) && mine.static.includes(TAIL));
  assert.ok(!mine.dynamic.includes(CANARY_BLOCK_TITLE), 'intact stamps: no block');

  const room = await enrich('hello', { liveTurn: true, audience: 'friends', audiences: ['friends'], topicGrants: {} });
  assert.ok(!room.static.includes(TAIL), 'a group room without identityBasic gets no custom files');
  assert.ok(!room.dynamic.includes(CANARY_BLOCK_TITLE), 'and that is not a missing stamp');

  identity = files(`I'm blunt.\n[canary v1 — persona: rewritten by something]\nMore.`);
  const broken = await enrich('hello', { liveTurn: true });
  assert.ok(broken.dynamic.includes(`${CANARY_BLOCK_TITLE} — the app checked my identity stamps`));
  assert.match(broken.dynamic, /"persona" is in self\/my_persona\.md, but not word for word any more\./);
});
