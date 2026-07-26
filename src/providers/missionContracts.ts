export type CouncilProviderId = 'claude-code' | 'codex';
export type CouncilAccessMode = 'read-only' | 'workspace-write';
export type MissionApprovalDecision = 'accept' | 'decline' | 'cancel';

export interface MissionProviderStatus {
  readonly providerId: CouncilProviderId;
  readonly displayName: string;
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly persistentConversations: boolean;
  readonly approvals: boolean;
  readonly diagnostic: string | undefined;
}

export interface MissionRoleAssignment {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly roleProfileId: string;
  readonly roleInstructions: string;
  readonly requestFingerprint: string;
  readonly accessMode: CouncilAccessMode;
  readonly model?: string | undefined;
}

export interface MissionConversation {
  readonly providerId: CouncilProviderId;
  readonly providerConversationId: string;
  readonly assignmentId: string;
  readonly resumed: boolean;
}

export interface MissionTurn {
  readonly providerId: CouncilProviderId;
  readonly providerConversationId: string;
  readonly providerTurnId: string;
  readonly assignmentId: string;
}

export type MissionProviderEvent =
  | {
      readonly type: 'status';
      readonly providerId: CouncilProviderId;
      readonly status: MissionProviderStatus;
    }
  | {
      readonly type: 'conversation';
      readonly providerId: CouncilProviderId;
      readonly providerConversationId: string;
      readonly assignmentId: string | undefined;
      readonly state: 'started' | 'idle' | 'active' | 'failed';
    }
  | {
      readonly type: 'turn';
      readonly providerId: CouncilProviderId;
      readonly providerConversationId: string;
      readonly providerTurnId: string;
      readonly assignmentId: string | undefined;
      readonly state: 'started' | 'completed' | 'failed' | 'interrupted';
    }
  | {
      readonly type: 'output';
      readonly providerId: CouncilProviderId;
      readonly providerConversationId: string;
      readonly providerTurnId: string;
      readonly assignmentId: string | undefined;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly type: 'approval';
      readonly providerId: CouncilProviderId;
      readonly approvalId: string;
      readonly assignmentId: string | undefined;
      readonly state: 'pending' | 'resolved' | 'expired';
      readonly kind?: 'command' | 'file-change' | undefined;
      readonly decision?: MissionApprovalDecision | undefined;
      readonly summary?: string | undefined;
    }
  | {
      readonly type: 'error';
      readonly providerId: CouncilProviderId;
      readonly message: string;
    };

export type MissionProviderFailureKind =
  | 'unavailable'
  | 'unauthenticated'
  | 'unsupported'
  | 'invalid-assignment'
  | 'conflict'
  | 'provider-failure'
  | 'uncertain-outcome'
  | 'shutting-down';

export type MissionProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: MissionProviderFailureKind;
      readonly message: string;
    };

export interface MissionAgentProviderAdapter {
  readonly providerId: CouncilProviderId;
  readonly status: MissionProviderStatus;

  connect(): Promise<MissionProviderStatus>;
  ensureConversation(
    assignment: MissionRoleAssignment,
    expectedBindingRevision: number,
  ): Promise<MissionProviderResult<MissionConversation>>;
  resumeConversation(
    assignmentId: string,
  ): Promise<MissionProviderResult<MissionConversation>>;
  dispatchTurn(
    assignmentId: string,
    taskPrompt: string,
  ): Promise<MissionProviderResult<MissionTurn>>;
  interruptTurn(
    assignmentId: string,
  ): Promise<MissionProviderResult<void>>;
  resolveApproval(
    approvalId: string,
    decision: MissionApprovalDecision,
  ): Promise<MissionProviderResult<void>>;
  recentOutput(assignmentId: string): string;
  onEvent(listener: (event: MissionProviderEvent) => void): () => void;
  shutdown(): Promise<void>;
}
