#!/usr/bin/env node
/**
 * Send one message to the Familiar over the Claude Code bridge (0.14.94).
 *
 *   node scripts/claude-code-bridge.mjs < message.txt
 *   node scripts/claude-code-bridge.mjs --message "short message"
 *   node scripts/claude-code-bridge.mjs --new < message.txt     (start a fresh conversation)
 *
 * Prints the Familiar's reply, then any notes it left for Claude Code that
 * came back with it, then which tools its turn used. Reading the message from
 * stdin keeps quotes, apostrophes and newlines intact. Turns can take minutes
 * on a high-effort model, so this waits up to 10 minutes.
 *
 * Server: http://127.0.0.1:$PROTO_FAMILIAR_PORT (default 8742). Exits 1 with
 * the reason when the turn didn't go through (bridge off, no reply, server down).
 * Used by the familiar-liaison agent (.claude/agents/familiar-liaison.md).
 */
const args = process.argv.slice(2);
const PORT = Number(process.env.PROTO_FAMILIAR_PORT) || 8742;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const i = args.indexOf('--message');
  const message = (i >= 0 ? String(args[i + 1] ?? '') : await readStdin()).trim();
  if (!message) { console.error('No message: pass --message "…" or pipe it in.'); return 1; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10 * 60_000);
  let res, data;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/api/bridge/claude-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ message, ...(args.includes('--new') ? { newConversation: true } : {}) }),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    console.error(err?.name === 'AbortError' ? 'No reply within 10 minutes.' : `Couldn't reach the app on port ${PORT}: ${err?.message ?? err}`);
    return 1;
  } finally { clearTimeout(timer); }
  if (!data?.ok) { console.error(`The turn didn't go through (HTTP ${res.status}): ${data?.error ?? 'no details'}`); return 1; }
  console.log(data.reply);
  const notes = Array.isArray(data.notes) ? data.notes : [];
  if (notes.length) {
    console.log(`\n--- ${notes.length === 1 ? 'a note' : `${notes.length} notes`} it left for Claude Code:`);
    for (const n of notes) console.log(`- ${String(n.at ?? '').replace('T', ' ').slice(0, 16)} (${n.id}): ${n.text}`);
  }
  console.log(`\n--- tools its turn used: ${(data.toolsUsed ?? []).join(', ') || 'none'}`);
  if (Array.isArray(data.unbackedClaim) && data.unbackedClaim.length) {
    console.log(`--- the reply says something was done, but no tool ran: ${data.unbackedClaim.map(p => `"${p}"`).join(', ')}`);
  }
  const u = data.usage;
  if (u) console.log(`--- tokens this turn: ${u.prompt_tokens ?? '?'} in, ${u.completion_tokens ?? '?'} out` +
    (u.reasoning_tokens ? ` (${u.reasoning_tokens} reasoning)` : '') + (u.cached_tokens ? `, ${u.cached_tokens} cached` : '') +
    (u.rounds > 1 ? `, over ${u.rounds} rounds` : ''));
  return 0;
}

main().then(code => process.exit(code), (err) => { console.error(err?.message ?? err); process.exit(1); });
