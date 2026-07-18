/**
 * z.ai Vision MCP client (vision build spec — coding-plan vision allotment).
 *
 * On the GLM Coding Plan, vision is NOT available through the chat-completions
 * endpoint — it's delivered only through z.ai's "Vision Understanding" MCP
 * server (`@z_ai/mcp-server`, powered by GLM-4.6V) with its OWN quota pool,
 * separate from the coding-prompt allotment. So to spend that allotment we
 * spawn that MCP server as a stdio child (the same SDK Phylactery/Unruh use)
 * and call its `analyze_image` tool for describeAsset.
 *
 * This is DESCRIBE-only: the coding chat models (GLM-4.6/5.2) can't take live
 * image parts, so a z.ai-coding vision setup always describes-then-stands-in
 * (the Pass 2 path). The client is:
 *   - lazily spawned, keyed by API key (a new key tears down + respawns);
 *   - gated (only used when a z.ai-coding connection is assigned to vision);
 *   - graceful — any spawn/call failure returns {ok:false}, so describeAsset
 *     leaves the description null (retried later) and nothing breaks.
 *
 * Off-switch: PROTO_FAMILIAR_ZAI_VISION_DISABLED=1.
 */

import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { shortSlug } from './slug-ids.js';
import { IMAGE_MIME_EXT } from './media.js';

// The command that starts the server. Overridable for odd installs / testing.
// Default: `npx -y @z_ai/mcp-server` (bin `zai-mcp-server`, build/index.js).
function zaiMcpSpawn() {
  const override = (process.env.PROTO_FAMILIAR_ZAI_MCP_COMMAND ?? '').trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { command: npx, args: ['-y', '@z_ai/mcp-server'] };
}

export function zaiVisionDisabled() {
  return process.env.PROTO_FAMILIAR_ZAI_VISION_DISABLED === '1';
}

// ── Pure adaptation helpers (exported for tests) ──────────────────

// z.ai's vision tools are task-specific; `analyze_image` is the general one.
// Fall back to any tool whose name reads as general image analysis.
export function pickAnalyzeTool(tools = []) {
  const names = tools.map(t => t?.name).filter(Boolean);
  if (names.includes('analyze_image')) return 'analyze_image';
  const general = names.find(n => /analyze.*image|image.*analyz|describe.*image/i.test(n));
  return general || names.find(n => /image/i.test(n)) || null;
}

// Build the tool arguments from its inputSchema, adapting to whatever the
// server names its params: an image field (path | url | base64) + a prompt
// field. `img` carries the possible representations; we pass the one the
// schema asks for. Pure — returns { args, needs } where needs.file signals the
// caller must materialize a temp file first.
export function buildAnalyzeArgs(inputSchema, { filePath, dataUrl, base64, prompt } = {}) {
  const props = (inputSchema && typeof inputSchema === 'object' && inputSchema.properties) || {};
  const keys = Object.keys(props);
  const find = (re) => keys.find(k => re.test(k));
  const args = {};
  let needsFile = false;

  // Image param — prefer an explicit path field (the Claude-Code-native shape),
  // then a url/image field (data URL), then a base64 field.
  const pathKey = find(/(^|_)(path|file|filepath|image_path)$/i) || find(/path|file/i);
  const urlKey  = find(/url$/i) || find(/^image$/i) || find(/image_?url/i);
  const b64Key  = find(/base64|b64|data$/i);
  if (pathKey && filePath !== undefined)      { args[pathKey] = filePath; needsFile = true; }
  else if (urlKey && dataUrl !== undefined)   { args[urlKey]  = dataUrl; }
  else if (b64Key && base64 !== undefined)    { args[b64Key]  = base64; }
  else if (urlKey && dataUrl !== undefined)   { args[urlKey]  = dataUrl; }
  else if (pathKey && filePath !== undefined) { args[pathKey] = filePath; needsFile = true; }

  // Prompt / instruction param, when the tool accepts one.
  const promptKey = find(/prompt|query|question|instruction|task|describe/i);
  if (promptKey && prompt) args[promptKey] = prompt;

  return { args, needsFile, imageKey: pathKey || urlKey || b64Key || null };
}

