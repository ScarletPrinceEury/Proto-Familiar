// The familiar-liaison agent + its send script (0.14.94, ward decision):
// conversations with the Familiar run on Sonnet through a project agent, which
// sends over the bridge with scripts/claude-code-bridge.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(REPO, '.claude', 'agents', 'familiar-liaison.md');

test('the liaison agent runs on Sonnet, with no edit tools', () => {
  const text = readFileSync(AGENT, 'utf8');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  assert.match(front, /^name: familiar-liaison$/m);
  assert.match(front, /^model: sonnet$/m);
  const tools = front.match(/^tools: (.*)$/m)?.[1].split(',').map(s => s.trim()) ?? [];
  assert.ok(tools.includes('Bash') && tools.includes('Read'));
  assert.ok(!tools.some(t => /^(Edit|Write|NotebookEdit)$/.test(t)), 'it reports what needs changing; it does not change code');
  assert.match(text, /scripts\/claude-code-bridge\.mjs/);
});

test('the project agent and settings files are tracked, not git-ignored', (t) => {
  let git = true;
  for (const p of ['.claude/agents/familiar-liaison.md', '.claude/settings.json']) {
    try {
      execFileSync('git', ['check-ignore', '--no-index', p], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] });
      assert.fail(`${p} is git-ignored, so it would never be committed`);
    } catch (err) {
      if (err?.code === 'ENOENT') { git = false; break; }
      if (err instanceof assert.AssertionError) throw err;
      // exit 1 = not ignored: what we want
    }
  }
  if (!git) t.skip('git not available');
});

function stubServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(req, JSON.parse(body || '{}'), res));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function send(port, stdin, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'scripts', 'claude-code-bridge.mjs'), ...args], {
      env: { ...process.env, PROTO_FAMILIAR_PORT: String(port) },
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

test('the send script posts stdin intact and prints the reply, notes and tools', async () => {
  let got;
  const srv = await stubServer((req, body, res) => {
    got = { url: req.url, body };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reply: 'Heard you.', toolsUsed: ['recall'], notes: [{ id: 'n-1', at: '2026-10-17T09:30:00.000Z', text: 'one more thing' }] }));
  });
  const msg = "It's \"quoted\",\nwith a second line.";
  const r = await send(srv.address().port, msg, '--new');
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(got.url, '/api/bridge/claude-code');
  assert.deepEqual(got.body, { message: msg, newConversation: true });
  assert.match(r.out, /^Heard you\./);
  assert.match(r.out, /a note it left for Claude Code:\n- 2026-10-17 09:30 \(n-1\): one more thing/);
  assert.match(r.out, /tools its turn used: recall/);
});

test('the send script exits 1 with the reason when the bridge is off', async () => {
  const srv = await stubServer((_req, _body, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'the bridge is off' }));
  });
  const r = await send(srv.address().port, 'hello');
  srv.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /HTTP 403\): the bridge is off/);
  assert.equal(r.out, '');
});
