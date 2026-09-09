import type { SlackFileReference, SlackQueueEvent } from "./types.js";

const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;
const SLACK_ID_PATTERN = /^[A-Z0-9]{2,64}$/;
const SOURCE_APP_ID_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;
const SLACK_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SLACK_TIMESTAMP_PATTERN = /^\d{1,20}(?:\.\d{1,12})?$/;
const MAX_SLACK_FILE_BYTES = 20 * 1024 * 1024;

const BACKFILL_REQUEST_FIELDS = [
  "tenantId",
  "workspaceId",
  "channelId",
  "messageTs",
  "fileId",
  "sourceAppId",
] as const;

export const MEETING_MINUTES_BACKFILL_EVENT_PREFIX = "meeting_minutes_backfill_";

export interface MeetingMinutesBackfillRequest {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly fileId: string;
  /** Slack app that authored the source message, not the Events API receiver. */
  readonly sourceAppId: string;
}

/** A source observation returned by Slack history. It intentionally has no URL or credential fields. */
export interface MeetingMinutesBackfillSourceMessage {
  readonly channel?: unknown;
  readonly ts?: unknown;
  readonly thread_ts?: unknown;
  readonly app_id?: unknown;
  readonly user?: unknown;
  readonly bot_profile?: unknown;
  readonly subtype?: unknown;
  readonly text?: unknown;
  readonly files?: unknown;
}

export class MeetingMinutesBackfillValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MeetingMinutesBackfillValidationError";
    this.code = code;
  }
}

function reject(code: string): never {
  throw new MeetingMinutesBackfillValidationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) reject(code);
  return value;
}

function validTimestamp(value: unknown, code: string): string {
  return requiredString(value, SLACK_TIMESTAMP_PATTERN, code);
}

/**
 * Parse the operator payload without accepting aliases, wildcards, or fields
 * that could later be interpreted as an alternate source or event identity.
 */
export function parseMeetingMinutesBackfillRequest(value: unknown): MeetingMinutesBackfillRequest {
  if (!isRecord(value)) reject("meeting_minutes_backfill_request_invalid");
  const keys = Object.keys(value);
  if (keys.length !== BACKFILL_REQUEST_FIELDS.length
    || keys.some((key) => !(BACKFILL_REQUEST_FIELDS as readonly string[]).includes(key))) {
    reject("meeting_minutes_backfill_request_fields_invalid");
  }
  return {
    tenantId: requiredString(value.tenantId, TENANT_ID_PATTERN, "meeting_minutes_backfill_tenant_invalid"),
    workspaceId: requiredString(value.workspaceId, SLACK_ID_PATTERN, "meeting_minutes_backfill_workspace_invalid"),
    channelId: requiredString(value.channelId, SLACK_ID_PATTERN, "meeting_minutes_backfill_channel_invalid"),
    messageTs: validTimestamp(value.messageTs, "meeting_minutes_backfill_message_invalid"),
    fileId: requiredString(value.fileId, SLACK_FILE_ID_PATTERN, "meeting_minutes_backfill_file_invalid"),
    sourceAppId: requiredString(value.sourceAppId, SOURCE_APP_ID_PATTERN, "meeting_minutes_backfill_source_app_invalid"),
  };
}

/**
 * FNV-1a is used only to keep the synthetic event id bounded for Slack's
 * identity contracts. Two independently seeded 64-bit words make accidental
 * collisions very unlikely while retaining deterministic, synchronous
 * derivation in both Workers and tests.
 */
function stableWord(value: string, seed: bigint): string {
  let hash = seed;
  const prime = 1_099_511_628_211n;
  const mask = 18_446_744_073_709_551_615n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Stable synthetic event identity. It deliberately excludes fileId/sourceAppId and caller-provided event ids. */
export function deriveMeetingMinutesBackfillEventId(
  value: Pick<MeetingMinutesBackfillRequest, "workspaceId" | "channelId" | "messageTs">,
): string {
  const workspaceId = requiredString(value.workspaceId, SLACK_ID_PATTERN, "meeting_minutes_backfill_workspace_invalid");
  const channelId = requiredString(value.channelId, SLACK_ID_PATTERN, "meeting_minutes_backfill_channel_invalid");
  const messageTs = validTimestamp(value.messageTs, "meeting_minutes_backfill_message_invalid");
  const source = `${workspaceId}\0${channelId}\0${messageTs}`;
  return `${MEETING_MINUTES_BACKFILL_EVENT_PREFIX}${stableWord(source, 14_695_981_039_346_656_037n)}${stableWord(source, 10_995_116_282_11n)}`;
}

/** Backfill events already name one exact file and must retain the run id that the admin ledger observes. */
export function isMeetingMinutesBackfillEvent(value: Pick<SlackQueueEvent, "eventId">): boolean {
  return /^meeting_minutes_backfill_[0-9a-f]{32}$/.test(value.eventId);
}

function sourceFile(value: unknown): SlackFileReference | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !SLACK_FILE_ID_PATTERN.test(value.id)
    || typeof value.name !== "string" || !value.name) return undefined;
  if (value.mimetype !== undefined && typeof value.mimetype !== "string") return undefined;
  if (value.size !== undefined && (typeof value.size !== "number"
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_SLACK_FILE_BYTES)) return undefined;
  const mimetype = typeof value.mimetype === "string" ? value.mimetype : undefined;
  const size = typeof value.size === "number" ? value.size : undefined;
  return {
    id: value.id,
    name: value.name,
    ...(mimetype === undefined ? {} : { mimetype }),
    ...(size === undefined ? {} : { size }),
  };
}

