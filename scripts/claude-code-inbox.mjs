#!/usr/bin/env node
/**
 * Claude Code's inbox (0.14.93): notes the Familiar left for Claude Code
 * (src/bridge/claude-code-mailbox.js).
 *
 *   node scripts/claude-code-inbox.mjs           hand over waiting notes and print
 *                                                them (the SessionStart hook in
 *                                                .claude/settings.json runs this)
 *   node scripts/claude-code-inbox.mjs --peek    print waiting notes, leave them waiting
 *   node scripts/claude-code-inbox.mjs --wait    poll until a note arrives, print it,
 *                                                exit (run in the background from a
 *                                                session to hear from the Familiar
 *                                                mid-session; --interval 30 --timeout 3600)
 *
 * Asks the running server first (http://127.0.0.1:$PROTO_FAMILIAR_PORT, default
 * 8742). With the server down it reads the live install's inbox file directly:
 * $PROTO_FAMILIAR_INBOX_FILE, else tomes/.claude-code-inbox.json in the main
 * checkout (found through git, so it works from a worktree too).
 *
 * A hook must never get in the way of a session: this always exits 0 and prints
 * nothing when there's nothing to say (no server, no inbox, bridge off, no notes).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClaudeCodeMailbox, formatNotesForSession } from '../src/bridge/claude-code-mailbox.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const num = (name, def) => { const i = args.indexOf(`--${name}`); const v = Number(args[i + 1]); return i >= 0 && v > 0 ? v : def; };
const PORT = Number(process.env.PROTO_FAMILIAR_PORT) || 8742;
const BASE = `http://127.0.0.1:${PORT}`;

/** The live install's root: the main checkout, even when run from a worktree. */
function installRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.dirname(common);
  } catch { return process.cwd(); }
}

function familiarNameFromFile(root) {
  try { return String(JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8'))?.charName || '').trim() || null; }
  catch { return null; }
}

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally { clearTimeout(t); }
}

/** { notes, name } from the server, or from the file when the server is down; null = nothing to say. */
async function getNotes({ peek, via }) {
  try {
    if (peek) {
      const { status, body } = await fetchJson(`${BASE}/api/bridge/claude-code/inbox`);
      if (status !== 200 || !body?.enabled) return null;
      return { notes: (body.notes ?? []).filter(n => !n.deliveredAt).reverse(), name: null };
    }
    const { status, body } = await fetchJson(`${BASE}/api/bridge/claude-code/inbox/take`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ via }),
    });
    if (status !== 200) return null;            // bridge off (403) or something else: say nothing
    return { notes: body?.notes ?? [], name: body?.name ?? null };
  } catch {
    // Server not running: read the install's inbox file directly.
    const root = installRoot();
    const inboxFile = process.env.PROTO_FAMILIAR_INBOX_FILE || path.join(root, 'tomes', '.claude-code-inbox.json');
    const mailbox = createClaudeCodeMailbox({ logsDir: path.join(root, 'logs'), inboxFile, log: () => {} });
    const notes = peek
      ? (await mailbox.listNotes({ limit: 200 })).filter(n => !n.deliveredAt).reverse()
      : await mailbox.takeNotes({ via });
    return { notes, name: familiarNameFromFile(root) };
  }
}

function print(res) {
  const text = formatNotesForSession(res?.notes ?? [], { name: res?.name || 'the Familiar', port: PORT });
  if (text) process.stdout.write(text + '\n');
  return !!text;
}

async function main() {
  if (flag('wait')) {
    const interval = num('interval', 30) * 1000, deadline = Date.now() + num('timeout', 3600) * 1000;
    while (Date.now() < deadline) {
      if (print(await getNotes({ peek: false, via: 'wait' }))) return;
      await new Promise(r => setTimeout(r, interval));
    }
    process.stdout.write('[Proto-Familiar] No note from the Familiar while I waited.\n');
    return;
  }
  print(await getNotes({ peek: flag('peek'), via: process.env.CLAUDE_CODE_INBOX_VIA || 'session-start' }));
}

main().catch(() => {}).finally(() => process.exit(0));
