// A tiny Express app for tests/async-route-errors.test.mjs, run as a CHILD
// process so a crash can be observed without taking the test runner down.
//   node async-route-app.mjs guarded   → with guardAsyncRoutes + the error handler
//   node async-route-app.mjs bare      → plain Express 4 (the crash this prevents)
import express from 'express';
import { guardAsyncRoutes, asyncRouteErrorHandler } from '../../src/server/async-routes.js';

const guarded = process.argv[2] === 'guarded';
const app = express();
if (guarded) guardAsyncRoutes(app);
app.use(express.json());

app.get('/ok', (_req, res) => res.json({ ok: true }));
app.get('/boom', async () => {
  await new Promise(r => setTimeout(r, 10));
  throw new Error('kaboom');
});
app.get('/stream-boom', async (_req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.write('partial ');
  await new Promise(r => setTimeout(r, 10));
  throw new Error('mid-stream');
});
app.post('/echo', (req, res) => res.json(req.body));

if (guarded) app.use(asyncRouteErrorHandler({ error() {}, warn() {} }));

const server = app.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
