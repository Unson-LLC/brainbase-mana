import { afterEach, describe, expect, it } from "vitest";
import { processBrainbaseRpcMessage } from "../../container/brainbase-mcp-server.mjs";

afterEach(() => { delete process.env.MANA_TENANT_BOUNDARY_HANDLE; });

describe("Brainbase stdio MCP bridge", () => {
  it("forwards initialization with the tenant boundary and unwraps SSE", async () => {
    process.env.MANA_TENANT_BOUNDARY_HANDLE = "boundary-1";
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("x-mana-tenant-boundary-handle")).toBe("boundary-1");
      expect(JSON.parse(String(init?.body))).toMatchObject({ method: "initialize" });
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}}}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    };
    await expect(processBrainbaseRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, fetchImpl as typeof fetch))
      .resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { capabilities: { tools: {} } } });
  });

  it("does not emit a response for successful notifications", async () => {
    process.env.MANA_TENANT_BOUNDARY_HANDLE = "boundary-1";
    const fetchImpl = async () => new Response(null, { status: 202 });
    await expect(processBrainbaseRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, fetchImpl as typeof fetch))
      .resolves.toBeNull();
  });

  it("returns the resolver in the tool catalog before Claude starts", async () => {
    process.env.MANA_TENANT_BOUNDARY_HANDLE = "boundary-1";
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ method: "tools/list" });
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"brainbase_resolve_turn"}]}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    };
    await expect(processBrainbaseRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, fetchImpl as typeof fetch))
      .resolves.toMatchObject({ result: { tools: [{ name: "brainbase_resolve_turn" }] } });
  });
});
