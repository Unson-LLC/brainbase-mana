import { adminJsonInputErrorResponse, readAdminJsonRequest } from "./admin-json-input.js";
import {
  buildMeetingMinutesBackfillEvent,
  MeetingMinutesBackfillValidationError,
  parseMeetingMinutesBackfillRequest,
  type MeetingMinutesBackfillRequest,
  type MeetingMinutesBackfillSourceMessage,
} from "./meeting-minutes-backfill.js";
import type { SlackQueueEvent } from "./types.js";

export interface MeetingMinutesBackfillExistingRun {
  readonly runId: string;
  readonly status: string;
  readonly workspaceId?: string;
  readonly sourceAppId?: string;
  readonly sourceChannelId?: string;
  readonly sourceThreadTs?: string;
  readonly sourceMessageTs?: string;
  readonly file?: { readonly id?: string; readonly name?: string };
  readonly slack?: { readonly selectionTs?: string };
}

export interface MeetingMinutesBackfillAdminDependencies {
  authorize(request: Request): Promise<boolean>;
  /** Check tenant/workspace/router channel against the already authenticated boundary. */
  isTenantScope(request: MeetingMinutesBackfillRequest): boolean | Promise<boolean>;
  /** Check the exact workspace/channel/source-app tuple in Company Authority. */
  isTrustedSource(request: MeetingMinutesBackfillRequest): boolean | Promise<boolean>;
  /** Authenticated operator identity copied into the derived queue envelope. */
  requesterId: string | ((request: MeetingMinutesBackfillRequest) => string);
  readSourceMessage(request: MeetingMinutesBackfillRequest): Promise<MeetingMinutesBackfillSourceMessage>;
  /** Existing queue producer. The stable event id is derived before this callback. */
  enqueue(event: SlackQueueEvent): Promise<void>;
  /** Reads the existing meeting-minutes ledger keyed by the stable event/file run id. */
  findRun?(runId: string): Promise<MeetingMinutesBackfillExistingRun | undefined>;
  now?(): string;
}

function response(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function isSourceValidationError(error: unknown): boolean {
  return error instanceof MeetingMinutesBackfillValidationError
    && error.code.startsWith("meeting_minutes_backfill_")
    && !error.code.includes("request_")
    && !error.code.includes("tenant_invalid")
    && !error.code.includes("workspace_invalid")
    && !error.code.includes("channel_invalid")
    && !error.code.includes("message_invalid")
    && !error.code.includes("file_invalid")
    && !error.code.includes("source_app_invalid");
}

function runMatchesEvent(run: MeetingMinutesBackfillExistingRun, event: SlackQueueEvent): boolean {
  return run.runId === `${event.eventId}_${event.files?.[0]?.id ?? ""}`
    && (run.workspaceId === undefined || run.workspaceId === event.workspaceId)
    && (run.sourceChannelId === undefined || run.sourceChannelId === event.channelId)
    && (run.sourceThreadTs === undefined || run.sourceThreadTs === event.threadTs)
    && (run.sourceMessageTs === undefined || run.sourceMessageTs === event.messageTs)
    && (run.file?.id === undefined || run.file.id === event.files?.[0]?.id)
    && (run.file?.name === undefined || run.file.name === event.files?.[0]?.name);
}

/**
 * Authenticated admin entrypoint for a one-source meeting-minutes backfill.
 * It does not post to Slack itself: the normal queue consumer owns run
 * creation and destination selection, which preserves the existing durable
 * idempotency fence for repeated requests.
 */
export async function handleMeetingMinutesBackfillAdminRequest(
  request: Request,
  dependencies: MeetingMinutesBackfillAdminDependencies,
): Promise<Response> {
  if (!(await dependencies.authorize(request))) return response("unauthorized", 401);

  let parsed: unknown;
  try {
    parsed = await readAdminJsonRequest(request);
  } catch (error) {
    const rejected = adminJsonInputErrorResponse(error);
    if (rejected) return rejected;
    throw error;
  }

  let input: MeetingMinutesBackfillRequest;
  try {
    input = parseMeetingMinutesBackfillRequest(parsed);
  } catch (error) {
    if (error instanceof MeetingMinutesBackfillValidationError) return response(error.code, 400);
    throw error;
  }
  if (!(await dependencies.isTenantScope(input))) return response("meeting_minutes_backfill_scope_mismatch", 403);
  if (!(await dependencies.isTrustedSource(input))) return response("meeting_minutes_backfill_source_untrusted", 403);

  let parent: MeetingMinutesBackfillSourceMessage;
  try {
    parent = await dependencies.readSourceMessage(input);
  } catch {
    return response("meeting_minutes_backfill_source_read_failed", 502);
  }

  let event: SlackQueueEvent;
  try {
    event = buildMeetingMinutesBackfillEvent(input, parent, {
      tenantId: input.tenantId,
      userId: typeof dependencies.requesterId === "function"
        ? dependencies.requesterId(input)
        : dependencies.requesterId,
      receivedAt: dependencies.now?.() ?? new Date().toISOString(),
    });
  } catch (error) {
    if (isSourceValidationError(error)) {
      return response((error as MeetingMinutesBackfillValidationError).code, 409);
    }
    if (error instanceof MeetingMinutesBackfillValidationError) return response(error.code, 400);
    throw error;
  }

  const file = event.files?.[0];
  if (!file) return response("meeting_minutes_backfill_file_missing", 409);
  const runId = `${event.eventId}_${file.id}`;
  let existing: MeetingMinutesBackfillExistingRun | undefined;
  if (dependencies.findRun) {
    try {
      existing = await dependencies.findRun(runId);
    } catch {
      return response("meeting_minutes_backfill_ledger_read_failed", 500);
    }
    if (existing && !runMatchesEvent(existing, event)) {
      return response("meeting_minutes_backfill_run_conflict", 409);
    }
  }

  // A persisted selector is the durable fence against duplicate Slack
  // replies. Repeated admin calls are acknowledged from the ledger only.
  if (existing?.slack?.selectionTs) {
    return Response.json({ runId, status: existing.status, enqueued: false, created: false });
  }

  try {
    await dependencies.enqueue(event);
  } catch {
    return response("meeting_minutes_backfill_enqueue_failed", 502);
  }
  return Response.json({ runId, status: existing?.status ?? "queued", enqueued: true, created: existing === undefined });
}
