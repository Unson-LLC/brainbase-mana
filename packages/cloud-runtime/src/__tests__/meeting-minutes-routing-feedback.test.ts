import { createHmac } from "node:crypto";
import {
  handleMeetingMinutesInteraction,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
} from "../slack-interactions.js";

const secret = "secret";
const now = 1_786_420_000;

function request(payload: unknown, headerOverrides: Partial<Record<string, string>> = {}): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;
  return new Request("https://worker/slack/interactions", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(now),
      "x-slack-signature": signature,
      ...headerOverrides,
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

const tenantBoundary = {
  resolveTenantEffects: async (source: TenantInteractionIdentity): Promise<TenantInteractionEffects> => {
    const credentialFetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    return {
      tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      source,
      durableObject: async (_effectId, _target, execute) => execute({} as never),
      brainbaseProxy: async (_effectId, _target, _mode, execute) => execute(credentialFetch),
      slackDelivery: async (_effectId, _target, _event, execute) => execute(credentialFetch),
    };
  },
};

function basePayload(actionId: string, value: Record<string, unknown>) {
  return {
    api_app_id: "A1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "1.1", thread_ts: "1.0" },
    response_url: "https://hooks.slack.com/actions/T1/B1/token",
    actions: [{ action_id: actionId, action_ts: "1.2", value: JSON.stringify(value) }],
  };
}

function deferred() {
  const work: Promise<void>[] = [];
  return { work, defer: (promise: Promise<void>) => { work.push(promise); } };
}

function feedbackTenantIdentity(): TenantInteractionIdentity {
  return {
    app_id: "A1",
    workspace_id: "T1",
    event_id: "slack-interaction-feedback",
    channel_id: "C1",
    thread_ts: "1.0",
    requester_id: "U1",
  };
}

function expectPendingMessage(message: unknown, text: string, ephemeral = false) {
  expect(JSON.stringify(message)).toContain(text);
  expect(message).toMatchObject({ replace_original: ephemeral ? false : true });
  if (ephemeral) expect(message).toMatchObject({ response_type: "ephemeral" });
}

function expectRedoEphemeralMessage(message: unknown) {
  expect(message).toMatchObject({ replace_original: false, response_type: "ephemeral",
    channel: "C1", thread_ts: "1.0", user: "U1" });
}

const receiptText = "操作を受け付けました。確認しています。";

function expectGenericReceipt(message: unknown) {
  expect(message).toEqual({
    replace_original: false,
    response_type: "in_channel",
    thread_ts: "1.0",
    text: receiptText,
    blocks: [{ type: "section", text: { type: "plain_text", text: receiptText } }],
  });
  const serialized = JSON.stringify(message);
  expect(serialized).not.toContain("Ev1_F1");
  expect(serialized).not.toContain("定例.txt");
  expect(serialized).not.toContain("tech-knight");
  expect(serialized).not.toContain("mana");
}

function expectImmediateNavigationFeedback(message: unknown, text: string) {
  expect(message).toEqual({
    replace_original: true,
    text,
    blocks: [{ type: "section", text: { type: "plain_text", text } }],
  });
  const serialized = JSON.stringify(message);
  expect(serialized).not.toContain("Ev1_F1");
  expect(serialized).not.toContain("定例.txt");
  expect(serialized).not.toContain("tech-knight");
}

function expectActionableNavigation(message: unknown, actionId: string) {
  expect(message).toMatchObject({ replace_original: true });
  expect(JSON.stringify(message)).toContain(actionId);
}

describe("meeting minutes routing feedback", () => {
  it.each([
    {
      name: "project navigation",
      actionId: "mana_meeting_minutes_choose_organization:tech-knight",
      value: { runId: "Ev1_F1", organizationId: "tech-knight", fileName: "定例.txt" },
    },
    {
      name: "workspace navigation",
      actionId: "mana_meeting_minutes_back_to_organizations",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
    },
    {
      name: "destination selection",
      actionId: "mana_meeting_minutes_choose_destination",
      value: { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" },
    },
    {
      name: "redo confirmation",
      actionId: "mana_meeting_minutes_redo",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
    },
    {
      name: "redo processing",
      actionId: "mana_meeting_minutes_confirm_redo",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
    },
  ])("acknowledges immediately while $name waits for tenant authority", async ({ actionId, value }) => {
    let releaseTenant!: (effects: TenantInteractionEffects) => void;
    const tenantGate = new Promise<TenantInteractionEffects>((resolve) => { releaseTenant = resolve; });
    const resolveTenantEffects = vi.fn(() => tenantGate);
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const isIntakePaused = vi.fn().mockResolvedValue(false);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(basePayload(actionId, value)), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send,
      updateBeforeTenant,
      updateOriginal,
      isIntakePaused,
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    const isRedo = actionId === "mana_meeting_minutes_redo" || actionId === "mana_meeting_minutes_confirm_redo";
    const nextActionId = actionId.startsWith("mana_meeting_minutes_choose_organization:")
      ? "mana_meeting_minutes_choose_destination:board"
      : actionId === "mana_meeting_minutes_back_to_organizations"
      ? "mana_meeting_minutes_choose_organization:unson-business"
      : undefined;
    const navigationText = actionId === "mana_meeting_minutes_choose_destination"
      ? "処理の開始を確認しています…"
      : undefined;
    if (isRedo) {
      expect(updateBeforeTenant).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(updateBeforeTenant).toHaveBeenCalledOnce());
      if (nextActionId) expectActionableNavigation(updateBeforeTenant.mock.calls[0]?.[1], nextActionId);
      else if (navigationText) expectImmediateNavigationFeedback(updateBeforeTenant.mock.calls[0]?.[1], navigationText);
      else expectGenericReceipt(updateBeforeTenant.mock.calls[0]?.[1]);
    }
    await vi.waitFor(() => expect(resolveTenantEffects).toHaveBeenCalledOnce());
    expect(updateOriginal).not.toHaveBeenCalled();
    expect(isIntakePaused).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    releaseTenant(await tenantBoundary.resolveTenantEffects(feedbackTenantIdentity()));
    await Promise.all(background.work);
    expect(isIntakePaused).toHaveBeenCalledOnce();
    if (nextActionId) expect(updateOriginal).not.toHaveBeenCalled();
    else expect(updateOriginal).toHaveBeenCalled();
    if (isRedo) {
      expect(updateOriginal).toHaveBeenCalledOnce();
      expectRedoEphemeralMessage(updateOriginal.mock.calls[0]?.[1]);
    }
    if (actionId === "mana_meeting_minutes_choose_destination" ||
      actionId === "mana_meeting_minutes_confirm_redo") expect(send).toHaveBeenCalledOnce();
  });

  it("keeps the HTTP acknowledgement and routing work when the generic receipt fails", async () => {
    let releaseTenant!: (effects: TenantInteractionEffects) => void;
    const tenantGate = new Promise<TenantInteractionEffects>((resolve) => { releaseTenant = resolve; });
    const resolveTenantEffects = vi.fn(() => tenantGate);
    const updateBeforeTenant = vi.fn().mockRejectedValue(new Error("response_url timeout"));
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(basePayload(
      "mana_meeting_minutes_choose_destination",
      { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" },
    )), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send,
      updateBeforeTenant,
      updateOriginal,
      isIntakePaused: vi.fn().mockResolvedValue(false),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    releaseTenant(await tenantBoundary.resolveTenantEffects(feedbackTenantIdentity()));
    await Promise.all(background.work);
    expect(updateBeforeTenant).toHaveBeenCalledOnce();
    expect(updateOriginal).toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("delivers selector progress before tenant, intake, and send work starts", async () => {
    let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const updateBeforeTenant = vi.fn(() => receiptGate);
    let releaseTenant!: (effects: TenantInteractionEffects) => void;
    const tenantGate = new Promise<TenantInteractionEffects>((resolve) => { releaseTenant = resolve; });
    const resolveTenantEffects = vi.fn(() => tenantGate);
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(basePayload(
      "mana_meeting_minutes_choose_destination",
      { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" },
    )), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send,
      updateBeforeTenant,
      updateOriginal,
      isIntakePaused: vi.fn().mockResolvedValue(false),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(updateBeforeTenant).toHaveBeenCalledOnce());
    expect(resolveTenantEffects).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(updateOriginal).not.toHaveBeenCalled();
    expect(updateBeforeTenant).toHaveBeenCalledOnce();

    releaseReceipt();
    await vi.waitFor(() => expect(resolveTenantEffects).toHaveBeenCalledOnce());
    releaseTenant(await tenantBoundary.resolveTenantEffects(feedbackTenantIdentity()));
    await Promise.all(background.work);
    expect(send).toHaveBeenCalledOnce();
    expect(updateOriginal).toHaveBeenCalled();
  });

  it.each([
    {
      name: "invalid signature",
      payload: basePayload("mana_meeting_minutes_choose_destination",
        { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" }),
      headers: { "x-slack-signature": "v0=invalid" },
      status: 401,
    },
    {
      name: "invalid app",
      payload: { ...basePayload("mana_meeting_minutes_choose_destination",
        { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" }), api_app_id: "A2" },
      headers: {},
      status: 403,
    },
    {
      name: "invalid operator",
      payload: { ...basePayload("mana_meeting_minutes_choose_destination",
        { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" }), user: { id: "U2" } },
      headers: {},
      status: 403,
    },
    {
      name: "invalid value",
      payload: basePayload("mana_meeting_minutes_choose_destination", { destinationId: "mana", fileName: "定例.txt" }),
      headers: {},
      status: 400,
    },
  ])("does not send a receipt for $name", async ({ payload, headers, status }) => {
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const resolveTenantEffects = vi.fn(tenantBoundary.resolveTenantEffects);
    const response = await handleMeetingMinutesInteraction(request(payload, headers), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send: vi.fn().mockResolvedValue(undefined),
      updateBeforeTenant,
      defer: vi.fn(),
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(status);
    expect(updateBeforeTenant).not.toHaveBeenCalled();
    if (status !== 401 && status !== 403) expect(resolveTenantEffects).not.toHaveBeenCalled();
  });

  it("does not send a receipt for an unknown action", async () => {
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const response = await handleMeetingMinutesInteraction(request(basePayload("unknown_action", {
      runId: "Ev1_F1", fileName: "定例.txt",
    })), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      destinations,
      send: vi.fn().mockResolvedValue(undefined),
      updateBeforeTenant,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(400);
    expect(updateBeforeTenant).not.toHaveBeenCalled();
  });

  it("does not send a receipt for an unsafe response URL", async () => {
    const payload = {
      ...basePayload("mana_meeting_minutes_choose_destination", {
        runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt",
      }),
      response_url: "https://evil.example/actions/T1/token",
    };
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      destinations,
      send: vi.fn().mockResolvedValue(undefined),
      updateBeforeTenant,
      updateOriginal: vi.fn().mockResolvedValue(undefined),
      isIntakePaused: vi.fn().mockResolvedValue(false),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await Promise.all(background.work);
    expect(updateBeforeTenant).not.toHaveBeenCalled();
  });

  it("uses sourceThreadTs from the signed action value when Slack omits the message thread", async () => {
    const payload = basePayload("mana_meeting_minutes_choose_destination", {
      runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt", sourceThreadTs: "1.0",
    });
    delete (payload as { message?: unknown }).message;
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      destinations,
      send,
      updateBeforeTenant,
      updateOriginal,
      isIntakePaused: vi.fn().mockResolvedValue(false),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(updateBeforeTenant).toHaveBeenCalledOnce());
    expectImmediateNavigationFeedback(updateBeforeTenant.mock.calls[0]?.[1], "処理の開始を確認しています…");
    await Promise.all(background.work);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ threadTs: "1.0" }), expect.objectContaining({ id: "mana" }));
  });

  it("updates the selector quickly even when no source thread is available", async () => {
    let releaseTenant!: (effects: TenantInteractionEffects) => void;
    const tenantGate = new Promise<TenantInteractionEffects>((resolve) => { releaseTenant = resolve; });
    const payload = basePayload("mana_meeting_minutes_choose_destination", {
      runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt",
    });
    delete (payload as { message?: unknown }).message;
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const resolveThreadTs = vi.fn().mockResolvedValue("1.0");
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects: vi.fn(() => tenantGate),
      destinations,
      send,
      updateBeforeTenant,
      updateOriginal,
      resolveThreadTs,
      isIntakePaused: vi.fn().mockResolvedValue(false),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(updateBeforeTenant).toHaveBeenCalledOnce());
    expectImmediateNavigationFeedback(updateBeforeTenant.mock.calls[0]?.[1], "処理の開始を確認しています…");
    expect(background.work).toHaveLength(1);
    releaseTenant(await tenantBoundary.resolveTenantEffects({
      app_id: "A1", workspace_id: "T1", event_id: "slack-interaction-feedback",
      channel_id: "C1", thread_ts: "interaction:fallback", requester_id: "U1",
    }));
    await Promise.all(background.work);
    expect(resolveThreadTs).toHaveBeenCalledWith("Ev1_F1");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ threadTs: "1.0" }),
      expect.objectContaining({ id: "mana" }));
  });

  it("rejects conflicting source thread coordinates before tenant resolution", async () => {
    const payload = basePayload("mana_meeting_minutes_choose_destination", {
      runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt", sourceThreadTs: "2.0",
    });
    const resolveTenantEffects = vi.fn(tenantBoundary.resolveTenantEffects);
    const updateBeforeTenant = vi.fn();
    const response = await handleMeetingMinutesInteraction(request(payload), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send: vi.fn(),
      updateBeforeTenant,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "slack_interaction_invalid" });
    expect(resolveTenantEffects).not.toHaveBeenCalled();
    expect(updateBeforeTenant).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "project navigation",
      actionId: "mana_meeting_minutes_choose_organization:tech-knight",
      value: { runId: "Ev1_F1", organizationId: "tech-knight", fileName: "定例.txt" },
      pending: "プロジェクト一覧を開いています",
      final: "保存先プロジェクトを選択してください",
      ephemeral: false,
    },
    {
      name: "workspace navigation",
      actionId: "mana_meeting_minutes_back_to_organizations",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
      pending: "ワークスペース一覧を開いています",
      final: "保存先組織を選択してください",
      ephemeral: false,
    },
    {
      name: "destination selection",
      actionId: "mana_meeting_minutes_choose_destination",
      value: { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" },
      pending: "処理の開始を確認しています",
      final: undefined,
      ephemeral: false,
    },
    {
      name: "redo confirmation",
      actionId: "mana_meeting_minutes_redo",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
      pending: "保存先のやり直しを確認しています",
      final: "保存先をやり直しますか",
      ephemeral: true,
    },
    {
      name: "redo processing",
      actionId: "mana_meeting_minutes_confirm_redo",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
      pending: "やり直しの開始を確認しています",
      final: "保存先変更の要求を受け付けました",
      ephemeral: true,
    },
  ])("projects $name feedback before the intake gate", async ({ actionId, value, pending, final, ephemeral }) => {
    let release!: (paused: boolean) => void;
    const intakeGate = new Promise<boolean>((resolve) => { release = resolve; });
    const isIntakePaused = vi.fn(() => intakeGate);
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    let releaseTenant!: (effects: TenantInteractionEffects) => void;
    const tenantGate = new Promise<TenantInteractionEffects>((resolve) => { releaseTenant = resolve; });
    const resolveTenantEffects = vi.fn(() => tenantGate);
    const response = await handleMeetingMinutesInteraction(request(basePayload(actionId, value)), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send,
      updateOriginal,
      isIntakePaused,
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    expect(updateOriginal).not.toHaveBeenCalled();
    releaseTenant(await tenantBoundary.resolveTenantEffects(feedbackTenantIdentity()));
    await vi.waitFor(() => expect(isIntakePaused).toHaveBeenCalledOnce());
    const isRedo = ephemeral;
    if (isRedo) {
      expect(updateOriginal).not.toHaveBeenCalled();
    } else {
      expect(updateOriginal).toHaveBeenCalledOnce();
      expectPendingMessage(updateOriginal.mock.calls[0]?.[1], pending, ephemeral);
    }
    expect(isIntakePaused).toHaveBeenCalledOnce();
    if (!isRedo) expect(updateOriginal.mock.invocationCallOrder[0]).toBeLessThan(isIntakePaused.mock.invocationCallOrder[0]!);

    release(false);
    await Promise.all(background.work);
    if (isRedo) {
      expect(updateOriginal).toHaveBeenCalledOnce();
      expectRedoEphemeralMessage(updateOriginal.mock.calls[0]?.[1]);
    }
    if (final) expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain(final);
    if (actionId === "mana_meeting_minutes_choose_destination") expect(send).toHaveBeenCalledOnce();
    if (actionId === "mana_meeting_minutes_confirm_redo") expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "redo confirmation",
      actionId: "mana_meeting_minutes_redo",
    },
    {
      name: "redo processing",
      actionId: "mana_meeting_minutes_confirm_redo",
    },
  ])("keeps the $name pause notice ephemeral", async ({ actionId }) => {
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(basePayload(actionId,
      { runId: "Ev1_F1", fileName: "定例.txt" })), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      destinations,
      send,
      updateOriginal,
      isIntakePaused: vi.fn().mockResolvedValue(true),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledOnce();
    expectRedoEphemeralMessage(updateOriginal.mock.calls[0]?.[1]);
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("受付は一時停止中");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "redo confirmation",
      actionId: "mana_meeting_minutes_redo",
    },
    {
      name: "redo processing",
      actionId: "mana_meeting_minutes_confirm_redo",
    },
  ])("keeps the $name intake error ephemeral", async ({ actionId }) => {
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(basePayload(actionId,
      { runId: "Ev1_F1", fileName: "定例.txt" })), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      destinations,
      send,
      updateOriginal,
      isIntakePaused: vi.fn().mockRejectedValue(new Error("raw Bearer secret")),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledOnce();
    expectRedoEphemeralMessage(updateOriginal.mock.calls[0]?.[1]);
    const projected = JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1]);
    expect(projected).toContain("temporary_failure");
    expect(projected).not.toContain("Bearer secret");
    expect(send).not.toHaveBeenCalled();
  });
});
