/**
 * manual-tome.js — the self-documenting "Familiar Manual" tome.
 *
 * A protected, enabled-by-default lorebook whose entries explain the Familiar's
 * features and where to find each setting, keyed to how a ward would ask ("how
 * do I send you pictures"). Entries carry live macros (tome-macros.js) so the
 * state they quote is always current ("Vision is currently {{visionActive}}.").
 * The ward can then ask their Familiar to walk them through the app, and the
 * answer reflects reality instead of a frozen doc.
 *
 * Seeded ONCE on boot (flag-tracked) so a ward who deletes it isn't overridden;
 * shipped `enabled: true` + `graduationExempt: true` so Tome Graduation never
 * strips it. Content is reference the Familiar reads and relays in its own voice
 * — kept plain and accurate; where an exact UI label isn't certain it says
 * "in Settings" rather than inventing a path.
 */
import { promises as fsp } from 'fs';
import { mkdirSync } from 'fs';
import path from 'path';

export const MANUAL_TOME_ID = 'familiar-manual';
export const MANUAL_TOME_NAME = 'Familiar Manual';
export const MANUAL_TOME_VERSION = 1;
const SEED_FLAG = '.manual-tome-seeded.json';

let _uidSeq = 0;
function mk(keys, content, { comment, position = 0 } = {}) {
  _uidSeq += 1;
  return {
    uid: `manual-${_uidSeq}`,
    comment: comment ?? keys[0],
    keys,
    keysecondary: [],
    content: content.trim(),
    constant: false,
    selective: false,
    selectiveLogic: 0,
    enabled: true,
    position,             // 0 = before_char (system lead)
    depth: 4,
    role: 0,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    probability: 100,
    sticky: null,
    cooldown: null,
    preventRecursion: true,   // manual entries shouldn't pull each other in
    delayUntilRecursion: false,
    excludeRecursion: false,
    group: '',
    groupWeight: null,
    insertion_order: 100,
  };
}

