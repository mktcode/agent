import { describe, expect, it } from 'vitest';

import {
  ActiveBranchDeletionError,
  DirtyWorkingTreeError,
  DetachedHeadError,
  GitOperationError,
  InvalidBranchNameError,
  InvalidLockStateError,
  LockUnavailableError,
  NoActiveSessionError,
  SessionAlreadyExistsError,
  SessionBusyError,
  UpstreamNotConfiguredError,
  ValidationError,
} from '../src/errors';

describe('shared errors', () => {
  it('provides stable codes and deterministic messages', () => {
    const cases = [
      [new ValidationError('Invalid branch name'), 'VALIDATION_ERROR', 'Invalid branch name'],
      [new LockUnavailableError(), 'LOCK_UNAVAILABLE', 'Workspace lock is unavailable.'],
      [new InvalidLockStateError(), 'INVALID_LOCK_STATE', 'Workspace lock is not currently held.'],
      [new SessionAlreadyExistsError(), 'SESSION_ALREADY_EXISTS', 'An agent session already exists.'],
      [new NoActiveSessionError(), 'NO_ACTIVE_SESSION', 'There is no active agent session.'],
      [new SessionBusyError(), 'SESSION_BUSY', 'The agent session is already executing a turn.'],
      [new GitOperationError('LIST_BRANCHES_FAILED', 'Failed to list local branches.'), 'LIST_BRANCHES_FAILED', 'Failed to list local branches.'],
      [new DirtyWorkingTreeError(), 'DIRTY_WORKING_TREE', 'Working tree must be clean before mutating git operations.'],
      [new InvalidBranchNameError('bad..branch'), 'INVALID_BRANCH_NAME', 'Invalid branch name: bad..branch'],
      [new ActiveBranchDeletionError('main'), 'ACTIVE_BRANCH_DELETE', 'Cannot delete the currently checked out branch: main'],
      [new UpstreamNotConfiguredError('main'), 'UPSTREAM_NOT_CONFIGURED', 'Branch main must track origin/main before it can be pushed.'],
      [new DetachedHeadError(), 'DETACHED_HEAD', 'Repository is in detached HEAD state.'],
    ] as const;

    for (const [error, code, message] of cases) {
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
    }
  });

  it('serializes details as structured JSON', () => {
    const error = new InvalidBranchNameError('bad..branch', new Error('invalid ref format'));

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'INVALID_BRANCH_NAME',
      message: 'Invalid branch name: bad..branch',
      details: {
        branch: 'bad..branch',
        cause: {
          name: 'Error',
          message: 'invalid ref format',
        },
      },
    });
  });
});