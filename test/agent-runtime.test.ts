import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionBusyError,
  SessionNotFoundError,
} from '../src/agent-runtime';
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
    expect(createSessionCalls[0]?.sessionStoragePath).toBe(`${workspacePath}/.pi/sessions`);
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