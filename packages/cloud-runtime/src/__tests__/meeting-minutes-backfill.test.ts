import { describe, expect, it, vi } from "vitest";

import {
  buildMeetingMinutesBackfillEvent,
  deriveMeetingMinutesBackfillEventId,
  isMeetingMinutesBackfillEvent,
  parseMeetingMinutesBackfillRequest,
  validateMeetingMinutesBackfillSource,
} from "../meeting-minutes-backfill.js";
import { handleMeetingMinutesBackfillAdminRequest } from "../meeting-minutes-backfill-entrypoints.js";

const request = {
  tenantId: "unson-business",
  workspaceId: "T123456",
  channelId: "C0BKTFQ9V38",
  messageTs: "1788948593.030659",
  fileId: "F123456",
  sourceAppId: "A_ZAPIER",
};

const parent = {
  channel: request.channelId,
  ts: request.messageTs,
  thread_ts: "1788948593.000001",
  app_id: request.sourceAppId,
  subtype: "bot_message",
  text: "議事録テキスト",
  files: [{ id: request.fileId, name: "meeting.txt", mimetype: "text/plain", size: 123 }],
};

describe("meeting minutes backfill contract", () => {
  it("accepts exactly the six immutable source fields", () => {
    expect(parseMeetingMinutesBackfillRequest(request)).toEqual(request);
  });

  it.each([
    { ...request, extra: "reject" },
    { ...request, fileId: "*" },
    { ...request, channelId: "C*" },
    { ...request, messageTs: "latest" },
    { ...request, sourceAppId: "" },
  ])("rejects unsafe or unknown request fields: $extra", (value) => {
    expect(() => parseMeetingMinutesBackfillRequest(value)).toThrow();
  });

  it("derives an event id only from workspace, channel, and message timestamp", () => {
    const eventId = deriveMeetingMinutesBackfillEventId(request);
    expect(eventId).toBe(deriveMeetingMinutesBackfillEventId({
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      messageTs: request.messageTs,
    }));
    expect(eventId).toMatch(/^meeting_minutes_backfill_[0-9a-f]{32}$/);
    expect(eventId.length).toBeLessThanOrEqual(128);
    expect(eventId).not.toContain(request.fileId);
  });

  it("marks only the derived backfill event for direct run identity", () => {
    expect(isMeetingMinutesBackfillEvent({ eventId: deriveMeetingMinutesBackfillEventId(request) })).toBe(true);
    expect(isMeetingMinutesBackfillEvent({ eventId: "ordinary-event" })).toBe(false);
  });

  it("requires the exact parent channel, message, trusted source app, and txt file", () => {
    expect(validateMeetingMinutesBackfillSource(request, parent)).toEqual({
      file: parent.files[0],
      threadTs: parent.thread_ts,
    });
    expect(() => validateMeetingMinutesBackfillSource(request, { ...parent, channel: "COTHER" })).toThrow("channel_mismatch");
    expect(() => validateMeetingMinutesBackfillSource(request, { ...parent, ts: "1788948593.030660" })).toThrow("message_mismatch");
    expect(() => validateMeetingMinutesBackfillSource(request, { ...parent, app_id: "A_OTHER" })).toThrow("source_app_mismatch");
    expect(() => validateMeetingMinutesBackfillSource(request, { ...parent, files: [{ id: request.fileId, name: "meeting.pdf" }] })).toThrow("file_type_invalid");
  });

  it("accepts Slack history's bot profile app id when legacy bot messages omit app_id", () => {
    const legacyParent = { ...parent, app_id: undefined,
      bot_profile: { app_id: request.sourceAppId } };
    expect(validateMeetingMinutesBackfillSource(request, legacyParent)).toEqual({
      file: parent.files[0], threadTs: parent.thread_ts,
    });
  });

  it("builds the queue event with the stable id and only the requested file", () => {
    const event = buildMeetingMinutesBackfillEvent(request, parent, {
      tenantId: request.tenantId,
      userId: "UADMIN",
      receivedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(event).toMatchObject({
      tenantId: request.tenantId,
      eventId: deriveMeetingMinutesBackfillEventId(request),
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      threadTs: parent.thread_ts,
      messageTs: request.messageTs,
      userId: "UADMIN",
      sourceAppId: request.sourceAppId,
      subtype: "bot_message",
      eventType: "message",
      receivedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(event.files).toEqual([parent.files[0]]);
  });

  it("authorizes, validates, and enqueues a backfill once while reusing a persisted run", async () => {
    let savedRun: { runId: string; status: "awaiting_destination"; slack: { selectionTs: string; postedChunkIndexes: number[] } } | undefined;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const requesterId = vi.fn().mockReturnValue("UADMIN");
    const dependencies = {
      authorize: vi.fn().mockResolvedValue(true),
      isTenantScope: vi.fn().mockReturnValue(true),
      isTrustedSource: vi.fn().mockReturnValue(true),
      requesterId,
      readSourceMessage: vi.fn().mockResolvedValue(parent),
      findRun: vi.fn(async () => savedRun),
      enqueue,
      now: () => "2026-09-09T00:00:00.000Z",
    };
    const makeRequest = () => new Request("https://worker.example/admin/meeting-minutes/backfill", {
      method: "POST",
      body: JSON.stringify(request),
    });
    const expectedRunId = `${deriveMeetingMinutesBackfillEventId(request)}_${request.fileId}`;

    const first = await handleMeetingMinutesBackfillAdminRequest(makeRequest(), dependencies);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      runId: expectedRunId,
      status: "queued",
      enqueued: true,
      created: true,
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(requesterId).toHaveBeenCalledWith(request);
    const queuedEvent = enqueue.mock.calls[0]?.[0];
    savedRun = { runId: expectedRunId, status: "awaiting_destination", slack: {
      selectionTs: "1788948600.000001", postedChunkIndexes: [],
    } };

    const second = await handleMeetingMinutesBackfillAdminRequest(makeRequest(), dependencies);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ status: "awaiting_destination", enqueued: false, created: false });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(queuedEvent).toMatchObject({ eventId: deriveMeetingMinutesBackfillEventId(request), files: [{ id: request.fileId }] });
  });

  it("rejects an untrusted source before reading Slack or enqueueing", async () => {
    const readSourceMessage = vi.fn();
    const enqueue = vi.fn();
    const response = await handleMeetingMinutesBackfillAdminRequest(new Request("https://worker.example/admin/meeting-minutes/backfill", {
      method: "POST", body: JSON.stringify(request),
    }), {
      authorize: vi.fn().mockResolvedValue(true),
      isTenantScope: vi.fn().mockReturnValue(true),
      isTrustedSource: vi.fn().mockReturnValue(false),
      requesterId: "UADMIN", readSourceMessage, enqueue,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "meeting_minutes_backfill_source_untrusted" });
    expect(readSourceMessage).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
