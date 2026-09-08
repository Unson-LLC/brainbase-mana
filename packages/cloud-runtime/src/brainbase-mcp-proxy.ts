import { TenantBoundaryError } from "./multitenancy/errors.js";

export const BRAINBASE_MCP_PROXY_HOST = "brainbase-mcp.internal";
export const BRAINBASE_MCP_PROXY_PATH = "/mcp";
export const BRAINBASE_JUDGMENT_HOOK_PROXY_PATH = "/host/judgment/hook";

export interface BrainbaseMcpProxyEnv {
  BRAINBASE_MCP_BASE_URL?: string;
  BRAINBASE_MCP_TOKEN?: string;
  BRAINBASE_JUDGMENT_PROJECT_CODE?: string;
  /** Canonical Company Authority project ID to judgment Hook project code. */
  BRAINBASE_JUDGMENT_AUTHORITY_PROJECTS_JSON?: string;
}

export interface BrainbaseMcpProxyPolicy {
  allowedTools: readonly string[];
  companyAuthorityResponse?: unknown;
}

const COMPANY_AUTHORITY_HEADER = "x-brainbase-company-authority-response";
const MAX_COMPANY_AUTHORITY_HEADER_BYTES = 12 * 1024;
const MAX_JUDGMENT_HOOK_DIAGNOSTIC_BYTES = 64 * 1024;
const JUDGMENT_HOOK_DIAGNOSTIC_TIMEOUT_MS = 250;

function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function mcpToolName(request: Request): Promise<string | undefined> {
  if (new URL(request.url).pathname !== BRAINBASE_MCP_PROXY_PATH) return undefined;
  try {
    const body = await request.clone().json() as { method?: unknown; params?: { name?: unknown } };
    return body.method === "tools/call" && typeof body.params?.name === "string"
      ? body.params.name.slice(0, 120) : undefined;
  } catch { return undefined; }
}

async function mcpMethod(request: Request): Promise<string | undefined> {
  if (new URL(request.url).pathname !== BRAINBASE_MCP_PROXY_PATH || request.method !== "POST") return undefined;
  try {
    const body = await request.clone().json() as { method?: unknown };
    return typeof body.method === "string" ? body.method : undefined;
  } catch { return undefined; }
}

const MCP_LIFECYCLE_METHODS = new Set(["initialize", "notifications/initialized", "tools/list"] as const);
type McpLifecycleMethod = "initialize" | "notifications/initialized" | "tools/list";
type McpLifecycleCategory =
  | "request_received"
  | "response"
  | "upstream_http_error"
  | "configuration_error"
  | "transport_error"
  | "catalog_error";

const SAFE_JUDGMENT_HOOK_ERROR_CODES = new Set(["judgment_episode_not_found"]);
const JUDGMENT_AUDIT_PREFIXES = ["🧠 判断参照:", "⚠️ 判断参照:"] as const;
const BRAINBASE_AUDIT_PREFIXES = ["📚 Brainbase", "⚠️ Brainbase"] as const;
const MODEL_ACTION_REQUEST_PATTERN = /(?:mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+|brainbase_[a-z0-9_]+).{0,120}(?:実行|呼び出|tool call|call)/isu;
const MODEL_ACTION_REQUEST_REVERSE_PATTERN = /(?:実行|呼び出|tool call|call).{0,120}(?:mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+|brainbase_[a-z0-9_]+)/isu;

type JudgmentHookResponseKind = "empty" | "system_message" | "block" | "invalid";
type JudgmentHookDecision = "block" | "absent" | "invalid";

interface JudgmentHookDiagnosticRequest {
  isStop: boolean;
  stopHookActive: boolean;
}

