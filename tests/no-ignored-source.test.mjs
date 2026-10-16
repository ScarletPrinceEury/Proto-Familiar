// No source file may be git-ignored (0.14.91).
//
// A .gitignore safety net for stray runtime dirs (`src/**/tomes/`) also matched
// the real source dir src/tomes/, so a new module there (room-lore.js) was never
// committed while the code importing it was: the branch passed every test
// locally, where the file existed, and main crashed at boot for anyone who
// pulled it. This check runs where the files are written — a dev checkout — and
// fails the moment a source file would be silently left out of a commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = /\.(?:m?js|py|sql|html|css)$/;
const NOT_OURS = /(?:^|\/)(?:node_modules|\.venv|__pycache__|\.pytest_cache|dist|build)\//;

function git(args) {
  try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

test('no source file in the repo is git-ignored', (t) => {
  const out = git(['ls-files', '--others', '--ignored', '--exclude-standard']);
  if (out == null) return t.skip('git not available');
  const ignored = out.split(/\r?\n/).filter(f => f && SOURCE.test(f) && !NOT_OURS.test(f));
  assert.deepEqual(ignored, [], `ignored by .gitignore, so they would never be committed:\n${ignored.join('\n')}`);
});

test('a stray runtime tomes/ dir under src/ is still ignored', (t) => {
  if (git(['--version']) == null) return t.skip('git not available');
  for (const p of ['src/pondering/tomes/x.json', 'src/tomes/tomes/x.json']) {
    assert.notEqual(git(['check-ignore', '--no-index', p]), null, `${p} should stay ignored`);
  }
  assert.equal(git(['check-ignore', '--no-index', 'src/tomes/room-lore.js']), null, 'the tome modules are source');
});
