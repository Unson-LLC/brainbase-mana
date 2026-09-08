import { describe, expect, it } from "vitest";
import {
  PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION,
  PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
  projectPersonalKnowledgeDiagnostics,
} from "../reply-personal-kg-diagnostics.js";

const queryHash = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const promptBoundary: Record<string, unknown> = {
  type: "system",
  subtype: "hook_response",
  hook_event_name: "UserPromptSubmit",
};

const rawStream = (...events: readonly Record<string, unknown>[]): string =>
  `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

const stream = (...events: readonly Record<string, unknown>[]): string =>
  rawStream(promptBoundary, ...events);

const searchUse = (id: string, query = "fixture query"): Record<string, unknown> => ({
  type: "assistant",
  message: {
    content: [{
      type: "tool_use",
      id,
      name: PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
      input: { query },
    }],
  },
});

const otherUse = (id: string): Record<string, unknown> => ({
  type: "assistant",
  message: {
    content: [{
      type: "tool_use",
      id,
      name: `${PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME}_extra`,
      input: { query: "ignored" },
    }],
  },
});

const searchResult = (
  id: string,
  items: readonly Record<string, unknown>[],
  options: { isError?: boolean; asTextBlock?: boolean } = {},
): Record<string, unknown> => {
  const value = JSON.stringify({ untrusted_data: true, items });
  return {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: id,
        ...(options.isError === undefined ? {} : { is_error: options.isError }),
        content: options.asTextBlock ? [{ type: "text", text: value }] : value,
      }],
    },
  };
};

describe("projectPersonalKnowledgeDiagnostics", () => {
  it.each([{ error: "private error canary" }, { success: false }, { isError: "false" }, { is_error: true, isError: false }])("rejects structured failure envelopes %j", async (failure) => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(searchUse("toolu_failure"), {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_failure",
        content: JSON.stringify({ untrusted_data: true, items: [], ...failure }) }] },
    }));
    expect(output.success).toBeNull();
    expect(output.reason).toBe("result_invalid");
    expect(JSON.stringify(output)).not.toContain("private error canary");
  });

  it("rejects arbitrary ASCII event IDs without logging their content", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(searchUse("toolu_id"),
      searchResult("toolu_id", [{ event_id: "pke_private_secret_canary", body: "body" }])));
    expect(output.success).toBeNull();
    expect(JSON.stringify(output)).not.toContain("private_secret_canary");
  });

  it("projects a paired gateway search result and hashes query/body without exposing either", async () => {
    const query = "fixture query";
    const body = "personal-kg-body-secret-canary";
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_search_1", query),
      searchResult("toolu_search_1", [{ event_id: "pke_0958db2f1fbd5aef85c6e691", body }]),
    ));

    expect(output).toEqual({
      schemaVersion: PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION,
      toolName: PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
      success: true,
      calls: [{
        success: true,
        queryHash: await queryHash(query),
        resultEventIds: ["pke_0958db2f1fbd5aef85c6e691"],
        resultBodyHashes: [await queryHash(body)],
        resultCount: 1,
      }],
      callCount: 1,
      resultCount: 1,
      reason: "complete",
    });
    expect(JSON.stringify(output)).not.toContain(query);
    expect(JSON.stringify(output)).not.toContain(body);
  });

  it("accepts the standard MCP text content wrapper and optional body_hash metadata", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_search_2"),
      searchResult("toolu_search_2", [{ event_id: "pke_2062471bc256a782d9ec37ec", body_hash: "sha256:untrusted" }], { asTextBlock: true }),
    ));

    expect(output.success).toBe(true);
    expect(output.calls[0]).toMatchObject({
      resultEventIds: ["pke_2062471bc256a782d9ec37ec"],
      resultBodyHashes: [null],
      resultCount: 1,
    });
  });

  it("returns false for an explicit tool error and never parses error content", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_search_error"),
      searchResult("toolu_search_error", [{ event_id: "pke_f3526e27ccfaddcac3b2d289", body: "error-body-canary" }], { isError: true }),
    ));

    expect(output.success).toBe(false);
    expect(output.callCount).toBe(1);
    expect(output.resultCount).toBe(1);
    expect(output.reason).toBe("result_error");
    expect(output.calls[0]).toMatchObject({ success: false, resultEventIds: [], resultBodyHashes: [] });
    expect(JSON.stringify(output)).not.toContain("pke_f3526e27ccfaddcac3b2d289");
    expect(JSON.stringify(output)).not.toContain("error-body-canary");
  });

  it("keeps an unpaired call unknown instead of reporting a successful search", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(searchUse("toolu_search_missing")));

    expect(output).toMatchObject({
      success: null,
      callCount: 1,
      resultCount: 0,
      reason: "result_missing",
    });
    expect(output.calls[0]).toMatchObject({ success: null, resultEventIds: [], resultBodyHashes: [], resultCount: 0 });
  });

  it("requires the exact tool name and ignores other tools/results", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      otherUse("toolu_other"),
      searchResult("toolu_other", [{ event_id: "pke_9c81c8f60be44f09c92cc6ba" }]),
    ));

    expect(output).toEqual({
      schemaVersion: PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION,
      toolName: PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
      success: null,
      calls: [],
      callCount: 0,
      resultCount: 0,
      reason: "no_call",
    });
  });

  it("uses only the current prompt attempt when an earlier attempt is present", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_old", "old query"),
      searchResult("toolu_old", [{ event_id: "pke_b6235b98df3cf8098e26a7a1" }]),
      { type: "system", subtype: "hook_response", hook_event_name: "UserPromptSubmit" },
      searchUse("toolu_current", "current query"),
      searchResult("toolu_current", [{ event_id: "pke_4ae7e45ea4872ad8535f6e88" }]),
    ));

    expect(output.success).toBe(true);
    expect(output.callCount).toBe(1);
    expect(output.resultCount).toBe(1);
    expect(output.calls[0]?.resultEventIds).toEqual(["pke_4ae7e45ea4872ad8535f6e88"]);
    expect(output.calls[0]?.queryHash).toBe(await queryHash("current query"));
  });

  it("requires a current prompt boundary before projecting an exact search call", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(rawStream(
      searchUse("toolu_without_boundary"),
      searchResult("toolu_without_boundary", [{ event_id: "pke_0672a2099788da56a63fe597" }]),
    ));

    expect(output).toEqual({
      schemaVersion: PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION,
      toolName: PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
      success: null,
      calls: [],
      callCount: 0,
      resultCount: 0,
      reason: "current_attempt_missing",
    });
    expect(JSON.stringify(output)).not.toContain("pke_0672a2099788da56a63fe597");
  });

  it("ignores results for other tools instead of making a successful search partial", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      otherUse("toolu_other_result"),
      searchResult("toolu_other_result", [{ event_id: "pke_47aff4a77c511100c72812ee" }]),
      searchUse("toolu_target"),
      searchResult("toolu_target", [{ event_id: "pke_61f5182c36ef5afb45e6627a" }]),
    ));

    expect(output).toMatchObject({ success: true, callCount: 1, resultCount: 1, reason: "complete" });
    expect(output.calls[0]?.resultEventIds).toEqual(["pke_61f5182c36ef5afb45e6627a"]);
    expect(JSON.stringify(output)).not.toContain("pke_47aff4a77c511100c72812ee");
  });

  it("does not pair a result that appears before its tool_use", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchResult("toolu_out_of_order", [{ event_id: "pke_0bb34141b62316d5a785a49a" }]),
      searchUse("toolu_out_of_order"),
    ));

    expect(output).toMatchObject({ success: null, callCount: 1, resultCount: 0, reason: "result_before_call" });
    expect(output.calls[0]).toMatchObject({ success: null, resultEventIds: [], resultBodyHashes: [], resultCount: 0 });
    expect(JSON.stringify(output)).not.toContain("pke_0bb34141b62316d5a785a49a");
  });

  it("rejects an exact search id reused by another tool", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_collision"),
      otherUse("toolu_collision"),
      searchResult("toolu_collision", [{ event_id: "pke_2265a701de59587914f5fab3" }]),
    ));

    expect(output).toMatchObject({ success: null, callCount: 1, reason: "duplicate_result" });
    expect(output.calls[0]).toMatchObject({ success: null, resultEventIds: [], resultBodyHashes: [] });
    expect(JSON.stringify(output)).not.toContain("pke_2265a701de59587914f5fab3");
  });

  it("pairs multiple calls by tool_use_id and preserves their order", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_a", "query a"),
      searchUse("toolu_b", "query b"),
      searchResult("toolu_b", [{ event_id: "pke_52a0af9ab336e86997c7a6bc" }]),
      searchResult("toolu_a", [{ event_id: "pke_8db8cf35026b35bfb25631d2" }]),
    ));

    expect(output).toMatchObject({ success: true, callCount: 2, resultCount: 2, reason: "complete" });
    expect(output.calls.map((call) => call.resultEventIds)).toEqual([["pke_8db8cf35026b35bfb25631d2"], ["pke_52a0af9ab336e86997c7a6bc"]]);
  });

  it("does not choose between duplicate results for one tool_use_id", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_duplicate"),
      searchResult("toolu_duplicate", [{ event_id: "pke_ce974d4caaa68d22ca7522d7" }]),
      searchResult("toolu_duplicate", [{ event_id: "pke_5d280fcdd9e837220422d507" }]),
    ));

    expect(output).toMatchObject({ success: null, callCount: 1, resultCount: 2, reason: "duplicate_result" });
    expect(output.calls[0]).toMatchObject({ success: null, resultEventIds: [], resultBodyHashes: [] });
    expect(JSON.stringify(output)).not.toContain("pke_ce974d4caaa68d22ca7522d7");
    expect(JSON.stringify(output)).not.toContain("pke_5d280fcdd9e837220422d507");
  });

  it("treats malformed or unsafe result structure as unknown", async () => {
    const malformed = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_malformed"),
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_malformed", content: "{\"untrusted_data\":true}" }] },
      },
    ));
    expect(malformed).toMatchObject({ success: null, reason: "result_invalid" });
    expect(malformed.calls[0]).toMatchObject({ success: null, resultEventIds: [], resultBodyHashes: [] });

    const unsafeEventId = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_unsafe"),
      searchResult("toolu_unsafe", [{ event_id: "pke_ok\nsecret", body: "unsafe-body" }]),
    ));
    expect(unsafeEventId).toMatchObject({ success: null, reason: "result_invalid" });
    expect(JSON.stringify(unsafeEventId)).not.toContain("secret");

    const structuredError = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_structured_error"),
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_structured_error",
            content: JSON.stringify({
              untrusted_data: true,
              isError: true,
              items: [{ event_id: "pke_24246df2a03817db1d7fd519" }],
            }),
          }],
        },
      },
    ));
    expect(structuredError).toMatchObject({ success: null, reason: "result_invalid" });
    expect(JSON.stringify(structuredError)).not.toContain("pke_24246df2a03817db1d7fd519");
  });

  it("keeps invalid query input unknown even if a result envelope exists", async () => {
    const output = await projectPersonalKnowledgeDiagnostics(stream(
      searchUse("toolu_invalid_query", "   "),
      searchResult("toolu_invalid_query", [{ event_id: "pke_70d10e07c8b03ccf77f354f8" }]),
    ));

    expect(output).toMatchObject({ success: null, reason: "result_invalid" });
    expect(output.calls[0]).toMatchObject({ success: null, queryHash: null, resultEventIds: [], resultBodyHashes: [] });
  });

  it("bounds the stream before parsing and never emits a canary", async () => {
    const output = await projectPersonalKnowledgeDiagnostics("x".repeat(600_000));

    expect(output).toEqual({
      schemaVersion: PERSONAL_KNOWLEDGE_DIAGNOSTIC_SCHEMA_VERSION,
      toolName: PERSONAL_KNOWLEDGE_SEARCH_TOOL_NAME,
      success: null,
      calls: [],
      callCount: 0,
      resultCount: 0,
      reason: "truncated",
    });
    expect(JSON.stringify(output)).not.toContain("x".repeat(100));
  });

  it("caps calls at eight and reports the projection as truncated", async () => {
    const events: Record<string, unknown>[] = [];
    for (let index = 0; index < 9; index += 1) {
      const id = `toolu_limit_${index}`;
      events.push(searchUse(id, `query ${index}`));
      events.push(searchResult(id, [{ event_id: `pke_${index.toString(16).padStart(24, "0")}` }]));
    }

    const output = await projectPersonalKnowledgeDiagnostics(stream(...events));

    expect(output.callCount).toBe(8);
    expect(output.calls).toHaveLength(8);
    expect(output.success).toBe(null);
    expect(output.reason).toBe("truncated");
    expect(output.calls.at(-1)?.resultEventIds).toEqual(["pke_000000000000000000000007"]);
  });
});
