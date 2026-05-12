/**
 * thalamus.js — entity-core bridge for Proto-Familiar
 *
 * Spawns entity-core-alpha as a child process on startup and keeps it
 * running.  Exports enrich(), which assembles three sections of context
 * (memories, character values, voice) to prepend to the LLM system prompt.
 *
 * If entity-core is unreachable for any reason, enrich() logs the error
 * and returns '' so the calling request can continue without enrichment.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow overriding the entry-point path via environment variable.
const ENTITY_CORE_ENTRY = process.env.ENTITY_CORE_PATH
  ?? path.resolve(__dirname, '../entity-core-alpha/src/mod.ts');

/** @type {import('@modelcontextprotocol/sdk/client/index.js').Client | null} */
let mcpClient = null;

async function connect() {
  const transport = new StdioClientTransport({
    command: 'deno',
    args: ['run', '-A', '--unstable-cron', ENTITY_CORE_ENTRY],
  });

  const client = new Client(
    { name: 'proto-familiar', version: '1.0.0' },
    { capabilities: {} },
  );

  // Clear the reference when the process exits so enrich() degrades gracefully.
  client.onclose = () => {
    console.error('[thalamus] entity-core connection closed');
    mcpClient = null;
  };

  await client.connect(transport);
  mcpClient = client;
  console.log('[thalamus] Connected to entity-core at', ENTITY_CORE_ENTRY);
}

// Fire-and-forget — a failure here must not crash the server.
connect().catch(err => {
  console.error('[thalamus] Failed to start entity-core:', err.message);
});

// ---------------------------------------------------------------------------
// Helper — safely pull the text payload from an MCP tool result
// ---------------------------------------------------------------------------
function parseToolText(result, fallback) {
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// enrich
// ---------------------------------------------------------------------------

/**
 * Query entity-core for context relevant to the current user message and
 * return it as a formatted string with three clearly labelled sections:
 *
 *   [Relevant Context]  — memories matching the user's message
 *   [Character Values]  — core identity files (my_identity, my_personhood, my_wants)
 *   [Voice]             — persona and behaviour files (my_persona, my_mechanics)
 *
 * Returns '' if entity-core is unreachable or any error occurs.
 *
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
export async function enrich(userMessage) {
  if (!mcpClient) return '';

  try {
    const [memResult, idResult] = await Promise.all([
      mcpClient.callTool({
        name: 'memory/search',
        arguments: {
          query: userMessage,
          instanceId: 'proto-familiar',
          maxResults: 5,
        },
      }),
      mcpClient.callTool({
        name: 'identity/get_all',
        arguments: {},
      }),
    ]);

    // ── [Relevant Context] from memory search ─────────────────────────────
    const memData = parseToolText(memResult, {});
    const memLines = (memData.results ?? [])
      .map(r => `- ${(r.excerpt ?? r.content ?? '').trim()}`)
      .filter(s => s.length > 2)
      .join('\n');

    // ── Identity files ─────────────────────────────────────────────────────
    // identity/get_all returns an array of { category, filename, content, promptLabel }
    const idRaw = parseToolText(idResult, []);
    const files = Array.isArray(idRaw) ? idRaw : (idRaw.files ?? []);
    const selfFiles = files.filter(f => f.category === 'self');

    const VALUE_FILES = new Set(['my_identity', 'my_personhood', 'my_wants']);
    const VOICE_FILES  = new Set(['my_persona', 'my_mechanics']);

    const valuesText = selfFiles
      .filter(f => VALUE_FILES.has(f.filename))
      .map(f => (f.content ?? '').trim())
      .filter(Boolean)
      .join('\n\n');

    const voiceText = selfFiles
      .filter(f => VOICE_FILES.has(f.filename))
      .map(f => (f.content ?? '').trim())
      .filter(Boolean)
      .join('\n\n');

    // ── Assemble ───────────────────────────────────────────────────────────
    const sections = [];
    if (memLines)   sections.push(`[Relevant Context]\n${memLines}`);
    if (valuesText) sections.push(`[Character Values]\n${valuesText}`);
    if (voiceText)  sections.push(`[Voice]\n${voiceText}`);

    return sections.join('\n\n');
  } catch (err) {
    console.error('[thalamus] enrich failed:', err.message);
    return '';
  }
}
