// turn-log.js — what each live turn's tool loop actually did (0.14.74).
//
// Why: in the first identity review the Familiar repeatedly reported tool calls
// that never ran, and nothing on disk could say whether it never called them,
// called a tool it didn't have this turn, or called one the loop then dropped
// (the streaming loop only runs calls when a round ends with finish_reason
// 'tool_calls'). Per turn this records the tools offered, and per round the
// finish reason, the calls the model sent, and whether they ran or were dropped
// — plus whether the web client was retrying a turn that had already run tools.
//
// One JSON line per turn at logs/turn-tools.jsonl, rotated to turn-tools.1.jsonl
// past MAX_BYTES so it can't grow without bound. Diagnostics only: never throws,
// never touches the turn. Hard off-switch PROTO_FAMILIAR_TURN_LOG_DISABLED=1.

import path from 'path';
import { mkdirSync, promises as fsp } from 'fs';
import { REPO_ROOT } from '../../repo-root.js';
import { findTextToolCalls } from '../../message-sanitize.mjs';

const LOG_DIR   = path.join(REPO_ROOT, 'logs');
const LOG_FILE  = path.join(LOG_DIR, 'turn-tools.jsonl');
const OLD_FILE  = path.join(LOG_DIR, 'turn-tools.1.jsonl');
export const TURN_LOG_MAX_BYTES = 2 * 1024 * 1024;

export function turnLogEnabled() {
  return process.env.PROTO_FAMILIAR_TURN_LOG_DISABLED !== '1';
}

/**
 * One round of a tool loop, in the shape every surface records. `toolCalls` is
 * the provider message's tool_calls (or the streamed accumulation). A round
 * whose calls arrived without finish_reason 'tool_calls' is `dropped`: the loop
 * treats it as the final answer and the calls never run.
 */
export function describeRound({ round, finishReason, toolCalls, ran, content, reasoning, closing = false }) {
  const calls = (Array.isArray(toolCalls) ? toolCalls : []).map(tc => tc?.function?.name || '?');
  // A call written into the reply as text instead of made (0.14.86).
  const written = typeof content === 'string' ? findTextToolCalls(content).filter(n => !calls.includes(n)) : [];
  return {
    round,
    finishReason: finishReason ?? null,
    calls,
    ran: !!ran,
    dropped: calls.length > 0 && !ran,
    contentChars: typeof content === 'string' ? content.length : 0,
    reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0,
    ...(closing ? { closing: true } : {}),
    ...(written.length ? { textToolCalls: written } : {}),
  };
}

/** The tool names in a provider tools array, for the "offered" field. */
export function toolNames(tools) {
  return (Array.isArray(tools) ? tools : []).map(t => t?.function?.name).filter(Boolean);
}

/** Append one turn's record. Best-effort; never throws. */
export async function logTurn(entry) {
  if (!turnLogEnabled()) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      const st = await fsp.stat(LOG_FILE);
      if (st.size > TURN_LOG_MAX_BYTES) await fsp.rename(LOG_FILE, OLD_FILE);
    } catch { /* no file yet */ }
    await fsp.appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (err) {
    console.warn('[turn-log] append failed (non-fatal):', err?.message ?? err);
  }
}

/** Most recent turns first. Never throws. */
export async function readTurns({ limit = 100 } = {}) {
  try {
    const raw = await fsp.readFile(LOG_FILE, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-limit).reverse()
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
