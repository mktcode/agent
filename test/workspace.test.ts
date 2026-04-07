import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCleanupRegistry,
  createGitRepository,
  createTempWorkspacePath,
} from './harness';
import {
  InvalidLockStateError,
  LockUnavailableError,
  PostCloneCommandError,
  WorkspaceManager,
} from '../src/workspace';

const cleanup = createCleanupRegistry();

afterEach(async () => {
  await cleanup.runAll();
});

describe('WorkspaceManager lock semantics', () => {
  it('acquires when unlocked', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    expect(manager.acquire()).toBe(true);
    expect(manager.isLocked()).toBe(true);
  });

  it('returns false when acquiring while locked', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    expect(manager.acquire()).toBe(true);
    expect(manager.acquire()).toBe(false);
    expect(manager.isLocked()).toBe(true);
  });

  it('releases when locked', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    manager.acquire();
    manager.release();

    expect(manager.isLocked()).toBe(false);
  });

  it('throws when releasing while unlocked', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    expect(() => manager.release()).toThrow(InvalidLockStateError);
  });
});

describe('WorkspaceManager.runExclusive', () => {
  it('executes the function when unlocked', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    await expect(manager.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('throws when already locked', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    manager.acquire();

    await expect(manager.runExclusive(async () => 'never')).rejects.toBeInstanceOf(
      LockUnavailableError,
    );
  });

  it('releases the lock after success', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    await manager.runExclusive(async () => 'ok');

    expect(manager.isLocked()).toBe(false);
  });

  it('releases the lock after failure', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });
    const failure = new Error('boom');

    await expect(
      manager.runExclusive(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(manager.isLocked()).toBe(false);
  });

  it('fails nested runExclusive calls', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    await manager.runExclusive(async () => {
      await expect(manager.runExclusive(async () => 'nested')).rejects.toBeInstanceOf(
        LockUnavailableError,
      );
    });
  });

  it('holds the lock until the async function completes', async () => {
    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });

    let signalStarted: (() => void) | undefined;
    let releaseOperation: (() => void) | undefined;

    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });

    const runPromise = manager.runExclusive(async () => {
      signalStarted?.();
      await gate;
      return 'done';
    });

    await started;

    expect(manager.isLocked()).toBe(true);
    expect(manager.acquire()).toBe(false);

    releaseOperation?.();

    await expect(runPromise).resolves.toBe('done');
    expect(manager.isLocked()).toBe(false);
  });
});

describe('WorkspaceManager.initialize', () => {
  it('clones the repository when the workspace does not exist', async () => {
    const repository = await createGitRepository(cleanup);

    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({
      repoUrl: repository.repoPath,
      workspacePath,
    });

    await manager.initialize();

    const clonedContent = await readFile(path.join(workspacePath, repository.filePath), 'utf8');
    expect(clonedContent).toBe(repository.fileContent);
  });

  it('does nothing when the workspace already exists', async () => {
    const repository = await createGitRepository(cleanup);

    const workspacePath = await createTempWorkspacePath(cleanup);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, 'marker.txt'), 'keep', 'utf8');

    const manager = new WorkspaceManager({
      repoUrl: repository.repoPath,
      workspacePath,
    });

    await manager.initialize();

    await expect(readFile(path.join(workspacePath, 'marker.txt'), 'utf8')).resolves.toBe('keep');
    await expect(readFile(path.join(workspacePath, repository.filePath), 'utf8')).rejects.toThrow();
  });

  it('runs the post-clone command after a fresh clone', async () => {
    const repository = await createGitRepository(cleanup);

    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({
      repoUrl: repository.repoPath,
      workspacePath,
      postCloneCommand: 'printf setup > post-clone.txt',
    });

    await manager.initialize();

    await expect(readFile(path.join(workspacePath, 'post-clone.txt'), 'utf8')).resolves.toBe('setup');
  });

  it('fails when the post-clone command exits non-zero and preserves output', async () => {
    const repository = await createGitRepository(cleanup);

    const workspacePath = await createTempWorkspacePath(cleanup);
    const manager = new WorkspaceManager({
      repoUrl: repository.repoPath,
      workspacePath,
      postCloneCommand: 'printf fail-out && printf fail-err >&2 && exit 9',
    });

    await expect(manager.initialize()).rejects.toEqual(
      new PostCloneCommandError('printf fail-out && printf fail-err >&2 && exit 9', {
        exitCode: 9,
        stderr: 'fail-err',
        stdout: 'fail-out',
      }),
    );
  });
});