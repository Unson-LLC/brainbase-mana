/**
 * Content-free projection of the personal-KG search portion of a Claude JSONL
 * transcript.
 *
 * The gateway response is untrusted by design. This module only emits the
 * exact tool name, bounded hashes, bounded personal-KG event ids, counts, and
 * a finite reason enum. It must remain best effort: a malformed transcript or
 * unavailable digest implementation is an unknown result, never a thrown
 * error and never a successful empty search.
 */

export const PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME = "mcp__gateway__search_personal_kg" as const;
export const PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION = "mana.reply.personal_kg.v1" as const;

const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 128 * 1024;
const MAX_STREAM_EVENTS = 4_096;
const MAX_SEARCH_CALLS = 8;
const MAX_RESULT_ITEMS = 50;
const MAX_QUERY_LENGTH = 4_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 28;
const MAX_DIAGNOSTIC_JSON_LENGTH = 64 * 1024;

// Only this content-derived event-id format is safe to expose here. Other
// API-valid identifiers remain unknown rather than becoming a text log.
const PERSONAL_EVENT_ID = /^pke_[a-f0-9]{24}$/u;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export type PersonalKnowledgeDiagnosticSuccess = true | false | null;

export type PersonalKnowledgeDiagnosticReason =
  | "complete"
  | "no_call"
  | "result_error"
  | "result_missing"
  | "result_invalid"
  | "duplicate_result"
  | "unmatched_result"
  | "partial"
  | "truncated"
  | "stream_invalid"
  | "hash_unavailable"
  | "current_attempt_missing"
  | "result_before_call";

export interface PersonalKnowledgeCallDiagnostic {
  success: PersonalKnowledgeDiagnosticSuccess;
  queryHash: string | null;
  resultEventIds: string[];
  /** Body hashes align by index with resultEventIds; null means unavailable. */
  resultBodyHashes: Array<string | null>;
  /** Number of paired tool_result blocks, not the number of returned items. */
  resultCount: number;
}

export interface PersonalKnowledgeDiagnostics {
  schemaVersion: typeof PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION;
  toolName: typeof PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME;
  success: PersonalKnowledgeDiagnosticSuccess;
  calls: PersonalKnowledgeCallDiagnostic[];
  callCount: number;
  /** Number of paired tool_result blocks across the bounded calls. */
  resultCount: number;
  reason: PersonalKnowledgeDiagnosticReason;
}

type JsonRecord = Record<string, unknown>;

interface RawResult {
  block: JsonRecord;
}

interface RawCall {
  id: string | null;
  query: string | null;
  queryValid: boolean;
  results: RawResult[];
  duplicate: boolean;
  resultBeforeCall: boolean;
}

interface ParsedStream {
  events: JsonRecord[];
  invalid: boolean;
  truncated: boolean;
}

interface ResultProjection {
  valid: boolean;
  truncated: boolean;
  hashUnavailable: boolean;
  eventIds: string[];
  bodyHashes: Array<string | null>;
}

interface CallProjection {
  diagnostic: PersonalKnowledgeCallDiagnostic;
  invalid: boolean;
  duplicate: boolean;
  beforeCall?: boolean;
  error: boolean;
  missing: boolean;
  truncated: boolean;
  hashUnavailable: boolean;
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function safeToolUseId(value: unknown): string | null {
  if (typeof value !== "string" || !TOOL_USE_ID.test(value)) return null;
  return value;
}

function safeEventId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !PERSONAL_EVENT_ID.test(value)) return null;
  return value;
}

function safeQuery(value: unknown): { value: string; valid: true } | { value: null; valid: false } {
  if (typeof value !== "string") return { value: null, valid: false };
  const query = value.trim();
  if (!query || query.length > MAX_QUERY_LENGTH || byteLength(query) > MAX_BODY_BYTES) {
    return { value: null, valid: false };
  }
  return { value: query, valid: true };
}

function messageContent(event: JsonRecord): unknown {
  const message = isRecord(event.message) ? event.message : undefined;
  return message?.content;
}

function contentBlocks(event: JsonRecord): JsonRecord[] {
  const content = messageContent(event);
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function isUserPromptSubmit(event: JsonRecord): boolean {
  return event.type === "system"
    && event.subtype === "hook_response"
    && (event.hook_event === "UserPromptSubmit" || event.hook_event_name === "UserPromptSubmit");
}

function parseStream(stdout: string): ParsedStream {
  if (byteLength(stdout) > MAX_STDOUT_BYTES) return { events: [], invalid: false, truncated: true };

  const events: JsonRecord[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (byteLength(line) > MAX_LINE_BYTES || events.length >= MAX_STREAM_EVENTS) {
      return { events: [], invalid: false, truncated: true };
    }
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) return { events: [], invalid: true, truncated: false };
      events.push(value);
    } catch {
      return { events: [], invalid: true, truncated: false };
    }
  }
  return { events, invalid: false, truncated: false };
}

