export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export function processBrainbaseRpcMessage(
  message: JsonRpcRequest,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown> | null>;
