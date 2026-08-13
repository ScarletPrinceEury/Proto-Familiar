/**
 * session-log.js — write a conversation to logs/ so the ward can review it in
 * the Sessions tab, exactly like a web-chat log.
 *
 * Extracted when voice calls needed the same "land as a reviewable session"
 * behaviour the Discord gateway already had (the no-copy-paste rule: a second
 * consumer is the signal to share). Transport-neutral: the caller owns the log
 * SHAPE (sessionId, messages, audienceTag, provider, timestamps); this only
 * persists it, atomically (tmp + rename, so a crash mid-write never leaves a
 * half-file that would read as a corrupt session).
 *
 * The message shape a reviewable log wants: `{ id, role, content, timestamp }`
 * per message. `stampMessages` fills id/timestamp on plain `{role, content}`
 * turns (voice calls accumulate those) without disturbing ones that already
 * carry them (Discord turns do).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Persist a session log. `data.sessionId` names the file; the rest is written
 * as-is. Returns { ok } and never throws — a failed log write must never sink a
 * call teardown or a chat turn.
 */
export async function writeSessionLog(data, { logsDir } = {}) {
  if (!data?.sessionId || !logsDir) return { ok: false, reason: 'missing sessionId or logsDir' };
  try {
    await fsp.mkdir(logsDir, { recursive: true });
    const file = path.join(logsDir, `${data.sessionId}.json`);
    const tmp  = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * Give plain `{role, content}` turns the `id` + `timestamp` a reviewable log
 * renders from, leaving any that already have them untouched. A single stamp
 * time is fine — voice turns are accumulated in order and the array order is
 * what the viewer reads; the timestamp is for display, not ordering.
 */
export function stampMessages(messages, stampIso = new Date().toISOString()) {
  return (Array.isArray(messages) ? messages : []).map((m) => ({
    id:        m?.id || randomUUID(),
    role:      m?.role,
    content:   m?.content,
    timestamp: m?.timestamp || stampIso,
    ...(m?.attachments ? { attachments: m.attachments } : {}),
  }));
}
