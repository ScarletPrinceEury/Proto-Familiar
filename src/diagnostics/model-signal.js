/**
 * Which model I'm running on, and whether that changed since my last turn in
 * this conversation (0.14.85).
 *
 * The app knows which model answers every turn; I can't tell from inside. So
 * the [Now] block says it, plainly, in code — the model never types it (the
 * exact-values rule). When the model differs from the one that ran my last
 * turn here, or this is the first turn of a new conversation, the line says
 * that too, so my own "after a swap or a fresh start, I check my memory first"
 * has something to go on.
 *
 * The last model per conversation lives in tomes/.last-model.json, keyed by
 * session id alone: a conversation shared between web and Discord is one
 * conversation, and a different model on the other surface is a real change.
 */
import path from 'path';
import { mkdirSync, promises as fsp } from 'fs';
import { REPO_ROOT } from '../../repo-root.js';

const STATE_FILE = path.join(REPO_ROOT, 'tomes', '.last-model.json');
const MAX_SESSIONS = 200;
let _state = null;
let _persist = true;

/** The line itself. Pure. '' when the model isn't known. */
export function formatModelLine({ model, previousModel = null, firstTurn = false } = {}) {
  const m = String(model ?? '').trim();
  if (!m) return '';
  const parts = [`I'm running on ${m}.`];
  const prev = String(previousModel ?? '').trim();
  if (prev && prev !== m) parts.push(`That changed since my last turn here, which ran on ${prev}.`);
  if (firstTurn) parts.push('This is the first turn of a new conversation.');
  return parts.join(' ');
}

async function load() {
  if (_state) return _state;
  try { _state = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')) || {}; }
  catch { _state = {}; }
  if (typeof _state !== 'object' || Array.isArray(_state)) _state = {};
  return _state;
}

async function save(state) {
  if (!_persist) return;
  const keys = Object.keys(state);
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => String(state[a]?.at ?? '').localeCompare(String(state[b]?.at ?? '')));
    for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete state[k];
  }
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[model-signal] could not save the last model:', err?.message ?? err);
  }
}

/**
 * The line for this turn, recording this turn's model as the conversation's
 * latest. Never throws: a state-file problem just drops the "changed" part.
 */
export async function modelSignal({ sessionKey = null, model, firstTurn = false } = {}) {
  const m = String(model ?? '').trim();
  if (!m) return '';
  let previousModel = null;
  try {
    const state = await load();
    if (sessionKey) {
      previousModel = state[sessionKey]?.model ?? null;
      if (previousModel !== m) {
        state[sessionKey] = { model: m, at: new Date().toISOString() };
        await save(state);
      }
    }
  } catch (err) {
    console.warn('[model-signal] state unavailable:', err?.message ?? err);
  }
  return formatModelLine({ model: m, previousModel, firstTurn });
}

/** Test hook: start from `state` (in memory only — nothing is written). */
export function __resetModelSignalForTest(state = {}) { _state = state; _persist = false; }
