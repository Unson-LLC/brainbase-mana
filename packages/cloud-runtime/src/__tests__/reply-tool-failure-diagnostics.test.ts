import { replyToolFailureDiagnostics } from "../reply-tool-failure-diagnostics.js";
const name = "mcp__brainbase__brainbase_resolve_turn";
const stream = (blocks: unknown[]) => blocks.map((block) => JSON.stringify({ message: { content: [block] } })).join("\n");
it("associates failed results by id and emits only fixed metadata", () => {
  const output = replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "private-id", name, input: { secret: "private-input" } },
    { type: "tool_use", id: "other", name: "mcp__private_tool" },
    { type: "tool_result", tool_use_id: "other", is_error: true, content: "SCHEMA_INVALID" },
    { type: "tool_result", tool_use_id: "private-id", is_error: true, content: "Bearer private-token SCHEMA_INVALID private-message" },
  ]));
  expect(output).toEqual([{ toolName: name, isError: true, errorCodes: ["SCHEMA_INVALID"], permissionDenialToolMatch: false, failureCategory: "input_validation" }]);
  expect(JSON.stringify(output)).not.toContain("private");
});
it("omits unknown codes and successful or unbound results", () => {
  expect(replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", isError: true, content: "private_unknown_code" },
    { type: "tool_result", tool_use_id: "1", is_error: false, content: "SCHEMA_INVALID" },
    { type: "tool_result", tool_use_id: "missing", is_error: true },
  ]))).toEqual([{ toolName: name, isError: true, errorCodes: [], permissionDenialToolMatch: false, failureCategory: "unknown" }]);
  expect(replyToolFailureDiagnostics("malformed\n")).toEqual([]);
});

it.each([
  ["Input validation error private content", "input_validation", undefined],
  ["Request timed out private content", "transport_timeout", undefined],
  ["HTTP error! status: 503 private content", "transport_http_error", 503],
  ["HTTP 502 private content", "transport_http_error", 502],
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
