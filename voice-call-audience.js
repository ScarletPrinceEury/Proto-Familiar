/**
 * voice-call-audience.js — decide the audience a voice-call turn is gated to.
 *
 * A voice call is a SHARED audio space: every reply is spoken ALOUD to everyone
 * in the channel. So the audience of a turn is not who SPOKE — it's who can
 * HEAR, which is the whole live roster. This resolves the lowest clearance
 * present, so a spoken reply never carries content above what everyone in the
 * channel is cleared for. (The leak this closes: the ward's own turn used to be
 * gated to ward-private, speaking my human's private recall aloud to villagers.)
 *
 * Pure + fully injected — no gateway, DB, or registry — so the cases that matter
 * on a safety path are unit-testable: ward alone → ward-private, any villager
 * present → the room's tag, a stranger present → the strangers ceiling, and the
 * mid-call join (a new roster yields a new tag, which the caller uses to reset
 * the shared history so a more-private stretch never reaches a newcomer).
 */

/**
 * @param {object}   deps
 * @param {string[]} deps.members         uids currently in the voice channel (live roster)
 * @param {string}   [deps.wardUserId]    the ward — full clearance, never a gating participant
 * @param {string}   [deps.botId]         the Familiar's own bot — it speaks, it does not tighten the gate
 * @param {function} [deps.resolveVillager] async (uid) => {id,name}|null — registered villager, else null (stranger)
 * @param {function} [deps.resolveTag]    (audienceInput) => tag — audienceTagFor(input, registry)
 * @param {string}   [deps.location]      the room's location key
 * @returns {Promise<{audienceInput, othersPresent, audienceTag, sessionAudience}>}
 *   `sessionAudience` is the literal `'ward-private'` sentinel when nobody else
 *   can hear, else the room audience OBJECT that scopes recall in `/api/chat`.
 */
export async function resolveCallAudience({
  members = [],
  wardUserId,
  botId,
  resolveVillager = async () => null,
  resolveTag = () => null,
  location = null,
} = {}) {
  const participants = [];
  for (const uid of Array.isArray(members) ? members : []) {
    if (uid === wardUserId) continue;         // the ward has full clearance — not a gating participant
    if (botId && uid === botId) continue;     // the bot is here to speak, not a listener that tightens the gate
    let villager = null;
    try { villager = await resolveVillager(uid); } catch { /* unresolved → stranger */ }
    // A stranger (unregistered) still counts — they can hear — and tightens the
    // gate to the strangers ceiling via resolveTag.
    participants.push({ id: villager?.id ?? null, name: villager?.name ?? 'someone' });
  }

  const audienceInput = { location, participants };

  // Nobody else can hear → this is the ward alone (a DM-shaped call): ward-private.
  if (participants.length === 0) {
    return { audienceInput, othersPresent: false, audienceTag: 'ward-private', sessionAudience: 'ward-private' };
  }

  // Others present → gate to the room's tag (the lowest clearance everyone shares).
  let audienceTag = 'shared-room';
  try { audienceTag = resolveTag(audienceInput) || 'shared-room'; } catch { audienceTag = 'shared-room'; }
  return { audienceInput, othersPresent: true, audienceTag, sessionAudience: audienceInput };
}