/** Verify that Slack history returned the exact source requested by the operator. */
export function validateMeetingMinutesBackfillSource(
  request: MeetingMinutesBackfillRequest,
  parent: MeetingMinutesBackfillSourceMessage,
  expectedSourceUserId?: string,
): { file: SlackFileReference; threadTs: string } {
  parseMeetingMinutesBackfillRequest(request);
  if (!isRecord(parent)) reject("meeting_minutes_backfill_source_invalid");
  if (parent.channel !== request.channelId) reject("meeting_minutes_backfill_channel_mismatch");
  if (parent.ts !== request.messageTs) reject("meeting_minutes_backfill_message_mismatch");
  const botProfileAppId = isRecord(parent.bot_profile) ? parent.bot_profile.app_id : undefined;
  const trustedAuthoritySubject = expectedSourceUserId !== undefined
    && SLACK_ID_PATTERN.test(expectedSourceUserId)
    && parent.user === expectedSourceUserId;
  if (parent.app_id !== request.sourceAppId && botProfileAppId !== request.sourceAppId
    && !trustedAuthoritySubject) {
    reject("meeting_minutes_backfill_source_app_mismatch");
  }

  if (!Array.isArray(parent.files)) reject("meeting_minutes_backfill_file_missing");
  const matching = parent.files.filter((candidate) => isRecord(candidate) && candidate.id === request.fileId);
  if (matching.length === 0) reject("meeting_minutes_backfill_file_mismatch");
  if (matching.length !== 1) reject("meeting_minutes_backfill_file_ambiguous");
  const file = sourceFile(matching[0]);
  if (!file) reject("meeting_minutes_backfill_file_invalid");
  if (!/\.txt$/i.test(file.name) || (file.mimetype !== undefined && file.mimetype !== "text/plain")) {
    reject("meeting_minutes_backfill_file_type_invalid");
  }

  const threadTs = parent.thread_ts === undefined ? request.messageTs
    : validTimestamp(parent.thread_ts, "meeting_minutes_backfill_thread_invalid");
  if (typeof parent.text !== "undefined" && typeof parent.text !== "string") {
    reject("meeting_minutes_backfill_text_invalid");
  }
  if (parent.subtype !== undefined && parent.subtype !== "bot_message" && parent.subtype !== "file_share") {
    reject("meeting_minutes_backfill_subtype_invalid");
  }
  return { file, threadTs };
}

export interface MeetingMinutesBackfillEventOptions {
  readonly tenantId: string;
  readonly userId: string;
  readonly receivedAt: string;
  readonly expectedSourceUserId?: string;
}

/** Convert a verified source observation into the existing Slack queue contract. */
export function buildMeetingMinutesBackfillEvent(
  request: MeetingMinutesBackfillRequest,
  parent: MeetingMinutesBackfillSourceMessage,
  options: MeetingMinutesBackfillEventOptions,
): SlackQueueEvent {
  const parsed = parseMeetingMinutesBackfillRequest(request);
  if (options.tenantId !== parsed.tenantId || !TENANT_ID_PATTERN.test(options.tenantId)) {
    reject("meeting_minutes_backfill_tenant_mismatch");
  }
  const userId = requiredString(options.userId, SOURCE_APP_ID_PATTERN, "meeting_minutes_backfill_requester_invalid");
  if (typeof options.receivedAt !== "string" || !options.receivedAt.trim()) {
    reject("meeting_minutes_backfill_received_at_invalid");
  }
  const checked = validateMeetingMinutesBackfillSource(parsed, parent, options.expectedSourceUserId);
  const subtype = parent.subtype === "file_share" ? "file_share" : "bot_message";
  return {
    tenantId: parsed.tenantId,
    eventId: deriveMeetingMinutesBackfillEventId(parsed),
    workspaceId: parsed.workspaceId,
    channelId: parsed.channelId,
    threadTs: checked.threadTs,
    messageTs: parsed.messageTs,
    userId,
    sourceAppId: parsed.sourceAppId,
    subtype,
    eventType: "message",
    text: typeof parent.text === "string" ? parent.text : "",
    receivedAt: options.receivedAt,
    files: [checked.file],
  };
}
