/**
 * updater.js — self-update against the repo/branch this install came from.
 *
 * Repo-agnostic BY DESIGN (the ward's ask): everything keys off `origin` and the
 * checked-out branch, read live from git — so a fork tracks the fork, and once
 * the install is re-pointed at (or re-cloned from) the upstream repo it tracks
 * that instead, with no code change. Pure git (no GitHub API), so it works for
 * private repos (using the clone's own credentials) and non-GitHub hosts.
 *
 * check → `git fetch origin <branch>` (incremental), compare HEAD to
 *         origin/<branch>, read the remote package.json version + latest commit
 *         subject when behind.
 * apply → `git merge --ff-only origin/<branch>`; REFUSES on a dirty tree (never
 *         clobbers local edits). New code is live only after a restart — this
 *         never restarts the process itself (launcher-agnostic; the caller tells
 *         the ward to restart).
 *
 * Hard off-switch: PROTO_FAMILIAR_UPDATE_DISABLED=1 (for dev / ephemeral / air-
 * gapped installs where self-update is unwanted).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileP = promisify(execFile);

export function updateDisabled() {
  return process.env.PROTO_FAMILIAR_UPDATE_DISABLED === '1';
}

/** Default git runner (repo cwd, no shell → no injection). Tests inject a fake. */
export async function defaultGit(args, { timeout = 20000 } = {}) {
  const { stdout } = await execFileP('git', args, { cwd: __dirname, timeout, windowsHide: true });
  return String(stdout).trim();
}

function localVersion() {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
}

/** A friendly "owner/repo" from any git remote URL (ssh or https), else the URL. */
export function repoSlug(url) {
  if (!url) return null;
  const m = String(url).match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : String(url);
}

/** What repo/branch/commit/version this install currently is. */
export async function getRepoInfo({ git = defaultGit } = {}) {
  const [origin, branch, commit] = await Promise.all([
    git(['remote', 'get-url', 'origin']).catch(() => null),
    git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    git(['rev-parse', 'HEAD']).catch(() => null),
  ]);
  return { origin, repo: repoSlug(origin), branch, commit, version: localVersion() };
}

/**
 * Check origin/<branch> for a newer commit. Returns a status object the UI +
 * Discord command render. Never throws — a fetch/network failure comes back as
 * { ok:false, error } with the current info still populated.
 */
export async function checkForUpdate({ git = defaultGit, fetch = true } = {}) {
  if (updateDisabled()) return { ok: false, disabled: true, checkedAt: Date.now() };
  const info = await getRepoInfo({ git });
  const base = {
    repo: info.repo, branch: info.branch,
    current: { version: info.version, commit: info.commit },
    checkedAt: Date.now(),
  };
  if (!info.branch || !info.origin || !info.commit) {
    return { ...base, ok: false, error: 'not a git checkout with an origin remote' };
  }
  if (fetch) {
    try { await git(['fetch', '--quiet', 'origin', info.branch], { timeout: 30000 }); }
    catch (e) { return { ...base, ok: false, error: `couldn't reach the remote: ${e?.message ?? e}` }; }
  }
  let remoteCommit = null;
  try { remoteCommit = await git(['rev-parse', `origin/${info.branch}`]); }
  catch { return { ...base, ok: false, error: `no origin/${info.branch} to track` }; }

  let behind = 0;
  try { behind = Number(await git(['rev-list', '--count', `HEAD..origin/${info.branch}`])) || 0; } catch {}
  let dirty = false;
  try { dirty = (await git(['status', '--porcelain'])).length > 0; } catch {}

  let remoteVersion = null, remoteSubject = null;
  if (behind > 0) {
    try { remoteVersion = JSON.parse(await git(['show', `origin/${info.branch}:package.json`])).version || null; } catch {}
    try { remoteSubject = await git(['log', '-1', '--format=%s', `origin/${info.branch}`]); } catch {}
  }
  return {
    ...base, ok: true,
    remote: { version: remoteVersion, commit: remoteCommit, subject: remoteSubject },
    behind, updateAvailable: behind > 0, dirty,
  };
}

/**
 * Fast-forward the working tree to origin/<branch>. Refuses on a dirty tree.
 * Returns { ok, version (new, on-disk), restartRequired } or { ok:false, error }.
 */
export async function applyUpdate({ git = defaultGit } = {}) {
  if (updateDisabled()) return { ok: false, disabled: true };
  const info = await getRepoInfo({ git });
  if (!info.branch || !info.origin) return { ok: false, error: 'not a git checkout with an origin remote' };
  try {
    if ((await git(['status', '--porcelain'])).length > 0) {
      return { ok: false, error: 'local changes present — commit or stash them first, then update.' };
    }
  } catch { /* if status fails, the merge --ff-only below will still fail safely */ }
  try {
    await git(['fetch', '--quiet', 'origin', info.branch], { timeout: 30000 });
    await git(['merge', '--ff-only', `origin/${info.branch}`], { timeout: 30000 });
  } catch (e) {
    return { ok: false, error: `update failed (not a fast-forward, or the remote was unreachable): ${e?.message ?? e}` };
  }
  return {
    ok: true, restartRequired: true,
    repo: info.repo, branch: info.branch,
    version: localVersion(),   // package.json on disk is now the updated one
  };
}
