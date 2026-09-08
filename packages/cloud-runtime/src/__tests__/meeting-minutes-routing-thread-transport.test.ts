import { createHmac } from "node:crypto";
import {
  handleMeetingMinutesInteraction,
  updateSlackInteractionMessage,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
} from "../slack-interactions.js";

const secret = "secret";
const now = 1_786_420_000;
const responseUrl = "https://hooks.slack.com/actions/T1/B1/token";

function request(payload: unknown): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;
  return new Request("https://worker/slack/interactions", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(now),
      "x-slack-signature": signature,
    },
  });
}

const destinations = [
  {
    id: "mana",
    projectId: "p1",
    contextProjectCode: "back-office",
    taskProjectCodes: ["back-office"],
    taskBoardTargetId: "minutes-back-office",
    name: "Back Office",
    organization: { id: "unson-business", name: "雲孫 事業運営" },
    slackChannelId: "C2",
    github: { owner: "Unson-LLC", repo: "back_office" },
  },
  {
    id: "board",
    projectId: "p2",
    contextProjectCode: "techknight",
    taskProjectCodes: ["techknight"],
    taskBoardTargetId: "minutes-board",
    name: "ボード定例",
    organization: { id: "tech-knight", name: "Tech Knight" },
    slackChannelId: "C3",
    github: { owner: "Tech-Knight-inc", repo: "tech-knight-project" },
  },
];

function payload(actionId: string, value: Record<string, unknown>) {
  return {
    api_app_id: "A1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "9.9", thread_ts: "1.0" },
    response_url: responseUrl,
    actions: [{ action_id: actionId, action_ts: "1.2", value: JSON.stringify(value) }],
  };
}

function deferred() {
  const work: Promise<void>[] = [];
  return { work, defer: (promise: Promise<void>) => { work.push(promise); } };
}

function tenantEffects(source: TenantInteractionIdentity, fetchImpl: typeof fetch): TenantInteractionEffects {
  return {
    tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    source,
    durableObject: async (_effectId, _target, execute) => execute({} as never),
    brainbaseProxy: async (_effectId, _target, _mode, execute) => execute(fetchImpl),
    slackDelivery: async (_effectId, _target, _event, execute) => execute(fetchImpl),
  };
}

function sourceIdentity(): TenantInteractionIdentity {
  return {
    app_id: "A1",
    workspace_id: "T1",
    event_id: "slack-interaction-thread-transport",
    channel_id: "C1",
    thread_ts: "1.0",
    requester_id: "U1",
  };
}

describe("meeting minutes routing thread transport", () => {
  it.each([
    {
      name: "project navigation",
      actionId: "mana_meeting_minutes_choose_organization:tech-knight",
      value: { runId: "Ev1_F1", organizationId: "tech-knight", fileName: "Meeting secret.txt" },
    },
    {
      name: "workspace navigation",
      actionId: "mana_meeting_minutes_back_to_organizations",
      value: { runId: "Ev1_F1", fileName: "Meeting secret.txt" },
    },
    {
      name: "destination selection",
      actionId: "mana_meeting_minutes_choose_destination",
      value: { runId: "Ev1_F1", destinationId: "mana", fileName: "Meeting secret.txt" },
    },
  ])("sends the $name receipt to the validated source thread before tenant resolution", async ({ actionId, value }) => {
    let releaseTenant!: (effects: TenantInteractionEffects) => void;
    const tenantGate = new Promise<TenantInteractionEffects>((resolve) => { releaseTenant = resolve; });
    const slackFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const resolveTenantEffects = vi.fn(() => tenantGate);
    const send = vi.fn().mockResolvedValue(undefined);
    const updateOriginal = (url: string, message: Parameters<typeof updateSlackInteractionMessage>[1],
      fetchImpl: typeof fetch) => updateSlackInteractionMessage(url, message, fetchImpl);
    const updateBeforeTenant = (url: string, message: Parameters<typeof updateSlackInteractionMessage>[1]) =>
      updateSlackInteractionMessage(url, message, slackFetch);
    const background = deferred();
    const interactionPayload = payload(actionId, value);

    const response = await handleMeetingMinutesInteraction(request(interactionPayload), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      destinations,
      send,
      resolveTenantEffects,
      updateOriginal,
      updateBeforeTenant,
      isIntakePaused: vi.fn().mockResolvedValue(false),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(resolveTenantEffects).toHaveBeenCalledOnce();

    try {
      await vi.waitFor(() => expect(slackFetch).toHaveBeenCalledOnce());
      const [url, init] = slackFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(responseUrl);
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      const receipt = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(receipt).toEqual({
        replace_original: false,
        response_type: "in_channel",
        thread_ts: "1.0",
        text: "操作を受け付けました。確認しています。",
        blocks: [{ type: "section", text: { type: "plain_text", text: "操作を受け付けました。確認しています。" } }],
      });
      const serialized = JSON.stringify(receipt);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("Ev1_F1");
      expect(serialized).not.toContain("Meeting secret.txt");
      expect(serialized).not.toContain("U1");
    } finally {
      releaseTenant(tenantEffects(sourceIdentity(), slackFetch as unknown as typeof fetch));
      await Promise.all(background.work);
    }
  });
});
