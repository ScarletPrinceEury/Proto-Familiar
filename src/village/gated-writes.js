/**
 * gated-writes.js — what a villager's turn may change by id (0.14.105, ward-signed).
 *
 * A villager whose grants allow writes gets tools that act on a stored item by
 * id: correct a memory, move its date, resolve / delete / retime / snooze /
 * link a schedule item, apply a template to one. Recall on that turn was scoped
 * to the room, but the writes weren't: given an id, they changed any memory,
 * my human's private ones included, and ids are readable slugs, so they can be
 * guessed. Now, on a gated turn, every id a by-id write names is read first,
 * and the write goes ahead only when the room could read that item too:
 * - a memory: its audience is one of the room's visible audiences AND its
 *   content tag passes the room's topic grants (the same two checks recall
 *   runs in Phylactery's memory.search);
 * - a schedule item: it isn't sensitive (what schedule_find hides).
 * A missing item is refused exactly like a hidden one, so the refusal never
 * tells anyone whether an id exists. A read that fails refuses too.
 *
 * My human's own turns and my quiet moments aren't gated (audiences undefined).
 */
import { memoryVisibleToVillager } from '../memory/content-tags.js';
import { isSensitiveNode } from '../safety/spine-states.js';

// Each by-id write a villager can reach, the kind of item it changes, and the
// arguments that name one. tests/gated-writes.test.mjs checks every villager
// write tool with an id-shaped argument is here or in NOT_TARGETED.
export const GATED_BY_ID_WRITES = Object.freeze({
  update_memory_by_id:  { kind: 'memory',   args: ['id'] },
  move_memory_date:     { kind: 'memory',   args: ['id'] },
  schedule_resolve:     { kind: 'schedule', args: ['id'] },
  schedule_delete:      { kind: 'schedule', args: ['id'] },
  schedule_assign_time: { kind: 'schedule', args: ['id'] },
  schedule_snooze_task: { kind: 'schedule', args: ['id'] },
  schedule_link:        { kind: 'schedule', args: ['src', 'dst'] },
  template_apply:       { kind: 'schedule', args: ['event_id'] },
});

// Villager write tools with an id-shaped argument that doesn't name a stored
// memory or schedule item, and why.
export const NOT_TARGETED = Object.freeze({
  gcal_attribute_calendar: 'calendar_id names one of the synced calendars, which a full schedule grant covers',
});

const REFUSAL = {
  memory:   "Nothing changed: that memory isn't one I can change from this conversation. If it needs fixing, I can pass it to my human with relay_to_ward.",
  schedule: "Nothing changed: that item isn't one I can change from this conversation. If it needs changing, I can pass it to my human with relay_to_ward.",
};

/** Whether a memory, as memory_read_by_id returns it, is one this room could read. */
export function memoryReadableInRoom(mem, { audiences, topicGrants } = {}) {
  if (!mem || mem.ok === false || !mem.id) return false;
  if (!Array.isArray(audiences) || !audiences.includes(mem.audience || 'ward-private')) return false;
  return memoryVisibleToVillager(mem.content_tag || null, topicGrants && typeof topicGrants === 'object' ? topicGrants : {});
}

/** Whether a schedule item, as getScheduleNode returns it, is one a gated room may change. */
export function scheduleItemWritableInRoom(res) {
  const node = res && typeof res.node === 'object' ? res.node : res;
  if (!node || node.ok === false || !node.id) return false;
  return !isSensitiveNode(node);
}

/**
 * The refusal text when a by-id write on a gated turn names an item the room
 * couldn't read, else null (go ahead). `deps` carries the room's audiences and
 * topic grants plus the two readers, so this stays testable without the MCP
 * peers.
 */
export async function gatedWriteRefusal(name, args, { audiences, topicGrants, readMemoryById, getScheduleNode } = {}) {
  const rule = GATED_BY_ID_WRITES[name];
  if (!rule) return null;
  for (const key of rule.args) {
    const id = String(args?.[key] ?? '').trim();
    if (!id) continue;
    let ok = false;
    try {
      ok = rule.kind === 'memory'
        ? memoryReadableInRoom(await readMemoryById({ id }), { audiences, topicGrants })
        : scheduleItemWritableInRoom(await getScheduleNode({ id }));
    } catch { ok = false; }
    if (!ok) return REFUSAL[rule.kind];
  }
  return null;
}
