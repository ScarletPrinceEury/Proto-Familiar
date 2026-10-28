/**
 * turn-record.js — a turn's record lands in its session log as the turn goes
 * (0.14.106).
 *
 * A tool round used to be recorded only once its turn finished. The web chat
 * committed my human's message, the rounds and my reply together. Voice kept
 * only the words. Discord kept only my reply, so on Discord the next turn's
 * "[Last turn …]" line said I'd used no tools after every turn where I had. A
 * turn that broke off after its tools ran (a closed tab, a dropped connection,
 * a call that hung up) left no trace of them, and the web chat then retried
 * it, running every write a second time.
 *
 * Now each surface builds a turn's messages here and writes them as they happen:
 * - my human's message, before the model call;
 * - each tool round, as soon as its results are back;
 * - the reply, when it lands;
 * - if the turn ends after it began but before it finished: whatever I'd said
 *   so far, plus a plain app note that it was cut off.
 *
 * Every message carries the turn's `turnId` and a stable id. A second writer
 * saving the same turn (the web client) therefore unions with these instead of
 * doubling them, and a turn that already ran tools can be recognised and never
 * run again.
 */

import { APP_NOTE_KIND, CUT_OFF_NOTE_PREFIX } from '../../message-sanitize.mjs';
import { appendSessionMessages, readSessionMessages } from './session-log.js';

const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const isValidTurnId = (id) => typeof id === 'string' && TURN_ID_RE.test(id);
const isIso = (s) => typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s));

/** The app note for a turn that was cut off. Plain fact, no verdict (CLAUDE.md #6). */
export function cutOffNoteText(toolsRan) {
  return `${CUT_OFF_NOTE_PREFIX} before I finished answering.${toolsRan ? ' The tools above had already run.' : ''}]`;
}

/**
 * Read a request's `turn` envelope, or null when there isn't a usable one (then
 * the request isn't journaled at all: utility calls such as a handoff summary
 * never send one). Shape:
 *   { sessionId, turnId, userMessage: {id, content, timestamp, speaker?,
 *     attachments?, moodTag?}, replyMessageId, location?, prevTurnId?, retry? }
 * Only known fields of the user message are kept.
 */
export function parseTurnEnvelope(raw, { isValidSessionId } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const { sessionId, turnId, userMessage: um, replyMessageId, location, prevTurnId } = raw;
  if (typeof isValidSessionId !== 'function' || !isValidSessionId(sessionId)) return null;
  if (!isValidTurnId(turnId) || !isValidTurnId(replyMessageId)) return null;
  if (!um || typeof um !== 'object' || !isValidTurnId(um.id)) return null;
  if (typeof um.content !== 'string' || !isIso(um.timestamp)) return null;
  const userMessage = {
    id: um.id, role: 'user', content: um.content, timestamp: um.timestamp, turnId,
    ...(typeof um.speaker === 'string' && um.speaker.trim() ? { speaker: um.speaker } : {}),
    ...(Array.isArray(um.attachments) && um.attachments.length ? { attachments: um.attachments.filter(a => a && typeof a.id === 'string') } : {}),
    ...(typeof um.moodTag === 'string' && um.moodTag.trim() ? { moodTag: um.moodTag } : {}),
  };
  const loc = location && typeof location === 'object' && typeof location.platform === 'string'
    ? { platform: location.platform, ...(typeof location.label === 'string' ? { label: location.label } : {}) }
    : null;
  return {
    sessionId, turnId, userMessage, replyMessageId, location: loc,
    prevTurnId: isValidTurnId(prevTurnId) && prevTurnId !== turnId ? prevTurnId : null,
    // A second send of the same turn (a retry, a fallback connection, "Try
    // again"): the server reads the log to check it never ran tools.
    retry: raw.retry === true,
  };
}

/**
 * One tool round as stored messages: the assistant carrier holding the calls,
 * then one `role:'tool'` result per call (the shape the web chat always stored).
 */
export function toolRoundMessages({ turnId, round, toolCalls, results, content, timestamp }) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const base = `${turnId}-r${round}`;
  return [
    { id: base, role: 'assistant', content: content || null, tool_calls: calls, timestamp, turnId },
    ...(Array.isArray(results) ? results : []).map((r, i) => ({
      id: `${base}-${i}`, role: 'tool', tool_call_id: r.tool_call_id, content: r.content,
      timestamp, _toolName: r.name, turnId,
    })),
  ];
}

export function replyMessage({ id, turnId, content, timestamp, cutOff = false }) {
  return { id, role: 'assistant', content, timestamp, turnId, ...(cutOff ? { cutOff: true } : {}) };
}

