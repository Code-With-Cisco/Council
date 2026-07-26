import type { GitWorktreeEntry } from './contracts.js';

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
      path: current.path,
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
