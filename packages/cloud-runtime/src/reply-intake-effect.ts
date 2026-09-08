import type { SlackQueueEvent } from "./types.js";
import type { TenantContextEnvelope } from "./multitenancy/contracts.js";
import { deny } from "./multitenancy/errors.js";
import type {
  TenantInteractionEffects,
  TenantInteractionIdentity,
  TenantInteractionTarget,
} from "./slack-interactions.js";

const SLACK_ORIGIN = "https://slack.com";
const REACTION_NAME = "eyes";
const THREAD_STATUSES = new Set(["分析しています…", ""]);

type ReplyIntakeEffect =
  | {
      kind: "reaction";
      action: "add" | "remove";
      path: "/api/reactions.add" | "/api/reactions.remove";
      body: { channel: string; timestamp: string; name: typeof REACTION_NAME };
      effectId: "reply-intake:reaction:add" | "reply-intake:reaction:remove";
    }
  | {
      kind: "thread_status";
      status: "分析しています…" | "";
      path: "/api/assistant.threads.setStatus";
      body: { channel_id: string; thread_ts: string; status: "分析しています…" | "" };
      effectId: `reply-intake:status:set:${number}` | "reply-intake:status:clear";
    };

export interface ReplyIntakeEffectOptions {
  event: SlackQueueEvent;
  getTenantContext(): TenantContextEnvelope;
  resolveEffects(identity: TenantInteractionIdentity, context: TenantContextEnvelope): Promise<TenantInteractionEffects>;
  fallback(request: Request): Promise<Response>;
}