const cutOffNoteId = (turnId) => `${turnId}-cutoff`;

export function cutOffNote({ turnId, toolsRan, timestamp }) {
  return {
    id: cutOffNoteId(turnId), role: 'system', kind: APP_NOTE_KIND, noteType: 'cut-off',
    toolsRan: !!toolsRan, content: cutOffNoteText(toolsRan), timestamp, turnId,
  };
}

/**
 * Stored messages as /api/chat takes them as history: role, content and the
 * tool fields, plus the speaker on a user turn. Everything else a log keeps
 * (ids, timestamps, turnId, kind) stays out of the request.
 */
export function toApiHistory(messages) {
  return (Array.isArray(messages) ? messages : []).map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    const base = { role: m.role, content: m.content ?? null };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) base.tool_calls = m.tool_calls;
    if (m.role === 'user' && m.speaker) base.speaker = m.speaker;
    return base;
  });
}

/**
 * The turn id of the conversation's last message when it's my human's and
 * nothing came after it: a turn that may still be finishing (or never got its
 * record into this copy). The next turn sends it as `prevTurnId`.
 */
export function unansweredTurnId(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  return last?.role === 'user' && isValidTurnId(last.turnId) ? last.turnId : null;
}

/** Whether a turn already ran tools, from a session's stored messages. */
export function turnRanTools(messages, turnId) {
  return (Array.isArray(messages) ? messages : []).some(m => m?.turnId === turnId && m.role === 'tool');
}

/** A turn's stored messages, in log order: my human's, its rounds, the reply, any note. */
export function turnMessagesOf(messages, turnId) {
  return (Array.isArray(messages) ? messages : []).filter(m => m?.turnId === turnId);
}

// ── Turns in flight ──────────────────────────────────────────────
// A retry of a turn, or the next turn after one was cut off, can arrive while
// the first is still finishing a tool round (the browser already left; the tool
// call can't be stopped). Those wait here until it has written what it did.
const _active = new Map();   // turnId → Promise that settles when the turn's record is written

/** Wait (up to `ms`) for a turn still running to finish writing. true = it's done (or wasn't running). */
export async function awaitTurnSettled(turnId, ms = 20_000) {
  const p = _active.get(turnId);
  if (!p) return true;
  let timer;
  const timeout = new Promise(r => { timer = setTimeout(() => r(false), ms); timer.unref?.(); });
  try { return await Promise.race([p.then(() => true), timeout]); }
  finally { clearTimeout(timer); }
}

export function turnInFlight(turnId) { return _active.has(turnId); }

// Turns this process has run tools for, so a retry is caught without reading
// the log. Bounded; after a restart the log is the record (turnRanTools).
const _ranTools = new Set();
const RAN_TOOLS_KEEP = 500;
function noteToolsRan(turnId) {
  _ranTools.delete(turnId);
  _ranTools.add(turnId);
  while (_ranTools.size > RAN_TOOLS_KEEP) _ranTools.delete(_ranTools.values().next().value);
}
export function ranToolsHere(turnId) { return _ranTools.has(turnId); }

/**
 * The writer for one turn. `write(messages, { remove })` persists them
 * (add-or-replace by id, taking out the `remove` ids) and resolves to { ok }.
 * It never throws into the turn, and a failed write is logged, never fatal:
 * the reply still goes out.
 */
