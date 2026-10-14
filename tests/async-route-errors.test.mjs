// An error thrown in an async route can't take the server down (0.14.68).
//
// Express 4 doesn't catch a rejected promise from an async route handler, and
// Node exits on an unhandled rejection — so any throw in any of server.js's
// ~200 async routes, outside its own try, killed the whole Familiar. The
// fixture app runs in a child process so the crash itself is observable.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { guardAsyncRoutes, asyncRouteErrorHandler } = await import('../src/server/async-routes.js');
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'async-route-app.mjs');

function startFixture(mode) {
  const child = spawn(process.execPath, [FIXTURE, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(r => child.on('exit', (code) => r(code)));
  const port = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const m = buf.match(/PORT (\d+)/); if (m) resolve(Number(m[1])); });
    child.on('exit', () => reject(new Error('fixture exited before listening')));
  });
  return { child, exited, port };
}

describe('a throwing async route, across a real process', () => {
  test('guarded: the route answers 500 with the reason, and the server stays up', { timeout: 10_000 }, async () => {
    const { child, port } = startFixture('guarded');
    try {
      const base = `http://127.0.0.1:${await port}`;
      const r = await fetch(`${base}/boom`);
      assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { error: 'kaboom' });
      // A throw after the response started can't be turned into a 500 — the
      // response is ended instead of left hanging.
      const s = await fetch(`${base}/stream-boom`, { signal: AbortSignal.timeout(3000) });
      assert.match(await s.text(), /partial/);
      // Malformed JSON is a 400 from the body parser, answered as JSON too.
      const bad = await fetch(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
      assert.equal(bad.status, 400);
      assert.ok((await bad.json()).error);
      // Still alive.
      assert.deepEqual(await (await fetch(`${base}/ok`)).json(), { ok: true });
      assert.equal(child.exitCode, null);
    } finally { child.kill(); }
  });

  test('bare Express 4: the same throw kills the whole process (the bug this closes)', { timeout: 10_000 }, async () => {
    const { child, exited, port } = startFixture('bare');
    try {
      const base = `http://127.0.0.1:${await port}`;
      await fetch(`${base}/boom`).catch(() => null);
      const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('still running'), 3000))]);
      assert.notEqual(code, 'still running');
      assert.notEqual(code, 0);
    } finally { child.kill(); }
  });
});

describe('guardAsyncRoutes leaves everything else alone', () => {
  const fakeApp = () => {
    const calls = [];
    const app = { settings: { env: 'test' } };
    for (const v of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
      app[v] = function (...args) { calls.push([v, ...args]); return this === app ? 'route-registered' : 'wrong-this'; };
    }
    return { app, calls };
  };

  test("app.get('setting') is still Express's settings getter", () => {
    const { app, calls } = fakeApp();
    guardAsyncRoutes(app);
    app.get('env');
    assert.deepEqual(calls.at(-1), ['get', 'env']);
  });

  test('error handlers (4 args) and non-functions pass through untouched; arrays are wrapped inside', () => {
    const { app, calls } = fakeApp();
    guardAsyncRoutes(app);
    const errH = (err, req, res, next) => next(err);
    const plain = (req, res) => res.end();
    app.post('/x', errH, [plain], 'not-a-fn');
    const [, , a, b, c] = calls.at(-1);
    assert.equal(a, errH);
    assert.ok(Array.isArray(b) && b[0] !== plain && b[0].length === 3);
    assert.equal(c, 'not-a-fn');
  });

  test('a rejection with no reason still reaches next() as an error, never as "continue"', async () => {
    const { app, calls } = fakeApp();
    guardAsyncRoutes(app);
    app.get('/y', async () => { throw undefined; });   // eslint-disable-line no-throw-literal
    const wrapped = calls.at(-1)[2];
    const got = await new Promise((resolve) => wrapped({}, {}, resolve));
    assert.ok(got instanceof Error);
  });

  test('the error handler ends a response whose headers were already sent', () => {
    let ended = false;
    const res = { headersSent: true, writableEnded: false, end() { ended = true; } };
    asyncRouteErrorHandler({ error() {}, warn() {} })(new Error('x'), { method: 'GET', originalUrl: '/z' }, res, () => {});
    assert.equal(ended, true);
  });
});
