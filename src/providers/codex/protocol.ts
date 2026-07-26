export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface CodexThread {
  readonly id: string;
  readonly cwd: string;
  readonly status:
    | { readonly type: 'notLoaded' | 'idle' | 'systemError' }
    | {
        readonly type: 'active';
        readonly activeFlags: readonly unknown[];
      };
}

export interface CodexTurn {
  readonly id: string;
  readonly status: string;
  readonly error: unknown;
}

export interface CodexInitializeResult {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export type CodexAccountKind = 'apiKey' | 'chatgpt' | 'amazonBedrock';

export interface CodexAccountState {
  readonly requiresOpenaiAuth: boolean;
  readonly authenticated: boolean;
  readonly accountKind: CodexAccountKind | undefined;
  readonly displayLabel: string | undefined;
}

export interface CodexConnectionState {
  readonly phase:
    | 'stopped'
    | 'connecting'
    | 'ready'
    | 'unauthenticated'
    | 'failed';
  readonly initialized: boolean;
  readonly userAgent: string | undefined;
  readonly platformFamily: string | undefined;
  readonly platformOs: string | undefined;
  readonly account: CodexAccountState | undefined;
  readonly diagnostic: string | undefined;
}

export interface CodexThreadStartRequest {
  readonly cwd: string;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandbox: CodexSandboxMode;
  readonly developerInstructions: string;
  readonly model?: string | undefined;
}

export interface CodexThreadStartResult {
  readonly thread: CodexThread;
  readonly model: string;
  readonly modelProvider: string;
  readonly cwd: string;
}

export interface CodexTurnStartRequest {
  readonly threadId: string;
  readonly text: string;
  readonly cwd?: string | undefined;
  readonly approvalPolicy?: CodexApprovalPolicy | undefined;
  readonly sandboxMode?: CodexSandboxMode | undefined;
  readonly model?: string | undefined;
}

export type CodexApprovalDecision = 'accept' | 'decline' | 'cancel';

export interface CodexApprovalAttention {
  readonly approvalId: string;
  readonly kind: 'command' | 'file-change';
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly reason: string | undefined;
  readonly command: string | undefined;
  readonly cwd: string | undefined;
  readonly requestedAt: string;
}

export type CodexAppServerEvent =
  | {
      readonly type: 'connection';
      readonly state: CodexConnectionState;
    }
  | {
      readonly type: 'thread-started' | 'thread-status';
      readonly threadId: string;
      readonly payload: unknown;
    }
  | {
      readonly type: 'turn-started' | 'turn-completed';
      readonly threadId: string;
      readonly turnId: string;
      readonly payload: unknown;
    }
  | {
      readonly type: 'output';
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly stream: 'assistant' | 'command' | 'file-change';
      readonly delta: string;
      readonly truncated: boolean;
    }
  | {
      readonly type: 'approval-requested';
      readonly approval: CodexApprovalAttention;
    }
  | {
      readonly type: 'approval-resolved';
      readonly approvalId: string;
      readonly decision: CodexApprovalDecision | 'expired';
    }
  | {
      readonly type: 'provider-error' | 'protocol-warning';
      readonly message: string;
      readonly payload?: unknown;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requiredString(
  record: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context}.${field} must be a non-empty string.`);
  }
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseThread(value: unknown, context = 'thread'): CodexThread {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  const statusValue = value['status'];
  if (!isRecord(statusValue)) throw new Error(`${context}.status must be an object.`);
  const statusType = requiredString(statusValue, 'type', `${context}.status`);
  let status: CodexThread['status'];
  if (
    statusType === 'notLoaded' ||
    statusType === 'idle' ||
    statusType === 'systemError'
  ) {
    status = { type: statusType };
  } else if (statusType === 'active') {
    const activeFlags = statusValue['activeFlags'];
    if (!Array.isArray(activeFlags)) {
      throw new Error(`${context}.status.activeFlags must be an array.`);
    }
    status = { type: 'active', activeFlags };
  } else {
    throw new Error(`${context}.status.type is unsupported: ${statusType}.`);
  }
  return {
    id: requiredString(value, 'id', context),
    cwd: requiredString(value, 'cwd', context),
    status,
  };
}

export function parseTurn(value: unknown, context = 'turn'): CodexTurn {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  return {
    id: requiredString(value, 'id', context),
    status: requiredString(value, 'status', context),
    error: value['error'],
  };
}
