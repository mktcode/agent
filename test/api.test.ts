import type { FastifyInstance } from 'fastify';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiServer } from '../src/api';
import {
  LockUnavailableError,
  NoActiveSessionError,
  ValidationError,
} from '../src/errors';
import type { StreamAgentEventsOptions } from '../src/streaming';

interface GitServiceStub {
  listBranches: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
}

interface AgentRuntimeStub {
  start: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

const servers: FastifyInstance[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

function createServer() {
  const gitService: GitServiceStub = {
    listBranches: vi.fn(async () => ['feature', 'main']),
    checkout: vi.fn(async () => undefined),
    merge: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => undefined),
  };
  const agentRuntime: AgentRuntimeStub = {
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
  const streamAgentEvents = vi.fn((options: StreamAgentEventsOptions) => {
    const raw = options.reply.raw as StreamAgentEventsOptions['reply']['raw'] & { end(): void };

    options.reply.hijack();
    raw.statusCode = 200;
    raw.end();
  });

  const server = createApiServer({
    authToken: 'secret-token',
    gitService,
    agentRuntime,
    streamAgentEvents,
  });

  servers.push(server);

  return { server, gitService, agentRuntime, streamAgentEvents };
}

function authorizedHeaders() {
  return {
    authorization: 'Bearer secret-token',
  };
}

describe('API authentication', () => {
  it('rejects requests without a bearer token', async () => {
    const { server, gitService } = createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/git/branches',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized.',
      },
    });
    expect(gitService.listBranches).not.toHaveBeenCalled();
  });

  it('rejects requests with an invalid bearer token', async () => {
    const { server, agentRuntime } = createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/agent/start',
      headers: {
        authorization: 'Bearer wrong-token',
      },
      payload: {
        prompt: 'Implement the feature',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized.',
      },
    });
    expect(agentRuntime.start).not.toHaveBeenCalled();
  });
});

describe('API validation', () => {
  it('rejects missing required fields', async () => {
    const { server, gitService } = createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/git/checkout',
      headers: authorizedHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body.',
        details: {
          issues: ['branch must be a string'],
        },
      },
    });
    expect(gitService.checkout).not.toHaveBeenCalled();
  });

  it('rejects unknown fields without coercion', async () => {
    const { server, gitService } = createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/git/push',
      headers: authorizedHeaders(),
      payload: {
        branch: 123,
        extra: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body.',
        details: {
          issues: ['branch must be a string', 'Unexpected field: extra'],
        },
      },
    });
    expect(gitService.push).not.toHaveBeenCalled();
  });
});

describe('API delegation', () => {
  it('delegates branch listing directly to the git module', async () => {
    const { server, gitService } = createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/git/branches',
      headers: authorizedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      branches: ['feature', 'main'],
    });
    expect(gitService.listBranches).toHaveBeenCalledTimes(1);
  });

  it('delegates git mutations directly to the git module', async () => {
    const { server, gitService } = createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/git/merge',
      headers: authorizedHeaders(),
      payload: {
        source: 'feature',
        target: 'main',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
    expect(gitService.merge).toHaveBeenCalledTimes(1);
    expect(gitService.merge).toHaveBeenCalledWith('feature', 'main');
  });

  it('delegates agent endpoints directly to the agent runtime', async () => {
    const { server, agentRuntime } = createServer();

    const startResponse = await server.inject({
      method: 'POST',
      url: '/agent/start',
      headers: authorizedHeaders(),
      payload: {
        prompt: 'Implement the feature',
      },
    });
    const sendResponse = await server.inject({
      method: 'POST',
      url: '/agent/send',
      headers: authorizedHeaders(),
      payload: {
        input: 'Continue',
      },
    });
    const stopResponse = await server.inject({
      method: 'DELETE',
      url: '/agent/session',
      headers: authorizedHeaders(),
    });

    expect(startResponse.statusCode).toBe(200);
    expect(sendResponse.statusCode).toBe(200);
    expect(stopResponse.statusCode).toBe(200);
    expect(agentRuntime.start).toHaveBeenCalledWith('Implement the feature');
    expect(agentRuntime.send).toHaveBeenCalledWith('Continue');
    expect(agentRuntime.stop).toHaveBeenCalledTimes(1);
  });

  it('attaches the streaming endpoint directly to the streaming layer', async () => {
    const { server, agentRuntime, streamAgentEvents } = createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/agent/stream',
      headers: authorizedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(streamAgentEvents).toHaveBeenCalledTimes(1);
    expect(streamAgentEvents.mock.calls[0]?.[0].eventSource).toBe(agentRuntime);
  });
});

describe('API error mapping', () => {
  it('maps lock contention to 409 conflict', async () => {
    const { server, gitService } = createServer();

    gitService.checkout.mockRejectedValueOnce(new LockUnavailableError());

    const response = await server.inject({
      method: 'POST',
      url: '/git/checkout',
      headers: authorizedHeaders(),
      payload: {
        branch: 'feature',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'LOCK_UNAVAILABLE',
        message: 'Workspace lock is unavailable.',
      },
    });
  });

  it('maps known domain errors to 400 bad request', async () => {
    const { server, agentRuntime } = createServer();

    agentRuntime.send.mockRejectedValueOnce(new NoActiveSessionError());

    const response = await server.inject({
      method: 'POST',
      url: '/agent/send',
      headers: authorizedHeaders(),
      payload: {
        input: 'Continue',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'NO_ACTIVE_SESSION',
        message: 'There is no active agent session.',
      },
    });
  });

  it('maps validation errors to 400 bad request', async () => {
    const { server, gitService } = createServer();

    gitService.deleteBranch.mockRejectedValueOnce(new ValidationError('Invalid branch name'));

    const response = await server.inject({
      method: 'DELETE',
      url: '/git/branch',
      headers: authorizedHeaders(),
      payload: {
        branch: 'bad..branch',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid branch name',
      },
    });
  });

  it('maps unexpected errors to 500 internal server error', async () => {
    const { server, gitService } = createServer();

    gitService.push.mockRejectedValueOnce(new Error('boom'));

    const response = await server.inject({
      method: 'POST',
      url: '/git/push',
      headers: authorizedHeaders(),
      payload: {
        branch: 'main',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      },
    });
  });
});