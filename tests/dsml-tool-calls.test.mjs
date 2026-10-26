// Tool calls written into a reply as DeepSeek DSML markup (src/util/text-tool-calls.js).
// Seen live 2026-10-26: the markup went out as the reply, so nothing ran and
// the person got markup instead of an answer. Includes PIPELINE tests through
// the real runToolCallLoop with a stubbed provider.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDsmlToolCalls, stripDsmlToolCalls, dsmlInvokeNames, settleTextToolCalls,
  createDsmlStreamGuard, guardStreamEvent,
} from '../src/util/text-tool-calls.js';
import { findTextToolCalls, collapseToolTurns } from '../message-sanitize.mjs';
import { runToolCallLoop, CLOSING_WORDS_NOTE } from '../cerebellum.js';

// The reply exactly as it was stored on 2026-10-26.
const LIVE = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">logs/s-20261016-3nxt.json</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
const WITH_PROSE = `Good, filed. Now the check-in.\n\n${LIVE.replace('read_file', 'send_to_claude_code')}`;

describe('extractDsmlToolCalls', () => {
  it('parses the live reply into the call it was', () => {
    const r = extractDsmlToolCalls(LIVE);
    assert.equal(r.found, true);
    assert.deepEqual(r.calls, [{ name: 'read_file', arguments: { path: 'logs/s-20261016-3nxt.json' } }]);
    assert.equal(r.text, '');
  });

  it('keeps the prose around a block', () => {
    const r = extractDsmlToolCalls(WITH_PROSE);
    assert.equal(r.calls[0].name, 'send_to_claude_code');
    assert.equal(r.text, 'Good, filed. Now the check-in.');
  });

  it('reads string="false" as JSON, accepts ASCII bars and the function_calls wrapper, several invokes', () => {
    const t = '<|DSML|function_calls>\n<|DSML|invoke name="a_tool"><|DSML|parameter name="n" string="false">3</|DSML|parameter><|DSML|parameter name="o" string="false">{"x":true}</|DSML|parameter></|DSML|invoke>\n<|DSML|invoke name="b_tool"></|DSML|invoke>\n</|DSML|function_calls>';
    const r = extractDsmlToolCalls(t);
    assert.deepEqual(r.calls, [{ name: 'a_tool', arguments: { n: 3, o: { x: true } } }, { name: 'b_tool', arguments: {} }]);
  });

  it('a block cut off mid-call runs nothing and is still stripped', () => {
    const r = extractDsmlToolCalls('Checking.\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">logs/s-');
    assert.deepEqual(r.calls, []);
    assert.equal(r.text, 'Checking.');
  });

  it('leaves ordinary text alone, including other written-out shapes', () => {
    const plain = 'I can call read_file for you. <tool_call>{"name":"x","arguments":{}}</tool_call> a < b';
    const r = extractDsmlToolCalls(plain);
    assert.equal(r.found, false);
    assert.equal(r.text, plain);
    assert.equal(stripDsmlToolCalls(plain), plain);
  });

  it('findTextToolCalls now names DSML calls too', () => {
    assert.deepEqual(dsmlInvokeNames(WITH_PROSE), ['send_to_claude_code']);
    assert.ok(findTextToolCalls(LIVE).includes('read_file'));
  });
});

describe('settleTextToolCalls', () => {
  it('a working round with no real calls: the written calls become real ones', () => {
    const s = settleTextToolCalls({ content: LIVE, toolCalls: [], idPrefix: 'textcall-r3' });
    assert.equal(s.recovered, 1);
    assert.equal(s.toolCalls[0].id, 'textcall-r3-1');
    assert.equal(s.toolCalls[0].function.name, 'read_file');
    assert.deepEqual(JSON.parse(s.toolCalls[0].function.arguments), { path: 'logs/s-20261016-3nxt.json' });
    assert.equal(s.content, '');
  });

  it('the closing round (tools off): stripped, nothing recovered', () => {
    const s = settleTextToolCalls({ content: WITH_PROSE, closing: true });
    assert.equal(s.recovered, 0);
    assert.equal(s.stripped, true);
    assert.equal(s.content, 'Good, filed. Now the check-in.');
    assert.deepEqual(s.names, ['send_to_claude_code']);
  });

  it('a round that already has real calls: stripped, the real calls stand', () => {
    const real = [{ id: 'c1', type: 'function', function: { name: 'recall', arguments: '{}' } }];
    const s = settleTextToolCalls({ content: LIVE, toolCalls: real });
    assert.equal(s.toolCalls, real);
    assert.equal(s.recovered, 0);
  });

  it('no markup: unchanged', () => {
    const s = settleTextToolCalls({ content: 'hello', toolCalls: [] });
    assert.equal(s.stripped, false);
    assert.equal(s.content, 'hello');
  });
});

describe('history never carries the markup', () => {
  it('collapseToolTurns strips it, and a reply that was only markup drops out', () => {
    const out = collapseToolTurns([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: WITH_PROSE },
      { role: 'user', content: 'and?' },
      { role: 'assistant', content: LIVE },
    ]);
    assert.ok(!JSON.stringify(out).includes('DSML'));
    assert.equal(out.filter(m => m.role === 'assistant').length, 1);
    assert.equal(out[1].content, 'Good, filed. Now the check-in.');
  });
});

