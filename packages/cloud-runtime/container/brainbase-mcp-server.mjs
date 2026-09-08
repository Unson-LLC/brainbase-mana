import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://brainbase-mcp.internal/mcp";
const ACCEPT = "application/json, text/event-stream";
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function responsePayload(text, contentType) {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  throw new Error("mcp_response_missing");
}

export async function processBrainbaseRpcMessage(message, fetchImpl = fetch) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "Invalid Request");
  }
  const boundaryHandle = process.env.MANA_TENANT_BOUNDARY_HANDLE?.trim();
  if (!boundaryHandle) return rpcError(message.id, -32000, "Brainbase MCP is not configured");
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json", "x-mana-tenant-boundary-handle": boundaryHandle },
    body: JSON.stringify(message), redirect: "manual", signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response) return rpcError(message.id, -32000, "Brainbase MCP is unavailable");
  if (message.method.startsWith("notifications/") && response.ok) return null;
  const text = await response.text();
  if (!response.ok) return rpcError(message.id, -32000, `Brainbase MCP HTTP ${response.status}`);
  try {
    return responsePayload(text, response.headers.get("content-type") ?? "application/json");
  } catch {
    return rpcError(message.id, -32000, "Brainbase MCP returned an invalid response");
  }
}

async function run() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`); continue; }
    const response = await processBrainbaseRpcMessage(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => { process.exitCode = 1; });
}
