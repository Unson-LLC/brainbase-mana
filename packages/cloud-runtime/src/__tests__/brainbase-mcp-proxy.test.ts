import { describe, expect, it, vi } from "vitest";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import { handleBrainbaseMcpProxyRequest } from "../brainbase-mcp-proxy.js";

describe("Brainbase judgment Hook proxy", () => {
  it("forwards only the verified Company Authority response supplied by the durable boundary", async () => {
    const authority = { schema_version: "1.0", actor: { canonical_person_id: "per_owner" } };
    const forward = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const encoded = new Headers(init?.headers).get("x-brainbase-company-authority-response");
      expect(encoded).toBeTruthy();
      expect(JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"))).toEqual(authority);
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", {
        method: "POST",
        headers: { "x-brainbase-company-authority-response": "hostile-input" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "brainbase_resolve_turn", arguments: {},
        } }),
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn"], companyAuthorityResponse: authority },
    );
    expect(response.status).toBe(200);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("rejects the unsupported MCP notification stream without contacting upstream", async () => {
    const forward = vi.fn();
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": "session-transport",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test", BRAINBASE_MCP_TOKEN: "token" },
      forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
    expect(await response.json()).toEqual({
      error: { code: "BRAINBASE_MCP_NOTIFICATION_STREAM_UNSUPPORTED", retryable: false },
    });
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards the DELETE MCP session transport request", async () => {
    const method = "DELETE";
    const forward = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://bb.example.test/mcp");
      expect(init?.method).toBe(method);
      expect(new Headers(init?.headers).get("mcp-session-id")).toBe("session-transport");
      expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", {
        method,
        headers: {
          "mcp-session-id": "session-transport",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test", BRAINBASE_MCP_TOKEN: "token" },
      forward as typeof fetch,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(204);
  });

  it.each([
    "{", "null", "[]",
    JSON.stringify([{ jsonrpc: "2.0", method: "tools/call", params: { name: "brainbase_admin_write" } }]),
    JSON.stringify({ jsonrpc: "2.0", method: "resources/read", params: { uri: "private://data" } }),
  ])("rejects malformed, batch and alternate A0 operations", async (body) => {
    const forward = vi.fn();
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"])("preserves required A0 MCP operation %s", async (method) => {
    const forward = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1,
      result: method === "tools/list" ? { tools: [{ name: "brainbase_resolve_turn" }] } : {} }));
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method,
        ...(method === "tools/call" ? { params: { name: "brainbase_resolve_turn", arguments: {} } } : {}),
      }) }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(200);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("forwards the MCP session ID in both directions", async () => {
    const forward = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("mcp-session-id")).toBe("session-123");
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "brainbase_resolve_turn" }] } },
        { headers: { "mcp-session-id": "session-456" } },
      );
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", {
        method: "POST",
        headers: { "mcp-session-id": "session-123" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.headers.get("mcp-session-id")).toBe("session-456");
  });

  it("exposes only company-authorized tools in a JSON catalog and safe transport headers", async () => {
    const forward = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [
      { name: "brainbase_resolve_turn", inputSchema: { type: "object" } },
      { name: "brainbase_knowledge_resolve", inputSchema: { type: "object" } },
      { name: "brainbase_admin_write", inputSchema: { type: "object" } },
    ] } }, { headers: {
      "content-type": "application/mcp+json",
      "mcp-session-id": "catalog-session",
      "set-cookie": "session=secret",
      "x-upstream-debug": "must-not-forward",
    } })) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
      }) }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn", "brainbase_knowledge_resolve"] },
    );
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "brainbase_resolve_turn", "brainbase_knowledge_resolve",
    ]);
    expect(response.headers.get("content-type")).toBe("application/mcp+json");
    expect(response.headers.get("mcp-session-id")).toBe("catalog-session");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream-debug")).toBeNull();
  });

  it("filters an event-stream catalog and fails closed for malformed success payloads", async () => {
    const catalog = { jsonrpc: "2.0", id: 1, result: { tools: [
      { name: "brainbase_resolve_turn" }, { name: "brainbase_admin_write" },
    ] } };
    for (const [upstream, expectedStatus] of [
      [new Response(`event: message\ndata: ${JSON.stringify(catalog)}\n\n`, { headers: {
        "content-type": "text/event-stream",
        "mcp-session-id": "event-stream-session",
        "set-cookie": "session=secret",
        "x-upstream-debug": "must-not-forward",
      } }), 200],
      [Response.json({ jsonrpc: "2.0", id: 1, result: {} }), 502],
    ] as const) {
      const response = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
        }) }),
        { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, vi.fn(async () => upstream.clone()) as unknown as typeof fetch,
        { allowedTools: ["brainbase_resolve_turn"] },
      );
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(await response.text()).toContain('"tools":[{"name":"brainbase_resolve_turn"}]');
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(response.headers.get("mcp-session-id")).toBe("event-stream-session");
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("x-upstream-debug")).toBeNull();
      } else {
        expect(await response.json()).toEqual({ error: { code: "BRAINBASE_MCP_TOOL_CATALOG_INVALID", retryable: true } });
      }
    }
  });

  it.each(["brainbase_admin_write", "brainbase_graph_query", "unknown_tool"])("denies A0 tool %s before forwarding", async (name) => {
    const forward = vi.fn();
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} },
      }) }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn", "brainbase_knowledge_resolve"] },
    );
    expect(response.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards only the Hook with a fixed project binding and strict headers", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
      expect(headers.get("x-brainbase-project-code")).toBe("mana");
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-forwarded-for")).toBeNull();
      expect(headers.get("x-hostile-input")).toBeNull();
      return Response.json({ decision: "allow" });
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", {
        method: "POST",
        headers: { cookie: "secret=1", "x-forwarded-for": "127.0.0.1", "x-hostile-input": "1" },
        body: "{}",
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token", BRAINBASE_JUDGMENT_PROJECT_CODE: "mana" }, fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("https://bb.unson.jp/runtime-mcp/host/judgment/hook", expect.objectContaining({ method: "POST", redirect: "manual" }));
  });

  it("rejects upstream redirects without following them", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token", BRAINBASE_JUDGMENT_PROJECT_CODE: "mana" }, fetchImpl,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "BRAINBASE_UPSTREAM_REDIRECT_REJECTED", retryable: false } });
  });

  it("returns a stable retryable error when the upstream is unavailable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network detail must not leak"); }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token", BRAINBASE_JUDGMENT_PROJECT_CODE: "mana" }, fetchImpl,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "BRAINBASE_UPSTREAM_UNAVAILABLE", retryable: true } });
  });

  it("keeps generic MCP on the caller-provided tenant credential transport", async () => {
    const tenantCredentialFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-brainbase-project-code")).toBeNull();
      return Response.json({ jsonrpc: "2.0", result: {} });
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp" }, tenantCredentialFetch,
    );
    expect(response.status).toBe(200);
    expect(tenantCredentialFetch).toHaveBeenCalledWith(
      "https://bb.unson.jp/runtime-mcp/mcp",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("fails closed for missing credentials and all non-Hook operations", async () => {
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST" }), {})).status).toBe(503);
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/mcp", { method: "POST" }), {})).status).toBe(503);
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/health"), {})).status).toBe(403);
  });
});


