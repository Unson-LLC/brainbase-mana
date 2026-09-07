const TOOLS = new Set([
  "mcp__brainbase__brainbase_resolve_turn",
  "mcp__brainbase__brainbase_judgment_state_record",
]);
const CODES = [
  "SCHEMA_INVALID", "BRAINBASE_UPSTREAM_UNAVAILABLE", "BRAINBASE_PROXY_NOT_CONFIGURED",
  "COMPANY_AUTHORITY_OPERATION_FORBIDDEN", "TENANT_CONTEXT_INVALID",
  "AUTHORITY_CONTEXT_EXPIRED", "brainbase_project_not_accessible",
  "brainbase_api_unavailable", "judgment_state_invalid",
  "judgment_turn_resolution_binding_invalid",
] as const;
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : undefined;

/** Only fixed tool names and known codes leave the private Claude stream. */
export function replyToolFailureDiagnostics(stdout: string) {
  const blocks: RecordValue[] = [];
  const denials: RecordValue[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const event = record(JSON.parse(line));
      if (event?.type === "result" && Array.isArray(event.permission_denials)) {
        for (const raw of event.permission_denials) {
          const denial = record(raw);
          if (denial) denials.push(denial);
        }
      }
      const content = record(event?.message)?.content;
      if (Array.isArray(content)) {
        for (const value of content) { const block = record(value); if (block) blocks.push(block); }
      }
    } catch { /* Partial stream lines are not diagnostic evidence. */ }
  }
  const names = new Map<string, string>();
  for (const block of blocks) {
    if (block.type === "tool_use" && typeof block.id === "string"
      && typeof block.name === "string" && TOOLS.has(block.name)) names.set(block.id, block.name);
  }
  const failures = [];
  for (const block of blocks) {
    if (block.type !== "tool_result" || !(block.is_error === true || block.isError === true)
      || typeof block.tool_use_id !== "string") continue;
    const toolName = names.get(block.tool_use_id);
    if (!toolName) continue;
    const content = JSON.stringify(block.content ?? null);
    const errorCodes = CODES.filter((code) => new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`, "u").test(content));
    const permissionDenialToolMatch = denials.some((denial) =>
      denial.tool_use_id === block.tool_use_id && denial.tool_name === toolName);
    const httpMatch = content.match(/\b(?:HTTP(?: error!? status)?|status(?: code)?)\s*[:=]?\s*([1-5][0-9]{2})\b/i);
    const failureCategory = permissionDenialToolMatch ? "pretool_denied"
      : /\b(?:input validation|invalid arguments|SCHEMA_INVALID)\b/i.test(content) ? "input_validation"
      : /\b(?:timeout|timed out|TimeoutError)\b/i.test(content) ? "transport_timeout"
      : httpMatch ? "transport_http_error" : "unknown";
    failures.push({ toolName, isError: true as const, errorCodes, permissionDenialToolMatch, failureCategory,
      ...(httpMatch ? { httpStatus: Number(httpMatch[1]) } : {}) });
    if (failures.length === 8) break;
  }
  return failures;
}
