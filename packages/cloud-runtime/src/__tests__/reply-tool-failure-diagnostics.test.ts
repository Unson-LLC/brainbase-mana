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
  expect(output).toEqual([{ toolName: name, isError: true, errorCodes: ["SCHEMA_INVALID"] }]);
  expect(JSON.stringify(output)).not.toContain("private");
});
it("omits unknown codes and successful or unbound results", () => {
  expect(replyToolFailureDiagnostics(stream([
    { type: "tool_use", id: "1", name },
    { type: "tool_result", tool_use_id: "1", isError: true, content: "private_unknown_code" },
    { type: "tool_result", tool_use_id: "1", is_error: false, content: "SCHEMA_INVALID" },
    { type: "tool_result", tool_use_id: "missing", is_error: true },
  ]))).toEqual([{ toolName: name, isError: true, errorCodes: [] }]);
  expect(replyToolFailureDiagnostics("malformed\n")).toEqual([]);
});
