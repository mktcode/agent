import { simpleGit, type SimpleGit } from 'simple-git';

import {
  ActiveBranchDeletionError,
  type AppErrorDetails,
  CurrentBranchMismatchError,
  DetachedHeadError,
  DirtyWorkingTreeError,
  GitOperationError,
  InvalidBranchNameError,
  UpstreamNotConfiguredError,
  toErrorDetails,
} from './errors';

export {
  ActiveBranchDeletionError,
  CurrentBranchMismatchError,
  DetachedHeadError,
  DirtyWorkingTreeError,
  GitOperationError as GitServiceError,
  InvalidBranchNameError,
  UpstreamNotConfiguredError,
} from './errors';

type ConfigValue = string | string[] | undefined;

export interface GitServiceOptions {
  workspacePath: string;
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
      throw new GitOperationError('LIST_BRANCHES_FAILED', 'Failed to list local branches.', {
        cause: toErrorDetails(error),
      });
    }
  }

  public async getStatus(): Promise<{ branch: string; hasUncommittedChanges: boolean }> {
    try {
      const branch = await this.#getCurrentBranch();
      const status = await this.#git.status();

      return {
        branch,
        hasUncommittedChanges: !status.isClean(),
      };
    } catch (error) {
      throw this.#wrapUnexpectedError('STATUS_FAILED', 'Failed to read repository status.', error);
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
        throw new GitOperationError(
          'MERGE_FAILED',
          `Failed to merge ${source} into ${target}.`,
          { mergeResult },
        );
      }

      const status = await this.#git.status();

      if (!status.isClean()) {
        throw new GitOperationError(
          'MERGE_FAILED',
          `Failed to merge ${source} into ${target}.`,
          { status },
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

  public async revert(): Promise<void> {
    const currentBranch = await this.#assertCurrentBranch();
    const status = await this.#git.status();

    if (status.isClean()) {
      return;
    }

    try {
      await this.#git.raw(['reset', '--hard', 'HEAD']);
      await this.#git.raw(['clean', '-fd']);

      const finalStatus = await this.#git.status();

      if (!finalStatus.isClean()) {
        throw new GitOperationError('REVERT_FAILED', 'Failed to revert uncommitted changes.', {
          status: {
            current: finalStatus.current,
            files: finalStatus.files,
          },
        });
      }

      await this.#assertCurrentBranch(currentBranch);
    } catch (error) {
      throw this.#wrapUnexpectedError('REVERT_FAILED', 'Failed to revert uncommitted changes.', error);
    }
  }

  public async push(branch: string, commitMessage: string): Promise<void> {
    await this.#validateBranchName(branch);
    await this.#assertCurrentBranch(branch);
    await this.#assertUpstreamConfiguration(branch);

    let createdCommit = false;

    const status = await this.#git.status();

    try {
      if (!status.isClean()) {
        await this.#git.add(['--all']);
        await this.#git.commit(commitMessage);
        createdCommit = true;
      }

      await this.#git.push('origin', `${branch}:${branch}`);
      await this.#assertCurrentBranch(branch);
    } catch (error) {
      throw this.#wrapPushError(branch, error, createdCommit ? 'push' : 'commit', createdCommit);
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
      throw new CurrentBranchMismatchError(expectedBranch, currentBranch);
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

  #wrapUnexpectedError(code: string, message: string, error: unknown): GitOperationError {
    if (error instanceof GitOperationError) {
      return error;
    }

    return new GitOperationError(code, message, {
      cause: toErrorDetails(error),
    });
  }

  #wrapPushError(
    branch: string,
    error: unknown,
    stage: 'commit' | 'push',
    createdCommit: boolean,
  ): GitOperationError {
    if (error instanceof GitOperationError) {
      return error;
    }

    return new GitOperationError('PUSH_FAILED', `Failed to push branch ${branch}.`, {
      createdCommit,
      stage,
      ...this.#extractGitOutput(error),
      cause: toErrorDetails(error),
    });
  }

  #extractGitOutput(error: unknown): AppErrorDetails {
    if (!(error instanceof Error)) {
      return {};
    }

    const details: AppErrorDetails = {};
    const errorWithOutput = error as Error & {
      stderr?: string;
      stdout?: string;
      git?: {
        stderr?: string;
        stdout?: string;
      };
    };

    const stdout = errorWithOutput.stdout ?? errorWithOutput.git?.stdout;
    const stderr = errorWithOutput.stderr ?? errorWithOutput.git?.stderr;

    if (stdout !== undefined && stdout.length > 0) {
      details.stdout = stdout.trimEnd();
    }

    if (stderr !== undefined && stderr.length > 0) {
      details.stderr = stderr.trimEnd();
    }

    if (Object.keys(details).length === 0 && error.message.length > 0) {
      details.message = error.message;
    }

    return details;
  }
}