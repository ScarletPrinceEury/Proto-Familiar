/**
 * Canonical OpenAI-compatible chat-completions URLs per provider tag.
 *
 * Used in two places:
 *   - server.js fetches these directly from POST /api/chat (proxy).
 *   - thalamus.js passes the matching URL to Phylactery as
 *     PHYLACTERY_LLM_BASE_URL (and ZAI_BASE_URL for z.ai providers).
 *     Phylactery's consolidate.py also accepts the legacy
 *     ENTITY_CORE_LLM_BASE_URL alias. The value must be the full
 *     endpoint including /chat/completions — consolidate.py posts
 *     directly to it with no path appending.
 *
 * When adding a provider: add the full URL here, update the matching
 * provider-tag string in public/app.js's connection editor, and add a
 * server.js validation entry if necessary. Don't fork these per file.
 */
export const PROVIDER_URLS = {
  nanogpt:      'https://nano-gpt.com/api/v1/chat/completions',
  zai:          'https://api.z.ai/api/paas/v4/chat/completions',
  'zai-coding': 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  // Google AI Studio (Gemini) via its OpenAI-compatible surface — same
  // Bearer-auth chat/completions shape every other consumer here expects,
  // so streaming, tools, and Phylactery consolidation all work unchanged.
  google:       'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

// ── Reasoning effort (always-on-thinking models, GLM-5.3+) ──────────────────
//
// GLM-5.3 made thinking MANDATORY: it no longer accepts thinking:off, and
// `reasoning_effort` defaults to `max`. So a normally-shaped request spends its
// whole token budget on chain-of-thought and comes back with EMPTY content —
// which our reasoning_content fallback then surfaces as a raw "thinking dump",
// and whose empty/oddly-shaped turns dropped the user's own message. Sending an
// explicit, modest effort keeps chat turns answer-first.
//
// A connection may carry `reasoningEffort`: 'low' | 'high' | 'max' | 'off'.
//   - low/high/max → sent verbatim (honored for ANY provider — the ward's call).
//   - off/none     → never sent (explicit opt-out).
//   - unset        → auto-'low', but ONLY for providers we KNOW accept the
//                    param (the z.ai GLM family). Other providers (Google's
//                    OpenAI-compat, arbitrary NanoGPT models) receive it only
//                    when set explicitly, so an unset default can never
//                    introduce an unknown-param 400.
export const REASONING_EFFORT_VALUES = new Set(['low', 'high', 'max']);
const ALWAYS_THINKING_PROVIDERS = new Set(['zai', 'zai-coding']);

/** The reasoning_effort to send for a connection, or null to send none. */
export function resolveReasoningEffort(conn = {}) {
  const raw = String(conn?.reasoningEffort ?? '').trim().toLowerCase();
  if (REASONING_EFFORT_VALUES.has(raw)) return raw;
  if (raw === 'off' || raw === 'none') return null;
  return ALWAYS_THINKING_PROVIDERS.has(conn?.provider) ? 'low' : null;
}
