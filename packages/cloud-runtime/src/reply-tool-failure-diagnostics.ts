const TOOLS = new Set([
  "mcp__brainbase__brainbase_resolve_turn",
  "mcp__brainbase__brainbase_judgment_state_record",
]);
const STATE_RECORD_TOOL_NAMES = new Set([
  "mcp__brainbase__brainbase_judgment_state_record",
  "brainbase_judgment_state_record",
]);

// Keep this list in sync with the errors that the interactive judgment Hook
// can actually throw. A stream may contain arbitrary tool output, so a
// generic `judgment_*` regexp would make private text observable in logs.
const HOOK_CODES = [
  "judgment_hook_audit_not_recorded",
  "judgment_hook_final_answer_digest_mismatch",
  "judgment_hook_final_audit_missing",
  "judgment_hook_payload_too_large",
  "judgment_hook_response_invalid",
  "judgment_hook_route_receipt_missing",
  "judgment_hook_stop_output_invalid",
  "judgment_hook_stop_repair_incomplete",
  "judgment_hook_tool_identity_missing",
  "judgment_hook_tool_receipt_conflict",
  "judgment_hook_transcript_boundary_invalid",
  "judgment_hook_transcript_boundary_missing",
  "judgment_hook_transcript_boundary_unreadable",
  "judgment_hook_transcript_invalid",
  "judgment_hook_transcript_too_large",
  "judgment_hook_transcript_tool_failed",
  "judgment_hook_transcript_tool_identity_conflict",
  "judgment_hook_transcript_tool_identity_missing",
  "judgment_hook_transcript_tool_input_missing",
  "judgment_hook_transcript_tool_response_invalid",
  "judgment_hook_transcript_tool_response_missing",
  "judgment_hook_transcript_tool_result_conflict",
  "judgment_hook_transcript_tool_result_missing",
  "judgment_hook_transcript_truncated",
  "judgment_hook_transcript_unreadable",
  "judgment_request_invalid",
  "judgment_resolve_turn_duplicate",
  "judgment_resolve_turn_required_first",
  "judgment_turn_identity_mismatch",
  "judgment_turn_identity_missing",
  "judgment_turn_state_lock_timeout",
] as const;

const CODES = [
  "SCHEMA_INVALID", "BRAINBASE_UPSTREAM_UNAVAILABLE", "BRAINBASE_PROXY_NOT_CONFIGURED",
  "COMPANY_AUTHORITY_OPERATION_FORBIDDEN", "TENANT_CONTEXT_INVALID",
  "AUTHORITY_CONTEXT_EXPIRED", "brainbase_project_not_accessible",
  "brainbase_api_unavailable", "judgment_state_invalid",
  "judgment_turn_resolution_binding_invalid", "judgment_resolution_input_invalid",
  "brainbase_judgment_binding_unavailable", "brainbase_api_response_invalid",
  "brainbase_auth_context_invalid", "brainbase_auth_unavailable", "brainbase_api_error",
  ...HOOK_CODES,
] as const;
const HOOK_CODE_SET = new Set<string>(HOOK_CODES);
const JSON_RPC_ERROR_CODES = new Set([-32602, -32000]);
const CONNECTION_ERROR_PATTERN = /\b(?:connection\s+(?:closed|refused|reset|terminated)|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket\s+hang\s+up)\b/i;
const TOOL_UNAVAILABLE_PATTERN = /\b(?:no\s+such\s+tool|unknown\s+tool|tool\s+not\s+available)\b/i;
const NAMED_TOOL_UNAVAILABLE_PATTERN = /\btool\s+[A-Za-z0-9_.:-]{1,160}\s+(?:is\s+)?not\s+available\b/i;
const PRETOOL_HOOK_FAILURE_PATTERN = /\bPreToolUse\s+hook\s+error\b/i;

type RecordValue = Record<string, unknown>;
type BrainbaseConnectionStatus = "connected" | "failed" | "pending" | "needs-auth" | "disabled" | "unknown";
type FailureCategory = "pretool_denied" | "hook_failure" | "tool_unavailable" | "input_validation" | "transport_timeout" | "transport_http_error" | "connection_error" | "unknown";

export interface ReplyClaudeTimeoutDiagnostics {
  streamStatus: "empty" | "partial" | "result_observed";
  stopHookResponseCount: number;
  decisionBlockCount: number;
  exitErrorCount: number;
  hookCodes: string[];
  stateRecordToolUseCount: number;
  resultEventPresent: boolean;
}

const record = (v: unknown): RecordValue | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : undefined;

