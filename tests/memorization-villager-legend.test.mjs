// The villager legend injected into the memorization prompt (2026-09-16): who
// from my human's Village appears in a slice, with pronouns + notes, so the
// extraction gets their names/pronouns right and doesn't re-note standing facts.
// Gated by disclosableVillagerFields — a shared-room slice never carries a
// private note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVillagerLegendBlock, buildPrompt, buildSharedRoomPrompt,
} from '../src/memory/memorization.js';

const registry = {
  villagers: [
    {
      id: 'v-sam', name: 'Sam', pronouns: 'she/her',
      relationToWard: "my human's sister", notes: 'plays cello',
      privateNotes: 'in therapy on Tuesdays',
      aliases: [{ platform: 'discord', handle: 'samcello' }],
    },
    {
      id: 'v-alex', name: 'Alex', pronouns: 'they/them',
      notes: 'a friend from work', aliases: [],
    },
    {
      id: 'v-quiet', name: 'Quinn', pronouns: 'he/him', notes: 'never comes up', aliases: [],
    },
  ],
};

function msgs(lines) {
  // lines: [{ speaker, content }]
  return lines.map(l => ({ role: l.speaker ? 'user' : 'assistant', speaker: l.speaker ?? null, content: l.content }));
}

test('a villager who SPOKE gets a card with pronouns + notes', () => {
  const block = buildVillagerLegendBlock(
    msgs([{ speaker: 'Sam', content: 'hey' }, { content: 'hi Sam' }, { speaker: 'Sam', content: 'how are you' }]),
    registry, { wardPrivate: true, wardName: 'Maus' },
  );
  assert.match(block, /### People here/);
  assert.match(block, /Sam \(she\/her\)/);
  assert.match(block, /plays cello/);
  assert.doesNotMatch(block, /Alex/, 'Alex did not appear');
  assert.doesNotMatch(block, /Quinn/, 'Quinn did not appear');
});

test('a villager only MENTIONED (never spoke) still gets a card — the ward talking about them', () => {
  const block = buildVillagerLegendBlock(
    msgs([{ speaker: null, content: 'I had lunch with Alex today' }, { content: 'oh nice' }]),
    registry, { wardPrivate: true, wardName: 'Maus' },
  );
  assert.match(block, /Alex \(they\/them\) — a friend from work/);
});

test('name match is word-boundaried — "Sam" is not caught by "same"', () => {
  const block = buildVillagerLegendBlock(
    msgs([{ speaker: null, content: 'it was the same as always, nothing new' }, { content: 'mm' }]),
    registry, { wardPrivate: true, wardName: 'Maus' },
  );
  assert.equal(block, '', 'no real villager appeared');
});

test('an alias handle counts as an appearance', () => {
  const block = buildVillagerLegendBlock(
    msgs([{ speaker: 'samcello', content: 'yo' }, { content: 'hey' }]),
    registry, { wardPrivate: true, wardName: 'Maus' },
  );
  assert.match(block, /Sam \(she\/her\)/);
});

test('ward-private slice includes a private note; a shared room withholds it', () => {
  const appear = msgs([{ speaker: 'Sam', content: 'hi' }, { content: 'hi Sam' }]);
  const wardPriv = buildVillagerLegendBlock(appear, registry, { wardPrivate: true, wardName: 'Maus' });
  assert.match(wardPriv, /in therapy on Tuesdays/, 'ward-private: private note is fair game');

  const shared = buildVillagerLegendBlock(appear, registry, { wardPrivate: false, wardName: 'Maus' });
  assert.doesNotMatch(shared, /in therapy on Tuesdays/, 'shared room: private note withheld');
  assert.match(shared, /Sam \(she\/her\)/, 'but pronouns + public notes still ride');
});

test('nobody from the Village present → empty string (prompt unchanged)', () => {
  const block = buildVillagerLegendBlock(
    msgs([{ speaker: null, content: 'just me thinking out loud' }, { content: 'mhm' }]),
    registry, { wardPrivate: true, wardName: 'Maus' },
  );
  assert.equal(block, '');
});

test('empty / missing registry → empty string, never throws', () => {
  const m = msgs([{ speaker: 'Sam', content: 'hi' }, { content: 'hey' }]);
  assert.equal(buildVillagerLegendBlock(m, { villagers: [] }, {}), '');
  assert.equal(buildVillagerLegendBlock(m, null, {}), '');
});

test('the ward is never rendered as a villager card even if a villager shares their name', () => {
  const reg = { villagers: [{ id: 'v-x', name: 'Maus', pronouns: 'she/her', notes: 'x', aliases: [] }] };
  const block = buildVillagerLegendBlock(
    msgs([{ speaker: 'Maus', content: 'hi' }, { content: 'hey' }]), reg, { wardPrivate: true, wardName: 'Maus' },
  );
  assert.equal(block, '');
});

// ── the builders render the passed block ─────────────────────────────────────
const twoTurns = msgs([{ speaker: 'Sam', content: 'hello there' }, { content: 'hi Sam, good to see you' }]);

test('buildPrompt renders the villager legend block when given one', () => {
  const block = buildVillagerLegendBlock(twoTurns, registry, { wardPrivate: true, wardName: 'Maus' });
  const prompt = buildPrompt(twoTurns, null, 'Maus', [], true, block);
  assert.match(prompt, /### People here/);
  assert.match(prompt, /Sam \(she\/her\)/);
});

test('buildPrompt without a legend block is unchanged (no People-here section)', () => {
  const prompt = buildPrompt(twoTurns, null, 'Maus', [], true);
  assert.doesNotMatch(prompt, /### People here/);
});

test('buildSharedRoomPrompt renders the legend block too', () => {
  const block = buildVillagerLegendBlock(twoTurns, registry, { wardPrivate: false, wardName: 'Maus' });
  const prompt = buildSharedRoomPrompt(twoTurns, null, 'Maus', block);
  assert.match(prompt, /### People here/);
  assert.match(prompt, /Sam \(she\/her\)/);
  assert.doesNotMatch(prompt, /in therapy on Tuesdays/, 'shared room withholds the private note');
});
