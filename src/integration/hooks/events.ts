/**
 * Typed hook payloads.
 *
 * All seven events the app subscribes to were confirmed present in the
 * installed v2.1.220 settings schema (claude-code-settings.schema.json), not
 * only in the docs: Notification, SubagentStart, SubagentStop, TaskCreated,
 * TaskCompleted, TeammateIdle, PostToolUseFailure.
 *
 * Payloads arrive from an external process, so nothing is trusted: every field
 * is optional and narrowed at the boundary.
 */

/** The subset of hook events Decagram Council subscribes to. */
export type DecagramCouncilHookEvent =
  | 'Notification'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'TeammateIdle'
  | 'PostToolUseFailure';

export const DECAGRAM_COUNCIL_HOOK_EVENTS: readonly DecagramCouncilHookEvent[] = [
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'PostToolUseFailure',
];

/**
 * Notification matcher values that mean a human is needed.
 *
 * `agent_needs_input` and `agent_completed` are the two the spec calls for;
 * `permission_prompt` and the elicitation dialogs are included because they are
 * also states where the session is parked waiting on a person.
 */
export type NotificationType =
  | 'agent_needs_input'
  | 'agent_completed'
  | 'permission_prompt'
  | 'idle_prompt'
  | 'elicitation_dialog'
  | 'elicitation_complete'
  | 'elicitation_response'
  | 'auth_success'
  | (string & {});

/** Fields present on every hook payload regardless of event. */
export interface HookBase {
  readonly hook_event_name?: string | undefined;
  /** Full session UUID. Its first 8 characters are the daemon's short id. */
  readonly session_id?: string | undefined;
  readonly prompt_id?: string | undefined;
  readonly transcript_path?: string | undefined;
  readonly cwd?: string | undefined;
  readonly permission_mode?: string | undefined;
  readonly agent_id?: string | undefined;
  readonly agent_type?: string | undefined;
}

export interface NotificationPayload extends HookBase {
  readonly notification_type?: NotificationType | undefined;
  readonly message?: string | undefined;
}

export interface SubagentPayload extends HookBase {
  readonly task?: string | undefined;
  readonly last_assistant_message?: string | undefined;
}

export interface TaskPayload extends HookBase {
  readonly task_id?: string | undefined;
  readonly task_name?: string | undefined;
  readonly task_state?: string | undefined;
  /** Deprecated since v2.1.178 — carries the session-derived name. Read, never relied on. */
  readonly team_name?: string | undefined;
}

export interface TeammateIdlePayload extends HookBase {
  readonly teammate_name?: string | undefined;
  readonly reason?: string | undefined;
  readonly team_name?: string | undefined;
}

export interface ToolFailurePayload extends HookBase {
  readonly tool_name?: string | undefined;
  readonly tool_input?: unknown;
  readonly error?: string | undefined;
}

export type HookPayload =
  | NotificationPayload
  | SubagentPayload
  | TaskPayload
  | TeammateIdlePayload
  | ToolFailurePayload;

/** A validated inbound hook delivery. */
export interface HookDelivery {
  readonly event: DecagramCouncilHookEvent;
  readonly payload: HookPayload;
  /** Short session id derived from `session_id`, for correlating with roster rows. */
  readonly shortId: string | undefined;
  readonly receivedAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Validates an inbound body.
 *
 * The event name comes from the request path rather than the payload: hook
 * scripts know which entry fired them, whereas `hook_event_name` is
 * attacker-controllable data on a socket any local process can reach.
 */
export function parseHookDelivery(event: string, body: unknown): HookDelivery | null {
  if (!(DECAGRAM_COUNCIL_HOOK_EVENTS as readonly string[]).includes(event)) return null;
  if (!isRecord(body)) return null;

  const sessionId = asString(body['session_id']);
  return {
    event: event as DecagramCouncilHookEvent,
    payload: body as HookPayload,
    shortId: sessionId?.slice(0, 8),
    receivedAt: new Date(),
  };
}

/**
 * Whether a delivery means a human is being waited on.
 *
 * This is the app's single attention channel — the amber state — so it stays
 * narrow. A completed agent is news, not a demand for a decision.
 */
export function isNeedsInput(delivery: HookDelivery): boolean {
  if (delivery.event === 'TeammateIdle') {
    const reason = (delivery.payload as TeammateIdlePayload).reason;
    return reason === 'waiting_for_user';
  }
  if (delivery.event !== 'Notification') return false;
  const type = (delivery.payload as NotificationPayload).notification_type;
  return type === 'agent_needs_input' || type === 'permission_prompt' || type === 'elicitation_dialog';
}