function hasFixedCode(text: string, code: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`, "u").test(text);
}

function fixedCodes(text: string): string[] {
  return CODES.filter((code) => hasFixedCode(text, code));
}

function fixedHookCodes(text: string): string[] {
  return HOOK_CODES.filter((code) => hasFixedCode(text, code));
}

function parsedRecord(value: unknown): RecordValue | undefined {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function stopHookResponse(event: RecordValue): boolean {
  return event.type === "system" && event.subtype === "hook_response"
    && (event.hook_event === "Stop" || event.hook_event_name === "Stop");
}

function hasBlockDecision(event: RecordValue): boolean {
  if (event.decision === "block") return true;
  for (const value of [event.output, event.stdout]) {
    if (parsedRecord(value)?.decision === "block") return true;
  }
  return false;
}

function hasNonZeroExitCode(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  return typeof value === "string" && /^-?[1-9][0-9]*$/.test(value);
}

function hookCodeText(event: RecordValue): string[] {
  const values: string[] = [];
  for (const value of [event.stderr, event.stdout, event.output, event.reason]) {
    if (typeof value === "string") values.push(value);
    const parsed = parsedRecord(value);
    for (const nested of [parsed?.reason, parsed?.stderr, parsed?.stdout, parsed?.systemMessage]) {
      if (typeof nested === "string") values.push(nested);
    }
  }
  return values;
}

function connectionStatus(value: unknown): BrainbaseConnectionStatus {
  if (typeof value !== "string") return "unknown";
  const normalized = value === "needs_auth" ? "needs-auth" : value;
  return normalized === "connected" || normalized === "failed" || normalized === "pending"
    || normalized === "needs-auth" || normalized === "disabled"
    ? normalized
    : "unknown";
}

function initializationMetadata(events: RecordValue[]): {
  brainbaseConnectionStatus: BrainbaseConnectionStatus;
  tools?: string[];
} {
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  if (!init) return { brainbaseConnectionStatus: "unknown" };

  const servers = Array.isArray(init.mcp_servers)
    ? init.mcp_servers.map(record).filter((value): value is RecordValue => Boolean(value))
    : [];
  const brainbase = servers.find((server) => server.name === "brainbase");
  const tools = Array.isArray(init.tools) && init.tools.every((tool): tool is string => typeof tool === "string")
    ? [...init.tools]
    : undefined;
  return {
    brainbaseConnectionStatus: connectionStatus(brainbase?.status),
    ...(tools ? { tools } : {}),
  };
}

function httpStatus(text: string): number | undefined {
  const match = text.match(/\b(?:HTTP(?:\s+error!?\s+status|\s+status|[_-]?status)?|status(?:[_ ]?code)?)\s*[:=]?\s*([1-5][0-9]{2})\b/i);
  return match ? Number(match[1]) : undefined;
}

function jsonRpcErrorCode(text: string): number | undefined {
  const match = text.match(/["']?code["']?\s*[:=]\s*(-32602|-32000)\b/i);
  return match && JSON_RPC_ERROR_CODES.has(Number(match[1])) ? Number(match[1]) : undefined;
}

function classifyFailure(
  content: string,
  errorCodes: string[],
  permissionDenialToolMatch: boolean,
  status: number | undefined,
): FailureCategory {
  if (permissionDenialToolMatch) return "pretool_denied";
  if (errorCodes.some((code) => HOOK_CODE_SET.has(code))
      || PRETOOL_HOOK_FAILURE_PATTERN.test(content)) return "hook_failure";
  if (TOOL_UNAVAILABLE_PATTERN.test(content) || NAMED_TOOL_UNAVAILABLE_PATTERN.test(content)) {
    return "tool_unavailable";
  }
  if (/\b(?:input validation|invalid arguments|SCHEMA_INVALID)\b/i.test(content)) {
    return "input_validation";
  }
  if (/\b(?:timeout|timed out|TimeoutError)\b/i.test(content)) return "transport_timeout";
  if (status !== undefined && status >= 400) return "transport_http_error";
  if (CONNECTION_ERROR_PATTERN.test(content)) return "connection_error";
  return "unknown";
}

/** Only fixed tool names, codes, statuses, and categories leave the private Claude stream. */
export function replyToolFailureDiagnostics(stdout: string) {
  const blocks: RecordValue[] = [];
  const denials: RecordValue[] = [];
  const events: RecordValue[] = [];
  const observedPreToolHookErrorCodes = new Set<string>();

  for (const line of stdout.split("\n")) {
    try {
      const event = record(JSON.parse(line));
      if (!event) continue;
      events.push(event);
      if (event?.type === "result" && Array.isArray(event.permission_denials)) {
        for (const raw of event.permission_denials) {
          const denial = record(raw);
          if (denial) denials.push(denial);
        }
      }
      if (event.type === "system" && event.subtype === "hook_response"
          && (event.hook_event === "PreToolUse" || event.hook_event_name === "PreToolUse")
          && event.exit_code === 2 && event.outcome === "error" && typeof event.stderr === "string") {
        for (const code of fixedCodes(event.stderr)) {
          if (HOOK_CODE_SET.has(code)) observedPreToolHookErrorCodes.add(code);
        }
      }
      const content = record(event.message)?.content;
      if (Array.isArray(content)) {
        for (const value of content) {
          const block = record(value);
          if (block) blocks.push(block);
        }
      }
    } catch { /* Partial stream lines are not diagnostic evidence. */ }
  }

  const init = initializationMetadata(events);
  const names = new Map<string, string>();
  for (const block of blocks) {
    if (block.type === "tool_use" && typeof block.id === "string"
      && typeof block.name === "string" && TOOLS.has(block.name)) names.set(block.id, block.name);
  }

  const failures: Array<Record<string, unknown>> = [];
  const seenResultIds = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "tool_result" || !(block.is_error === true || block.isError === true)
      || typeof block.tool_use_id !== "string" || seenResultIds.has(block.tool_use_id)) continue;
    const toolName = names.get(block.tool_use_id);
    if (!toolName) continue;
    seenResultIds.add(block.tool_use_id);

    const content = JSON.stringify(block.content ?? null);
    const metadataText = typeof block.content === "string"
      ? `${content} ${block.content}` : content;
    const errorCodes = fixedCodes(metadataText);
    const permissionDenialToolMatch = denials.some((denial) =>
      denial.tool_use_id === block.tool_use_id && denial.tool_name === toolName);
    const status = httpStatus(metadataText);
    const rpcCode = jsonRpcErrorCode(metadataText);
    const failure = {
      toolName,
      isError: true as const,
      errorCodes,
      permissionDenialToolMatch,
      failureCategory: classifyFailure(
        metadataText, errorCodes, permissionDenialToolMatch, status,
      ),
      brainbaseConnectionStatus: init.brainbaseConnectionStatus,
      ...(init.tools ? { toolAdvertised: init.tools.includes(toolName) } : {}),
      ...(status === undefined ? {} : { httpStatus: status }),
      ...(rpcCode === undefined ? {} : { jsonRpcErrorCode: rpcCode }),
      ...(observedPreToolHookErrorCodes.size > 0
        ? { observedPreToolHookErrorCodes: [...observedPreToolHookErrorCodes] }
        : {}),
    };
    failures.push(failure);
    if (failures.length === 8) break;
  }
  return failures;
}

/**
 * Extract only fixed, non-content metadata from a timed-out Claude stream.
 * Every count is limited to observed structured events; a partial stream is
 * explicitly marked so zero values are never mistaken for a complete audit.
 */
export function replyClaudeTimeoutDiagnostics(stdout: string): ReplyClaudeTimeoutDiagnostics {
  let nonEmptyLineCount = 0;
  let malformedLineCount = 0;
  let stopHookResponseCount = 0;
  let decisionBlockCount = 0;
  let exitErrorCount = 0;
  let stateRecordToolUseCount = 0;
  let resultEventPresent = false;
  const hookCodes = new Set<string>();

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    nonEmptyLineCount += 1;
    let event: RecordValue | undefined;
    try {
      event = record(JSON.parse(line));
    } catch {
      malformedLineCount += 1;
      continue;
    }
    if (!event) {
      malformedLineCount += 1;
      continue;
    }
    if (event.type === "result") resultEventPresent = true;

    if (event.type === "system" && event.subtype === "hook_response") {
      if (stopHookResponse(event)) {
        stopHookResponseCount += 1;
        if (hasBlockDecision(event)) decisionBlockCount += 1;
        if (hasNonZeroExitCode(event.exit_code) || event.outcome === "error") exitErrorCount += 1;
      }
      for (const value of hookCodeText(event)) {
        for (const code of fixedHookCodes(value)) hookCodes.add(code);
      }
    }

    const content = record(event.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      const block = record(value);
      if (block?.type === "tool_use" && typeof block.name === "string"
        && STATE_RECORD_TOOL_NAMES.has(block.name)) {
        stateRecordToolUseCount += 1;
      }
    }
  }

  const streamStatus = nonEmptyLineCount === 0
    ? "empty"
    : malformedLineCount > 0 || !resultEventPresent
      ? "partial"
      : "result_observed";
  return {
    streamStatus,
    stopHookResponseCount,
    decisionBlockCount,
    exitErrorCount,
    hookCodes: [...hookCodes],
    stateRecordToolUseCount,
    resultEventPresent,
  };
}
