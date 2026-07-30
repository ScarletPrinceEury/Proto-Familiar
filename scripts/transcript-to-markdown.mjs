#!/usr/bin/env node
/**
 * Turn a session log into a readable development transcript.
 *
 * The raw `.jsonl` is one JSON object per event — every tool call, every file
 * diff, every intermediate result — which is the wrong shape for reading and
 * the wrong shape for ingesting. This flattens it to markdown: what was said,
 * what was done, and what came back, with the machine noise dropped.
 *
 * ── What is kept and what is not ────────────────────────────────────────
 * Kept: my human's messages verbatim, my replies verbatim, and a one-line
 * record of each tool call with its result trimmed.
 *
 * Dropped: base64 payloads, the full text of files written (they are in git),
 * and system reminders. A transcript that reproduces every file it wrote is
 * larger than the repository and less useful than `git log`.
 *
 * The point is the REASONING — why a thing was tried, what it turned out to
 * be, what was wrong about the previous guess. That is the part no other
 * artifact in the project captures.
 *
 *   node scripts/transcript-to-markdown.mjs <session.jsonl> [--out=FILE]
 *   node scripts/transcript-to-markdown.mjs <session.jsonl> --full
 */

import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (flag) => process.argv.includes(flag);

/** How much of a tool result is worth keeping inline. */
const RESULT_CHARS = has('--full') ? 4000 : 700;
/** Tool inputs are usually the interesting half; commands especially. */
const INPUT_CHARS = has('--full') ? 3000 : 500;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\r/g, '');
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t;
};

/** System reminders and injected context are scaffolding, not conversation. */
function stripReminders(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[\s\S]*?<\/local-command-[a-z]*>/g, '')
    .trim();
}

/** A short, honest label for what a tool call was doing. */
function describeTool(name, input = {}) {
  if (name === 'mcp__workspace__bash') return input.command ?? '';
  if (name === 'Read') return input.file_path ?? '';
  if (name === 'Write') return input.file_path ?? '';
  if (name === 'Edit') return input.file_path ?? '';
  if (name === 'Grep') return `${input.pattern ?? ''}${input.path ? `  in ${input.path}` : ''}`;
  if (name === 'Glob') return input.pattern ?? '';
  if (name === 'WebSearch') return input.query ?? '';
  if (name?.includes('web_fetch')) return input.url ?? '';
  const json = JSON.stringify(input);
  return json === '{}' ? '' : json;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('Usage: node scripts/transcript-to-markdown.mjs <session.jsonl> [--out=FILE] [--full]');
    return 1;
  }
  // Refuse an extra positional rather than ignoring it. The destination is
  // `--out=FILE`; passing a path as argv[3] silently wrote to the default
  // instead, which looks exactly like success while going somewhere else.
  const strays = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  if (strays.length) {
    console.error(`Unexpected argument: ${strays[0]}\nThe destination is --out=FILE, e.g. --out=docs/my-transcript.md`);
    return 1;
  }

  const out = [];
  let turns = 0;
  let toolCalls = 0;
  let firstAt = null;
  let lastAt = null;
  const toolResults = new Map();   // tool_use_id -> trimmed result

  // Two passes over the file, never the whole thing in memory: once to collect
  // results so each call can be printed with its outcome, once to render.
  for (const pass of [1, 2]) {
    const rl = createInterface({ input: createReadStream(source, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }

      const msg = ev.message ?? ev;
      const role = msg.role ?? ev.type;
      const content = msg.content;
      if (ev.timestamp) {
        firstAt ??= ev.timestamp;
        lastAt = ev.timestamp;
      }

      if (pass === 1) {
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === 'tool_result') {
            const body = typeof block.content === 'string' ? block.content : textOf(block.content);
            toolResults.set(block.tool_use_id, clip(body, RESULT_CHARS));
          }
        }
        continue;
      }

      // ── pass 2: render ──
      if (role === 'user') {
        // A user event carrying only tool_results is machinery, not speech.
        const spoken = stripReminders(textOf(content) || (typeof content === 'string' ? content : ''));
        if (!spoken) continue;
        turns++;
        out.push(`\n---\n\n## Broeckchen\n\n${spoken}\n`);
      } else if (role === 'assistant' && Array.isArray(content)) {
        const said = textOf(content).trim();
        const calls = content.filter((b) => b?.type === 'tool_use');
        if (said) out.push(`\n### Claude\n\n${said}\n`);
        for (const call of calls) {
          toolCalls++;
          const what = describeTool(call.name, call.input);
          const result = toolResults.get(call.id);
          out.push(`\n<details><summary>🔧 <code>${call.name}</code>${what ? ` — ${clip(what.split('\n')[0], 90)}` : ''}</summary>\n`);
          if (what) out.push(`\n\`\`\`\n${clip(what, INPUT_CHARS)}\n\`\`\`\n`);
          if (result) out.push(`\n**Result:**\n\n\`\`\`\n${result}\n\`\`\`\n`);
          out.push(`\n</details>\n`);
        }
      }
    }
  }

  const header = [
    '# Proto-Familiar — voice development transcript',
    '',
    'Raw session log, flattened to markdown for reading and for ingestion.',
    '',
    `- **Session:** \`${path.basename(source, '.jsonl')}\``,
    firstAt ? `- **From:** ${firstAt}` : null,
    lastAt ? `- **To:** ${lastAt}` : null,
    `- **Exchanges:** ${turns}`,
    `- **Tool calls:** ${toolCalls}`,
    has('--full') ? '- **Detail:** full' : '- **Detail:** trimmed (re-run with `--full` for longer tool output)',
    '',
    '> Tool calls are collapsed. The value here is the reasoning — what was',
    '> tried, what it turned out to be, and what the previous guess got wrong.',
    '',
  ].filter(Boolean).join('\n');

  const dest = arg('out', path.join(process.cwd(), 'docs', 'voice-development-transcript.md'));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, `${header}${out.join('')}\n`, 'utf8');

  const { size } = await fs.stat(dest);
  console.log(`${turns} exchanges, ${toolCalls} tool calls → ${path.relative(process.cwd(), dest)} (${(size / 1024).toFixed(0)} KB)`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`Transcript conversion failed: ${String(err?.message ?? err)}`);
    process.exitCode = 1;
  });
