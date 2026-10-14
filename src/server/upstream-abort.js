/**
 * upstream-abort.js — stop a provider request when nobody is waiting for it.
 *
 * Two bounds on every upstream request an HTTP route makes for my human:
 *
 *   1. Client disconnect. When the tab closes, the voice turn gives up, or an
 *      external OpenAI-compatible client hangs up, the provider request is
 *      aborted instead of running on (spending tokens, holding a socket).
 *      NOTE the trap this module exists for: since Node 16 a request's 'close'
 *      event fires when its BODY has been read, not when the client leaves. By
 *      the time a route's handler runs, express.json() has read the body, so a
 *      `req.on('close')` listener attached there never fires — /api/chat had
 *      exactly that, and its "abort when the tab closes" never aborted
 *      anything. The response's 'close' (with `writableFinished` false) is the
 *      real disconnect signal.
 *   2. A wall-clock deadline on NON-streaming requests (providerCallTimeoutMs,
 *      300s by default): a provider that sends headers and then trickles
 *      keep-alive bytes never trips undici's idle timeouts. A stream gets no
 *      deadline — a long answer streaming in is legitimate, and someone is
 *      watching it who can stop it.
 */

import { deadlineSignal, isTimeoutError, providerCallTimeoutMs } from '../../llm-call.js';

/**
 * An AbortSignal that fires when the client behind `res` goes away before the
 * response finished. Attach at the top of the handler, before any await.
 */
export function clientDisconnectSignal(res) {
  const ac = new AbortController();
  const gone = () => ac.abort(new DOMException('client disconnected', 'AbortError'));
  if (res.destroyed) gone();               // already gone before we started listening
  else res.once('close', () => { if (!res.writableFinished) gone(); });
  return ac.signal;
}

/** The signal one upstream fetch carries: the client's, plus a deadline unless it streams. */
export function upstreamSignal(clientSignal, { stream = false } = {}) {
  return deadlineSignal({ signal: clientSignal, timeoutMs: stream ? 0 : providerCallTimeoutMs() });
}

/**
 * Classify a failed upstream fetch or body read: { status, message }.
 *   499 — the client left (nothing to send; just stop).
 *   504 — the deadline fired: no complete answer in time.
 *   502 — anything else on the network.
 */
export function upstreamFailure(err, { clientSignal = null, provider = 'the provider' } = {}) {
  if (clientSignal?.aborted) return { status: 499, message: 'client disconnected' };
  if (isTimeoutError(err)) {
    const secs = Math.round(providerCallTimeoutMs() / 1000);
    return { status: 504, message: `No complete answer from ${provider} within ${secs}s, so the request was stopped. Try again, or pick a faster model.` };
  }
  return { status: 502, message: `Network error reaching ${provider}: ${err?.message ?? err}` };
}