class ProviderResponseRejected extends Error {
  constructor(readonly response: Response) {
    super("reply_intake_provider_response_rejected");
    this.name = "ProviderResponseRejected";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function reject(): never {
  return deny("slack_delivery", "AUTHORITY_SCOPE_MISMATCH");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function parseEffect(request: Request, event: SlackQueueEvent): Promise<ReplyIntakeEffect> {
  const path = new URL(request.url).pathname;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (request.method !== "POST" || contentType !== "application/json") reject();

  let value: unknown;
  try {
    value = JSON.parse(await request.clone().text()) as unknown;
  } catch {
    reject();
  }
  const body = record(value);
  if (!body) reject();

  if (path === "/api/reactions.add" || path === "/api/reactions.remove") {
    if (!exactKeys(body, ["channel", "timestamp", "name"])
      || body.channel !== event.channelId
      || body.timestamp !== event.messageTs
      || body.name !== REACTION_NAME) reject();
    return {
      kind: "reaction",
      action: path.endsWith(".add") ? "add" : "remove",
      path,
      body: {
        channel: event.channelId,
        timestamp: event.messageTs,
        name: REACTION_NAME,
      },
      effectId: path.endsWith(".add")
        ? "reply-intake:reaction:add"
        : "reply-intake:reaction:remove",
    };
  }

  if (path === "/api/assistant.threads.setStatus") {
    if (!exactKeys(body, ["channel_id", "thread_ts", "status"])
      || body.channel_id !== event.channelId
      || body.thread_ts !== event.threadTs
      || typeof body.status !== "string"
      || !THREAD_STATUSES.has(body.status)) reject();
    const status = body.status as "分析しています…" | "";
    return {
      kind: "thread_status",
      status,
      path,
      body: {
        channel_id: event.channelId,
        thread_ts: event.threadTs,
        status,
      },
      effectId: status === ""
        ? "reply-intake:status:clear"
        : `reply-intake:status:set:${Math.floor(Date.now() / 90_000)}`,
    };
  }

  reject();
}

function sourceIdentity(options: ReplyIntakeEffectOptions): TenantInteractionIdentity {
  const { event } = options;
  const context = options.getTenantContext();
  const appId = context.workspace_connection.app_id;
  const enterpriseId = context.workspace_connection.enterprise_id
    ?? context.slack.enterprise_id;
  const requesterId = context.slack.requester_id;
  if (!appId
    || context.tenant.tenant_id !== event.tenantId
    || context.workspace_connection.workspace_id !== event.workspaceId
    || context.slack.event_id !== event.eventId
    || context.slack.channel_id !== event.channelId
    || context.slack.thread_ts !== event.threadTs
    || !event.userId
    || context.actor.authenticated_subject_id !== event.userId
    || requesterId !== event.userId
    || (context.workspace_connection.enterprise_id !== undefined
      && context.slack.enterprise_id !== undefined
      && context.workspace_connection.enterprise_id !== context.slack.enterprise_id)) {
    reject();
  }
  return {
    app_id: appId,
    workspace_id: event.workspaceId,
    ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
    event_id: event.eventId,
    channel_id: event.channelId,
    thread_ts: event.threadTs,
    requester_id: event.userId,
  };
}

/** Preserve the accepted source boundary while allowing only the derived event identity. */
export function assertReplyIntakeTenantBoundary(
  initial: TenantContextEnvelope,
  resolved: TenantContextEnvelope,
  expectedEventId: string,
): void {
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (resolved.tenant.tenant_id !== initial.tenant.tenant_id
    || resolved.tenant.tenant_revision !== initial.tenant.tenant_revision
    || resolved.workspace_connection.connection_id !== initial.workspace_connection.connection_id
    || resolved.workspace_connection.connection_revision !== initial.workspace_connection.connection_revision
    || resolved.workspace_connection.provider !== initial.workspace_connection.provider
    || resolved.workspace_connection.installation_id !== initial.workspace_connection.installation_id
    || resolved.workspace_connection.workspace_id !== initial.workspace_connection.workspace_id
    || resolved.workspace_connection.enterprise_id !== initial.workspace_connection.enterprise_id
    || resolved.workspace_connection.app_id !== initial.workspace_connection.app_id
    || resolved.workspace_connection.status !== initial.workspace_connection.status
    || resolved.actor.principal_id !== initial.actor.principal_id
    || resolved.actor.principal_type !== initial.actor.principal_type
    || resolved.actor.authenticated_subject_id !== initial.actor.authenticated_subject_id
    || resolved.actor.delegated_by !== initial.actor.delegated_by
    || resolved.authorization.project_ids[0] !== initial.authorization.project_ids[0]
    || !sameSet(resolved.authorization.project_ids, initial.authorization.project_ids)
    || !sameSet(resolved.authorization.organization_ids, initial.authorization.organization_ids)
    || !sameSet(resolved.authorization.data_scopes, initial.authorization.data_scopes)
    || !sameSet(resolved.authorization.capability_ids, initial.authorization.capability_ids)
    || resolved.placement.deployment_id !== initial.placement.deployment_id
    || resolved.placement.profile !== initial.placement.profile
    || resolved.contract_revision !== initial.contract_revision
    || resolved.slack.event_id !== expectedEventId
    || resolved.slack.channel_id !== initial.slack.channel_id
    || resolved.slack.enterprise_id !== initial.slack.enterprise_id
    || resolved.slack.thread_ts !== initial.slack.thread_ts
    || resolved.slack.requester_id !== initial.slack.requester_id) reject();
}

function targetFor(source: TenantInteractionIdentity): TenantInteractionTarget {
  return {
    app_id: source.app_id,
    workspace_id: source.workspace_id,
    ...(source.enterprise_id ? { enterprise_id: source.enterprise_id } : {}),
    channel_id: source.channel_id,
    thread_ts: source.thread_ts,
    requester_id: source.requester_id,
  };
}

async function assertProviderAccepted(response: Response, effect: ReplyIntakeEffect): Promise<void> {
  if (!response.ok) throw new ProviderResponseRejected(response);
  let payload: unknown;
  try {
    payload = await response.clone().json() as unknown;
  } catch {
    throw new ProviderResponseRejected(response);
  }
  const body = record(payload);
  const acceptedIdempotentError = effect.kind === "reaction"
    && ((effect.action === "add" && body?.error === "already_reacted")
      || (effect.action === "remove" && body?.error === "no_reaction"));
  if (body?.ok !== true && !acceptedIdempotentError) throw new ProviderResponseRejected(response);
}

/**
 * Add the four bounded Slack intake effects to the existing tenant credential
 * fetch. Any other Slack write remains denied by the caller's fallback.
 */
export function createReplyIntakeEffectFetch(options: ReplyIntakeEffectOptions): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const knownPath = target.pathname === "/api/reactions.add"
      || target.pathname === "/api/reactions.remove"
      || target.pathname === "/api/assistant.threads.setStatus";

    if (!knownPath) {
      if (target.hostname === "slack.com" && request.method !== "GET") reject();
      return options.fallback(request);
    }
    if (target.origin !== SLACK_ORIGIN || target.search || target.hash) reject();

    const effect = await parseEffect(request, options.event);
    const source = sourceIdentity(options);
    const effects = await options.resolveEffects(source, options.getTenantContext());
    const targetScope = targetFor(source);
    let observed: Response | undefined;
    try {
      await effects.slackDelivery(
        effect.effectId,
        targetScope,
        { kind: "reply_intake_effect", operation: effect.effectId },
        async (tenantFetch) => {
          const rebuilt = new Request(`${SLACK_ORIGIN}${effect.path}`, {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify(effect.body),
            signal: request.signal,
          });
          const response = await tenantFetch(rebuilt);
          observed = response;
          await assertProviderAccepted(response, effect);
        },
      );
    } catch (error) {
      if (error instanceof ProviderResponseRejected) return error.response;
      throw error;
    }
    // A completed idempotency claim skips the callback. It is already a
    // successful effect, so provide the same minimal response shape to the
    // shared pipeline without inventing provider data.
    return observed ?? Response.json({ ok: true });
  };
}
