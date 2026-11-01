/**
 * connection-chain.js — my connection, then my human's fallbacks, for a call
 * made on the server (known-issues D1).
 *
 * The web chat has always walked `fallbackConnectionIds` in the browser. The
 * background loops had nothing: when the model they run on was down or out of
 * allowance, the turn just failed. This is the server-side version of the same
 * list, used by noticing first (ward-signed 0.14.121).
 *
 * A call moves to the next connection only on a failure another connection
 * could get past: a usage limit, a server error (5xx, 429), a deadline, or a
 * network failure. A bad request (400) or a refused key (401/403) is about this
 * request, so it stops there, as the ward signed. It never moves on once the
 * caller's own signal is aborted (the turn's time is up).
 *
 * It is sticky: once a fallback answers, later rounds of the same turn start
 * there, so a turn doesn't keep knocking on a connection that just failed, and
 * rounds that already ran tools are never re-run (unlike re-running a whole turn
 * on the next connection, which the web chat does only before any tool ran).
 * Switching mid-turn means the fallback reads the first model's tool rounds;
 * NanoGPT and z.ai both take that history (probed for 0.14.119). A provider that
 * refuses it answers 400, which ends the call like any bad request.
 */

import { connectionReady } from '../../providers.js';
import { isTimeoutError, isUsageLimitError, providerErrorStatus } from '../../llm-call.js';

/**
 * `first`, then my human's fallbacks in their order: saved, ready, not `first`,
 * each once. [] when `first` isn't ready.
 */
export function connectionChain(settings, first) {
  if (!first || !connectionReady(first)) return [];
  const conns = Array.isArray(settings?.connections) ? settings.connections : [];
  const ids = Array.isArray(settings?.fallbackConnectionIds) ? settings.fallbackConnectionIds : [];
  const chain = [first];
  const seen = new Set([first.id]);
  for (const id of ids) {
    if (seen.has(id)) continue;
    const c = conns.find(x => x?.id === id);
    if (c && connectionReady(c)) { chain.push(c); seen.add(id); }
  }
  return chain;
}

const NETWORK_RE = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i;

/** Could another connection get past this failure? */
export function fallbackWorthy(err) {
  if (isTimeoutError(err) || isUsageLimitError(err)) return true;
  const status = providerErrorStatus(err);
  if (status != null) return status === 429 || status >= 500;
  return NETWORK_RE.test(String(err?.message ?? err ?? ''));
}

/** What a call log line says about a connection: never its key. */
export function connectionLabel(conn) {
  return { connection: conn?.name || conn?.model || conn?.id || '?', provider: conn?.provider ?? null, model: conn?.model ?? null };
}

/**
 * A caller that tries `call(conn, args)` down the chain. Each try is reported
 * to `onCall({ ...connectionLabel, ms, ok, error?, usageLimit? })`. On failure
 * it throws the last error, marked `usageLimited` when EVERY connection in the
 * chain has said its allowance is used up during this caller's life (so trying
 * again soon can't work; one that only timed out still might).
 */
export function chainCaller({ chain, call, signal = null, onCall = null, now = Date.now }) {
  if (!Array.isArray(chain) || !chain.length) throw new Error('no connection to call');
  let start = 0;
  const limited = chain.map(() => false);
  const report = (entry) => { try { onCall?.(entry); } catch { /* a log line never breaks the call */ } };
  return async (args) => {
    let lastErr = null;
    for (let i = start; i < chain.length; i++) {
      const conn = chain[i];
      const t0 = now();
      try {
        const data = await call(conn, args);
        report({ ...connectionLabel(conn), ms: now() - t0, ok: true });
        limited[i] = false;
        start = i;
        return data;
      } catch (err) {
        const usageLimit = isUsageLimitError(err);
        report({ ...connectionLabel(conn), ms: now() - t0, ok: false, error: String(err?.message ?? err).slice(0, 200), ...(usageLimit ? { usageLimit } : {}) });
        lastErr = err;
        limited[i] = usageLimit;
        if (signal?.aborted || !fallbackWorthy(err)) break;
      }
    }
    if (lastErr && typeof lastErr === 'object') {
      try { lastErr.usageLimited = limited.every(Boolean); } catch { /* frozen error: no mark */ }
    }
    throw lastErr;
  };
}
