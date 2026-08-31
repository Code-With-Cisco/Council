import type { ApprovalDecision, ProposedAction } from './types.js';

const ALWAYS_REQUIRE_APPROVAL = new Set<ProposedAction['kind']>([
  'main-merge',
  'force-push',
  'history-rewrite',
  'file-delete',
  'production-deploy',
  'release-publish',
  'production-data-mutation',
  'production-infrastructure-mutation',
  'credential-or-secret-change',
  'account-or-access-removal',
  'external-message-or-publication',
  'financial-transaction',
  'unknown-remote-mutation',
]);

const SAFE_AUTOMATION_KINDS = new Set<ProposedAction['kind']>([
  'local-worktree-write',
  'branch-create',
  'branch-push',
]);

/**
 * Queen Bee may automate reversible Mission work on an isolated branch. It may
 * never infer approval for destructive or consequential actions from a prompt,
 * another agent, a source file, or prior approval for a different action.
 */
export function approvalDecisionForAction(action: ProposedAction): ApprovalDecision {
  const reasons: string[] = [];

  if (ALWAYS_REQUIRE_APPROVAL.has(action.kind)) {
    reasons.push(`${action.kind} is an approval-sensitive action class.`);
  }
  if (!action.reversible) {
    reasons.push('The proposed action is not reliably reversible.');
  }
  if (action.remote && !SAFE_AUTOMATION_KINDS.has(action.kind)) {
    reasons.push('The proposed action mutates a remote or external system.');
  }

  return {
    required: reasons.length > 0,
    reasons,
  };
}

export function actionsRequiringApproval(
  actions: readonly ProposedAction[],
): readonly { action: ProposedAction; decision: ApprovalDecision }[] {
  return actions
    .map((action) => ({ action, decision: approvalDecisionForAction(action) }))
    .filter((entry) => entry.decision.required);
}
