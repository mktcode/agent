import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DirtyWorkingTreeError,
  GitService,
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
});

describe('GitService.push', () => {
  it('pushes a tracked branch to origin', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    const localHead = await commitFile(environment.workspacePath, 'push.txt', 'push\n', 'Push change');
    const service = new GitService({ workspacePath: environment.workspacePath });

    await service.push('main');

    const remoteGit = simpleGit(environment.remotePath);
    await expect(remoteGit.revparse('refs/heads/main')).resolves.toBe(localHead);
  });

  it('fails when the branch has no upstream configuration', async () => {
    const environment = await createGitEnvironment(cleanup);

    const git = simpleGit(environment.workspacePath);
    await git.checkoutLocalBranch('feature');
    await commitFile(environment.workspacePath, 'feature.txt', 'feature\n', 'Feature commit');

    const service = new GitService({ workspacePath: environment.workspacePath });

    await expect(service.push('feature')).rejects.toBeInstanceOf(UpstreamNotConfiguredError);
  });
});