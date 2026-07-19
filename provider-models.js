/**
 * Live model listing per provider — the backend for the Connections
 * modal's visible model browser (docs/ui-ux-guidelines.md: options the
 * user can pick must be *visible*, never only type-to-discover).
 *
 * Every supported provider exposes an OpenAI-compatible `GET /models`
 * beside its `/chat/completions` (the URL is derived from
 * providers.js — no second URL table to drift). The response shape is
 * normalised to a plain sorted list of model-id strings; anything the
 * provider adds beyond `id` is ignored on purpose.
 *
 * Failures (bad key, provider down, unexpected shape) return
 * `{ ok:false, error }` rather than throwing — the UI falls back to the
 * curated suggestion list it already ships.
 */
import { PROVIDER_URLS } from './providers.js';

const LIST_TIMEOUT_MS = 15_000;

/** chat/completions URL → sibling /models URL for the same surface. */
export function modelsUrlFor(provider) {
  const chat = PROVIDER_URLS[provider];
  if (!chat) return null;
  return chat.replace(/\/chat\/completions$/, '/models');
}

/**
 * Fetch the provider's model list. Returns
 * `{ ok:true, models:[{id}] }` or `{ ok:false, error }`.
 */
export async function listProviderModels({ provider, apiKey, httpFetch = globalThis.fetch } = {}) {
  const url = modelsUrlFor(provider);
  if (!url) return { ok: false, error: `unknown provider: ${provider}` };
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { ok: false, error: 'API key is required to list models.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
  try {
    const r = await httpFetch(url, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      return { ok: false, error: `provider replied ${r.status}${r.status === 401 || r.status === 403 ? ' — check the API key' : ''}` };
    }
    const body = await r.json().catch(() => null);
    // OpenAI-compatible shape: { data: [{ id, ... }] }. Some providers
    // return { models: [...] } or a bare array — accept all three.
    const raw = Array.isArray(body?.data) ? body.data
    	: Array.isArray(body?.models) ? body.models
    	: Array.isArray(body) ? body
    	: null;
    if (!raw) return { ok: false, error: 'unexpected response shape from provider' };
    const ids = [...new Set(
      raw.map(m => typeof m === 'string' ? m : m?.id ?? m?.name).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
    return { ok: true, models: ids.map(id => ({ id })) };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'provider timed out' : (err?.message ?? String(err)) };
  } finally {
    clearTimeout(timer);
  }
}
