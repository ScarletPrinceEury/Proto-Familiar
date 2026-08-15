/**
 * phylactery-result.js — read a Phylactery MCP tool result as success or failure.
 *
 * Phylactery's tools return a PLAIN STRING, not JSON — "Section '…' rewritten."
 * on success, "Failed: <reason>" on error — and flag argument/validation problems
 * with `isError` on the result. Neither path throws, so a caller that just awaits
 * `callTool` and returns ok sees a failed write as a success. This is the silent
 * failure behind the identity_update_section bug (thalamus sent `heading` where
 * the tool wanted `section`, the validation error came back as an isError result,
 * and the HTTP API still answered {ok:true}).
 *
 * `phylacteryToolError(result)` returns the failure text when the call did NOT
 * succeed, else null — so a wrapper can turn it into an honest {ok:false}.
 * Pure, so the detection is unit-tested without a live Phylactery.
 */

/**
 * @param {{ isError?: boolean, content?: Array<{type:string,text?:string}> }} result
 * @returns {string|null}  error text if the tool reported failure, else null
 */
export function phylacteryToolError(result) {
  const text = (result?.content?.find((c) => c?.type === 'text')?.text ?? '').trim();
  if (result?.isError) return text || 'phylactery reported an error';
  // The tools' own failure convention: a leading "Failed:" / "Failed -".
  if (/^failed\b\s*[:\-]/i.test(text)) return text;
  return null;
}
