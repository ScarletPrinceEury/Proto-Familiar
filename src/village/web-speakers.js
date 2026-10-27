/**
 * Other people who may type in my human's web chat (0.14.87, ward decision).
 *
 * Everything typed into the web chat used to read as my human: I answered them
 * when someone else was talking, memory filed that person's words as theirs,
 * their words were scored as my human's distress, and every message counted as
 * my human being around. My human lists the others ("Others who may type in my
 * web chat", Knowledge editor → Prompts); a message carries `speaker` when one of them sent it
 * (the composer's "Speaking as" picker, which resets to my human after every
 * send).
 *
 * Fail-closed: only a LISTED name counts. An unlisted or empty speaker is my
 * human — nobody stops being treated as my human by typing a bracket.
 */

/** The listed names, trimmed, deduped (case-insensitive), never my human's own. */
export function listedSpeakers(settings = {}) {
  const raw = settings?.webSpeakers;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const ward = String(settings?.userName ?? '').trim().toLowerCase();
  const out = [];
  for (const n of list) {
    const name = String(n ?? '').trim().slice(0, 40);
    if (!name || name.toLowerCase() === ward) continue;
    if (!out.some(x => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** The listed speaker of a user message (the list's own spelling), or null = my human. */
export function speakerOf(message, settings = {}) {
  if (!message || message.role !== 'user') return null;
  const s = String(message.speaker ?? '').trim().toLowerCase();
  if (!s) return null;
  return listedSpeakers(settings).find(n => n.toLowerCase() === s) ?? null;
}

/** "[Name]: text" — the label a listed speaker's line carries wherever a model reads it. Idempotent. */
export function labelAsSpeaker(text, name) {
  const t = String(text ?? '');
  return t.trimStart().startsWith(`[${name}]:`) ? t : `[${name}]: ${t}`;
}

/**
 * The line my [Now] block carries while I answer a listed speaker (0.14.104).
 * The "[Name]: " label on their message wasn't enough on its own: the rest of my
 * context is all about my human, so I answered Claude Code on the bridge as if
 * my human had written it. '' when it's my human typing.
 */
export function speakerAnchorLine(name) {
  const n = String(name ?? '').trim();
  return n ? `[Who's typing: this message is from ${n}, not my human. Their lines start "[${n}]:".]` : '';
}

/**
 * History for the provider: a listed speaker's turns read "[Name]: …" (the way
 * Discord shows non-ward speakers), and the `speaker` field itself never reaches
 * the provider. Content arrays (images) get the label on their first text part.
 */
export function labelSpeakers(messages = [], settings = {}) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(m => {
    if (!m || typeof m !== 'object' || !('speaker' in m)) return m;
    const { speaker, ...rest } = m;
    const name = speakerOf(m, settings);
    if (!name) return rest;
    if (typeof rest.content === 'string') return { ...rest, content: labelAsSpeaker(rest.content, name) };
    if (Array.isArray(rest.content)) {
      let done = false;
      const parts = rest.content.map(p => {
        if (done || p?.type !== 'text') return p;
        done = true;
        return { ...p, text: labelAsSpeaker(p.text, name) };
      });
      return { ...rest, content: done ? parts : [{ type: 'text', text: `[${name}]:` }, ...parts] };
    }
    return rest;
  });
}
