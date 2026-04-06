export type AppErrorDetails = Record<string, unknown>;

export interface AppErrorShape {
  code: string;
  message: string;
  details?: AppErrorDetails;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly details?: AppErrorDetails;

  public constructor(code: string, message: string, details?: AppErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  public toJSON(): AppErrorShape {
    if (this.details === undefined) {
      return {
        code: this.code,
        message: this.message,
      };
    }

    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  public constructor(message: string, details?: AppErrorDetails) {
    super('VALIDATION_ERROR', message, details);
  }
}

export class LockUnavailableError extends AppError {
  public constructor(message = 'Workspace lock is unavailable.', details?: AppErrorDetails) {
    super('LOCK_UNAVAILABLE', message, details);
  }
}

export class InvalidLockStateError extends AppError {
  public constructor(message = 'Workspace lock is not currently held.', details?: AppErrorDetails) {
    super('INVALID_LOCK_STATE', message, details);
  }
}

export class SessionBusyError extends AppError {
  public constructor(details?: AppErrorDetails) {
    super('SESSION_BUSY', 'The agent session is already executing a turn.', details);
  }
}

export class SessionNotFoundError extends AppError {
  public constructor(details?: AppErrorDetails) {
    super('SESSION_NOT_FOUND', 'The requested agent session was not found.', details);
  }
}

export class GitOperationError extends AppError {
  public constructor(code: string, message: string, details?: AppErrorDetails) {
    super(code, message, details);
  }
}

export class DirtyWorkingTreeError extends GitOperationError {
  public constructor(details?: AppErrorDetails) {
    super(
      'DIRTY_WORKING_TREE',
      'Working tree must be clean before mutating git operations.',
      details,
    );
  }
}

export class InvalidBranchNameError extends GitOperationError {
  public constructor(branch: string, cause?: unknown) {
    super('INVALID_BRANCH_NAME', `Invalid branch name: ${branch}`, withCause({ branch }, cause));
  }
}

export class ActiveBranchDeletionError extends GitOperationError {
  public constructor(branch: string) {
    super(
      'ACTIVE_BRANCH_DELETE',
      `Cannot delete the currently checked out branch: ${branch}`,
      { branch },
    );
  }
}

export class UpstreamNotConfiguredError extends GitOperationError {
  public constructor(branch: string) {
    super(
      'UPSTREAM_NOT_CONFIGURED',
      `Branch ${branch} must track origin/${branch} before it can be pushed.`,
      { branch },
    );
  }
}

export class DetachedHeadError extends GitOperationError {
  public constructor(details?: AppErrorDetails) {
    super('DETACHED_HEAD', 'Repository is in detached HEAD state.', details);
  }
}

export function toErrorDetails(error: unknown): AppErrorDetails | undefined {
  if (error === undefined) {
    return undefined;
  }

  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  return { value: error };
}

function withCause(details: AppErrorDetails, cause?: unknown): AppErrorDetails {
  const causeDetails = toErrorDetails(cause);

  if (causeDetails === undefined) {
    return details;
  }

  return {
    ...details,
    cause: causeDetails,
  };
}