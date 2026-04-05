import { simpleGit, type SimpleGit } from 'simple-git';

type ConfigValue = string | string[] | undefined;

export interface GitServiceOptions {
  workspacePath: string;
}

export class GitServiceError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  public constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'GitServiceError';
    this.code = code;
    this.cause = cause;
  }
}

export class DirtyWorkingTreeError extends GitServiceError {
  public constructor() {
    super('DIRTY_WORKING_TREE', 'Working tree must be clean before mutating git operations.');
    this.name = 'DirtyWorkingTreeError';
  }
}

export class InvalidBranchNameError extends GitServiceError {
  public constructor(branch: string, cause?: unknown) {
    super('INVALID_BRANCH_NAME', `Invalid branch name: ${branch}`, cause);
    this.name = 'InvalidBranchNameError';
  }
}

export class ActiveBranchDeletionError extends GitServiceError {
  public constructor(branch: string) {
    super('ACTIVE_BRANCH_DELETE', `Cannot delete the currently checked out branch: ${branch}`);
    this.name = 'ActiveBranchDeletionError';
  }
}

export class UpstreamNotConfiguredError extends GitServiceError {
  public constructor(branch: string) {
    super(
      'UPSTREAM_NOT_CONFIGURED',
      `Branch ${branch} must track origin/${branch} before it can be pushed.`,
    );
    this.name = 'UpstreamNotConfiguredError';
  }
}

export class DetachedHeadError extends GitServiceError {
  public constructor() {
    super('DETACHED_HEAD', 'Repository is in detached HEAD state.');
    this.name = 'DetachedHeadError';
  }
}

export class GitService {
  readonly #git: SimpleGit;

  public constructor(options: GitServiceOptions) {
    this.#git = simpleGit(options.workspacePath);
  }

  public async listBranches(): Promise<string[]> {
    try {
      const branchSummary = await this.#git.branchLocal();
      return [...branchSummary.all].sort((left, right) => left.localeCompare(right));
    } catch (error) {
      throw new GitServiceError('LIST_BRANCHES_FAILED', 'Failed to list local branches.', error);
    }
  }

  public async checkout(branch: string): Promise<void> {
    await this.#validateBranchName(branch);
    await this.#assertCleanWorkingTree();

    try {
      const branchSummary = await this.#git.branchLocal();

      if (branchSummary.all.includes(branch)) {
        await this.#git.checkout(branch);
      } else {
        await this.#git.checkoutLocalBranch(branch);
      }

      await this.#assertCurrentBranch(branch);
    } catch (error) {
      throw this.#wrapUnexpectedError('CHECKOUT_FAILED', `Failed to checkout branch ${branch}.`, error);
    }
  }

  public async merge(source: string, target: string): Promise<void> {
    await this.#validateBranchName(source);
    await this.#validateBranchName(target);
    await this.#assertCleanWorkingTree();

    let targetCheckedOut = false;

    try {
      await this.#git.checkout(target);
      targetCheckedOut = true;

      const mergeResult = await this.#git.merge([source]);

      if (mergeResult.failed) {
        throw new GitServiceError(
          'MERGE_FAILED',
          `Failed to merge ${source} into ${target}.`,
          mergeResult,
        );
      }

      const status = await this.#git.status();

      if (!status.isClean()) {
        throw new GitServiceError(
          'MERGE_FAILED',
          `Failed to merge ${source} into ${target}.`,
          status,
        );
      }

      await this.#assertCurrentBranch(target);
    } catch (error) {
      await this.#abortMergeIfNeeded();

      if (targetCheckedOut) {
        await this.#assertCurrentBranch(target);
      } else {
        await this.#assertCurrentBranch();
      }

      throw this.#wrapUnexpectedError(
        'MERGE_FAILED',
        `Failed to merge ${source} into ${target}.`,
        error,
      );
    }
  }

  public async deleteBranch(branch: string): Promise<void> {
    await this.#validateBranchName(branch);
    await this.#assertCleanWorkingTree();

    const currentBranch = await this.#getCurrentBranch();

    if (currentBranch === branch) {
      throw new ActiveBranchDeletionError(branch);
    }

    try {
      await this.#git.deleteLocalBranch(branch);
      await this.#assertCurrentBranch(currentBranch);
    } catch (error) {
      throw this.#wrapUnexpectedError(
        'DELETE_BRANCH_FAILED',
        `Failed to delete branch ${branch}.`,
        error,
      );
    }
  }

  public async push(branch: string): Promise<void> {
    await this.#validateBranchName(branch);
    await this.#assertCleanWorkingTree();
    await this.#assertUpstreamConfiguration(branch);

    try {
      await this.#git.push('origin', `${branch}:${branch}`);
      await this.#assertCurrentBranch();
    } catch (error) {
      throw this.#wrapUnexpectedError('PUSH_FAILED', `Failed to push branch ${branch}.`, error);
    }
  }

  async #validateBranchName(branch: string): Promise<void> {
    try {
      await this.#git.raw(['check-ref-format', '--branch', branch]);
    } catch (error) {
      throw new InvalidBranchNameError(branch, error);
    }
  }

  async #assertCleanWorkingTree(): Promise<void> {
    const status = await this.#git.status();

    if (!status.isClean()) {
      throw new DirtyWorkingTreeError();
    }
  }

  async #assertUpstreamConfiguration(branch: string): Promise<void> {
    const config = await this.#git.listConfig();
    const remote = this.#readConfigValue(config.all[`branch.${branch}.remote`]);
    const mergeTarget = this.#readConfigValue(config.all[`branch.${branch}.merge`]);

    if (remote !== 'origin' || mergeTarget !== `refs/heads/${branch}`) {
      throw new UpstreamNotConfiguredError(branch);
    }
  }

  async #assertCurrentBranch(expectedBranch?: string): Promise<string> {
    const currentBranch = await this.#getCurrentBranch();

    if (expectedBranch !== undefined && currentBranch !== expectedBranch) {
      throw new DetachedHeadError();
    }

    return currentBranch;
  }

  async #getCurrentBranch(): Promise<string> {
    const status = await this.#git.status();

    if (status.detached || status.current === null || status.current.length === 0) {
      throw new DetachedHeadError();
    }

    return status.current;
  }

  async #abortMergeIfNeeded(): Promise<void> {
    try {
      await this.#git.raw(['rev-parse', '--verify', 'MERGE_HEAD']);
    } catch {
      return;
    }

    await this.#git.raw(['merge', '--abort']);
  }

  #readConfigValue(value: ConfigValue): string | undefined {
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  #wrapUnexpectedError(code: string, message: string, error: unknown): GitServiceError {
    if (error instanceof GitServiceError) {
      return error;
    }

    return new GitServiceError(code, message, error);
  }
}