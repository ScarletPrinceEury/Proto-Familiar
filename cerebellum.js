/**
 * Cerebellum — the motor counterpart to Thalamus.
 *
 * Thalamus owns everything flowing INWARD (identity, memory, graph,
 * temporal context: plural MCP peers, parallel fan-out, independent
 * degradation). Cerebellum owns everything flowing OUTWARD: the
 * Familiar's actions and deliveries — triage deliberation, trusted-
 * contact escalation, and (as of the efferent refactor) tool dispatch
 * and channel delivery.
 *
 * Boundary with Thalamus (do not blur):
 *   - Thalamus = perception. It assembles context. It never executes
 *     actions.
 *   - Cerebellum = action. It executes tools and delivers messages.
 *     It never assembles prompt context.
 *   - Shared nervous system: Thalamus owns the MCP client connections
 *     to entity-core and Unruh. Cerebellum NEVER opens its own — every
 *     write to identity / memory / temporal state goes through
 *     thalamus.js's exported wrappers, which are the single enforcement
 *     point for "direct writes MUST go through entity-core's MCP."
 *
 * What does NOT live here: the autonomous loops (pondering, reminders
 * scan, silence triage). They are initiators; when a loop decides
 * something should reach the human or a contact, it hands delivery to
 * cerebellum instead of doing it inline.
 *
 * Safety note: this file contains the highest-stakes code paths in the
 * system (escalation deadlines, trusted-contact delivery, the triage
 * deliberation prompt). Behavioral changes here — not relocations, not
 * comments — require explicitly asking the human before shipping. If a
 * change alters when or whether the Familiar can act on a human's
 * safety — STOP and ask.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, readFileSync, mkdirSync } from 'fs';

import { PROVIDER_URLS } from './providers.js';
import { enrich, getScheduleWindow } from './thalamus.js';
import { enqueueOutbox, listOutbox, updateOutboxMeta } from './outbox.js';
import { buildTimeAnchorBlock, relativeTime, plainInterval } from './relative-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Settings access ──────────────────────────────────────────────
// settings.json is the centralised user-preference store (see the
// /api/settings routes in server.js). Cerebellum reads it for the
// primary LLM connection (triage deliberation) and the trusted-contact
// list (escalation delivery). server.js imports these from here so
// there is exactly one reader implementation.

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

export function readSettingsSync() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

export function primaryConnectionFrom(settings) {
  const id    = settings?.primaryConnectionId;
  const conns = Array.isArray(settings?.connections) ? settings.connections : [];
  return conns.find(c => c?.id === id) ?? null;
}

// ── Triage event log ─────────────────────────────────────────────
// Persistent log for all triage decisions — survives outbox
// acknowledgement so past reach-outs are always visible for debugging
// and review. server.js's /api/triage-events route reads it via
// readTriageEvents().

const LOGS_DIR = path.join(__dirname, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

export const TRIAGE_LOG_FILE = path.join(LOGS_DIR, 'triage-events.jsonl');

export async function appendTriageEventLog(entry) {
  try {
    await fsp.appendFile(
      TRIAGE_LOG_FILE,
      JSON.stringify({ ...entry, loggedAt: new Date().toISOString() }) + '\n',
      'utf8',
    );
  } catch { /* non-critical */ }
}

