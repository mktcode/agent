import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import {
  type AgentRuntime,
  type AgentRuntimePromptResult,
  type AgentRuntimeSessionEntry,
  type AgentRuntimeSessionInfo,
  type UiSessionItem,
} from './agent-runtime';
import { AppError, LockUnavailableError, ValidationError } from './errors';
import { type GitService } from './git-service';

export type AgentResponseFormat = 'raw' | 'ui';

export interface ApiServerOptions {
  authToken: string;
  gitService: Pick<GitService, 'getStatus' | 'listBranches' | 'checkout' | 'merge' | 'push' | 'revert' | 'deleteBranch'>;
  agentRuntime: Pick<AgentRuntime, 'prompt' | 'listSessions' | 'getSession' | 'getSessionEntries' | 'getSessionItems' | 'deleteSession' | 'subscribe' | 'subscribeUi'>;
}

export interface AgentSessionsResponse {
  sessions: AgentRuntimeSessionInfo[];
}

export interface AgentSessionResponse {
  session: AgentRuntimeSessionInfo;
}

export interface AgentSessionItemsResponse {
  items: AgentRuntimeSessionEntry[] | UiSessionItem[];
}

export interface AgentEventSource {
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface AgentPromptStreamResponse {
  statusCode: number;
  destroyed: boolean;
  writableEnded: boolean;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close' | 'error', listener: () => void): void;
  off(event: 'close' | 'error', listener: () => void): void;
}

export interface AgentPromptStreamReply {
  raw: AgentPromptStreamResponse;
  hijack(): void;
}

export interface StreamAgentPromptResponseOptions {
  agentRuntime: Pick<AgentRuntime, 'prompt' | 'subscribe' | 'subscribeUi'>;
  prompt: string;
  sessionId?: string;
  format?: AgentResponseFormat;
  reply: AgentPromptStreamReply;
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

  server.get('/git/status', async () => {
    return options.gitService.getStatus();
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
    const { branch, commitMessage } = validateStringBody(request.body, ['branch', 'commitMessage']);

    await options.gitService.push(branch, commitMessage);

    reply.status(200).send({});
  });

  server.post('/git/revert', async (request, reply) => {
    validateEmptyBody(request.body);

    await options.gitService.revert();

    reply.status(200).send({});
  });

  server.delete('/git/branch', async (request, reply) => {
    const { branch } = validateStringBody(request.body, ['branch']);

    await options.gitService.deleteBranch(branch);

    reply.status(200).send({});
  });

  server.post('/agent/prompt', async (request, reply) => {
    const { prompt, sessionId, format } = validateStringBody(request.body, ['prompt'], ['sessionId', 'format']);
    const responseFormat = validateAgentResponseFormat(format);

    await streamAgentPromptResponse({
      agentRuntime: options.agentRuntime,
      prompt,
      sessionId,
      format: responseFormat,
      reply: reply as unknown as AgentPromptStreamReply,
    });
  });

  server.get('/agent/sessions', async (): Promise<AgentSessionsResponse> => {
    const sessions = await options.agentRuntime.listSessions();
    return { sessions };
  });

  server.get('/agent/session/:sessionId', async (request): Promise<AgentSessionResponse> => {
    const { sessionId } = validateStringParams(request.params, ['sessionId']);
    const session = await options.agentRuntime.getSession(sessionId);

    return { session };
  });

  server.get('/agent/session/:sessionId/items', async (request): Promise<AgentSessionItemsResponse> => {
    const { sessionId } = validateStringParams(request.params, ['sessionId']);
    const { format } = validateStringQuery(request.query, ['format']);
    const responseFormat = validateAgentResponseFormat(format);

    if (responseFormat === 'ui') {
      return {
        items: await options.agentRuntime.getSessionItems(sessionId),
      };
    }

    return {
      items: await options.agentRuntime.getSessionEntries(sessionId),
    };
  });

  server.delete('/agent/session', async (request, reply) => {
    const { sessionId } = validateStringBody(request.body, ['sessionId']);

    await options.agentRuntime.deleteSession(sessionId);

    reply.status(200).send({});
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
  return validateStringRecord(body, requiredKeys, optionalKeys);
}

function validateStringParams(
  params: unknown,
  requiredKeys: string[],
  optionalKeys: string[] = [],
): StringBodyShape {
  return validateStringRecord(params, requiredKeys, optionalKeys);
}

function validateStringQuery(
  query: unknown,
  optionalKeys: string[] = [],
): StringBodyShape {
  return validateStringRecord(query, [], optionalKeys);
}

function validateStringRecord(
  value: unknown,
  requiredKeys: string[],
  optionalKeys: string[] = [],
): StringBodyShape {
  const issues: string[] = [];
  const allowedKeys = [...requiredKeys, ...optionalKeys];

  if (!isRecord(value)) {
    throw new ValidationError('Invalid request body.', {
      issues: ['Request body must be an object'],
    });
  }

  for (const key of requiredKeys) {
    if (typeof value[key] !== 'string') {
      issues.push(`${key} must be a string`);
    }
  }

  for (const key of optionalKeys) {
    if (key in value && typeof value[key] !== 'string') {
      issues.push(`${key} must be a string`);
    }
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      issues.push(`Unexpected field: ${key}`);
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('Invalid request body.', { issues });
  }

  return value as StringBodyShape;
}

function validateAgentResponseFormat(format: string | undefined): AgentResponseFormat {
  if (format === undefined) {
    return 'raw';
  }

  if (format === 'raw' || format === 'ui') {
    return format;
  }

  throw new ValidationError('Invalid request body.', {
    issues: ['format must be one of: raw, ui'],
  });
}

function validateEmptyBody(body: unknown): void {
  if (body === undefined) {
    return;
  }

  if (!isRecord(body)) {
    throw new ValidationError('Invalid request body.', {
      issues: ['Request body must be an object'],
    });
  }

  const keys = Object.keys(body);

  if (keys.length > 0) {
    throw new ValidationError('Invalid request body.', {
      issues: keys.map((key) => `Unexpected field: ${key}`),
    });
  }
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

export async function streamAgentPromptResponse(
  options: StreamAgentPromptResponseOptions,
): Promise<void> {
  const {
    agentRuntime,
    prompt,
    sessionId,
    format = 'raw',
    reply,
  } = options;
  const response = reply.raw;

  let closed = false;

  const unsubscribe = (format === 'ui' ? agentRuntime.subscribeUi : agentRuntime.subscribe)((event) => {
    if (closed || response.destroyed || response.writableEnded) {
      return;
    }

    response.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const cleanup = (): void => {
    unsubscribe();
    response.off('close', handleDisconnect);
    response.off('error', handleDisconnect);
  };

  const handleDisconnect = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    cleanup();
  };

  response.on('close', handleDisconnect);
  response.on('error', handleDisconnect);

  let promptResult: AgentRuntimePromptResult;

  try {
    promptResult = await agentRuntime.prompt(prompt, sessionId);
  } catch (error) {
    cleanup();
    throw error;
  }

  if (closed || response.destroyed || response.writableEnded) {
    return;
  }

  reply.hijack();
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Agent-Session-Id', promptResult.sessionId);
  response.flushHeaders();

  await promptResult.completion.catch(() => undefined);

  cleanup();

  if (!closed && !response.destroyed && !response.writableEnded) {
    response.end();
  }
}