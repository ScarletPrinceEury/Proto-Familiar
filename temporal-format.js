/**
 * Pure renderer for Unruh's temporal_context payload.
 *
 * Kept in its own file (rather than inline in thalamus.js) so it can be
 * imported by tests without triggering thalamus.js's startup-time MCP
 * child-process spawns.
 *
 * Returns '' when there's nothing meaningful to surface (Unruh down,
 * payload missing, or every sub-block empty) so the assembler in
 * thalamus.js can omit the [Temporal Context] header entirely.
 *
 * Sub-block order — handoff, schedule, interests — mirrors the design
 * doc's daily-briefing order from docs/unruh-design.md.
 *
 * Payload shape (kept stable; Unruh's server.py mirrors this):
 *   {
 *     ts: '2026-01-15T10:00:00Z',
 *     schedule:  { window: [...], phase: {...} | null },
 *     interests: { standing: [...], live: [...] },
 *     handoff:   { intent: '...' | null, open_threads: [...] }
 *   }
 */
export function formatTemporalContext(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const blocks = [];

  const handoff = payload.handoff ?? {};
  if (handoff.intent || (handoff.open_threads ?? []).length) {
    const handoffLines = ['Last session:'];
    if (handoff.intent) handoffLines.push(`  intent — ${handoff.intent}`);
    for (const thread of handoff.open_threads ?? []) {
      handoffLines.push(`  open — ${typeof thread === 'string' ? thread : thread.label ?? thread.id}`);
    }
    blocks.push(handoffLines.join('\n'));
  }

  const schedule = payload.schedule ?? {};
  const phase = schedule.phase;
  const window = schedule.window ?? [];
  if (phase || window.length) {
    const schedLines = [];
    if (phase) schedLines.push(`Current phase: ${phase.label ?? phase.id ?? phase}`);
    for (const item of window) {
      const when = item.when ?? item.fires_at ?? '';
      const label = item.label ?? item.id ?? '';
      schedLines.push(`  ${when ? `${when} — ` : ''}${label}`);
    }
    if (schedLines.length) blocks.push(schedLines.join('\n'));
  }

  const interests = payload.interests ?? {};
  const standing = interests.standing ?? [];
  const live = interests.live ?? [];
  if (standing.length || live.length) {
    const interestLines = [];
    if (standing.length) {
      interestLines.push('Standing values:');
      for (const v of standing) interestLines.push(`  ${v.label ?? v}`);
    }
    if (live.length) {
      interestLines.push('Live interests (by weight):');
      for (const i of live) {
        const w = typeof i.weight === 'number' ? ` [${i.weight.toFixed(2)}]` : '';
        interestLines.push(`  ${i.label ?? i.id}${w}`);
      }
    }
    blocks.push(interestLines.join('\n'));
  }

  return blocks.join('\n\n');
}