describe('the stream guard', () => {
  const PROSE_BEFORE = 'Let me check that file.\n';
  const PROSE_AFTER = '\nBack in a moment.';
  const FULL = PROSE_BEFORE + LIVE + PROSE_AFTER;

  it('whatever the chunking, only the prose is ever forwarded', () => {
    for (let cut = 1; cut < FULL.length; cut++) {
      const g = createDsmlStreamGuard();
      const shown = g.push(FULL.slice(0, cut)) + g.push(FULL.slice(cut)) + g.end();
      assert.equal(shown, PROSE_BEFORE + PROSE_AFTER, `cut at ${cut}`);
    }
  });

  it('one character at a time', () => {
    const g = createDsmlStreamGuard();
    let shown = '';
    for (const ch of FULL) shown += g.push(ch);
    shown += g.end();
    assert.equal(shown, PROSE_BEFORE + PROSE_AFTER);
  });

  it('an ordinary "<" is only held until it can no longer be a tag', () => {
    const g = createDsmlStreamGuard();
    assert.equal(g.push('a <'), 'a ');
    assert.equal(g.push('b> and <i>x</i>'), '<b> and <i>x</i>');
    assert.equal(g.push(' <'), ' ');
    assert.equal(g.end(), '<');
  });

  it('an unfinished block is never shown', () => {
    const g = createDsmlStreamGuard();
    const shown = g.push('Okay. <｜DSML｜tool_calls>\n<｜DSML｜invoke name="x">') + g.end();
    assert.equal(shown, 'Okay. ');
  });

  it('guardStreamEvent rewrites or drops SSE lines', () => {
    const g = createDsmlStreamGuard();
    const ev = (content, extra = {}) => ({ choices: [{ index: 0, delta: { content }, ...extra }] });
    const line = (e) => `data: ${JSON.stringify(e)}`;
    const a = ev('Hi <｜DSML');
    assert.deepEqual(JSON.parse(guardStreamEvent(a, line(a), g).slice(6)).choices[0].delta.content, 'Hi ');
    const b = ev('｜tool_calls>junk');
    assert.equal(guardStreamEvent(b, line(b), g), null);
    const c = ev('', { finish_reason: 'stop' });
    assert.equal(guardStreamEvent(c, line(c), g), line(c), 'a content-less event passes untouched');
  });
});

// ── Pipeline: the real runToolCallLoop ────────────────────────────────────

const reply = (content, extra = {}) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, ...extra } }] });
const toolReply = (name) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: '{}' } }] } }] });

describe('PIPELINE — runToolCallLoop', () => {
  it('a call written as DSML runs, and the turn ends in words', async () => {
    const ran = [];
    const rounds = [];
    const answers = [reply(LIVE), reply('Read it. Here is what changed.')];
    const { data, toolRounds } = await runToolCallLoop({
      callUpstream: async () => answers.shift(),
      baseMessages: [{ role: 'user', content: 'check the Oct 16 session' }],
      executeTool: async (name, args) => { ran.push([name, JSON.parse(args)]); return 'ok: file contents'; },
      maxRounds: 5,
      onRound: (r) => rounds.push(r),
    });
    assert.deepEqual(ran, [['read_file', { path: 'logs/s-20261016-3nxt.json' }]]);
    assert.equal(data.choices[0].message.content, 'Read it. Here is what changed.');
    assert.equal(toolRounds.length, 1);
    assert.deepEqual(rounds[0].recoveredFromText, ['read_file']);
    assert.ok(!JSON.stringify(data).includes('DSML'));
  });

  it('the closing round never returns markup: one retry in words', async () => {
    const sent = [];
    const answers = [toolReply('recall'), toolReply('recall'), reply(LIVE), reply("I didn't get to the last file; here's what I have.")];
    const { data, roundCapHit } = await runToolCallLoop({
      callUpstream: async (msgs) => { sent.push(msgs); return answers.shift(); },
      baseMessages: [{ role: 'user', content: 'go' }],
      executeTool: async () => 'ok',
      maxRounds: 1,
    });
    assert.equal(roundCapHit, true);
    assert.equal(sent.length, 4, 'two rounds, the closing round, one retry');
    assert.ok(sent[3].some(m => m.role === 'system' && m.content === CLOSING_WORDS_NOTE));
    assert.equal(data.choices[0].message.content, "I didn't get to the last file; here's what I have.");
  });

  it('if the retry is markup too, the reply is empty, never markup', async () => {
    const answers = [toolReply('recall'), toolReply('recall'), reply(LIVE), reply(LIVE)];
    const { data } = await runToolCallLoop({
      callUpstream: async () => answers.shift(),
      baseMessages: [{ role: 'user', content: 'go' }],
      executeTool: async () => 'ok',
      maxRounds: 1,
    });
    assert.equal(data.choices[0].message.content, '');
  });

  it('a normal closing reply takes no retry', async () => {
    let calls = 0;
    const answers = [toolReply('recall'), toolReply('recall'), reply('Here is what I have.')];
    await runToolCallLoop({
      callUpstream: async () => { calls++; return answers.shift(); },
      baseMessages: [{ role: 'user', content: 'go' }],
      executeTool: async () => 'ok',
      maxRounds: 1,
    });
    assert.equal(calls, 3);
  });
});
