import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeActiveTools,
  composeDiscordTools,
  villagerToolNames,
  executeToolCall,
  TOOL_EXECUTORS,
  trackersEnabled,
} from '../cerebellum.js';
import { selectModules, trackerTermsRegex, TOOL_MODULES } from '../tool-surfacing.js';

// The six ward-only tracker tools (trackers build spec §3). The list is the
// contract every gating assertion below is checked against.
const TRACKER_TOOLS = [
  'tracker_create', 'tracker_create_from_template', 'tracker_log',
  'tracker_read', 'tracker_list', 'tracker_adjust',
];
const has = (tools, name) => tools.some(t => t.function?.name === name);
const namesOf = (tools) => tools.map(t => t.function?.name);

// ── T2 — fail-closed gating (the headline invariant) ─────────────────────────
// A gated (villager) turn contains ZERO tracker tools, whatever grants it holds.
// Tracker data is the ward's private patterns; a villager never reaches it.

test('T2: villagerToolNames never contains a tracker tool, even at the highest grants', () => {
  const maxGrants = { schedule: 'full', memories: true, contacts: true };
  const allow = villagerToolNames(maxGrants);
  for (const name of TRACKER_TOOLS) {
    assert.ok(!allow.has(name), `villager grant set must never include ${name}`);
  }
});

test('T2: composeDiscordTools for a full-grant villager exposes no tracker tool', () => {
  const tools = composeDiscordTools({
    isVillager: true,
    grants: { schedule: 'full', memories: true, contacts: true },
    settings: { trackersEnabled: true },
  });
  for (const name of TRACKER_TOOLS) {
    assert.ok(!has(tools, name), `villager Discord turn must not advertise ${name}`);
  }
});

test('T2: a stranger (no villager, no ward) gets an empty tool set — trackers included', () => {
  const tools = composeDiscordTools({ settings: { trackersEnabled: true } });
  assert.equal(tools.length, 0, 'a stranger turn advertises nothing at all');
});

// The ward path DOES reach them (they are the ward's own ledgers) — the mirror
// assertion, so "gated → none" is proven against a working "ward → yes".
test('T2 mirror: the ward reaches the tracker tools when the trackers module is surfaced', () => {
  const tools = composeActiveTools(null, { trackersEnabled: true }, { modules: new Set(['trackers']) });
  for (const name of TRACKER_TOOLS) {
    assert.ok(has(tools, name), `ward turn with the trackers module should advertise ${name}`);
  }
});

// ── §7 off-switch — disabled ⇒ no tracker tools compose at all ────────────────

test('§7: settings.trackersEnabled=false hides every tracker tool even when the module is surfaced', () => {
  const tools = composeActiveTools(null, { trackersEnabled: false }, { modules: new Set(['trackers']) });
  for (const name of TRACKER_TOOLS) {
    assert.ok(!has(tools, name), `disabled trackers must hide ${name}`);
  }
});

test('§7: PROTO_FAMILIAR_TRACKERS_DISABLED=1 hides every tracker tool', () => {
  const prev = process.env.PROTO_FAMILIAR_TRACKERS_DISABLED;
  process.env.PROTO_FAMILIAR_TRACKERS_DISABLED = '1';
  try {
    assert.equal(trackersEnabled({ trackersEnabled: true }), false, 'the env off-switch wins over the setting');
    const tools = composeActiveTools(null, { trackersEnabled: true }, { modules: new Set(['trackers']) });
    for (const name of TRACKER_TOOLS) {
      assert.ok(!has(tools, name), `the hard off-switch must hide ${name}`);
    }
  } finally {
    if (prev === undefined) delete process.env.PROTO_FAMILIAR_TRACKERS_DISABLED;
    else process.env.PROTO_FAMILIAR_TRACKERS_DISABLED = prev;
  }
});

test('trackersEnabled defaults ON when unset', () => {
  assert.equal(trackersEnabled({}), true);
});

// ── Surfacing — static vocabulary, the registry regex, and the cue block ──────

test('surfacing: tracking language surfaces the trackers module', () => {
  for (const turnText of ['log my mood today', 'what\'s in the pantry?', 'I slept badly', 'add milk to groceries']) {
    assert.ok(selectModules({ turnText }).has('trackers'), `"${turnText}" should surface trackers`);
  }
});

test('surfacing: an existing tracker\'s own label surfaces the module (registry regex)', () => {
  // "spoons" isn't in the static vocabulary — only the label registry reaches it.
  const bare = selectModules({ turnText: 'how are my spoons doing today?' });
  assert.ok(!bare.has('trackers'), 'without the label registered, a custom word does not surface it');
  const withLabel = selectModules({ turnText: 'how are my spoons doing today?', trackerLabels: ['spoons'] });
  assert.ok(withLabel.has('trackers'), 'a registered label surfaces the module');
});

test('surfacing: the [Tracker cues] block surfaces the module', () => {
  assert.ok(selectModules({ turnText: 'hi', dynamicBlock: '[Tracker cues]\n· mood — 40h since the last note' }).has('trackers'));
});

test('surfacing: idle chit-chat does not surface trackers', () => {
  assert.ok(!selectModules({ turnText: 'that movie last night was great' }).has('trackers'));
});

test('trackerTermsRegex skips 1–2 char labels (too collision-prone) and escapes metacharacters', () => {
  assert.equal(trackerTermsRegex(['a', 'x']), null, 'short labels produce no regex');
  // A metacharacter in a label is treated literally, not as a regex operator:
  // "mood.level" must match "mood.level", never "moodxlevel".
  const re = trackerTermsRegex(['mood.level']);
  assert.ok(re.test('check mood.level now'), 'the escaped dot matches a literal dot');
  assert.ok(!re.test('check moodxlevel now'), 'the dot is escaped, not a wildcard');
});

// ── Module wiring parity ─────────────────────────────────────────────────────

test('every tracker tool maps to the trackers module', () => {
  for (const name of TRACKER_TOOLS) {
    assert.equal(TOOL_MODULES[name], 'trackers', `${name} must live in the trackers module`);
  }
});

test('every tracker tool has an executor registered', () => {
  for (const name of TRACKER_TOOLS) {
    assert.equal(typeof TOOL_EXECUTORS[name], 'function', `${name} needs an executor`);
  }
});

// ── T3 (JS bridge) — required-arg guards surface a VISIBLE refusal, never a
// silent success (RULE B). The validation gate proper (unknown-field drop,
// type checks, missing-required, entry_cap) lives in Unruh and is covered by
// unruh/tests/test_tracker.py; here we prove the tool boundary refuses bad
// calls before ever reaching the store, and does so without throwing.

test('T3: tracker_log without a tracker_id refuses visibly and records nothing', async () => {
  const r = String(await executeToolCall('tracker_log', '{}', {}));
  assert.match(r, /tracker_id \(string\) is required/i);
});

test('T3: tracker_create guards its required args', async () => {
  assert.match(String(await executeToolCall('tracker_create', '{}', {})), /label \(string\) is required/i);
  assert.match(String(await executeToolCall('tracker_create', JSON.stringify({ label: 'x' }), {})), /archetype is required/i);
});

test('T3: tracker_read / tracker_adjust / tracker_create_from_template guard their required args', async () => {
  assert.match(String(await executeToolCall('tracker_read', '{}', {})), /tracker_id \(string\) is required/i);
  assert.match(String(await executeToolCall('tracker_adjust', '{}', {})), /id \(string\) is required/i);
  assert.match(String(await executeToolCall('tracker_create_from_template', '{}', {})), /template_id \(string\) is required/i);
});
