export type IntegrationDisposition =
  | 'direct-main'
  | 'review-branch'
  | 'blocked';

export type ChangeImpactKind =
  | 'tracked-file-delete'
  | 'history-rewrite'
  | 'force-push'
  | 'irreversible-data-change'
  | 'production-mutation'
  | 'external-publication'
  | 'credential-or-secret-change'
  | 'access-control-change'
  | 'security-policy-change'
  | 'destructive-system-command'
  | 'unknown-impact';

export interface ChangeImpactSignal {
  readonly kind: ChangeImpactKind;
  readonly detail: string;
}

export interface IntegrationImpactAssessment {
  readonly destructive: boolean;
  readonly uncertain: boolean;
  readonly requiresUserApproval: boolean;
  readonly disposition: IntegrationDisposition;
  readonly reasons: readonly string[];
}

const DESTRUCTIVE_KINDS = new Set<ChangeImpactKind>([
  'tracked-file-delete',
  'history-rewrite',
  'force-push',
  'irreversible-data-change',
  'production-mutation',
  'external-publication',
  'credential-or-secret-change',
  'access-control-change',
  'security-policy-change',
  'destructive-system-command',
]);

/**
 * Classifies integration impact conservatively. Unknown impact is never treated
 * as permission to write directly to main; it is escalated to the user just like
 * a destructive change.
 */
export function assessIntegrationImpact(
  signals: readonly ChangeImpactSignal[],
): IntegrationImpactAssessment {
  const destructiveSignals = signals.filter((signal) =>
    DESTRUCTIVE_KINDS.has(signal.kind),
  );
  const uncertainSignals = signals.filter(
    (signal) => signal.kind === 'unknown-impact',
  );
  const destructive = destructiveSignals.length > 0;
  const uncertain = uncertainSignals.length > 0;

  if (destructive || uncertain) {
    return {
      destructive,
      uncertain,
      requiresUserApproval: true,
      disposition: 'review-branch',
      reasons: [...destructiveSignals, ...uncertainSignals].map(
        (signal) => `${signal.kind}: ${signal.detail}`,
      ),
    };
  }

  return {
    destructive: false,
    uncertain: false,
    requiresUserApproval: false,
    disposition: 'direct-main',
    reasons: ['No destructive or uncertain integration signal was identified.'],
  };
}

export function reviewBranchForMission(missionId: string): string {
  const slug = missionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (slug === '') throw new TypeError('Mission ID cannot produce an empty branch name.');
  return `council/review/${slug}`;
}
