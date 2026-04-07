import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../src/errors';
import { buildServer, readServerConfig, startServer } from '../src/server';
import {
  createCleanupRegistry,
  createGitRepository,
  createTempDirectory,
  createTempWorkspacePath,
} from './harness';

const execFileAsync = promisify(execFile);

const cleanup = createCleanupRegistry();

afterEach(async () => {
  await cleanup.runAll();
});

describe('readServerConfig', () => {
  it('reads required values and applies defaults', () => {
    const cwd = '/tmp/nextagent';

    const config = readServerConfig(
      {
        AUTH_TOKEN: 'secret-token',
        REPO_URL: '/tmp/repository.git',
      },
      cwd,
    );

    expect(config).toEqual({
      authToken: 'secret-token',
      repoUrl: '/tmp/repository.git',
      postCloneCommand: undefined,
      workspacePath: path.join(cwd, '.workspace'),
      host: '127.0.0.1',
      port: 3000,
    });
  });

  it('reads an optional POST_CLONE_COMMAND', () => {
    const cwd = '/tmp/nextagent';

    const config = readServerConfig(
      {
        AUTH_TOKEN: 'secret-token',
        REPO_URL: '/tmp/repository.git',
        POST_CLONE_COMMAND: 'npm install',
      },
      cwd,
    );

    expect(config.postCloneCommand).toBe('npm install');
  });

  it('rejects missing AUTH_TOKEN', () => {
    expect(() =>
      readServerConfig(
        {
          REPO_URL: '/tmp/repository.git',
        },
        '/tmp/nextagent',
      ),
    ).toThrowError(new ValidationError('AUTH_TOKEN is required.'));
  });

  it('rejects missing REPO_URL', () => {
    expect(() =>
      readServerConfig(
        {
          AUTH_TOKEN: 'secret-token',
        },
        '/tmp/nextagent',
      ),
    ).toThrowError(new ValidationError('REPO_URL is required.'));
  });

  it('rejects an invalid PORT value', () => {
    expect(() =>
      readServerConfig(
        {
          AUTH_TOKEN: 'secret-token',
          REPO_URL: '/tmp/repository.git',
          PORT: 'abc',
        },
        '/tmp/nextagent',
      ),
    ).toThrowError(new ValidationError('PORT must be a valid integer.'));
  });
});

describe('buildServer', () => {
  it('initializes the workspace before returning the API server', async () => {
    const repository = await createGitRepository(cleanup);
    const workspacePath = await createTempWorkspacePath(cleanup);

    const server = await buildServer({
      authToken: 'secret-token',
      repoUrl: repository.repoPath,
      workspacePath,
      host: '127.0.0.1',
      port: 3000,
    });

    cleanup.add(async () => {
      await server.close();
    });

    await expect(readFile(path.join(workspacePath, repository.filePath), 'utf8')).resolves.toBe(
      repository.fileContent,
    );
  });
});

describe('startServer', () => {
  it('starts the Fastify server and listens on the configured interface', async () => {
    const repository = await createGitRepository(cleanup);
    const rootPath = await createTempDirectory(cleanup, 'nextagent-server-root-');

    const server = await startServer({
      authToken: 'secret-token',
      repoUrl: repository.repoPath,
      workspacePath: path.join(rootPath, '.workspace'),
      host: '127.0.0.1',
      port: 0,
    });

    cleanup.add(async () => {
      await server.close();
    });

    expect(server.server.listening).toBe(true);
  });
});

describe('production bundle', () => {
  it('loads the built server entrypoint before config validation runs', async () => {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    await execFileAsync(npmCommand, ['run', 'build'], {
      cwd: process.cwd(),
      env: process.env,
    });

    await expect(
      execFileAsync(process.execPath, ['dist/server.mjs'], {
        cwd: process.cwd(),
        env: {},
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: 'AUTH_TOKEN is required.\n',
    });
  });
});