interface JsonRecord {
  [key: string]: unknown;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function judgmentHookDiagnosticRequest(request: Request): Promise<JudgmentHookDiagnosticRequest> {
  if (new URL(request.url).pathname !== BRAINBASE_JUDGMENT_HOOK_PROXY_PATH || request.method !== "POST") {
    return { isStop: false, stopHookActive: false };
  }
  try {
    const body = await request.clone().json();
    if (!isJsonRecord(body)) return { isStop: false, stopHookActive: false };
    const eventName = body.hook_event_name ?? body.hookEventName;
    return {
      isStop: eventName === "Stop",
      stopHookActive: body.stop_hook_active === true,
    };
  } catch {
    return { isStop: false, stopHookActive: false };
  }
}

function safeHttpStatus(status: number): number | null {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAuditPrefix(value: unknown, prefixes: readonly string[]): boolean {
  return typeof value === "string"
    && value.split(/\r?\n/u).some((line) => prefixes.some((prefix) => line.startsWith(prefix)));
}

function modelActionRequested(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return MODEL_ACTION_REQUEST_PATTERN.test(value) || MODEL_ACTION_REQUEST_REVERSE_PATTERN.test(value);
}

function safeJudgmentHookErrorCode(value: unknown): string | null {
  const candidates: unknown[] = [];
  if (isJsonRecord(value)) {
    candidates.push(value.error);
    if (isJsonRecord(value.error)) candidates.push(value.error.code);
    if (isJsonRecord(value.output)) {
      candidates.push(value.output.error);
      if (isJsonRecord(value.output.error)) candidates.push(value.output.error.code);
    }
  }
  return candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && SAFE_JUDGMENT_HOOK_ERROR_CODES.has(candidate)) ?? null;
}

function judgmentHookOutput(body: unknown): { output?: JsonRecord; invalid: boolean } {
  if (!isJsonRecord(body)) return { invalid: true };
  if (body.schema_version !== "1" || body.accepted !== true || body.hook_event_name !== "Stop"
      || !isJsonRecord(body.output)) return { invalid: true };
  return { output: body.output, invalid: false };
}

function judgmentHookResponseSummary(body: unknown): {
  responseKind: JudgmentHookResponseKind;
  decision: JudgmentHookDecision;
  hasReason: boolean;
  hasSystemMessage: boolean;
  hasJudgmentAudit: boolean;
  hasBrainbaseAudit: boolean;
  modelActionRequested: boolean;
  errorCode: string | null;
} {
  const parsed = judgmentHookOutput(body);
  const output = parsed.output;
  const reason = output?.reason;
  const systemMessage = output?.systemMessage;
  const hasReason = nonEmptyString(reason);
  const hasSystemMessage = nonEmptyString(systemMessage);
  const decision: JudgmentHookDecision = !output || parsed.invalid
    ? "invalid"
    : Object.hasOwn(output, "decision")
      ? output.decision === "block" ? "block" : "invalid"
      : "absent";
  let responseKind: JudgmentHookResponseKind = "invalid";
  if (!parsed.invalid && output) {
    if (decision === "block") {
      responseKind = "block";
    } else if (decision === "invalid" || Object.hasOwn(output, "reason")) {
      responseKind = "invalid";
    } else if (Object.hasOwn(output, "systemMessage")) {
      responseKind = hasSystemMessage ? "system_message" : "invalid";
    } else if (Object.keys(output).length === 0) {
      responseKind = "empty";
    } else {
      responseKind = "invalid";
    }
  }
  return {
    responseKind,
    decision,
    hasReason,
    hasSystemMessage,
    hasJudgmentAudit: hasAuditPrefix(reason, JUDGMENT_AUDIT_PREFIXES),
    hasBrainbaseAudit: hasAuditPrefix(reason, BRAINBASE_AUDIT_PREFIXES),
    modelActionRequested: modelActionRequested(reason),
    errorCode: safeJudgmentHookErrorCode(body),
  };
}

function logJudgmentHookRequestDiagnostic(diagnosticRequest: JudgmentHookDiagnosticRequest): void {
  if (!diagnosticRequest.isStop) return;
  try {
    console.log(JSON.stringify({
      event: "brainbase_judgment_hook_diagnostic",
      phase: "request_received",
      hook_event_name: "Stop",
      stop_hook_active: diagnosticRequest.stopHookActive,
    }));
  } catch { /* Diagnostics are best effort and must not alter Hook semantics. */ }
}

async function readBoundedResponseText(response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JUDGMENT_HOOK_DIAGNOSTIC_BYTES) {
    return undefined;
  }

  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return undefined;
  }
  if (!clone.body) return "";

  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + JUDGMENT_HOOK_DIAGNOSTIC_TIMEOUT_MS;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("judgment_hook_diagnostic_timeout")),
        Math.max(0, deadline - Date.now()));
    });
    while (true) {
      if (Date.now() >= deadline) return undefined;
      const result = await Promise.race([reader.read(), timeoutPromise]);
      if (result.done) break;
      const chunk = result.value;
      const nextTotal = totalBytes + chunk.byteLength;
      if (nextTotal > MAX_JUDGMENT_HOOK_DIAGNOSTIC_BYTES) return undefined;
      chunks.push(chunk);
      totalBytes = nextTotal;
    }
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    // Cancellation is best effort. Awaiting it could retain the same
    // unbounded stream that this diagnostic reader is abandoning.
    void reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function logJudgmentHookResponseDiagnostic(
  response: Response,
  diagnosticRequest: JudgmentHookDiagnosticRequest,
): Promise<void> {
  if (!diagnosticRequest.isStop) return;
  try {
    let body: unknown;
    try {
      const text = await readBoundedResponseText(response);
      if (text !== undefined) body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const summary = judgmentHookResponseSummary(body);
    console.log(JSON.stringify({
      event: "brainbase_judgment_hook_diagnostic",
      phase: "response",
      status: safeHttpStatus(response.status),
      response_kind: summary.responseKind,
      decision: summary.decision,
      stop_hook_active: diagnosticRequest.stopHookActive,
      has_reason: summary.hasReason,
      has_system_message: summary.hasSystemMessage,
      has_judgment_audit: summary.hasJudgmentAudit,
      has_brainbase_audit: summary.hasBrainbaseAudit,
      model_action_requested: summary.modelActionRequested,
      error_code: summary.errorCode,
    }));
  } catch { /* Diagnostics are best effort and must not alter Hook semantics. */ }
}

function mcpLifecycleMethod(method: string | undefined): McpLifecycleMethod | undefined {
  return method && MCP_LIFECYCLE_METHODS.has(method as McpLifecycleMethod)
    ? method as McpLifecycleMethod
    : undefined;
}

const SAFE_BOUNDARY_CODES = new Set([
  "SCHEMA_INVALID", "SERVICE_AUTH_REQUIRED", "CREDENTIAL_LEASE_SCOPE_MISMATCH",
  "CREDENTIAL_LEASE_ALREADY_USED", "CREDENTIAL_LEASE_EXPIRED", "CREDENTIAL_LEASE_INVALID",
  "CREDENTIAL_LEASE_BINDING_MISMATCH",
  "CREDENTIAL_FORWARDING_UNAVAILABLE", "PROVIDER_OPERATION_UNSUPPORTED",
  "UPSTREAM_INVALID_RESPONSE", "UPSTREAM_UNAVAILABLE", "TENANT_CONTEXT_INVALID",
  "AUTHORITY_CONTEXT_EXPIRED", "COMPANY_AUTHORITY_OPERATION_FORBIDDEN",
  "WORKSPACE_CONNECTION_REVISION_MISMATCH", "CONFIGURATION_INVALID",
]);

function safeTransportFailure(error: unknown): { safeError: string; upstreamStatus?: number } {
  if (!(error instanceof TenantBoundaryError) || !SAFE_BOUNDARY_CODES.has(error.code)) {
    return { safeError: "BRAINBASE_UPSTREAM_UNAVAILABLE" };
  }
  const status = error.details?.status;
  return {
    safeError: error.code,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { upstreamStatus: status } : {}),
  };
}