// Pull the assistant text out of an MCP tool result ({content:[{type:'text',text}]}).
export function textFromToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n').trim();
  return text;
}

// ── Client lifecycle (lazy, keyed by API key) ─────────────────────

let _client = null;
let _clientKey = null;
let _toolName = null;     // cached analyze tool name
let _toolSchema = null;   // cached inputSchema
let _connecting = null;

async function teardown() {
  const c = _client;
  _client = null; _clientKey = null; _toolName = null; _toolSchema = null;
  if (c) { try { await c.close(); } catch { /* ignore */ } }
}

async function ensureClient(apiKey) {
  const key = String(apiKey ?? '').trim();
  if (!key) return null;
  if (_client && _clientKey === key) return _client;
  if (_client && _clientKey !== key) await teardown();   // key changed → respawn
  if (_connecting) { try { await _connecting; } catch { /* fall through */ } if (_client && _clientKey === key) return _client; }

  _connecting = (async () => {
    const { command, args } = zaiMcpSpawn();
    const transport = new StdioClientTransport({
      command, args,
      env: { ...process.env, Z_AI_API_KEY: key, Z_AI_MODE: 'ZAI' },
    });
    const client = new Client({ name: 'proto-familiar', version: '0' }, { capabilities: {} });
    client.onclose = () => { if (_client === client) { _client = null; _clientKey = null; _toolName = null; _toolSchema = null; } };
    await client.connect(transport);
    // Discover the analyze tool + its schema once per client.
    const listed = await client.listTools().catch(() => ({ tools: [] }));
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    _toolName = pickAnalyzeTool(tools);
    _toolSchema = tools.find(t => t?.name === _toolName)?.inputSchema ?? null;
    _client = client;
    _clientKey = key;
    console.log(`[zai-vision] connected to @z_ai/mcp-server (tool: ${_toolName ?? 'none found'})`);
    return client;
  })();
  try { return await _connecting; }
  catch (err) { console.error('[zai-vision] spawn/connect failed:', err?.message ?? err); await teardown(); return null; }
  finally { _connecting = null; }
}

/**
 * Describe an image through the z.ai coding-plan vision MCP. Returns
 * { ok:true, text } or { ok:false, reason }. Never throws.
 *
 * @param {object} p
 * @param {string} p.apiKey   the z.ai coding-plan API key
 * @param {Buffer} p.buffer   the image bytes
 * @param {string} p.mime     the image mime
 * @param {string} p.prompt   the describe instruction (first person, from vision.js)
 */
export async function describeViaZaiVision({ apiKey, buffer, mime, prompt } = {}) {
  if (zaiVisionDisabled()) return { ok: false, reason: 'zai-vision-disabled' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: 'no-bytes' };
  const client = await ensureClient(apiKey);
  if (!client) return { ok: false, reason: 'zai-mcp-unavailable' };
  if (!_toolName) return { ok: false, reason: 'no-analyze-tool' };

  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${base64}`;
  const { args, needsFile } = buildAnalyzeArgs(_toolSchema, { filePath: '__PENDING__', dataUrl, base64, prompt });

  // If the tool wants a file path, materialize a temp file (absolute path) and
  // clean it up after — the server (Claude-Code-native) reads images off disk.
  let tmpPath = null;
  try {
    if (needsFile) {
      const ext = IMAGE_MIME_EXT?.[mime] || 'jpg';
      tmpPath = path.join(os.tmpdir(), `pf-zai-${shortSlug(8)}.${ext}`);
      await fsp.writeFile(tmpPath, buffer);
      for (const k of Object.keys(args)) if (args[k] === '__PENDING__') args[k] = tmpPath;
    }
    const result = await client.callTool({ name: _toolName, arguments: args });
    const text = textFromToolResult(result);
    if (!text) return { ok: false, reason: 'empty-result' };
    return { ok: true, text, by: { provider: 'zai-coding', model: 'glm-4.6v(vision-mcp)' } };
  } catch (err) {
    return { ok: false, reason: `zai-vision-call-failed: ${err?.message ?? err}` };
  } finally {
    if (tmpPath) fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// Clean shutdown (server teardown).
export async function shutdownZaiVision() { await teardown(); }
