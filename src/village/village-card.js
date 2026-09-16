// Shared field-gating for a villager's disclosable registry fields.
//
// ONE policy, used by both `village_lookup` (cerebellum.js) and the Village
// presence block (village-presence.js), so the two can never drift on what
// counts as ward-only. The only gated field is `privateNotes`: it rides a
// ward-private turn and is withheld the instant anyone but my human is present.
// Pronouns, relation, comm style and public notes are how I refer to and tell
// my human's people apart, so they are always fair game (ward decision,
// 2026-09-16).
//
// Memories about a villager are NOT here — they flow through recall's own
// content/audience gate, so nothing on this path can become a bypass around it.
export function disclosableVillagerFields(v, { wardPrivate = true } = {}) {
  const has = (s) => typeof s === 'string' && s.trim().length > 0;
  return {
    pronouns:       has(v?.pronouns)       ? v.pronouns.trim()       : null,
    relationToWard: has(v?.relationToWard) ? v.relationToWard.trim() : null,
    commStyleNotes: has(v?.commStyleNotes) ? v.commStyleNotes.trim() : null,
    notes:          has(v?.notes)          ? v.notes.trim()          : null,
    // privateNotes rides a ward-private turn only; otherwise it is withheld.
    privateNotes:         (wardPrivate && has(v?.privateNotes)) ? v.privateNotes.trim() : null,
    privateNotesWithheld: (!wardPrivate && has(v?.privateNotes)),
  };
}