describe("MCP failure boundary diagnostics", () => {
  it.each(["policy", "config", "upstream_fetch"] as const)("records %s without request content", async (phase) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const toolName = phase === "policy" ? "private_tool_secret" : "brainbase_resolve_turn";
      const forward = vi.fn(async () => { throw new Error("Bearer secret transport detail"); });
      await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/mcp", {
        method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call",
          params: { name: toolName, arguments: { request: "private user content" } } }),
      }), phase === "config" ? {} : { BRAINBASE_MCP_BASE_URL: "https://example.test" },
      forward, { allowedTools: ["brainbase_resolve_turn"] });
      const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(entries).toEqual([
        { event: "brainbase_mcp_proxy_phase", toolName: phase === "policy" ? "other" : toolName, phase: "received" },
        { event: "brainbase_mcp_proxy_phase", toolName: phase === "policy" ? "other" : toolName, phase,
          status: { policy: 403, config: 503, upstream_fetch: 502 }[phase] },
      ]);
      expect(JSON.stringify(entries)).not.toMatch(/secret|private user content/);
      expect(forward).toHaveBeenCalledTimes(phase === "upstream_fetch" ? 1 : 0);
    } finally { log.mockRestore(); }
  });
});

describe("MCP lifecycle diagnostics", () => {
  it("records initialize, initialized notification, and tools/list with safe fields only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const initializeBody = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", private: "request-secret" },
    })}\n\n`;
    const catalogBody = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0", id: 2, result: { tools: [
        { name: "brainbase_resolve_turn" }, { name: "private_tool_secret" },
      ] },
    })}\n\n`;
    const responses = [
      new Response(initializeBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
      new Response(null, { status: 202 }),
      new Response(catalogBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ];
    const forward = vi.fn(async () => responses.shift()!);
    try {
      const env = { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" };
      const policy = { allowedTools: ["brainbase_resolve_turn"] };
      const initialize = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize", params: {},
        }) }), env, forward as typeof fetch, policy,
      );
      expect(initialize.status).toBe(200);
      expect(initialize.headers.get("content-type")).toContain("text/event-stream");
      expect(await initialize.text()).toContain("request-secret");

      const initialized = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", method: "notifications/initialized", params: {},
        }) }), env, forward as typeof fetch, policy,
      );
      expect(initialized.status).toBe(202);
      expect(await initialized.text()).toBe("");

      const tools = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
        }) }), env, forward as typeof fetch, policy,
      );
      expect(tools.status).toBe(200);
      expect(tools.headers.get("content-type")).toContain("text/event-stream");
      expect(await tools.text()).toContain('"tools":[{"name":"brainbase_resolve_turn"}]');

      const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(entries).toEqual([
        { event: "brainbase_mcp_lifecycle", method: "initialize", category: "request_received" },
        { event: "brainbase_mcp_lifecycle", method: "initialize", status: 200, category: "response" },
        { event: "brainbase_mcp_lifecycle", method: "notifications/initialized", category: "request_received" },
        { event: "brainbase_mcp_lifecycle", method: "notifications/initialized", status: 202, category: "response" },
        { event: "brainbase_mcp_lifecycle", method: "tools/list", category: "request_received" },
        { event: "brainbase_mcp_lifecycle", method: "tools/list", status: 200, category: "response" },
      ]);
      expect(JSON.stringify(entries)).not.toMatch(/request-secret|private_tool_secret/);
      expect(forward).toHaveBeenCalledTimes(3);
    } finally { log.mockRestore(); }
  });

  it("records an empty 204 notification response without changing it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", method: "notifications/initialized",
        }) }),
        { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" },
        vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
        { allowedTools: [] },
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "brainbase_mcp_lifecycle", method: "notifications/initialized", category: "request_received" },
        { event: "brainbase_mcp_lifecycle", method: "notifications/initialized", status: 204, category: "response" },
      ]);
    } finally { log.mockRestore(); }
  });

  it("records upstream HTTP failures without exposing the response body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize", params: {},
        }) }),
        { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" },
        vi.fn(async () => Response.json({
          jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Not Acceptable private response" },
        }, { status: 406 })) as typeof fetch,
        { allowedTools: [] },
      );
      expect(response.status).toBe(406);
      const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(entries).toEqual([
        { event: "brainbase_mcp_lifecycle", method: "initialize", category: "request_received" },
        { event: "brainbase_mcp_lifecycle", method: "initialize", status: 406,
          safeError: "BRAINBASE_UPSTREAM_HTTP_ERROR", category: "upstream_http_error" },
      ]);
      expect(JSON.stringify(entries)).not.toMatch(/Not Acceptable|private response/);
    } finally { log.mockRestore(); }
  });

  it("records transport failures with a fixed error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
        }) }),
        { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" },
        vi.fn(async () => { throw new Error("credential=private transport detail"); }) as typeof fetch,
        { allowedTools: [] },
      );
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "brainbase_mcp_lifecycle", method: "tools/list", category: "request_received" },
        { event: "brainbase_mcp_lifecycle", method: "tools/list", status: 502,
          safeError: "BRAINBASE_UPSTREAM_UNAVAILABLE", category: "transport_error" },
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/credential|private transport detail/);
    } finally { log.mockRestore(); }
  });
});


