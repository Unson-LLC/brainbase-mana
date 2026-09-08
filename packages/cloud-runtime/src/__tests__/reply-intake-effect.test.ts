import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReplyIntakeTenantBoundary, createReplyIntakeEffectFetch } from "../reply-intake-effect.js";
import type { TenantContextEnvelope } from "../multitenancy/contracts.js";
import type { SlackQueueEvent } from "../types.js";
import type { TenantInteractionEffects } from "../slack-interactions.js";

const event: SlackQueueEvent = { tenantId: "tenant", workspaceId: "T1", eventId: "Ev1",
  channelId: "D1", threadTs: "123.000001", messageTs: "123.000002", userId: "U1",
  eventType: "message", text: "test", receivedAt: "2026-09-09T00:00:00Z" };
function context(): TenantContextEnvelope {
  return {
    schema_version: "1.0", protocol_id: "mana-brainbase-tenant-context", protocol_version: "1.0",
    issuer: "brainbase", audience: ["mana-runtime"],
    correlation_id: "cor-test", operation_id: "op-test", idempotency_key: "idem-test",
    issued_at: "2026-09-09T00:00:00Z", expires_at: "2026-09-09T00:05:00Z",
    credential: { mode: "customer_oauth", credential_ref: "test", billing_principal_id: "person" },
    integrity: { method: "jws_detached", algorithm: "EdDSA", key_id: "test", value: "test" },
    tenant: { tenant_id: "tenant", tenant_revision: "1" },
    workspace_connection: { connection_id: "connection", connection_revision: "1", provider: "slack",
      installation_id: "installation", workspace_id: "T1", app_id: "A1", status: "active" },
    actor: { principal_id: "person", principal_type: "person", authenticated_subject_id: "U1" },
    authorization: { project_ids: ["project"], organization_ids: ["org"], data_scopes: [], capability_ids: ["runtime.execute"] },
    placement: { deployment_id: "deployment", profile: "shared_cloud" },
    slack: { event_id: "Ev1", channel_id: "D1", thread_ts: "123.000001", requester_id: "U1" },
    contract_revision: "1",
  };
}
const reaction = { channel: "D1", timestamp: "123.000002", name: "eyes" };
const status = { channel_id: "D1", thread_ts: "123.000001", status: "分析しています…" };
function harness() {
  const current = context();
  const provider = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
  const fallback = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ fallback: true }));
  const completed = new Set<string>();
  const delivery = vi.fn<TenantInteractionEffects["slackDelivery"]>().mockImplementation(async (id, _target, _event, execute) => {
    if (completed.has(id)) return;
    await execute(provider);
    completed.add(id);
  });
  const resolveEffects = vi.fn().mockImplementation(async (source) => ({ tenant_id: "tenant", source, slackDelivery: delivery }));
  const fetch = createReplyIntakeEffectFetch({ event, getTenantContext: () => current, resolveEffects, fallback });
  const call = (path: string, body: unknown, init: RequestInit = {}) => fetch(`https://slack.com/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret-canary" },
    body: JSON.stringify(body), ...init,
  });
  return { current, provider, fallback, delivery, resolveEffects, fetch, call };
}
afterEach(() => vi.useRealTimers());

describe("bounded Slack reply intake effects", () => {
  it("rebuilds requests from exact source coordinates and keeps the four effect owners separate", async () => {
    const h = harness();
    await h.call("reactions.add", reaction);
    await h.call("assistant.threads.setStatus", status);
    await h.call("assistant.threads.setStatus", { ...status, status: "" });
    await h.call("reactions.remove", reaction);
    expect(h.provider).toHaveBeenCalledTimes(4);
    expect(new Set(h.delivery.mock.calls.map(([id]) => id)).size).toBe(4);
    for (const [input] of h.provider.mock.calls) {
      const req = input as Request;
      expect(req.headers.has("authorization")).toBe(false);
      expect(req.redirect).toBe("manual");
      expect(new URL(req.url).origin).toBe("https://slack.com");
    }
    expect(h.resolveEffects).toHaveBeenCalledWith(expect.objectContaining({ requester_id: "U1", channel_id: "D1" }), h.current);
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it("deduplicates retries but permits a new status refresh interval", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    const h = harness();
    await h.call("reactions.add", reaction); await h.call("reactions.add", reaction);
    await h.call("assistant.threads.setStatus", status); await h.call("assistant.threads.setStatus", status);
    expect(h.provider).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 90_000);
    await h.call("assistant.threads.setStatus", status);
    expect(h.provider).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["reactions.add", { ...reaction, channel: "D2" }],
    ["reactions.add", { ...reaction, timestamp: "123.000003" }],
    ["reactions.add", { ...reaction, name: "white_check_mark" }],
    ["reactions.add", { ...reaction, token: "secret-canary" }],
    ["assistant.threads.setStatus", { ...status, thread_ts: "123.000004" }],
    ["assistant.threads.setStatus", { ...status, status: "arbitrary" }],
    ["chat.postMessage", { channel: "D1", text: "bypass" }],
  ])("rejects an unauthorized %s request before resolving credentials", async (path, body) => {
    const h = harness();
    await expect(h.call(path as string, body)).rejects.toMatchObject({ code: "AUTHORITY_SCOPE_MISMATCH" });
    expect(h.resolveEffects).not.toHaveBeenCalled(); expect(h.provider).not.toHaveBeenCalled();
  });

  it.each([
    ["https://evil.example/api/reactions.add", {}],
    ["http://slack.com/api/reactions.add", {}],
    ["https://slack.com/api/reactions.add?channel=D2", {}],
    ["https://slack.com/api/reactions.add#fragment", {}],
    ["https://slack.com/api/reactions.add", { method: "PUT" }],
    ["https://slack.com/api/reactions.add", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "channel=D2" }],
    ["https://slack.com/api/reactions.add", { body: "not-json" }],
  ])("rejects ambiguous request transport %s", async (url, override) => {
    const h = harness();
    await expect(h.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reaction), ...override }))
      .rejects.toMatchObject({ code: "AUTHORITY_SCOPE_MISMATCH" });
    expect(h.resolveEffects).not.toHaveBeenCalled();
  });

  it("preserves failed provider responses and does not mark their ownership complete", async () => {
    const h = harness();
    h.provider.mockResolvedValueOnce(Response.json({ ok: false, error: "missing_scope" }));
    expect(await (await h.call("reactions.add", reaction)).json()).toEqual({ ok: false, error: "missing_scope" });
    await h.call("reactions.add", reaction);
    expect(h.provider).toHaveBeenCalledTimes(2);
  });

  it("keeps read requests on the existing broker boundary", async () => {
    const h = harness();
    await h.fetch("https://slack.com/api/conversations.replies");
    expect(h.fallback).toHaveBeenCalledOnce(); expect(h.resolveEffects).not.toHaveBeenCalled();
  });

  it.each(["tenantId", "workspaceId", "eventId", "channelId", "threadTs", "userId"] as const)("rejects a changed source %s", async (key) => {
    const h = harness();
    const fetch = createReplyIntakeEffectFetch({ event: { ...event, [key]: "different" }, getTenantContext: () => h.current,
      resolveEffects: h.resolveEffects, fallback: h.fallback });
    await expect(fetch("https://slack.com/api/reactions.add", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...reaction, channel: key === "channelId" ? "different" : reaction.channel }) }))
      .rejects.toMatchObject({ code: "AUTHORITY_SCOPE_MISMATCH" });
  });
});

describe("intake child boundary binding", () => {
  it.each([
    ["tenant", "tenant_id"], ["tenant", "tenant_revision"],
    ["workspace_connection", "connection_id"], ["workspace_connection", "connection_revision"],
    ["workspace_connection", "installation_id"], ["workspace_connection", "workspace_id"],
    ["workspace_connection", "app_id"], ["workspace_connection", "enterprise_id"],
    ["actor", "principal_id"], ["actor", "authenticated_subject_id"], ["actor", "delegated_by"],
    ["placement", "deployment_id"], ["slack", "channel_id"], ["slack", "thread_ts"],
    ["slack", "requester_id"], ["slack", "enterprise_id"],
  ])("rejects changed %s.%s", (section, key) => {
    const initial = context(), child = context();
    (child[section as keyof TenantContextEnvelope] as unknown as Record<string, unknown>)[key] = "different";
    expect(() => assertReplyIntakeTenantBoundary(initial, child, "Ev1")).toThrow("AUTHORITY_SCOPE_MISMATCH");
  });
  it("rejects project/organization changes and accepts only the expected child event", () => {
    const initial = context(), child = context();
    child.authorization.project_ids.push("other");
    expect(() => assertReplyIntakeTenantBoundary(initial, child, "Ev1")).toThrow();
    child.authorization.project_ids = ["project"];
    child.authorization.organization_ids = ["other"];
    expect(() => assertReplyIntakeTenantBoundary(initial, child, "Ev1")).toThrow();
    child.authorization.organization_ids = ["org"];
    child.slack.event_id = "child-event";
    expect(() => assertReplyIntakeTenantBoundary(initial, child, "Ev1")).toThrow();
    expect(() => assertReplyIntakeTenantBoundary(initial, child, "child-event")).not.toThrow();
  });
});
