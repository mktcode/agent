import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { type AgentRuntime } from './agent-runtime';
import { AppError, LockUnavailableError, ValidationError } from './errors';
import { type GitService } from './git-service';
import {
  streamAgentPrompt as defaultStreamAgentPrompt,
  type StreamAgentPromptOptions,
  type StreamAgentPromptReply,
} from './streaming';

export interface ApiServerOptions {
  authToken: string;
  gitService: Pick<GitService, 'listBranches' | 'checkout' | 'merge' | 'push' | 'deleteBranch'>;
  agentRuntime: Pick<AgentRuntime, 'prompt' | 'stop' | 'subscribe'>;
  streamAgentPrompt?: (options: StreamAgentPromptOptions) => Promise<void> | void;
}

interface StringBodyShape {
  [key: string]: string;
}

class UnauthorizedApiError extends Error {
  public constructor() {
    super('Unauthorized.');
    this.name = 'UnauthorizedApiError';
  }
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const server = Fastify();
  const streamAgentPrompt = options.streamAgentPrompt ?? defaultStreamAgentPrompt;

  server.addHook('onRequest', async (request) => {
    authenticateRequest(request, options.authToken);
  });

  server.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = mapError(error);

    reply.status(statusCode).send({ error: body });
  });

  server.get('/git/branches', async () => {
    const branches = await options.gitService.listBranches();
    return { branches };
  });

  server.post('/git/checkout', async (request, reply) => {
    const { branch } = validateStringBody(request.body, ['branch']);

    await options.gitService.checkout(branch);

    reply.status(200).send({});
  });

  server.post('/git/merge', async (request, reply) => {
    const { source, target } = validateStringBody(request.body, ['source', 'target']);

    await options.gitService.merge(source, target);

    reply.status(200).send({});
  });

  server.post('/git/push', async (request, reply) => {
    const { branch } = validateStringBody(request.body, ['branch']);

    await options.gitService.push(branch);

    reply.status(200).send({});
  });

  server.delete('/git/branch', async (request, reply) => {
    const { branch } = validateStringBody(request.body, ['branch']);

    await options.gitService.deleteBranch(branch);

    reply.status(200).send({});
  });

  server.post('/agent/prompt', async (request, reply) => {
    const { prompt, sessionId } = validateStringBody(request.body, ['prompt'], ['sessionId']);

    await streamAgentPrompt({
      agentRuntime: options.agentRuntime,
      prompt,
      sessionId,
      reply: reply as unknown as StreamAgentPromptReply,
    });
  });

  return server;
}

function authenticateRequest(request: FastifyRequest, authToken: string): void {
  const authorization = request.headers.authorization;

  if (authorization !== `Bearer ${authToken}`) {
    throw new UnauthorizedApiError();
  }
}

function validateStringBody(
  body: unknown,
  requiredKeys: string[],
  optionalKeys: string[] = [],
): StringBodyShape {
  const issues: string[] = [];
  const allowedKeys = [...requiredKeys, ...optionalKeys];

  if (!isRecord(body)) {
    throw new ValidationError('Invalid request body.', {
      issues: ['Request body must be an object'],
    });
  }

  for (const key of requiredKeys) {
    if (typeof body[key] !== 'string') {
      issues.push(`${key} must be a string`);
    }
  }

  for (const key of optionalKeys) {
    if (key in body && typeof body[key] !== 'string') {
      issues.push(`${key} must be a string`);
    }
  }

  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) {
      issues.push(`Unexpected field: ${key}`);
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('Invalid request body.', { issues });
  }

  return body as StringBodyShape;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapError(error: unknown): { statusCode: number; body: AppError | { code: string; message: string } } {
  if (error instanceof UnauthorizedApiError) {
    return {
      statusCode: 401,
      body: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized.',
      },
    };
  }

  if (error instanceof LockUnavailableError) {
    return {
      statusCode: 409,
      body: error,
    };
  }

  if (error instanceof AppError) {
    return {
      statusCode: 400,
      body: error,
    };
  }

  if (isFastifyClientError(error)) {
    return {
      statusCode: 400,
      body: new ValidationError(error.message),
    };
  }

  return {
    statusCode: 500,
    body: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error.',
    },
  };
}

function isFastifyClientError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error
    && 'statusCode' in error
    && typeof error.statusCode === 'number'
    && error.statusCode < 500
  );
}