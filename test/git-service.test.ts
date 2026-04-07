import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CurrentBranchMismatchError,
  DirtyWorkingTreeError,
  GitService,
  InvalidBranchNameError,
  UpstreamNotConfiguredError,
} from '../src/git-service';
import {
  commitFile,
  createCleanupRegistry,
  createGitEnvironment,
} from './harness';

const cleanup = createCleanupRegistry();

afterEach(async () => {
  await cleanup.runAll();
});

describe('GitService.listBranches', () => {
  it('returns normalized local branch names', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await git.checkout('main');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.listBranches()).resolves.toEqual(['feature', 'main']);
  });
});

describe('GitService.getStatus', () => {
  it('returns the current branch and whether uncommitted changes exist', async () => {
    const environment = await createGitEnvironment(cleanup);
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.getStatus()).resolves.toEqual({
      branch: 'main',
      hasUncommittedChanges: false,
    });

    await writeFile(path.join(environment.workspacePath, 'untracked.txt'), 'dirty', 'utf8');

    await expect(service.getStatus()).resolves.toEqual({
      branch: 'main',
      hasUncommittedChanges: true,
    });
  });
});

describe('GitService.checkout', () => {
  it('checks out an existing branch', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await git.checkout('main');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.checkout('feature');

    await expect(git.branchLocal()).resolves.toMatchObject({ current: 'feature' });
  });

  it('creates and checks out a new branch from HEAD', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    const headBefore = await git.revparse('HEAD');
    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.checkout('feature');

    const branchSummary = await git.branchLocal();
    expect(branchSummary.current).toBe('feature');
    expect(branchSummary.all).toContain('feature');
    await expect(git.revparse('HEAD')).resolves.toBe(headBefore);
  });

  it('fails immediately when the working tree is dirty', async () => {
    const environment = await createGitEnvironment(cleanup);

    await writeFile(path.join(environment.workspacePath, 'untracked.txt'), 'dirty', 'utf8');

    const git = simpleGit(environment.workspacePath);
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.checkout('feature')).rejects.toBeInstanceOf(DirtyWorkingTreeError);
    await expect(git.branchLocal()).resolves.toMatchObject({ current: 'main' });
  });
});

describe('GitService.merge', () => {
  it('merges source into target and keeps target checked out', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await commitFile(environment.workspacePath, 'feature.txt', 'feature\n', 'Add feature');
    await git.checkout('main');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.merge('feature', 'main');

    const branchSummary = await git.branchLocal();
    const log = await git.log();

    expect(branchSummary.current).toBe('main');
    expect(log.all.map((entry) => entry.message)).toContain('Add feature');
    await expect(readFile(path.join(environment.workspacePath, 'feature.txt'), 'utf8')).resolves.toBe(
      'feature\n',
    );
  });

  it('aborts a conflicting merge and leaves the repository clean', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await commitFile(environment.workspacePath, 'README.md', 'feature\n', 'Feature change');
    await git.checkout('main');
    const mainHeadBefore = await commitFile(
      environment.workspacePath,
      'README.md',
      'main\n',
      'Main change',
    );

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.merge('feature', 'main')).rejects.toThrow();

    const status = await git.status();
    expect(status.isClean()).toBe(true);
    expect(status.current).toBe('main');
    await expect(git.revparse('HEAD')).resolves.toBe(mainHeadBefore);
  });

  it('fails immediately when the working tree is dirty', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await commitFile(environment.workspacePath, 'feature.txt', 'feature\n', 'Add feature');
    await git.checkout('main');
    const headBefore = await git.revparse('HEAD');
    await writeFile(path.join(environment.workspacePath, 'untracked.txt'), 'dirty', 'utf8');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.merge('feature', 'main')).rejects.toBeInstanceOf(DirtyWorkingTreeError);

    const status = await git.status();
    expect(status.current).toBe('main');
    await expect(git.revparse('HEAD')).resolves.toBe(headBefore);
  });
});

describe('GitService.deleteBranch', () => {
  it('deletes an existing branch', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await git.checkout('main');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.deleteBranch('feature');

    await expect(service.listBranches()).resolves.toEqual(['main']);
  });

  it('fails when attempting to delete the current branch', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.deleteBranch('feature')).rejects.toThrow();
    await expect(git.branchLocal()).resolves.toMatchObject({ current: 'feature' });
  });

  it('fails immediately when the working tree is dirty', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await git.checkout('main');
    await writeFile(path.join(environment.workspacePath, 'untracked.txt'), 'dirty', 'utf8');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.deleteBranch('feature')).rejects.toBeInstanceOf(DirtyWorkingTreeError);
    await expect(service.listBranches()).resolves.toEqual(['feature', 'main']);
  });
});

