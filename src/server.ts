import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { AgentRuntime } from './agent-runtime';
import { createApiServer } from './api';
import { ValidationError } from './errors';
import { GitService } from './git-service';
import { WorkspaceManager } from './workspace';

export interface ServerConfig {
  authToken: string;
  repoUrl: string;
  workspacePath: string;
  host: string;
  port: number;
}

export function readServerConfig(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): ServerConfig {
  const authToken = readRequiredEnv(env.AUTH_TOKEN, 'AUTH_TOKEN');
  const repoUrl = readRequiredEnv(env.REPO_URL, 'REPO_URL');
  const host = env.HOST ?? '127.0.0.1';
  const port = readPort(env.PORT);

  return {
    authToken,
    repoUrl,
    workspacePath: path.join(cwd, '.workspace'),
    host,
    port,
  };
}

export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const workspace = new WorkspaceManager({
    repoUrl: config.repoUrl,
    workspacePath: config.workspacePath,
  });

  await workspace.initialize();

  const gitService = new GitService({
    workspacePath: config.workspacePath,
  });
  const agentRuntime = new AgentRuntime({
    workspace,
    workspacePath: config.workspacePath,
  });

  return createApiServer({
    authToken: config.authToken,
    gitService,
    agentRuntime,
  });
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const server = await buildServer(config);

  await server.listen({
    host: config.host,
    port: config.port,
  });

  return server;
}

export async function main(): Promise<void> {
  const server = await startServer(readServerConfig(process.env));
  const address = server.server.address();

  if (typeof address === 'string') {
    process.stdout.write(`${address}\n`);
    return;
  }

  if (address !== null) {
    process.stdout.write(`http://${address.address}:${address.port}\n`);
  }
}

function readRequiredEnv(value: string | undefined, name: 'AUTH_TOKEN' | 'REPO_URL'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${name} is required.`);
  }

  return value;
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 3000;
  }

  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port)) {
    throw new ValidationError('PORT must be a valid integer.');
  }

  return port;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write('Unknown startup error.\n');
    }

    process.exitCode = 1;
  });
}