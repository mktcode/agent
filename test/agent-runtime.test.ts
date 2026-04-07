import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  SessionBusyError,
  SessionNotFoundError,
} from '../src/agent-runtime';
import { LockUnavailableError } from '../src/errors';
import {
  assertEventSequence,
  createCleanupRegistry,
  createEventCollector,
  createRuntimeHarness,
} from './harness';

const cleanup = createCleanupRegistry();

afterEach(async () => {
  await cleanup.runAll();
});

describe('AgentRuntime.prompt', () => {
  it('creates a persistent session and runs a turn when no session id is provided', async () => {
    const { runtime, getSession, workspacePath, createSessionCalls } = await createRuntimeHarness(cleanup);

    expect(workspacePath.endsWith('/.workspace')).toBe(true);

    const turn = await runtime.prompt('Implement the feature');
    await turn.completion;
    const session = getSession(turn.sessionId);

    expect(runtime.getState()).toBe('ready');
    expect(turn.sessionId).toBe('session-1');
    expect(session.prompts).toEqual(['Implement the feature']);
    expect(createSessionCalls[0]?.sessionStoragePath).toBe(path.join(path.dirname(workspacePath), '.pi', 'sessions'));
  });

  it('resumes the requested persistent session when a session id is provided', async () => {
    const { runtime, getSession, createSessionCalls } = await createRuntimeHarness(cleanup);

    const firstTurn = await runtime.prompt('first');
    await firstTurn.completion;
    await runtime.stop();

    const secondTurn = await runtime.prompt('second', firstTurn.sessionId);
    await secondTurn.completion;
    const session = getSession(firstTurn.sessionId);

    expect(runtime.getState()).toBe('ready');
    expect(secondTurn.sessionId).toBe(firstTurn.sessionId);
    expect(session.prompts).toEqual(['first', 'second']);
    expect(createSessionCalls.at(-1)?.sessionId).toBe(firstTurn.sessionId);
  });

  it('fails when the requested session does not exist', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    await expect(runtime.prompt('missing', 'unknown-session')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('fails when another turn is already running', async () => {
    const { runtime, getSession } = await createRuntimeHarness(cleanup);
    const first = await runtime.prompt('first');
    const session = getSession(first.sessionId);
    const gate = session.promptGates[0];

    expect(runtime.getState()).toBe('running');

    await expect(runtime.prompt('second')).rejects.toBeInstanceOf(SessionBusyError);

    gate?.resolve();
    await first.completion;
  });

  it('holds the workspace lock for the full turn', async () => {
    const { runtime, getSession, workspace } = await createRuntimeHarness(cleanup);
    const turn = await runtime.prompt('first');
    const session = getSession(turn.sessionId);
    const gate = session.promptGates[0];

    await session.promptStartedSignals[0];

    expect(runtime.getState()).toBe('running');
    expect(workspace.isLocked()).toBe(true);

    gate?.resolve();
    await turn.completion;

    expect(workspace.isLocked()).toBe(false);
    expect(runtime.getState()).toBe('ready');
  });

  it('releases the lock and keeps the session usable after a turn failure', async () => {
    const { runtime, getSession, workspace } = await createRuntimeHarness(cleanup);
    const failure = new Error('boom');

    const firstTurn = await runtime.prompt('first');
    await firstTurn.completion;
    const session = getSession(firstTurn.sessionId);
    session.failNextPrompt(failure);

    const brokenTurn = await runtime.prompt('broken', firstTurn.sessionId);

    await expect(brokenTurn.completion).rejects.toBe(failure);

    expect(workspace.isLocked()).toBe(false);
    expect(runtime.getState()).toBe('ready');

    const recoveredTurn = await runtime.prompt('recovered', firstTurn.sessionId);
    await recoveredTurn.completion;

    expect(session.prompts).toEqual(['first', 'broken', 'recovered']);
  });
});

describe('AgentRuntime.stop', () => {
  it('is a no-op without a loaded session', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.getState()).toBe('idle');
  });

  it('disposes a loaded idle session and returns to idle', async () => {
    const { runtime, getSession } = await createRuntimeHarness(cleanup);

    const turn = await runtime.prompt('first');
    await turn.completion;
    const session = getSession(turn.sessionId);
    await runtime.stop();

    expect(runtime.getState()).toBe('idle');
    expect(session.disposeCalls).toHaveLength(1);
  });

  it('cancels a running turn, waits for termination, and releases the lock', async () => {
    const { runtime, getSession, workspace } = await createRuntimeHarness(cleanup);
    const turn = await runtime.prompt('first');
    const session = getSession(turn.sessionId);
    const gate = session.promptGates[0];

    await session.promptStartedSignals[0];
    expect(runtime.getState()).toBe('running');
    expect(workspace.isLocked()).toBe(true);

    const stopPromise = runtime.stop();

    expect(session.abortCalls).toHaveLength(1);
    expect(runtime.getState()).toBe('running');

    session.abortCalls[0]?.resolve();
    gate?.resolve();

    await stopPromise;
    await turn.completion;

    expect(runtime.getState()).toBe('idle');
    expect(workspace.isLocked()).toBe(false);
    expect(session.disposeCalls).toHaveLength(1);
  });
});

