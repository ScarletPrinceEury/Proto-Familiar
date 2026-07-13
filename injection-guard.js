/**
 * injection-guard.js — prompt injection immunization
 *
 * Scans and sanitizes externally-sourced text before it is interpolated
 * into LLM prompts. Wired (0.8.57) at the genuinely-external inbound
 * boundaries: web text (websearch.js — search snippets, look_up text,
 * read_webpage extraction) and non-ward Discord text (discord-gateway.js
 * inboundContent()). Deliberately NOT applied to first-party stores
 * (Phylactery memories, Unruh schedule labels — provenance labels carry
 * that load), to the ward's own words on any path (threat scoring must
 * read them exactly as said), or to any outbound delivery (replies,
 * relays, trusted-contact messages) — inbound third-party text only.
 *
 * Two functions are exported:
 *   scanForInjection(text) — detect without mutating (use for logging/metrics)
 *   sanitizeExternal(text, opts?) — detect + replace in-place (use before prompt injection)
 *
 * Pattern philosophy: conservative false-positive budget. These phrases
 * should never appear in legitimate schedule labels, memories, or contact
 * names. Broad "you are"/"ignore" matches are intentionally excluded; only
 * combinations that are near-unambiguously adversarial are included.
 */

const INJECTION_PATTERNS = [
  // Classic instruction-override phrases
  { re: /\bignore\b.{0,30}\b(all |previous |prior |above )(system |)?instructions?\b/i, label: 'instruction-override' },
  { re: /\bdisregard\b.{0,30}\b(all |previous |prior |above )(system |)?instructions?\b/i, label: 'instruction-override' },
  { re: /\bforget\b.{0,30}\b(all |previous |prior |above )(system |)?instructions?\b/i, label: 'instruction-override' },
  // Explicit injection preambles
  { re: /\bnew instructions?\s*:/i, label: 'instruction-inject' },
  { re: /\bbegin new (system|instructions?|prompt)\b/i, label: 'instruction-inject' },
  // Safety / identity override attempts
  { re: /\boverride\b.{0,20}\b(safety|system prompt|your identity|your training|your values)\b/i, label: 'safety-override' },
  // Role redefinition with strong jailbreak keywords only
  { re: /\byou are now\s+(?:a[n]?\s+)?(different|unrestricted|uncensored|jailbreak|evil|liberated|free from)/i, label: 'role-redefine' },
  { re: /\bact as\s+(?:a[n]?\s+)?(unrestricted|uncensored|evil|jailbreak)\b/i, label: 'role-redefine' },
  // Fake structural role-declaration markers — standalone bracket tokens
  // caught anywhere in the string; `SYSTEM:` header only at line start
  // to avoid flagging technical prose like "SYSTEM: init complete"
  // Escape-tolerant: markdown pipelines (turndown at the web-read boundary)
  // emit `\[SYSTEM\]` for literal brackets — still reads as a role marker
  // to a model, so the escaped form is caught too.
  { re: /\\?\[(SYSTEM|INST|\/INST|OVERRIDE)\\?\]/i, label: 'fake-role-marker' },
  { re: /^\s*SYSTEM\s*:/m, label: 'fake-role-header' },
  // Chat-template special tokens (LLaMA / ChatML style)
  { re: /<\|im_start\|>|<\|im_end\|>/i, label: 'chat-template-token' },
  // Named jailbreak variants
  { re: /\bDAN\s*(?:mode|prompt|jailbreak)\b/i, label: 'named-jailbreak' },
];

/**
 * Scan text for injection patterns without modifying it.
 * @param {string} text
 * @returns {{ detected: boolean, patterns: string[] }}
 */
export function scanForInjection(text) {
  if (typeof text !== 'string' || !text) return { detected: false, patterns: [] };
  const found = [];
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  return { detected: found.length > 0, patterns: found };
}

/**
 * Replace injection patterns in externally-sourced text with a safe placeholder.
 * Returns the sanitized string. Logs a warning when patterns are found.
 *
 * @param {string|any} text   — the value to sanitize (non-strings are coerced)
 * @param {{ source?: string, context?: string }} opts
 *   source  — human-readable label for the data source (used in warning log)
 *   context — caller label prepended to the warning (e.g. 'thalamus/memory')
 * @returns {string}
 */
export function sanitizeExternal(text, { source = 'external', context = '' } = {}) {
  if (typeof text !== 'string') return String(text ?? '');
  let result = text;
  let detected = false;
  for (const { re, label } of INJECTION_PATTERNS) {
    const reG = new RegExp(re.source, re.flags + 'g');
    const next = result.replace(reG, `[removed:${label}]`);
    if (next !== result) {
      detected = true;
      result = next;
    }
  }
  if (detected) {
    const tag = context ? `[${context}] ` : '';
    console.warn(`[injection-guard] ${tag}injection pattern neutralized in ${source} content`);
  }
  return result;
}
