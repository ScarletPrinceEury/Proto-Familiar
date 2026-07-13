// updater.js — repo/branch-aware self-update. Git is injected so the tests
// exercise the check/apply logic without a real remote.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, applyUpdate, repoSlug, getRepoInfo } from '../updater.js';

afterEach(() => { delete process.env.PROTO_FAMILIAR_UPDATE_DISABLED; });

// A fake git driven by a response map keyed on the first meaningful args.
function fakeGit(overrides = {}) {
  const calls = [];
  const base = {
    'remote get-url origin': 'git@github.com:ScarletPrinceEury/Proto-Familiar.git',
    'rev-parse --abbrev-ref HEAD': 'main',
    'rev-parse HEAD': 'aaaaaaa',
    'fetch --quiet origin main': '',
    'rev-parse origin/main': 'aaaaaaa',
    'rev-list --count HEAD..origin/main': '0',
    'status --porcelain': '',
    'merge --ff-only origin/main': 'Fast-forward',
    'show origin/main:package.json': JSON.stringify({ version: '0.9.0-alpha' }),
    'log -1 --format=%s origin/main': 'feat: something new',
  };
  const map = { ...base, ...overrides };
  const git = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key in map) {
      const v = map[key];
      if (v instanceof Error) throw v;
      return v;
    }
    throw new Error(`unexpected git ${key}`);
  };
  git.calls = calls;
  return git;
}

test('repoSlug: ssh + https + trailing slash', () => {
  assert.equal(repoSlug('git@github.com:Owner/Repo.git'), 'Owner/Repo');
  assert.equal(repoSlug('https://github.com/Owner/Repo.git'), 'Owner/Repo');
  assert.equal(repoSlug('https://github.com/Owner/Repo/'), 'Owner/Repo');
  assert.equal(repoSlug(null), null);
});

test('getRepoInfo: reads origin/branch/commit + slug', async () => {
  const info = await getRepoInfo({ git: fakeGit() });
  assert.equal(info.repo, 'ScarletPrinceEury/Proto-Familiar');
  assert.equal(info.branch, 'main');
  assert.equal(info.commit, 'aaaaaaa');
});

test('checkForUpdate: up to date → no update', async () => {
  const r = await checkForUpdate({ git: fakeGit() });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, false);
  assert.equal(r.behind, 0);
  assert.equal(r.branch, 'main');
});

test('checkForUpdate: behind → update available with remote version + subject', async () => {
  const r = await checkForUpdate({ git: fakeGit({
    'rev-parse origin/main': 'bbbbbbb',
    'rev-list --count HEAD..origin/main': '3',
  }) });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, true);
  assert.equal(r.behind, 3);
  assert.equal(r.remote.version, '0.9.0-alpha');
  assert.match(r.remote.subject, /something new/);
});

test('checkForUpdate: tracks whatever branch is checked out (fork-agnostic)', async () => {
  const git = fakeGit({
    'remote get-url origin': 'https://github.com/SomeFork/Proto-Familiar.git',
    'rev-parse --abbrev-ref HEAD': 'dev',
    'fetch --quiet origin dev': '',
    'rev-parse origin/dev': 'ccccccc',
    'rev-list --count HEAD..origin/dev': '1',
    'show origin/dev:package.json': JSON.stringify({ version: '1.0.0' }),
    'log -1 --format=%s origin/dev': 'fork change',
  });
  const r = await checkForUpdate({ git });
  assert.equal(r.repo, 'SomeFork/Proto-Familiar');
  assert.equal(r.branch, 'dev');
  assert.equal(r.updateAvailable, true);
  assert.equal(r.remote.version, '1.0.0');
});

test('checkForUpdate: fetch failure degrades to ok:false with current info intact', async () => {
  const r = await checkForUpdate({ git: fakeGit({ 'fetch --quiet origin main': new Error('network down') }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn't reach the remote/);
  assert.equal(r.current.version && r.current.commit, r.current.commit); // current still populated
  assert.equal(r.branch, 'main');
});

test('checkForUpdate: off-switch disables', async () => {
  process.env.PROTO_FAMILIAR_UPDATE_DISABLED = '1';
  const r = await checkForUpdate({ git: fakeGit() });
  assert.equal(r.ok, false);
  assert.equal(r.disabled, true);
});

test('applyUpdate: clean tree → fast-forward, reports restart required', async () => {
  const git = fakeGit({ 'rev-list --count HEAD..origin/main': '2' });
  const r = await applyUpdate({ git });
  assert.equal(r.ok, true);
  assert.equal(r.restartRequired, true);
  assert.ok(git.calls.includes('merge --ff-only origin/main'));
});

test('applyUpdate: dirty tree → refuses, never merges', async () => {
  const git = fakeGit({ 'status --porcelain': ' M server.js' });
  const r = await applyUpdate({ git });
  assert.equal(r.ok, false);
  assert.match(r.error, /local changes present/);
  assert.ok(!git.calls.includes('merge --ff-only origin/main'));
});