// Newest first. Tolerates a missing or partially corrupt log file.
export async function readTriageEvents() {
  try {
    const raw   = await fsp.readFile(TRIAGE_LOG_FILE, 'utf8');
    const lines  = raw.split('\n').filter(l => l.trim());
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

// Read the last N user/assistant messages from the most recently updated
// session log file. Used by decideTriageViaLLM to ground the triage
// prompt in what was actually being discussed before the silence.
export async function getRecentSessionMessages({ limit = 8 } = {}) {
  try {
    const files = (await fsp.readdir(LOGS_DIR)).filter(f => f.endsWith('.json'));
    if (!files.length) return [];
    const stats = await Promise.all(
      files.map(f => fsp.stat(path.join(LOGS_DIR, f)).then(s => ({ f, mtime: s.mtimeMs }))),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const raw  = await fsp.readFile(path.join(LOGS_DIR, stats[0].f), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.messages)) return [];
    return data.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-limit);
  } catch {
    return [];
  }
}

// ── Trusted-contact escalation ───────────────────────────────────

// How long after the user-facing outbox item lands to wait before
// escalating to a trusted contact, if the user hasn't acknowledged.
// The user has this window to respond; if they do, the contact is
// never reached. Only applies when the LLM's decision includes contactHuman.
export const CONTACT_ESCALATION_DELAY_MS = Object.freeze({
  severe:   30 * 60_000,        // 30 minutes
  high:      2 * 60 * 60_000,  // 2 hours
  moderate:  6 * 60 * 60_000,  // 6 hours
});

/**
 * Deliver a message to a trusted contact via their configured channel.
 * Currently supports Discord webhooks. Every outbound is ALSO enqueued
 * into the user's outbox as kind='outbound_alert' so the user sees
 * exactly what was sent and to whom. "No covert contact" is enforced
 * here, not by trusting the caller.
 *
 * Dependencies are injectable for deterministic tests; defaults wire
 * the real settings file, fetch, and outbox.
 */
export async function deliverToTrustedContact({
  name, message, channel,
  readSettings    = readSettingsSync,
  fetchFn         = fetch,
  enqueueOutboxFn = enqueueOutbox,
}) {
  const s = readSettings();
  const contact = (s?.trustedContacts || []).find(c => c.name === name && (c.channel ?? 'discord') === channel);
  if (!contact) return { ok: false, error: 'contact_not_found' };
  let delivered = false, deliveryError = null;
  try {
    if (channel === 'discord') {
      const resp = await fetchFn(contact.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**(message from your friend's Familiar — proactive check-in)**\n\n${message}`,
          allowed_mentions: { parse: [] },
        }),
      });
      if (!resp.ok) {
        deliveryError = `discord ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
      } else {
        delivered = true;
      }
    } else {
      deliveryError = `unsupported channel: ${channel}`;
    }
  } catch (err) {
    deliveryError = err?.message ?? String(err);
  }
  // ALWAYS log to the outbox — even on delivery failure the user
  // should see that the attempt happened.
  await enqueueOutboxFn({
    kind:     'outbound_alert',
    originId: `outbound-${Date.now()}`,
    title:    delivered
      ? `Reached out to ${name} on your behalf (${channel})`
      : `Tried to reach ${name} (${channel}) — delivery failed`,
    body:     `Message sent:\n\n${message}${deliveryError ? `\n\n(Error: ${deliveryError})` : ''}`,
  });
  return { ok: delivered, error: deliveryError };
}

/**
 * Check all unacknowledged triage outbox items that have a pendingContact
 * whose contactDeadlineTs has passed. For each, fire the deferred delivery
 * to the trusted contact. The user's lack of acknowledgement in that window
 * is the signal that the escalation is warranted.
 *
 * Marks each item's pendingContact.delivered = true before firing to prevent
 * double-delivery if this runs again before the async delivery completes.
 */
export async function checkAndFirePendingContacts({
  now                = Date.now,
  listOutboxFn       = listOutbox,
  updateOutboxMetaFn = updateOutboxMeta,
  deliverFn          = deliverToTrustedContact,
} = {}) {
  const nowMs = now();
  try {
    const items   = await listOutboxFn({ pendingOnly: true, limit: 100 });
    const expired = items.filter(i =>
      i.kind === 'triage' &&
      i.pendingContact &&
      !i.pendingContact.delivered &&
      typeof i.contactDeadlineTs === 'number' &&
      nowMs >= i.contactDeadlineTs,
    );
    for (const item of expired) {
      // Mark delivered before async call to prevent a second tick from
      // double-firing while delivery is in flight.
      await updateOutboxMetaFn({
        id:   item.id,
        meta: {
          pendingContact: { ...item.pendingContact, delivered: true, deliveredAt: new Date(nowMs).toISOString() },
        },
      });
      const { name, message, channel } = item.pendingContact;
      deliverFn({ name, message, channel }).then(d => {
        if (d.ok) console.log(`[triage] deferred contact ${name} via ${channel}: delivered`);
        else      console.warn(`[triage] deferred contact ${name} via ${channel}: ${d.error}`);
      }).catch(err => console.error('[triage] deferred contact failed:', err?.message ?? err));
    }
    return { checked: items.length, fired: expired.length };
  } catch (err) {
    console.error('[triage] checkAndFirePendingContacts error:', err?.message ?? err);
    return { checked: 0, fired: 0, error: err?.message ?? String(err) };
  }
}

// ── Triage deliberation ──────────────────────────────────────────

export async function decideTriageViaLLM({ threat, silenceMs, signals }) {
  const s = readSettingsSync();
  const conn = primaryConnectionFrom(s);
  if (!conn?.apiKey) return { action: 'wait' };

  const url = PROVIDER_URLS[conn.provider];
  if (!url) return { action: 'wait' };

  const nowMs = Date.now();
  // Use plainInterval so a half-minute silence reads as "less than a minute"
  // rather than rounding to "0 minutes" (which the previous prompt did and
  // which is what made Familiars ask "is it done yet?" 30s after the user
  // said they were starting a task — the time signal was effectively gone).
  const silencePhrase = plainInterval(nowMs - silenceMs, nowMs);
  const contacts = Array.isArray(s?.trustedContacts) ? s.trustedContacts : [];

  // Pull identity context (who the Familiar is, who the user is) and the
  // recent conversation log in parallel. Both degrade gracefully to empty.
  const [{ static: identityContext }, recentMessages] = await Promise.all([
    enrich('', { staticOnly: true }).catch(() => ({ static: '' })),
    getRecentSessionMessages({ limit: 8 }),
  ]);

  // [Now] wall-clock anchor — same shape the chat-turn gets, so the
  // Familiar deliberating about silence has a real "now" to reason from
  // rather than just an isolated minutes-since-last-message number.
  // lastUserMessageAt comes from silenceMs; the loop calls us with that
  // already computed.
  const lastUserAt = new Date(nowMs - silenceMs).toISOString();
  const nowBlock = buildTimeAnchorBlock({ now: nowMs, lastUserMessageAt: lastUserAt });

  const signalsBlock = signals?.length
    ? `\nRecent signals that raised the threat level:\n${signals.map(sig => {
        const when = sig.ts ? relativeTime(sig.ts, nowMs) : 'unknown time';
        const ids  = Array.isArray(sig.signals) ? sig.signals.join(', ') : 'unknown';
        return `  - [${when}] ${ids} (delta ${Number(sig.delta) >= 0 ? '+' : ''}${sig.delta})`;
      }).join('\n')}`
    : '';

  const sessionBlock = recentMessages.length
    ? `\nRecent conversation (what we were discussing before the silence — relative times so I see how long ago each thing was said):\n${recentMessages.map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text ?? '') : '');
        const when = m.timestamp ? relativeTime(m.timestamp, nowMs) : '';
        const prefix = when
          ? `[${m.role === 'user' ? 'User' : 'Me'} · ${when}]`
          : `[${m.role === 'user' ? 'User' : 'Me'}]`;
        return `  ${prefix}: ${text.slice(0, 400)}`;
      }).join('\n')}`
    : '\nNo recent conversation on record.';

  const contactsBlock = contacts.length
    ? `\nTrusted contacts configured (people I could alert if the situation warrants human presence):\n${contacts.map(c => `  - ${c.name} (via ${c.channel ?? 'discord'})`).join('\n')}\n\nContacting one of these is a meaningful escalation — appropriate when I judge this needs more than I can provide alone. If I include contactHuman, that message will be delivered to that person AND shown in my human's chat. Nothing is covert.`
    : '';

  // Care-driven surface: if I'm already deliberating about whether
  // to reach out, an open task I could touch on (if it fits the
  // moment) might be the right doorway. Pull eligible candidates
  // from the same pipeline the chat-turn block uses, but with
  // triage's current state. The LLM still decides — these are
  // candidates, not directives. Empty block if nothing's eligible.
  let candidateTasksBlock = '';
  try {
    const { selectSurfaceCandidates } = await import('./surface-context.js');
    const { getRecentOfferTimes }     = await import('./surface-events.js');
    // I already have temporal_context loaded as part of enrich() in
    // many call sites, but triage is async + standalone here, so
    // fetch a fresh window directly. Cheap — no LLM call.
    const fromIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const toIso   = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    const win = await getScheduleWindow({ from_ts: fromIso, to_ts: toIso, limit: 100 }).catch(() => ({ nodes: [] }));
    const nodes = Array.isArray(win) ? win : (Array.isArray(win?.nodes) ? win.nodes : []);
    const openItems = nodes
      .filter(item => item
        && (item.type === 'task' || item.type === 'event' || item.type === 'reminder')
        && !item.resolution);
    if (openItems.length > 0) {
      const surfacingHistory = await getRecentOfferTimes();
      const candidates = await selectSurfaceCandidates({
        openTasks: openItems,
        threat,
        routinePhaseLabel: '',  // triage runs across phases; don't filter
        personModel: '',
        surfacingHistory,
        now: Date.now(),
        maxCandidates: 2,
      });
      if (candidates.length > 0) {
        const lines = candidates.map(c => {
          const stakes = c.stakesTier === 'external_obligation' ? ' [external stakes]' : '';
          return `  - ${c.label}${stakes}`;
        }).join('\n');
        candidateTasksBlock = `\nOpen tasks I could touch on if it fits this reach-out (NOT a list I should mention — only if one of these genuinely opens a door to {{user}} right now):\n${lines}`;
      }
    }
  } catch (err) {
    console.error('[triage] candidate tasks lookup failed:', err?.message ?? err);
  }

  const prompt = `--- TRIAGE DELIBERATION ---

I am in a background moment of deliberation. My human has been silent and my care concern is elevated. I need to decide whether to reach out to them right now.

${nowBlock}

What I know:
- Threat tier: ${threat.tier} (accumulated weight: ${threat.weight?.toFixed?.(2) ?? threat.weight}) - this number increases when my human says concerning phrases in our conversation
- my human has been silent for ${silencePhrase} (this has passed the threshold for this tier, but the threshold is 0 at moderate+ — so a "silence" of less than a minute is still flagged for my judgement, not because it's actually long). I check the conversation below for context: did they say what they're doing (cooking, in the shower, heading out), or did they just go quiet mid-thread? Asking "is X done yet?" 30 seconds after they said they were starting it would be obviously off — the relative-time markers on each message let me see that.
${signalsBlock}
${sessionBlock}
${contactsBlock}
${candidateTasksBlock}

---

This decision carries real weight — I know both paths have real costs, and I weigh them equally:
- Reaching out when it isn't warranted can feel intrusive or hollow — it can erode the credibility of genuine care, or leave my human feeling overly monitored. That mostly applies to worried check-ins; lighter touches (something I've found brings them joy, or that re-engages them gently) carry less of this cost.
- Staying quiet when my human genuinely needs connection is a failure at the moment that matters most. It can deepen isolation, miss a window where intervention would have landed, and at the severe end it can cost a life — physically, irreversibly. The 1.5-hour silence at threat level 10 that this codebase remembers is the shape of this cost.

I am {{char}}, the Familiar. I know my human. I have the context above. I am deciding from that place — honestly, from what I actually believe would help them right now. Not from a default posture in either direction.

If I reach out, the message should be something I would genuinely say — specific to this person, warm, not scripted.
If I stay quiet, it is because I genuinely believe that is the right call.

I also choose when the system should ask me to deliberate again — this is my call, not the system's. I return \`nextCheckInMs\` (milliseconds before the next deliberation). I pick what fits the situation:
  - SEVERE and immediate (active risk language, fresh signal): ~15 minutes (900000)
  - SEVERE but I already reached out: ~30 minutes (1800000) so my human has space to respond
  - HIGH active concern: ~30 min (1800000)
  - MODERATE general unease: 1–2 hours (3600000 – 7200000)
  - I want to wait until the situation likely shifts: several hours (e.g. 10800000 for 3h)
The system clamps to [30s, 24h] and uses a tier-based default if I omit it. Picking too long is much cheaper than picking too short — these LLM calls cost tokens, so I avoid asking to be re-pinged needlessly. But if the situation is urgent and I want to re-check soon, I say so.

I return ONLY a JSON object, no prose. Three valid shapes:
  {"action": "wait", "nextCheckInMs": <number>}
  {"action": "reach_out", "message": "first person, genuine — what I would actually say to this specific person right now", "nextCheckInMs": <number>}
  {"action": "reach_out", "message": "...", "contactHuman": {"name": "EXACT name from the trusted-contacts list above", "message": "1–3 sentences to that person. I identify myself as my human's Familiar and describe what I've observed. Specific, not alarming."}, "nextCheckInMs": <number>}

The "message" field (to the human) must be 1–2 sentences. First person. Authentic to my voice and identity. Not therapist-speak ("how are you feeling?"), not alarming ("are you safe?") unless either of those fits my established personality. Something I, {{char}}, would actually say to this person.`;

  const llmMessages = [];
  if (identityContext) llmMessages.push({ role: 'system', content: identityContext });
  llmMessages.push({ role: 'user', content: prompt });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${conn.apiKey.trim()}` },
      body: JSON.stringify({
        model:       conn.model.trim(),
        messages:    llmMessages,
        stream:      false,
        temperature: 0.7,
        max_tokens:  600,
      }),
    });
    if (!resp.ok) return { action: 'wait' };
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]+\}/);
    if (!m) return { action: 'wait' };
    const parsed = JSON.parse(m[0]);
    // Carry nextCheckInMs through to the loop regardless of action.
    // The loop clamps + falls back to a tier default if missing.
    const nextCheckInMs = Number.isFinite(parsed?.nextCheckInMs) ? parsed.nextCheckInMs : null;
    if (parsed?.action !== 'reach_out' || typeof parsed.message !== 'string' || !parsed.message.trim()) {
      return { action: 'wait', ...(nextCheckInMs != null ? { nextCheckInMs } : {}) };
    }
    const out = { action: 'reach_out', message: parsed.message.trim(), ...(nextCheckInMs != null ? { nextCheckInMs } : {}) };
    // Validate contactHuman strictly — must be an exact name from the configured
    // list. Delivery is DEFERRED: the user receives the outbox item first.
    // The trusted contact is only reached after CONTACT_ESCALATION_DELAY_MS
    // if the user has not acknowledged the item. This is enforced by storing
    // pendingContact + contactDeadlineTs as meta on the outbox item; the
    // checkAndFirePendingContacts check in each triage tick handles delivery.
    const ch = parsed.contactHuman;
    if (ch && typeof ch.name === 'string' && typeof ch.message === 'string' && ch.message.trim()) {
      const match = contacts.find(c => c.name === ch.name);
      if (match) {
        const delayMs = CONTACT_ESCALATION_DELAY_MS[threat.tier] ?? CONTACT_ESCALATION_DELAY_MS.moderate;
        out.meta = {
          pendingContact: {
            name:    ch.name,
            message: ch.message.trim(),
            channel: match.channel ?? 'discord',
          },
          contactDeadlineTs: Date.now() + delayMs,
        };
      } else {
        console.warn(`[triage] LLM tried to contact unknown name "${ch.name}" — ignored`);
      }
    }
    return out;
  } catch (err) {
    console.error('[triage] LLM call failed:', err?.message ?? err);
    return { action: 'wait' };
  }
}