function safeUpstreamError(status: number): string | undefined {
  return status >= 400 ? "BRAINBASE_UPSTREAM_HTTP_ERROR" : undefined;
}

function lifecycleCategory(status: number): "response" | "upstream_http_error" {
  return status >= 400 ? "upstream_http_error" : "response";
}

function logMcpLifecycle(
  method: McpLifecycleMethod | undefined,
  details: {
    status?: number;
    safeError?: string;
    upstreamStatus?: number;
    category: McpLifecycleCategory;
  },
): void {
  if (!method) return;
  console.log(JSON.stringify({
    event: "brainbase_mcp_lifecycle",
    method,
    ...(details.status === undefined ? {} : { status: details.status }),
    ...(details.safeError === undefined ? {} : { safeError: details.safeError }),
    ...(details.upstreamStatus === undefined ? {} : { upstreamStatus: details.upstreamStatus }),
    category: details.category,
  }));
}

function filterToolCatalogPayload(payload: unknown, allowedTools: readonly string[]): unknown {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("invalid_catalog");
  const envelope = payload as { result?: { tools?: unknown } };
  if (!envelope.result || !Array.isArray(envelope.result.tools)) throw new Error("invalid_catalog");
  const allowed = new Set(allowedTools);
  return {
    ...envelope,
    result: {
      ...envelope.result,
      tools: envelope.result.tools.filter((tool) =>
        Boolean(tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
          && allowed.has((tool as { name: string }).name))),
    },
  };
}

function allowedMcpResponseHeaders(response: Response): Headers {
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return headers;
}

