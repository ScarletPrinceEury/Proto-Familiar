/**
 * Tome tagging loop (0.14.91) — the driver for tome-tagging.js.
 *
 * Wires the real I/O (tome files, the locked tome write, the village registry,
 * the model call on the memorization connection) and paces itself: one batch
 * every 10 minutes until every note that could reach a shared room is sorted,
 * then it idles until new unsorted notes appear.
 *
 * DEFAULT OFF — my human turns it on with "Sort my tome notes for shared
 * rooms" in Settings. Defers during a live call. Hard off-switch:
 * PROTO_FAMILIAR_TOME_TAGGING_DISABLED=1. Never on the chat path.
 */
import path from 'path';
import { modifyTomeFile, enrich } from '../../thalamus.js';
import { getRegistry } from '../village/village.js';
import { isCallActiveFromFile } from '../voice/call-engine.js';
import { readSettingsSync, connectionForFeature } from '../../cerebellum.js';
import { connectionReady, resolveReasoningEffort } from '../../providers.js';
import { callProviderChat, familiarDeliberationMessages } from '../../llm-call.js';
import { substituteMacros } from '../../macros.js';
import { readTomeFiles } from './tome-store.js';
import { runOneTaggingTick, DEFAULT_BATCH_SIZE } from './tome-tagging.js';
import { createTickGuard } from '../util/tick-guard.js';
import { REPO_ROOT } from '../../repo-root.js';

const TOMES_DIR       = path.join(REPO_ROOT, 'tomes');
const DEFAULT_TICK_MS = 10 * 60_000;
const WATCHDOG_MS     = 20 * 60_000;   // one batched judgment + a few file writes

let _started  = false;
let _interval = null;
let _guard    = null;

function hardDisabled() {
  return process.env.PROTO_FAMILIAR_TOME_TAGGING_DISABLED === '1';
}

export function tomeTaggingEnabled(settings = readSettingsSync()) {
  return !hardDisabled() && settings?.tomeTaggingEnabled === true;   // opt-in
}

export async function runTomeTaggingTick() {
  const s = readSettingsSync();
  if (!tomeTaggingEnabled(s)) return { reason: 'disabled' };
  const conn = connectionForFeature(s, 'memorization');
  if (!connectionReady(conn)) return { reason: 'no_connection' };

  // My identity rides as a leading system message so I sort these as myself.
  const { static: identity } = await enrich('', { staticOnly: true }).catch(() => ({ static: '' }));

  const summary = await runOneTaggingTick({
    readTomes:      () => readTomeFiles(TOMES_DIR),
    modifyTomeFile,
    getRegistry:    () => getRegistry(),
    getSettings:    () => readSettingsSync(),
    buildMessages:  ({ prompt }) => familiarDeliberationMessages({
      identity,
      body: substituteMacros(prompt, readSettingsSync()),   // macro boundary #1
      cue: '(sorting my tome notes)',
    }),
    // RULE A: callProviderChat — generous cap + reasoning-content recovery.
    callLLM: (messages) => callProviderChat({
      provider: conn.provider, apiKey: conn.apiKey, model: conn.model, baseUrl: conn.baseUrl,
      messages, temperature: 0.2, maxTokens: 4000, reasoningEffort: resolveReasoningEffort(conn),
    }),
    batchSize: DEFAULT_BATCH_SIZE,
  });
  if (summary.reason === 'sorted' || summary.errors?.length || summary.reason === 'llm_failed') {
    console.log(`[tome-tagging] ${summary.reason}: looked at ${summary.looked ?? 0}, sorted ${summary.sorted ?? 0}, unsure ${summary.unsure ?? 0}, missed ${summary.missed ?? 0}`
      + (summary.error ? ` (${summary.error})` : '') + (summary.errors?.length ? `, ${summary.errors.length} write error(s)` : ''));
  }
  return summary;
}

export function startTomeTaggingLoop({ tickMs = DEFAULT_TICK_MS, watchdogMs = WATCHDOG_MS } = {}) {
  if (_started) return { stop: stopTomeTaggingLoop };
  if (hardDisabled()) {
    console.log('[tome-tagging] hard-disabled via PROTO_FAMILIAR_TOME_TAGGING_DISABLED=1');
    return { stop: () => {} };
  }
  _started = true;
  console.log('[tome-tagging] armed (opt-in; idles until "Sort my tome notes for shared rooms" is on in Settings)');
  _guard = createTickGuard({ name: 'tome-tagging', watchdogMs });
  _interval = setInterval(() => {
    _guard.run(async () => {
      if (await isCallActiveFromFile()) return;   // never during a live call
      await runTomeTaggingTick().catch(err => console.warn('[tome-tagging] tick error:', err?.message ?? err));
    });
  }, tickMs);
  _interval.unref?.();
  return { stop: stopTomeTaggingLoop };
}

export async function stopTomeTaggingLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_guard) await _guard.settle();
  _started = false;
}