describe('GitService.push', () => {
  it('pushes a tracked branch to origin', async () => {
    const environment = await createGitEnvironment(cleanup);

    const localHead = await commitFile(environment.workspacePath, 'push.txt', 'push\n', 'Push change');
    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.push('main', 'Ignored message');

    const remoteGit = simpleGit(environment.remotePath);
    await expect(remoteGit.revparse('refs/heads/main')).resolves.toBe(localHead);
  });

  it('creates a commit for dirty changes before pushing', async () => {
    const environment = await createGitEnvironment(cleanup);

    await writeFile(path.join(environment.workspacePath, 'dirty.txt'), 'dirty\n', 'utf8');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.push('main', 'Agent commit');

    const workspaceGit = simpleGit(environment.workspacePath);
    const remoteGit = simpleGit(environment.remotePath);
    const workspaceHead = await workspaceGit.revparse('HEAD');
    const workspaceLog = await workspaceGit.log();

    expect(workspaceLog.latest?.message).toBe('Agent commit');
    await expect(remoteGit.revparse('refs/heads/main')).resolves.toBe(workspaceHead);
  });

  it('fails when the branch has no upstream configuration', async () => {
    const environment = await createGitEnvironment(cleanup);

    await simpleGit(environment.workspacePath).checkoutLocalBranch('feature');
    await commitFile(environment.workspacePath, 'feature.txt', 'feature\n', 'Feature commit');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.push('feature', 'Agent commit')).rejects.toBeInstanceOf(UpstreamNotConfiguredError);
  });

  it('fails when the requested branch is not currently checked out', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await git.checkout('main');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.push('feature', 'Agent commit')).rejects.toBeInstanceOf(
      CurrentBranchMismatchError,
    );
  });

  it('surfaces commit hook failure output without discarding changes', async () => {
    const environment = await createGitEnvironment(cleanup);
    const hooksPath = path.join(environment.workspacePath, '.git', 'hooks', 'pre-commit');

    await writeFile(hooksPath, '#!/bin/sh\nprintf hook-stdout\nprintf hook-stderr >&2\nexit 1\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    await writeFile(path.join(environment.workspacePath, 'hooked.txt'), 'content\n', 'utf8');

    const git = simpleGit(environment.workspacePath);
    const headBefore = await git.revparse('HEAD');
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.push('main', 'Agent commit')).rejects.toMatchObject({
      code: 'PUSH_FAILED',
      details: {
        createdCommit: false,
        stage: 'commit',
      },
    });

    await expect(git.revparse('HEAD')).resolves.toBe(headBefore);
    await expect(readFile(path.join(environment.workspacePath, 'hooked.txt'), 'utf8')).resolves.toBe('content\n');
  });
});

describe('GitService.revert', () => {
  it('discards staged, unstaged, and untracked changes', async () => {
    const environment = await createGitEnvironment(cleanup);
    const trackedPath = path.join(environment.workspacePath, 'README.md');
    const untrackedPath = path.join(environment.workspacePath, 'untracked.txt');
    const git = simpleGit(environment.workspacePath);

    await writeFile(trackedPath, 'changed\n', 'utf8');
    await git.add('README.md');
    await writeFile(trackedPath, 'changed again\n', 'utf8');
    await writeFile(untrackedPath, 'untracked\n', 'utf8');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.revert();

    await expect(readFile(trackedPath, 'utf8')).resolves.toBe('# nextagent\n');
    await expect(readFile(untrackedPath, 'utf8')).rejects.toThrow();
    await expect(git.status()).resolves.toMatchObject({ files: [] });
  });
});

describe('GitService branch name validation', () => {
  it('rejects invalid branch names for checkout', async () => {
    const environment = await createGitEnvironment(cleanup);
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.checkout('invalid..branch')).rejects.toBeInstanceOf(InvalidBranchNameError);
  });

  it('rejects invalid source branch names for merge', async () => {
    const environment = await createGitEnvironment(cleanup);
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.merge('invalid..branch', 'main')).rejects.toBeInstanceOf(
      InvalidBranchNameError,
    );
  });

  it('rejects invalid target branch names for merge', async () => {
    const environment = await createGitEnvironment(cleanup);
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.merge('main', 'invalid..branch')).rejects.toBeInstanceOf(
      InvalidBranchNameError,
    );
  });

  it('rejects invalid branch names for deleteBranch', async () => {
    const environment = await createGitEnvironment(cleanup);
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.deleteBranch('invalid..branch')).rejects.toBeInstanceOf(
      InvalidBranchNameError,
    );
  });

  it('rejects invalid branch names for push', async () => {
    const environment = await createGitEnvironment(cleanup);
    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.push('invalid..branch', 'Agent commit')).rejects.toBeInstanceOf(InvalidBranchNameError);
  });
});