export function createTurnRecorder({ envelope, write, now = () => new Date().toISOString(), log = (...a) => console.warn('[turn-record]', ...a) }) {
  const { turnId, userMessage, replyMessageId } = envelope;
  const recorded = [];
  let begun = false, finished = false, rounds = 0, partial = '';
  let settleDone;
  const done = new Promise(r => { settleDone = r; });
  _active.set(turnId, done);

  const persist = async (msgs, { remove = [] } = {}) => {
    for (const m of msgs) {
      const i = recorded.findIndex(x => x.id === m.id);
      if (i >= 0) recorded[i] = m; else recorded.push(m);
    }
    try {
      const r = await write(msgs, { remove });
      if (r && r.ok === false) log(`couldn't write turn ${turnId}: ${r.reason ?? 'unknown'}`);
    } catch (err) { log(`couldn't write turn ${turnId}: ${err?.message ?? err}`); }
    return msgs;
  };

  return {
    turnId,
    get toolsRan() { return rounds > 0; },
    /** My human's message, before the model call. */
    async begin() {
      if (begun) return;
      begun = true;
      await persist([userMessage]);
    },
    /** One finished tool round. Returns the stored messages (for the client). */
    async round({ round, toolCalls, results, content, timestamp }) {
      rounds++;
      partial = '';
      noteToolsRan(turnId);
      return persist(toolRoundMessages({ turnId, round: round ?? rounds - 1, toolCalls, results, content, timestamp: timestamp || now() }));
    },
    /** What I've written of the reply so far, kept in case the turn is cut off. */
    setPartial(text) { partial = typeof text === 'string' ? text : ''; },
    /**
     * The turn finished. An empty reply is stored as nothing. A reply replaces
     * any cut-off partial an earlier try of this turn left under the same id,
     * and that try's cut-off note goes.
     */
    async finish(text) {
      finished = true;
      const content = typeof text === 'string' ? text : '';
      if (content.trim()) {
        await persist([replyMessage({ id: replyMessageId, turnId, content, timestamp: now() })], { remove: [cutOffNoteId(turnId)] });
      }
    },
    /**
     * Called once the request is over, whatever happened. A turn that began and
     * didn't finish gets what I'd said so far and, when anything happened at
     * all, the cut-off note. A turn where nothing ran and nothing was said is
     * left as my human's message alone: there's nothing to record, and it can
     * be tried again safely.
     */
    async settle() {
      try {
        if (!begun || finished) return;
        const at = now();
        const msgs = [];
        if (partial.trim()) msgs.push(replyMessage({ id: replyMessageId, turnId, content: partial, timestamp: at, cutOff: true }));
        if (rounds > 0 || partial.trim()) msgs.push(cutOffNote({ turnId, toolsRan: rounds > 0, timestamp: at }));
        if (msgs.length) await persist(msgs);
      } finally {
        finished = true;
        if (_active.get(turnId) === done) _active.delete(turnId);
        settleDone();
      }
    },
    /** Everything this turn wrote, in order. */
    messages() { return [...recorded]; },
  };
}

/**
 * What /api/chat does with a turn envelope before running the turn. Returns
 * { refusal } (the 409 body: this turn won't run) or { rec, priorTurn }:
 * - A send of this same turn still finishing a tool round → refused, still running.
 * - This turn already ran tools (this process saw it, or a retry finds it in
 *   the log) → refused, with what it recorded. A turn never runs twice.
 * - `prevTurnId` names a turn this client never got whole (cut off, or the
 *   page reloaded): wait for it to finish writing and hand back its record,
 *   so this turn starts knowing it and the client catches up.
 * - Otherwise a recorder that writes into the session log. `rec.meta.audienceTag`
 *   is set by the caller once the room is known: a voice call's log has always
 *   carried its room's tag (its hang-up write stamps it), so a log first written
 *   here gets it too, or a call that crashed before hang-up would be swept into
 *   memory as ward-private. A web chat log carries no tag, as before: which
 *   circle a shared web chat's facts belong to is the ward's decision
 *   (docs/known-issues-fix-plans.md, C2).
 */
export async function openTurn(envelope, { logsDir, settleMs = 20_000, log = (...a) => console.log('[chat]', ...a) } = {}) {
  if (!(await awaitTurnSettled(envelope.turnId, settleMs))) {
    return { refusal: { error: 'That message is still being answered.', _turnStillRunning: { turnId: envelope.turnId } } };
  }
  let stored = null;
  const storedMessages = async () => (stored ??= await readSessionMessages(envelope.sessionId, { logsDir }));
  if (ranToolsHere(envelope.turnId) || (envelope.retry && turnRanTools(await storedMessages(), envelope.turnId))) {
    log(`turn ${envelope.turnId} already ran tools — answering with its record instead of running it again`);
    return { refusal: {
      error: 'That message already ran tools, so it isn\'t sent again.',
      _turnAlreadyRan: { turnId: envelope.turnId, messages: turnMessagesOf(await storedMessages(), envelope.turnId) },
    } };
  }
  let priorTurn = null;
  if (envelope.prevTurnId) {
    await awaitTurnSettled(envelope.prevTurnId, settleMs);
    const prior = turnMessagesOf(await storedMessages(), envelope.prevTurnId);
    if (prior.some(m => m.role !== 'user')) priorTurn = { turnId: envelope.prevTurnId, messages: prior };
  }
  const meta = { audienceTag: null };
  const rec = createTurnRecorder({
    envelope,
    write: (msgs, { remove } = {}) => appendSessionMessages(envelope.sessionId, msgs, {
      logsDir, remove,
      defaults: {
        location: envelope.location, startedAt: envelope.userMessage.timestamp,
        ...(envelope.location?.platform === 'voice' && meta.audienceTag ? { audienceTag: meta.audienceTag } : {}),
      },
    }),
  });
  rec.meta = meta;
  return { rec, priorTurn };
}