describe("MCP transport error sanitization", () => {
  it.each([
    ["CREDENTIAL_LEASE_SCOPE_MISMATCH", 403, { safeError: "CREDENTIAL_LEASE_SCOPE_MISMATCH", upstreamStatus: 403 }],
    ["CREDENTIAL_LEASE_BINDING_MISMATCH", 403, { safeError: "CREDENTIAL_LEASE_BINDING_MISMATCH", upstreamStatus: 403 }],
    ["UPSTREAM_UNAVAILABLE", "private-status", { safeError: "UPSTREAM_UNAVAILABLE" }],
    ["private-secret-code", 403, { safeError: "BRAINBASE_UPSTREAM_UNAVAILABLE" }],
  ])("sanitizes boundary error %s", async (code, status, expected) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
        }) }),
        { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" },
        vi.fn(async () => { throw new TenantBoundaryError("private-boundary", String(code),
          "private-message", { status, token: "private-token" }); }) as typeof fetch,
        { allowedTools: [] },
      );
      expect(response.status).toBe(502);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "brainbase_mcp_lifecycle", method: "initialize", category: "request_received" },
        { event: "brainbase_mcp_lifecycle", method: "initialize", status: 502,
          ...expected, category: "transport_error" },
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
    } finally { log.mockRestore(); }
  });
});
