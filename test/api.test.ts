import type { FastifyInstance } from 'fastify';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiServer, streamAgentPromptResponse } from '../src/api';
import {
  LockUnavailableError,
  SessionNotFoundError,
  ValidationError,
} from '../src/errors';
import { ControlledEventSource, assertEventSequence, createDeferred, createReply } from './harness';

interface GitServiceStub {
  listBranches: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
}

interface AgentRuntimeStub {
  prompt: ReturnType<typeof vi.fn>;
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
    prompt: vi.fn(async () => ({ sessionId: 'session-1', completion: Promise.resolve() })),
    subscribe: vi.fn(() => () => undefined),
  };

  const server = createApiServer({
    authToken: 'secret-token',
    gitService,
    agentRuntime,
  });

  servers.push(server);

  return { server, gitService, agentRuntime };
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
      url: '/agent/prompt',
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
    expect(agentRuntime.prompt).not.toHaveBeenCalled();
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

  it('accepts an optional string session id for prompt requests', async () => {
    const { server, agentRuntime } = createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/agent/prompt',
      headers: authorizedHeaders(),
      payload: {
        prompt: 'Continue',
        sessionId: 'session-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(agentRuntime.prompt).toHaveBeenCalledWith('Continue', 'session-123');
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

  it('delegates agent prompts directly to the runtime and returns SSE headers', async () => {
    const { server, agentRuntime } = createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/agent/prompt',
      headers: authorizedHeaders(),
      payload: {
        prompt: 'Implement the feature',
        sessionId: 'session-9',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['x-agent-session-id']).toBe('session-1');
    expect(agentRuntime.prompt).toHaveBeenCalledWith('Implement the feature', 'session-9');
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

    agentRuntime.prompt.mockRejectedValueOnce(new SessionNotFoundError());

    const response = await server.inject({
      method: 'POST',
      url: '/agent/prompt',
      headers: authorizedHeaders(),
      payload: {
        prompt: 'Continue',
        sessionId: 'missing',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'The requested agent session was not found.',
      },
    });
  });

  it('streams prompt events unchanged and in order', async () => {
    const eventSource = new ControlledEventSource();
    const reply = createReply();
    const completion = createDeferred<void>();
    const agentRuntime = {
      subscribe: vi.fn((listener: (event: unknown) => void) => eventSource.subscribe(listener)),
      prompt: vi.fn(async (prompt: string, sessionId?: string) => ({
        sessionId: sessionId ?? 'session-1',
        completion: completion.promise,
      })),
    };

    const streamPromise = streamAgentPromptResponse({
      agentRuntime,
      prompt: 'Implement the feature',
      reply,
    });

    const firstEvent = { type: 'reasoning', text: 'first' };
    const secondEvent = { type: 'result', ok: true };

    eventSource.emit(firstEvent);
    eventSource.emit(secondEvent);
    completion.resolve();

    await streamPromise;

    expect(agentRuntime.prompt).toHaveBeenCalledWith('Implement the feature', undefined);
    expect(reply.raw.statusCode).toBe(200);
    expect(reply.raw.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(reply.raw.headers.get('Cache-Control')).toBe('no-cache');
    expect(reply.raw.headers.get('Connection')).toBe('keep-alive');
    expect(reply.raw.headers.get('X-Agent-Session-Id')).toBe('session-1');
    expect(reply.raw.flushHeadersCalls).toBe(1);
    assertEventSequence(reply.raw.writes, [
      `data: ${JSON.stringify(firstEvent)}\n\n`,
      `data: ${JSON.stringify(secondEvent)}\n\n`,
    ]);
  });

  it('streams only events emitted after subscription', async () => {
    const eventSource = new ControlledEventSource();
    const reply = createReply();
    const completion = createDeferred<void>();
    const agentRuntime = {
      subscribe: vi.fn((listener: (event: unknown) => void) => eventSource.subscribe(listener)),
      prompt: vi.fn(async () => ({
        sessionId: 'session-9',
        completion: completion.promise,
      })),
    };

    eventSource.emit({ type: 'before-subscribe' });

    const streamPromise = streamAgentPromptResponse({
      agentRuntime,
      prompt: 'Continue',
      sessionId: 'session-9',
      reply,
    });

    const event = { type: 'after-subscribe' };
    eventSource.emit(event);
    completion.resolve();

    await streamPromise;

    assertEventSequence(reply.raw.writes, [`data: ${JSON.stringify(event)}\n\n`]);
  });

  it('removes the listener and lets the active turn continue on disconnect', async () => {
    const eventSource = new ControlledEventSource();
    const reply = createReply();
    const completion = createDeferred<void>();
    const agentRuntime = {
      subscribe: vi.fn((listener: (event: unknown) => void) => eventSource.subscribe(listener)),
      prompt: vi.fn(async () => ({
        sessionId: 'session-1',
        completion: completion.promise,
      })),
    };

    const streamPromise = streamAgentPromptResponse({
      agentRuntime,
      prompt: 'Implement the feature',
      reply,
    });

    expect(eventSource.listenerCount()).toBe(1);

    reply.raw.emit('close');
    await Promise.resolve();

    expect(eventSource.listenerCount()).toBe(0);

    eventSource.emit({ type: 'ignored' });
    expect(reply.raw.writes).toEqual([]);

    completion.resolve();
    await streamPromise;
  });

  it('propagates runtime errors before streaming starts', async () => {
    const reply = createReply();
    const agentRuntime = {
      subscribe: vi.fn(() => () => undefined),
      prompt: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    await expect(
      streamAgentPromptResponse({
        agentRuntime,
        prompt: 'Implement the feature',
        reply,
      }),
    ).rejects.toThrow('boom');

    expect(reply.raw.flushHeadersCalls).toBe(0);
    expect(reply.raw.writes).toEqual([]);
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