describe('AgentRuntime.listSessions', () => {
  it('returns persisted sessions sorted by session id without changing runtime state', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    const firstTurn = await runtime.prompt('first');
    await firstTurn.completion;
    await runtime.stop();

    const secondTurn = await runtime.prompt('second');
    await secondTurn.completion;

    const sessions = await runtime.listSessions();

    expect(sessions.map((session) => session.id)).toEqual(['session-1', 'session-2']);
    expect(runtime.getState()).toBe('ready');
  });
});

describe('AgentRuntime.getSession', () => {
  it('returns the persisted session metadata for the requested session id without changing runtime state', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    const firstTurn = await runtime.prompt('first');
    await firstTurn.completion;
    await runtime.stop();

    const secondTurn = await runtime.prompt('second');
    await secondTurn.completion;

    const session = await runtime.getSession(firstTurn.sessionId);

    expect(session.id).toBe(firstTurn.sessionId);
    expect(session.firstMessage).toBe('first');
    expect(runtime.getState()).toBe('ready');
  });

  it('fails when the requested persisted session does not exist', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    await expect(runtime.getSession('missing-session')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('AgentRuntime.getSessionEntries', () => {
  it('returns current-branch persisted entries for the requested session id', async () => {
    const { runtime, getSessionEntries } = await createRuntimeHarness(cleanup);

    const turn = await runtime.prompt('first');
    await turn.completion;

    const entries = await runtime.getSessionEntries(turn.sessionId);

    expect(entries).toEqual(getSessionEntries(turn.sessionId));
  });
});

describe('AgentRuntime.getSessionItems', () => {
  it('projects persisted entries into minimal chat ui items', async () => {
    const { runtime, getSessionEntries } = await createRuntimeHarness(cleanup);

    const turn = await runtime.prompt('first');
    await turn.completion;

    const entries = getSessionEntries(turn.sessionId);
    entries.push(
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2024-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          timestamp: 1704067200000,
        },
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2024-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { file: 'a.txt' } },
          ],
          api: 'openai-responses',
          provider: 'openai',
          model: 'gpt-5.4-mini',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1704067201000,
        },
      },
      {
        type: 'message',
        id: 'tool-1',
        parentId: 'assistant-1',
        timestamp: '2024-01-01T00:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'file content' }],
          isError: true,
          timestamp: 1704067202000,
        },
      },
    );

    const items = await runtime.getSessionItems(turn.sessionId);

    expect(items).toEqual([
      {
        id: 'user-1:message',
        sessionId: turn.sessionId,
        timestamp: '2024-01-01T00:00:00.000Z',
        kind: 'message',
        status: 'final',
        role: 'user',
        text: 'hello',
        isError: false,
      },
      {
        id: 'assistant-1:thinking',
        sessionId: turn.sessionId,
        timestamp: '2024-01-01T00:00:01.000Z',
        kind: 'thinking',
        status: 'final',
        text: 'thinking',
        isError: false,
      },
      {
        id: 'assistant-1:message',
        sessionId: turn.sessionId,
        timestamp: '2024-01-01T00:00:01.000Z',
        kind: 'message',
        status: 'final',
        role: 'assistant',
        text: 'answer',
        isError: false,
      },
      {
        id: 'call-1:tool',
        sessionId: turn.sessionId,
        timestamp: '2024-01-01T00:00:02.000Z',
        kind: 'tool',
        status: 'error',
        toolName: 'read_file',
        toolCallId: 'call-1',
        text: 'file content',
        isError: true,
      },
    ]);
  });
});