async function filterToolCatalogResponse(response: Response, allowedTools: readonly string[]): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "application/json";
  const text = await response.text();
  try {
    if (contentType.includes("text/event-stream")) {
      let filtered = false;
      const output = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        const payload = filterToolCatalogPayload(JSON.parse(line.slice(5).trim()), allowedTools);
        filtered = true;
        return `data: ${JSON.stringify(payload)}`;
      }).join("\n");
      if (!filtered) throw new Error("invalid_catalog");
      return new Response(output, { status: response.status, headers: allowedMcpResponseHeaders(response) });
    }
    return Response.json(filterToolCatalogPayload(JSON.parse(text), allowedTools), {
      status: response.status,
      headers: allowedMcpResponseHeaders(response),
    });
  } catch {
    return Response.json({ error: { code: "BRAINBASE_MCP_TOOL_CATALOG_INVALID", retryable: true } }, { status: 502 });
  }
}

export async function handleBrainbaseMcpProxyRequest(
  request: Request,
  env: BrainbaseMcpProxyEnv,
  fetchImpl?: typeof fetch,
  policy?: BrainbaseMcpProxyPolicy,
): Promise<Response> {
  const url = new URL(request.url);
  const judgmentHookDiagnostic = await judgmentHookDiagnosticRequest(request);
  logJudgmentHookRequestDiagnostic(judgmentHookDiagnostic);
  const method = await mcpMethod(request);
  const lifecycleMethod = mcpLifecycleMethod(method);
  logMcpLifecycle(lifecycleMethod, { category: "request_received" });
  const toolName = await mcpToolName(request);
  const diagnosticTool = ["brainbase_resolve_turn", "brainbase_judgment_state_record", "brainbase_knowledge_resolve"].includes(toolName ?? "")
    ? toolName : "other";
  const logPhase = (phase: "received" | "policy" | "config" | "upstream_fetch", status?: number) => {
    if (!toolName) return;
    console.log(JSON.stringify({ event: "brainbase_mcp_proxy_phase", toolName: diagnosticTool, phase,
      ...(status === undefined ? {} : { status }) }));
  };
  logPhase("received");
  if (url.hostname === BRAINBASE_MCP_PROXY_HOST
      && url.pathname === BRAINBASE_MCP_PROXY_PATH
      && request.method === "GET") {
    return Response.json(
      { error: { code: "BRAINBASE_MCP_NOTIFICATION_STREAM_UNSUPPORTED", retryable: false } },
      { status: 405, headers: { allow: "POST, DELETE" } },
    );
  }
  const isAllowedPath = url.pathname === BRAINBASE_MCP_PROXY_PATH || url.pathname === BRAINBASE_JUDGMENT_HOOK_PROXY_PATH;
  const allowedMethod = url.pathname === BRAINBASE_MCP_PROXY_PATH
    ? ["POST", "DELETE"].includes(request.method)
    : request.method === "POST";
  if (url.hostname !== BRAINBASE_MCP_PROXY_HOST || !isAllowedPath || !allowedMethod) {
    const response = Response.json({ error: { code: "BRAINBASE_OPERATION_FORBIDDEN", retryable: false } }, { status: 403 });
    await logJudgmentHookResponseDiagnostic(response, judgmentHookDiagnostic);
    return response;
  }
  // This policy is supplied by the verified durable boundary, never by model
  // request headers. Tool discovery/annotations do not authorize tool calls.
  if (policy && url.pathname === BRAINBASE_MCP_PROXY_PATH && request.method === "POST") {
    let allowed = false;
    try {
      const body = await request.clone().json() as Record<string, unknown>;
      if (body && !Array.isArray(body) && body.jsonrpc === "2.0") {
        const params = body.params as { name?: unknown } | undefined;
        allowed = ["initialize", "notifications/initialized", "ping", "tools/list"].includes(String(body.method))
          || (body.method === "tools/call" && typeof params?.name === "string"
            && policy.allowedTools.includes(params.name));
      }
    } catch { /* Malformed/batch requests cannot bypass the operation gate. */ }
    if (!allowed) {
      logPhase("policy", 403);
      const response = Response.json({
        error: { code: "COMPANY_AUTHORITY_OPERATION_FORBIDDEN", retryable: false },
      }, { status: 403 });
      await logJudgmentHookResponseDiagnostic(response, judgmentHookDiagnostic);
      return response;
    }
  }
  if (!env.BRAINBASE_MCP_BASE_URL || (!env.BRAINBASE_MCP_TOKEN && !fetchImpl)) {
    logPhase("config", 503);
    logMcpLifecycle(lifecycleMethod, {
      status: 503,
      safeError: "BRAINBASE_PROXY_NOT_CONFIGURED",
      category: "configuration_error",
    });
    const response = Response.json({ error: { code: "BRAINBASE_PROXY_NOT_CONFIGURED", retryable: true } }, { status: 503 });
    await logJudgmentHookResponseDiagnostic(response, judgmentHookDiagnostic);
    return response;
  }
  const headers = new Headers();
  for (const name of [
    "accept", "content-type", "user-agent", "mcp-session-id", "mcp-protocol-version",
  ] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.BRAINBASE_MCP_TOKEN) headers.set("authorization", `Bearer ${env.BRAINBASE_MCP_TOKEN}`);
  if (policy?.companyAuthorityResponse !== undefined) {
    const encodedAuthority = base64UrlEncodeUtf8(JSON.stringify(policy.companyAuthorityResponse));
    if (new TextEncoder().encode(encodedAuthority).byteLength > MAX_COMPANY_AUTHORITY_HEADER_BYTES) {
      const response = Response.json({
        error: { code: "COMPANY_AUTHORITY_RESPONSE_TOO_LARGE", retryable: false },
      }, { status: 403 });
      await logJudgmentHookResponseDiagnostic(response, judgmentHookDiagnostic);
      return response;
    }
    headers.set(COMPANY_AUTHORITY_HEADER, encodedAuthority);
  }
  if (url.pathname === BRAINBASE_JUDGMENT_HOOK_PROXY_PATH) {
    const projectCode = env.BRAINBASE_JUDGMENT_PROJECT_CODE?.trim();
    if (!projectCode) {
      const response = Response.json({ error: { code: "BRAINBASE_PROXY_NOT_CONFIGURED", retryable: true } }, { status: 503 });
      await logJudgmentHookResponseDiagnostic(response, judgmentHookDiagnostic);
      return response;
    }
    headers.set("x-brainbase-project-code", projectCode);
  }
  try {
    const response = await (fetchImpl ?? fetch)(`${env.BRAINBASE_MCP_BASE_URL.replace(/\/$/, "")}${url.pathname}`, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      logMcpLifecycle(lifecycleMethod, {
        status: 502,
        safeError: "BRAINBASE_UPSTREAM_REDIRECT_REJECTED",
        category: "transport_error",
      });
      const redirectResponse = Response.json({ error: { code: "BRAINBASE_UPSTREAM_REDIRECT_REJECTED", retryable: false } }, { status: 502 });
      await logJudgmentHookResponseDiagnostic(redirectResponse, judgmentHookDiagnostic);
      return redirectResponse;
    }
    if (policy && method === "tools/list" && response.ok) {
      const filtered = await filterToolCatalogResponse(response, policy.allowedTools);
      logMcpLifecycle(lifecycleMethod, filtered.status >= 400
        ? { status: filtered.status, safeError: "BRAINBASE_MCP_TOOL_CATALOG_INVALID", category: "catalog_error" }
        : { status: filtered.status, category: "response" });
      return filtered;
    }
    logMcpLifecycle(lifecycleMethod, response.status >= 400
      ? { status: response.status, safeError: safeUpstreamError(response.status), category: lifecycleCategory(response.status) }
      : { status: response.status, category: lifecycleCategory(response.status) });
    await logJudgmentHookResponseDiagnostic(response, judgmentHookDiagnostic);
    if (toolName) {
      const diagnostic = await response.clone().text();
      console.log(JSON.stringify({
        event: "brainbase_mcp_tool_result",
        toolName,
        status: response.status,
        isError: /"isError"\s*:\s*true/u.test(diagnostic),
        errorCode: diagnostic.match(/\b(?:judgment|brainbase)_[a-z0-9_]{1,80}\b/u)?.[0] ?? null,
      }));
    }
    return new Response(response.body, { status: response.status, headers: allowedMcpResponseHeaders(response) });
  } catch (error) {
    logPhase("upstream_fetch", 502);
    logMcpLifecycle(lifecycleMethod, {
      status: 502,
      ...safeTransportFailure(error),
      category: "transport_error",
    });
    const response = Response.json({ error: { code: "BRAINBASE_UPSTREAM_UNAVAILABLE", retryable: true } }, { status: 502 });
    await logJudgmentHookResponseDiagnostic(response, judgmentHookDiagnostic);
    return response;
  }
}