function resultErrorFlag(block: JsonRecord): boolean | null {
  const snake = block.is_error;
  const camel = block.isError;
  if (snake !== undefined && typeof snake !== "boolean") return null;
  if (camel !== undefined && typeof camel !== "boolean") return null;
  if (snake === true && camel === false) return null;
  if (snake === false && camel === true) return null;
  return snake === true || camel === true;
}

function parseJsonContent(content: unknown): { value?: unknown; invalid: boolean; truncated: boolean } {
  if (typeof content === "string") {
    if (byteLength(content) > MAX_LINE_BYTES) return { invalid: false, truncated: true };
    try {
      return { value: JSON.parse(content), invalid: false, truncated: false };
    } catch {
      return { invalid: true, truncated: false };
    }
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    let totalBytes = 0;
    for (const item of content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
        return { invalid: true, truncated: false };
      }
      totalBytes += byteLength(item.text);
      if (totalBytes > MAX_LINE_BYTES) return { invalid: false, truncated: true };
      textParts.push(item.text);
    }
    if (textParts.length === 0) return { invalid: true, truncated: false };
    try {
      return { value: JSON.parse(textParts.join("")), invalid: false, truncated: false };
    } catch {
      return { invalid: true, truncated: false };
    }
  }

  if (isRecord(content)) return { value: content, invalid: false, truncated: false };
  return { invalid: true, truncated: false };
}