describe('AgentRuntime.deleteSession', () => {
  it('deletes a persisted session and disposes the open in-memory session when it matches', async () => {
    const { runtime, getSession, hasSession } = await createRuntimeHarness(cleanup);

    const turn = await runtime.prompt('first');
    await turn.completion;
    const session = getSession(turn.sessionId);

    await runtime.deleteSession(turn.sessionId);

    expect(hasSession(turn.sessionId)).toBe(false);
    expect(session.disposeCalls).toHaveLength(1);
    expect(runtime.getState()).toBe('idle');
  });

  it('fails when deleting an unknown persisted session', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    await expect(runtime.deleteSession('missing-session')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('fails with lock contention while a turn is running', async () => {
    const { runtime, getSession } = await createRuntimeHarness(cleanup);

    const turn = await runtime.prompt('first');
    const session = getSession(turn.sessionId);

    await session.promptStartedSignals[0];

    await expect(runtime.deleteSession(turn.sessionId)).rejects.toBeInstanceOf(LockUnavailableError);

    session.promptGates[0]?.resolve();
    await turn.completion;
  });
});

describe('AgentRuntime.subscribe', () => {
  it('forwards events unchanged and preserves order', async () => {
    const { runtime, getSession } = await createRuntimeHarness(cleanup);
    const received = createEventCollector();

    runtime.subscribe(received.listener);

    const firstEvent = { type: 'message_start', value: 1 };
    const secondEvent = { type: 'turn_end', value: 2 };

    const turn = await runtime.prompt('first');
    await turn.completion;
    const session = getSession(turn.sessionId);
    session.emit(firstEvent);
    session.emit(secondEvent);

    assertEventSequence(received.events, [firstEvent, secondEvent]);
  });

  it('supports multiple listeners without replay', async () => {
    const { runtime, getSession } = await createRuntimeHarness(cleanup);
    const first = createEventCollector();
    const second = createEventCollector();

    runtime.subscribe(first.listener);

    const turn = await runtime.prompt('first');
    await turn.completion;
    const session = getSession(turn.sessionId);
    session.emit({ type: 'before-second-listener' });

    runtime.subscribe(second.listener);

    const event = { type: 'after-second-listener' };
    session.emit(event);

    assertEventSequence(first.events, [{ type: 'before-second-listener' }, event]);
    assertEventSequence(second.events, [event]);
  });
});

describe('AgentRuntime.subscribeUi', () => {
  it('projects assistant deltas and tool execution into minimal ui items', async () => {
    const { runtime, getSession } = await createRuntimeHarness(cleanup);
    const received = createEventCollector();

    runtime.subscribeUi(received.listener);

    const turn = await runtime.prompt('first');
    await turn.completion;
    const session = getSession(turn.sessionId);

    session.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
        timestamp: 1704067200000,
      },
    });
    session.emit({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'hel' }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 1704067201000,
      },
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'plan',
        partial: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'hel' }],
          api: 'openai-responses',
          provider: 'openai',
          model: 'gpt-5.4-mini',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1704067201000,
        },
      },
    });
    session.emit({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'hello' }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 1704067201000,
      },
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 1,
        delta: 'hello',
        partial: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'hello' }],
          api: 'openai-responses',
          provider: 'openai',
          model: 'gpt-5.4-mini',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1704067201000,
        },
      },
    });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: { filePath: 'a.txt' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'denied',
      isError: true,
    });

    expect(received.events).toEqual([
      {
        type: 'session_item',
        item: {
          id: '1704067200000:user:message',
          sessionId: turn.sessionId,
          timestamp: '2024-01-01T00:00:00.000Z',
          kind: 'message',
          status: 'final',
          role: 'user',
          text: 'first',
          isError: false,
        },
      },
      {
        type: 'session_item',
        item: {
          id: '1704067201000:assistant:thinking',
          sessionId: turn.sessionId,
          timestamp: '2024-01-01T00:00:01.000Z',
          kind: 'thinking',
          status: 'streaming',
          text: 'plan',
          isError: false,
        },
      },
      {
        type: 'session_item',
        item: {
          id: '1704067201000:assistant:message',
          sessionId: turn.sessionId,
          timestamp: '2024-01-01T00:00:01.000Z',
          kind: 'message',
          status: 'streaming',
          role: 'assistant',
          text: 'hello',
          isError: false,
        },
      },
      {
        type: 'session_item',
        item: {
          id: 'call-1:tool',
          sessionId: turn.sessionId,
          timestamp: '2024-01-01T00:00:01.000Z',
          kind: 'tool',
          status: 'streaming',
          toolName: 'read_file',
          toolCallId: 'call-1',
          isError: false,
        },
      },
      {
        type: 'session_item',
        item: {
          id: 'call-1:tool',
          sessionId: turn.sessionId,
          timestamp: '2024-01-01T00:00:01.000Z',
          kind: 'tool',
          status: 'error',
          toolName: 'read_file',
          toolCallId: 'call-1',
          text: 'denied',
          isError: true,
        },
      },
    ]);
  });
});