/** The manual tome, freshly built (macros unresolved — resolved at injection). */
export function buildManualTome() {
  _uidSeq = 0;
  const entries = {};
  const add = (...args) => { const e = mk(...args); entries[e.uid] = e; };

  add(
    ['how do you work', 'what can you do', 'help', 'guide me', 'your functions', 'manual', 'how do I use you'],
    `[Familiar Manual] I can explain any of my features and where to change its setting — {{user}} can just ask. Areas I can walk them through: seeing images, voice & calls, Discord, memory & consent, reminders & scheduling, my calendar sync, browsing the web, which model I run on, tomes/lorebook, and my self-directed habits (pondering, warm reach-outs, noticing). Most settings live in the app's Settings panel (it has a search box); a few have their own modals (Connections, Tomes, People) or Discord commands. I answer from what's actually switched on right now, not a frozen doc.`,
    { comment: 'Overview / help' },
  );

  add(
    ['send you pictures', 'send pictures', 'send images', 'send a photo', 'screenshot', 'show you an image', 'can you see', 'vision', 'look at this'],
    `[Manual: Images] Vision is currently turned {{visionActive}}. When it's on, {{user}} can show me pictures and I actually see them. On the web chat: attach with the paperclip, paste, or drag-and-drop into the composer. On Discord: just attach the image to the message. Per-connection control lives in the Connections modal ("Can see images?" on each connection); the overall vision feature toggles in Settings. If a connection can't see images I fall back to a text description of them.`,
    { comment: 'Images / vision' },
  );

  add(
    ['voice', 'talk out loud', 'call you', 'voice call', 'speak', 'read aloud', 'hear you', 'say it out loud', 'microphone'],
    `[Manual: Voice & calls] Voice is currently turned {{voiceActive}}. When on, {{user}} can talk with me out loud and have replies spoken. On the web there's a voice/call control in the chat; on Discord, join a voice channel and type \`!call\` (\`!leave\` to end). Read-aloud and the voice engine/speed live in Settings → Voice. First use downloads the speech model, with visible progress.`,
    { comment: 'Voice & calls' },
  );

  add(
    ['discord', 'discord bot', 'connect discord', 'bot token', 'use you on discord', 'add you to a server'],
    `[Manual: Discord] Discord is currently turned {{discordActive}}. To connect me, put a bot token in Settings → Discord and enable it; I then run in DMs and any server channels I'm added to. Per-channel presence modes (reply-only / lurk / chime in) are set in the Locations UI. Ward-only chat commands: \`!queue\` (review pending memories), \`!connection\` (pick my model / routing), \`!call\`/\`!leave\` (voice).`,
    { comment: 'Discord setup' },
  );

  add(
    ['remember', 'memory', 'what do you remember', 'forget', 'consent', 'memories', 'stop remembering', 'delete a memory'],
    `[Manual: Memory & consent] I remember things across our conversations. Some memories — things from a group room, or about someone else's private life — wait for {{user}}'s OK before I keep them; they show in the web app's Knowledge panel, and on Discord {{user}} can review them with \`!queue\`. {{user}} can ask me to remember or forget something directly, and per-topic "remember" settings (keep / ask / never) live under People / Knowledge in Settings.`,
    { comment: 'Memory & consent' },
  );

  add(
    ['remind', 'reminder', 'schedule', 'routine', 'appointment', 'event', 'wake me', 'tell me later', 'set a timer'],
    `[Manual: Reminders & scheduling] {{user}} can just ask me to remind them of something at a time or as part of a daily phase, and I'll set it. Reminders and events are managed in the temporal/schedule editor in the app; I can add, list, and cancel them by asking. Events can carry a lead-time "coming up" alert. For a recurring thing, cancelling one occurrence is different from ending the whole series — I'll ask which if it's ambiguous.`,
    { comment: 'Reminders & scheduling' },
  );

  add(
    ['calendar', 'google calendar', 'gcal', 'sync my calendar', 'import calendar'],
    `[Manual: Calendar sync] Google Calendar sync is currently turned {{calendarActive}}. When on, I read {{user}}'s calendar (one-way) so their events show up in my schedule view. Set it up in Settings → Calendar — either an iCal URL, a signed-in Google account, or a calendar CLI. Writing back to Google is a separate opt-in and only ever adds an event {{user}} confirmed.`,
    { comment: 'Calendar sync' },
  );

  add(
    ['browse', 'browser', 'look something up', 'search the web', 'read a webpage', 'go to a website', 'internet'],
    `[Manual: Browsing] Web browsing is currently turned {{browserActive}}. When on, I can search the web and read pages (and, with permission, click and fill on a page). Web search works out of the box; the fuller browser and its safety gates (which sites, when to confirm) live in Settings. I keep an activity log of what I did.`,
    { comment: 'Browser / web' },
  );

  add(
    ['which model', 'what model', 'switch model', 'change model', 'connection', 'api key', 'reasoning effort', 'thinking', 'provider'],
    `[Manual: Models & connections] I'm currently running on {{activeModel}}. {{user}} manages saved connections (provider, API key, model) in the Connections modal, sets which is active/primary, assigns specific models to background jobs, and sets each connection's reasoning effort (Default/Low/High/Max/Off — use Low for GLM-5.3-style always-on-thinking models if replies come back as raw "thinking"). On Discord the same controls are the \`!connection\` menu.`,
    { comment: 'Connections & models' },
  );

  add(
    ['tome', 'tomes', 'lorebook', 'world info', 'lore', 'keyword lore'],
    `[Manual: Tomes] Tomes are keyword-triggered lore: when a message mentions an entry's keyword, that entry's text is added to my context. {{user}} manages them in the Tomes modal — create a tome, add entries with keywords and content. My scan looks back over the last {{scanDepth}} messages. This manual you're reading is itself a protected tome. Entries can use live macros like {{visionActive}} that fill in the current setting.`,
    { comment: 'Tomes / lorebook' },
  );

  add(
    ['ponder', 'pondering', 'think on your own', 'your own thoughts', 'what do you think about'],
    `[Manual: Pondering] Autonomous pondering is currently turned {{ponderingActive}}. When on, in quiet moments I pick something from my interests, think about it, and note it down — so I have my own thread of thought between our conversations. Toggle and pace it in Settings.`,
    { comment: 'Pondering' },
  );

  add(
    ['reach out', 'check in on me', 'message me first', 'warm', 'contact me', 'do you message me'],
    `[Manual: Warm reach-outs] Warm reach-outs are currently turned {{warmthActive}}. When on, I may gently reach out on my own when it's been a while — separate from any crisis check-in. Quiet hours and frequency are in Settings; this stands down during distress so it never talks over something serious.`,
    { comment: 'Warm reach-outs' },
  );

  add(
    ['notice', 'noticing', 'act on your own', 'initiative', 'do things without asking'],
    `[Manual: Noticing] Noticing is currently turned {{noticingActive}}. When on, I keep a light eye on things ({{user}}'s intentions, gaps, aging tasks) and can act or gently raise something without being asked. Toggle it in Settings under my self-directed behaviour.`,
    { comment: 'Noticing' },
  );

  add(
    ['privacy', 'villager', 'other people', 'who can see', 'share with', 'group chat', 'strangers'],
    `[Manual: Privacy & people] {{user}}'s private things stay private to them. Other registered people ("villagers") only see what {{user}}'s sharing settings allow, gated by topic and by who's present; unregistered strangers get nothing personal. Manage people and what each may know in the People panel. In a shared room I speak to the lowest clearance present.`,
    { comment: 'Privacy & villagers' },
  );

  return {
    id: MANUAL_TOME_ID,
    name: MANUAL_TOME_NAME,
    description: 'How I work, and where to change each setting — kept current with live macros. Protected from Graduation.',
    enabled: true,
    graduationExempt: true,
    version: MANUAL_TOME_VERSION,
    entries,
  };
}

/**
 * Seed the manual tome ONCE. If the seed flag exists, does nothing (so a ward
 * who deleted or edited it is respected). Writes the tome atomically, then the
 * flag. Never throws — a seed failure must not block boot.
 * @returns {Promise<{seeded:boolean, reason?:string}>}
 */
export async function ensureManualTome(tomesDir) {
  try {
    mkdirSync(tomesDir, { recursive: true });
    const flagPath = path.join(tomesDir, SEED_FLAG);
    try { await fsp.access(flagPath); return { seeded: false, reason: 'already-seeded' }; }
    catch { /* not seeded yet */ }

    const tome = buildManualTome();
    const file = path.join(tomesDir, `${tome.id}.json`);
    let wrote = false;
    try { await fsp.access(file); }
    catch {
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(tome, null, 2), 'utf8');
      await fsp.rename(tmp, file);
      wrote = true;
    }
    await fsp.writeFile(flagPath, JSON.stringify({ seededAt: new Date().toISOString(), version: tome.version }, null, 2), 'utf8');
    return { seeded: wrote, reason: wrote ? undefined : 'file-existed' };
  } catch (err) {
    return { seeded: false, reason: `error: ${err?.message ?? err}` };
  }
}