function bodyHashFromMetadata(value: unknown): string | null {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function projectResult(content: unknown): Promise<ResultProjection> {
  const parsed = parseJsonContent(content);
  if (parsed.truncated) return { valid: false, truncated: true, hashUnavailable: false, eventIds: [], bodyHashes: [] };
  if (parsed.invalid || !isRecord(parsed.value) || parsed.value.untrusted_data !== true
      || !Array.isArray(parsed.value.items)) {
    return { valid: false, truncated: false, hashUnavailable: false, eventIds: [], bodyHashes: [] };
  }
  if (parsed.value.items.length > MAX_RESULT_ITEMS) {
    return { valid: false, truncated: true, hashUnavailable: false, eventIds: [], bodyHashes: [] };
  }
  // The transport error flag belongs to the outer tool_result block. If a
  // gateway payload carries either spelling itself, fail closed instead of
  // treating an error envelope with items as a successful search.
  if (resultErrorFlag(parsed.value) !== false
      || Object.prototype.hasOwnProperty.call(parsed.value, "error")
      || (parsed.value.success !== undefined && parsed.value.success !== true)) {
    return { valid: false, truncated: false, hashUnavailable: false, eventIds: [], bodyHashes: [] };
  }

  const eventIds: string[] = [];
  const bodyHashes: Array<string | null> = [];
  for (const item of parsed.value.items) {
    if (!isRecord(item)) return { valid: false, truncated: false, hashUnavailable: false, eventIds: [], bodyHashes: [] };
    const eventId = safeEventId(item.event_id);
    if (!eventId) return { valid: false, truncated: false, hashUnavailable: false, eventIds: [], bodyHashes: [] };

    const hasBody = Object.prototype.hasOwnProperty.call(item, "body") && item.body !== undefined;
    if (hasBody && typeof item.body !== "string") {
      return { valid: false, truncated: false, hashUnavailable: false, eventIds: [], bodyHashes: [] };
    }
    if (typeof item.body === "string" && byteLength(item.body) > MAX_BODY_BYTES) {
      return { valid: false, truncated: true, hashUnavailable: false, eventIds: [], bodyHashes: [] };
    }

    eventIds.push(eventId);
    if (typeof item.body === "string") {
      try {
        bodyHashes.push(await sha256(item.body));
      } catch {
        return { valid: false, truncated: false, hashUnavailable: true, eventIds: [], bodyHashes: [] };
      }
    } else {
      const metadataHash = bodyHashFromMetadata(item.body_hash);
      bodyHashes.push(metadataHash);
    }
  }
  return { valid: true, truncated: false, hashUnavailable: false, eventIds, bodyHashes };
}

function emptyCall(success: PersonalKnowledgeDiagnosticSuccess, queryHash: string | null, resultCount: number): PersonalKnowledgeCallDiagnostic {
  return { success, queryHash, resultEventIds: [], resultBodyHashes: [], resultCount };
}

async function projectCall(call: RawCall): Promise<CallProjection> {
  let queryHash: string | null = null;
  if (call.queryValid && call.query !== null) {
    try {
      queryHash = await sha256(call.query);
    } catch {
      return {
        diagnostic: emptyCall(null, null, call.results.length),
        invalid: false,
        duplicate: call.duplicate,
        error: false,
        missing: false,
        truncated: false,
        hashUnavailable: true,
      };
    }
  }

  if (call.duplicate) {
    return {
      diagnostic: emptyCall(null, queryHash, call.results.length),
      invalid: false,
      duplicate: true,
      error: false,
      missing: false,
      truncated: false,
      hashUnavailable: false,
    };
  }
  if (call.resultBeforeCall) {
    return {
      diagnostic: emptyCall(null, queryHash, call.results.length),
      invalid: false,
      duplicate: false,
      beforeCall: true,
      error: false,
      missing: false,
      truncated: false,
      hashUnavailable: false,
    };
  }
  if (!call.queryValid || call.id === null) {
    return {
      diagnostic: emptyCall(null, queryHash, call.results.length),
      invalid: true,
      duplicate: false,
      error: false,
      missing: call.results.length === 0,
      truncated: false,
      hashUnavailable: false,
    };
  }
  if (call.results.length === 0) {
    return {
      diagnostic: emptyCall(null, queryHash, 0),
      invalid: false,
      duplicate: false,
      error: false,
      missing: true,
      truncated: false,
      hashUnavailable: false,
    };
  }
  if (call.results.length > 1) {
    return {
      diagnostic: emptyCall(null, queryHash, call.results.length),
      invalid: false,
      duplicate: true,
      error: false,
      missing: false,
      truncated: false,
      hashUnavailable: false,
    };
  }

  const resultBlock = call.results[0]!.block;
  const error = resultErrorFlag(resultBlock);
  if (error === null) {
    return {
      diagnostic: emptyCall(null, queryHash, 1),
      invalid: true,
      duplicate: false,
      error: false,
      missing: false,
      truncated: false,
      hashUnavailable: false,
    };
  }
  if (error) {
    return {
      diagnostic: emptyCall(false, queryHash, 1),
      invalid: false,
      duplicate: false,
      error: true,
      missing: false,
      truncated: false,
      hashUnavailable: false,
    };
  }

  const projected = await projectResult(resultBlock.content);
  if (projected.truncated) {
    return {
      diagnostic: emptyCall(null, queryHash, 1),
      invalid: false,
      duplicate: false,
      error: false,
      missing: false,
      truncated: true,
      hashUnavailable: false,
    };
  }
  if (projected.hashUnavailable) {
    return {
      diagnostic: emptyCall(null, queryHash, 1),
      invalid: false,
      duplicate: false,
      error: false,
      missing: false,
      truncated: false,
      hashUnavailable: true,
    };
  }
  if (!projected.valid) {
    return {
      diagnostic: emptyCall(null, queryHash, 1),
      invalid: true,
      duplicate: false,
      error: false,
      missing: false,
      truncated: false,
      hashUnavailable: false,
    };
  }
  return {
    diagnostic: {
      success: true,
      queryHash,
      resultEventIds: projected.eventIds,
      resultBodyHashes: projected.bodyHashes,
      resultCount: 1,
    },
    invalid: false,
    duplicate: false,
    error: false,
    missing: false,
    truncated: false,
    hashUnavailable: false,
  };
}

function aggregateSuccess(calls: readonly PersonalKnowledgeCallDiagnostic[]): PersonalKnowledgeDiagnosticSuccess {
  if (calls.length === 0) return null;
  if (calls.some((call) => call.success === false)) return false;
  if (calls.some((call) => call.success === null)) return null;
  return true;
}

function safeResult(reason: PersonalKnowledgeDiagnosticReason): PersonalKnowledgeDiagnostics {
  return {
    schemaVersion: PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION,
    toolName: PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
    success: null,
    calls: [],
    callCount: 0,
    resultCount: 0,
    reason,
  };
}

function aggregateReason(
  calls: readonly CallProjection[],
  unmatchedResult: boolean,
  truncated: boolean,
): PersonalKnowledgeDiagnosticReason {
  if (truncated || calls.some((call) => call.truncated)) return "truncated";
  if (calls.some((call) => call.hashUnavailable)) return "hash_unavailable";
  if (calls.some((call) => call.duplicate)) return "duplicate_result";
  if (calls.some((call) => call.invalid)) return "result_invalid";
  if (calls.some((call) => call.beforeCall === true)) return "result_before_call";
  if (calls.some((call) => call.error) && calls.some((call) => call.diagnostic.success === true)) return "partial";
  if (calls.some((call) => call.error)) return "result_error";
  if (calls.some((call) => call.missing)) return "result_missing";
  if (unmatchedResult) return "unmatched_result";
  if (calls.some((call) => call.diagnostic.success === null)) return "partial";
  return "complete";
}

/**
 * Extracts only the bounded personal-KG search evidence from Claude JSONL.
 * The function deliberately has no logger or external dependency so callers
 * can wrap it in a best-effort diagnostic sink without affecting replies.
 */
export async function projectPersonalKnowledgeDiagnostics(stdout: string): Promise<PersonalKnowledgeDiagnostics> {
  try {
    if (typeof stdout !== "string") return safeResult("stream_invalid");
    // Reject by UTF-16 length before allocating a TextEncoder buffer for a
    // potentially hostile string. The byte check remains in parseStream for
    // multibyte input and is conservative at this boundary.
    if (stdout.length > MAX_STDOUT_BYTES) return safeResult("truncated");
    const parsed = parseStream(stdout);
    if (parsed.truncated) return safeResult("truncated");
    if (parsed.invalid) return safeResult("stream_invalid");

    const boundary = parsed.events.reduce((latest, event, index) => isUserPromptSubmit(event) ? index : latest, -1);
    if (boundary < 0) {
      const hasSearchCall = parsed.events.some((event) => contentBlocks(event).some((block) =>
        event.type === "assistant" && block.type === "tool_use" && block.name === PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME));
      return safeResult(hasSearchCall ? "current_attempt_missing" : "no_call");
    }
    const events = parsed.events.slice(boundary + 1);
    const calls: RawCall[] = [];
    const callsById = new Map<string, RawCall>();
    const toolUsesById = new Map<string, Set<string>>();
    const resultsBeforeUse = new Set<string>();
    let unmatchedResult = false;
    let truncated = false;

    for (const event of events) {
      if (event.type === "assistant") {
        for (const block of contentBlocks(event)) {
          if (block.type !== "tool_use") continue;
          const toolUseId = safeToolUseId(block.id);
          if (toolUseId !== null) {
            const names = toolUsesById.get(toolUseId) ?? new Set<string>();
            names.add(typeof block.name === "string" ? block.name : "");
            toolUsesById.set(toolUseId, names);
            const existingCall = callsById.get(toolUseId);
            if (existingCall && block.name !== PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME) {
              existingCall.duplicate = true;
            }
          }
          if (block.name !== PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME) continue;
          if (calls.length >= MAX_SEARCH_CALLS) {
            truncated = true;
            continue;
          }
          const id = safeToolUseId(block.id);
          const input = isRecord(block.input) ? block.input : undefined;
          const query = safeQuery(input?.query);
          const call: RawCall = {
            id,
            query: query.value,
            queryValid: query.valid,
            results: [],
            duplicate: false,
            resultBeforeCall: id !== null && resultsBeforeUse.has(id),
          };
          if (id !== null && callsById.has(id)) {
            call.duplicate = true;
            callsById.get(id)!.duplicate = true;
          } else if (id !== null) {
            callsById.set(id, call);
            const names = toolUsesById.get(id);
            if (names && [...names].some((name) => name !== PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME)) call.duplicate = true;
          }
          calls.push(call);
        }
      } else if (event.type === "user") {
        for (const block of contentBlocks(event)) {
          if (block.type !== "tool_result") continue;
          const id = safeToolUseId(block.tool_use_id);
          if (id === null) {
            continue;
          }
          const result: RawResult = { block };
          const call = callsById.get(id);
          if (call) {
            call.results.push(result);
          } else if (toolUsesById.has(id)) {
            // A result belonging to another tool is intentionally ignored.
            // An exact search call would already be present in callsById;
            // any same-id collision was marked when its tool_use arrived.
          } else {
            // Results preceding their tool_use cannot be paired safely. Keep
            // only the bounded id marker; if a later exact call arrives it is
            // marked unknown rather than retroactively paired.
            resultsBeforeUse.add(id);
          }
        }
      }
    }
    // The marker is consumed by the call's resultBeforeCall bit. A result for
    // an unrelated/unknown tool remains outside this diagnostic projection.
    if (calls.length === 0) {
      return {
        ...safeResult(unmatchedResult ? "unmatched_result" : "no_call"),
        ...(truncated ? { reason: "truncated" as const } : {}),
      };
    }

    const projections: CallProjection[] = [];
    for (const call of calls) projections.push(await projectCall(call));
    const diagnostics = projections.map((projection) => projection.diagnostic);
    const output: PersonalKnowledgeDiagnostics = {
      toolName: PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
      schemaVersion: PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION,
      success: truncated ? null : aggregateSuccess(diagnostics),
      calls: diagnostics,
      callCount: diagnostics.length,
      resultCount: diagnostics.reduce((count, call) => count + call.resultCount, 0),
      reason: aggregateReason(projections, unmatchedResult, truncated),
    };
    return JSON.stringify(output).length <= MAX_DIAGNOSTIC_JSON_LENGTH ? output : safeResult("truncated");
  } catch {
    // A diagnostic must never turn an otherwise valid reply into a failure,
    // and no caught value is safe to expose in the returned schema.
    return safeResult("stream_invalid");
  }
}
