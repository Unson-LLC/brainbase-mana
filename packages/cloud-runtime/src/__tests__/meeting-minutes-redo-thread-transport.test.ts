import { createHmac } from "node:crypto";
import { handleMeetingMinutesInteraction, updateSlackInteractionMessage,
  type TenantInteractionEffects } from "../slack-interactions.js";

const now = 1_786_420_000;
const secret = "test-secret";

it.each(["mana_meeting_minutes_redo", "mana_meeting_minutes_confirm_redo"])(
  "%s sends only one private source-thread notice through the authorized transport", async (actionId) => {
    const payload = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      message: { ts: "9.9" }, response_url: "https://hooks.slack.com/actions/T1/B1/token",
      actions: [{ action_id: actionId, action_ts: "10.0",
        value: JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt", revision: 7, sourceThreadTs: "1.0" }) }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;
    const request = new Request("https://worker/slack/interactions", { method: "POST", body,
      headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature } });
    const brokeredFetch = vi.fn().mockResolvedValue(Response.json({ ok: true, message_ts: "11.0" }));
    const unbrokeredReceipt = vi.fn();
    const send = vi.fn();
    const background: Promise<void>[] = [];
    const response = await handleMeetingMinutesInteraction(request, {
      signingSecret: secret, expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      destinations: [], send, updateOriginal: updateSlackInteractionMessage,
      updateBeforeTenant: unbrokeredReceipt, acknowledgeBeforeTenant: true,
      defer: (work) => { background.push(work); },
      resolveTenantEffects: async (source): Promise<TenantInteractionEffects> => ({
        tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV", source,
        durableObject: async (_id, _target, execute) => execute({} as never),
        brainbaseProxy: async (_id, _target, _mode, execute) => execute(brokeredFetch),
        slackDelivery: async (_id, target, _event, execute) => {
          expect(target).toMatchObject({ channel_id: "C1", thread_ts: "1.0" });
          await execute(brokeredFetch);
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await Promise.all(background);
    expect(unbrokeredReceipt).not.toHaveBeenCalled();
    expect(brokeredFetch).toHaveBeenCalledOnce();
    expect(brokeredFetch.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.postEphemeral");
    const posted = JSON.parse(brokeredFetch.mock.calls[0]?.[1].body);
    expect(posted).toMatchObject({ channel: "C1", thread_ts: "1.0", user: "U1" });
    expect(posted).not.toHaveProperty("replace_original");
    expect(posted).not.toHaveProperty("response_type");
    if (actionId === "mana_meeting_minutes_redo") {
      expect(send).not.toHaveBeenCalled();
      const button = posted.blocks.flatMap((block: { elements?: unknown[] }) => block.elements ?? [])
        .find((element: { action_id?: string }) => element.action_id === "mana_meeting_minutes_confirm_redo");
      expect(JSON.parse(button.value)).toMatchObject({ revision: 7, sourceThreadTs: "1.0" });
    } else {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "meeting_minutes_redo", revision: 7,
        channelId: "C1", threadTs: "1.0", userId: "U1" }));
    }
  },
);
