import * as path from 'node:path';
import type { GitWorktreeEntry } from './contracts.js';

/**
 * Git reports worktree paths with forward slashes on every platform:
 * `C:/Users/me/repo`, never `C:\Users\me\repo`. Node produces the native form
 * from `process.cwd()`, `path.join` and friends, so an unnormalised comparison
 * of the two never matches on Windows — worktree reconciliation would conclude
 * that a checkout it had just created did not exist.
 *
 * Normalising here keeps that conversion in one place: every consumer of a
 * worktree entry compares against Node-shaped paths.
 */
function toNativePath(value: string): string {
  return value === '' ? value : path.normalize(value);
}

export function parseWorktreePorcelain(text: string): readonly GitWorktreeEntry[] {
  const records: GitWorktreeEntry[] = [];
  let current: {
    path?: string;
    head: string | undefined;
    branchRef: string | undefined;
    detached: boolean;
    bare: boolean;
    lockedReason: string | undefined;
    prunableReason: string | undefined;
  } | undefined;

  const finish = (): void => {
    if (current === undefined) return;
    if (current.path === undefined) {
      throw new Error('Git worktree record has no path.');
    }
    records.push({
      path: toNativePath(current.path),
      head: current.head,
      branchRef: current.branchRef,
      detached: current.detached,
      bare: current.bare,
      lockedReason: current.lockedReason,
      prunableReason: current.prunableReason,
    });
    current = undefined;
  };

  for (const token of text.split('\0')) {
    if (token === '') {
      finish();
      continue;
    }
    const separator = token.indexOf(' ');
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? undefined : token.slice(separator + 1);
    if (key === 'worktree') {
      if (current !== undefined) finish();
      current = {
        path: value ?? '',
        head: undefined,
        branchRef: undefined,
        detached: false,
        bare: false,
        lockedReason: undefined,
        prunableReason: undefined,
      };
      continue;
    }
    if (current === undefined) {
      throw new Error(`Git worktree field "${key}" appeared before a worktree path.`);
    }
    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branchRef = value;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.lockedReason = value ?? '';
        break;
      case 'prunable':
        current.prunableReason = value ?? '';
        break;
      default:
        // Forward-compatible: unknown fields do not change ownership evidence.
        break;
    }
  }
  finish();
  return records;
}

export function parseStatusPorcelain(text: string): readonly string[] {
  return text.split('\0').filter((entry) => entry !== '');
}
