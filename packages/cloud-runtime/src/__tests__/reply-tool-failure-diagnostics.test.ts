import { replyToolFailureDiagnostics } from "../reply-tool-failure-diagnostics.js";
const name = "mcp__brainbase__brainbase_resolve_turn";
const stream = (blocks: unknown[]) => blocks.map((block) => JSON.stringify({ message: { content: [block] } })).join("\n");
const initializedStream = (status: string, tools: string[], blocks: unknown[]) => [
  JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "brainbase", status }], tools }),
  stream(blocks),
].join("\n");
it("associates failed results by id and emits only fixed metadata", () => {
  const output = replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "private-id", name, input: { secret: "private-input" } },
    { type: "tool_use", id: "other", name: "mcp__private_tool" },
    { type: "tool_result", tool_use_id: "other", is_error: true, content: "SCHEMA_INVALID" },
    { type: "tool_result", tool_use_id: "private-id", is_error: true, content: "Bearer private-token SCHEMA_INVALID private-message" },
  ]));
  expect(output).toEqual([{ toolName: name, isError: true, errorCodes: ["SCHEMA_INVALID"], permissionDenialToolMatch: false, failureCategory: "input_validation", brainbaseConnectionStatus: "unknown" }]);
  expect(JSON.stringify(output)).not.toContain("private");
});
it("omits unknown codes and successful or unbound results", () => {
  expect(replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", isError: true, content: "private_unknown_code" },
    { type: "tool_result", tool_use_id: "1", is_error: false, content: "SCHEMA_INVALID" },
    { type: "tool_result", tool_use_id: "missing", is_error: true },
  ]))).toEqual([{ toolName: name, isError: true, errorCodes: [], permissionDenialToolMatch: false, failureCategory: "unknown", brainbaseConnectionStatus: "unknown" }]);
  expect(replyToolFailureDiagnostics("malformed\n")).toEqual([]);
});

it.each([
  ["Input validation error private content", "input_validation", undefined],
  ["Request timed out private content", "transport_timeout", undefined],
  ["HTTP error! status: 503 private content", "transport_http_error", 503],
  ["HTTP 502 private content", "transport_http_error", 502],
  ["HTTP 200 private content", "unknown", 200],
  ["private identifier 503", "unknown", undefined],
])("classifies fixed failure metadata", (content, failureCategory, httpStatus) => {
  const result = replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "private-id", name },
    { type: "tool_result", tool_use_id: "private-id", is_error: true, content },
  ]));
  expect(result[0]).toMatchObject({ failureCategory, permissionDenialToolMatch: false });
  expect(result[0]?.httpStatus).toBe(httpStatus);
  expect(JSON.stringify(result)).not.toContain("private");
});
it.each([true, false])("requires exact denial tool identity (%s)", (matches) => {
  const text = stream([
    { type: "tool_use", id: "private-id", name },
    { type: "tool_result", tool_use_id: "private-id", is_error: true, content: "private" },
  ]) + "\n" + JSON.stringify({ type: "result", permission_denials: [
    { tool_use_id: "private-id", tool_name: matches ? name : "another-tool" },
  ] });
  expect(replyToolFailureDiagnostics(text)[0]).toMatchObject({
    permissionDenialToolMatch: matches, failureCategory: matches ? "pretool_denied" : "unknown",
  });
});

it("preserves the known resolver input error code", () => {
  expect(replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", is_error: true, content: "judgment_resolution_input_invalid" },
  ]))[0]?.errorCodes).toEqual(["judgment_resolution_input_invalid"]);
});

it("reports an explicit failed Brainbase initialization and an absent tool without exposing stream data", () => {
  const secret = "private-mcp-token-and-body";
  const result = replyToolFailureDiagnostics(initializedStream("failed", [], [
    { type: "tool_use", id: "private-id", name },
    { type: "tool_result", tool_use_id: "private-id", is_error: true, content: `connection closed ${secret}` },
  ]));
  expect(result).toEqual([expect.objectContaining({
    toolName: name,
    failureCategory: "connection_error",
    brainbaseConnectionStatus: "failed",
    toolAdvertised: false,
  })]);
  expect(JSON.stringify(result)).not.toContain(secret);
});

it("reports a connected Brainbase and an advertised known tool", () => {
  const result = replyToolFailureDiagnostics(initializedStream("connected", [name], [
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", is_error: true, content: "judgment_turn_resolution_binding_invalid" },
  ]));
  expect(result).toEqual([expect.objectContaining({
    toolName: name,
    errorCodes: ["judgment_turn_resolution_binding_invalid"],
    failureCategory: "unknown",
    brainbaseConnectionStatus: "connected",
    toolAdvertised: true,
  })]);
});

it("keeps initialization unknown when the init metadata is absent", () => {
  const result = replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", is_error: true, content: "No such tool" },
  ]));
  expect(result[0]).toMatchObject({
    brainbaseConnectionStatus: "unknown",
    failureCategory: "tool_unavailable",
  });
  expect(result[0]).not.toHaveProperty("toolAdvertised");
});

it("observes fixed PreToolUse Hook codes without attributing Hook text to a tool", () => {
  const secret = "private-hook-stderr";
  const preToolHook = JSON.stringify({
    type: "system", subtype: "hook_response", hook_event: "PreToolUse",
    exit_code: 2, outcome: "error", stderr: `judgment_turn_identity_mismatch ${secret}`,
  });
  const result = replyToolFailureDiagnostics([
    preToolHook,
    stream([
      { type: "tool_use", id: "1", name },
      { type: "tool_result", tool_use_id: "1", is_error: true, content: "PreToolUse hook error" },
    ]),
  ].join("\n"));
  expect(result[0]).toMatchObject({
    failureCategory: "hook_failure",
    observedPreToolHookErrorCodes: ["judgment_turn_identity_mismatch"],
  });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it("keeps only fixed JSON-RPC error codes", () => {
  const known = replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", is_error: true, content: JSON.stringify({ code: -32602, message: "private" }) },
  ]));
  expect(known[0]).toMatchObject({ jsonRpcErrorCode: -32602 });
  const unknown = replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", is_error: true, content: JSON.stringify({ code: -32001, message: "private" }) },
  ]));
  expect(unknown[0]).not.toHaveProperty("jsonRpcErrorCode");
});
