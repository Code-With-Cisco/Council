import { createHash } from 'node:crypto';

/**
 * Mission conversations use an internal binding owner instead of claiming the
 * visible office profile. The execution ID makes retries stable while the
 * workspace ID prevents an execution copied from another workspace from
 * resolving to the same durable owner.
 */
export function claudeMissionBindingProfileId(
  workspaceId: string,
  missionExecutionId: string,
): string {
  const digest = createHash('sha256')
    .update(workspaceId, 'utf8')
    .update('\0', 'utf8')
    .update(missionExecutionId, 'utf8')
    .digest('hex');
  return `profile-internal-mission-${digest.slice(0, 40)}`;
}
