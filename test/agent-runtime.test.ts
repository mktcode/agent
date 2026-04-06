import { afterEach, describe, expect, it } from 'vitest';

import {
  NoActiveSessionError,
  SessionAlreadyExistsError,
  SessionBusyError,
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

describe('AgentRuntime.start', () => {
  it('creates a session and runs the first turn', async () => {
    const { runtime, session, workspacePath } = await createRuntimeHarness(cleanup);

    expect(workspacePath.endsWith('/.workspace')).toBe(true);

    await runtime.start('Implement the feature');

    expect(runtime.getState()).toBe('ready');
    expect(session.prompts).toEqual(['Implement the feature']);
  });

  it('fails when a session already exists', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    await runtime.start('first');

    await expect(runtime.start('second')).rejects.toBeInstanceOf(SessionAlreadyExistsError);
  });
});

describe('AgentRuntime.send', () => {
  it('runs an additional turn in the active session', async () => {
    const { runtime, session } = await createRuntimeHarness(cleanup);

    await runtime.start('first');
    await runtime.send('second');

    expect(runtime.getState()).toBe('ready');
    expect(session.prompts).toEqual(['first', 'second']);
  });

  it('fails when there is no active session', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    await expect(runtime.send('missing')).rejects.toBeInstanceOf(NoActiveSessionError);
  });

  it('fails when another turn is already running', async () => {
    const { runtime, session } = await createRuntimeHarness(cleanup);
    const firstTurn = session.queuePrompt();

    const startPromise = runtime.start('first');

    await session.promptStartedSignals[0];
    expect(runtime.getState()).toBe('running');

    await expect(runtime.send('second')).rejects.toBeInstanceOf(SessionBusyError);

    firstTurn.resolve();
    await startPromise;
  });

  it('holds the workspace lock for the full turn', async () => {
    const { runtime, session, workspace } = await createRuntimeHarness(cleanup);
    const gate = session.queuePrompt();

    const startPromise = runtime.start('first');

    await session.promptStartedSignals[0];

    expect(runtime.getState()).toBe('running');
    expect(workspace.isLocked()).toBe(true);

    gate.resolve();
    await startPromise;

    expect(workspace.isLocked()).toBe(false);
    expect(runtime.getState()).toBe('ready');
  });

  it('releases the lock and keeps the session usable after a turn failure', async () => {
    const { runtime, session, workspace } = await createRuntimeHarness(cleanup);
    const failure = new Error('boom');

    await runtime.start('first');
    session.failNextPrompt(failure);

    await expect(runtime.send('broken')).rejects.toBe(failure);

    expect(workspace.isLocked()).toBe(false);
    expect(runtime.getState()).toBe('ready');

    await runtime.send('recovered');

    expect(session.prompts).toEqual(['first', 'broken', 'recovered']);
  });
});

describe('AgentRuntime.stop', () => {
  it('is a no-op without an active session', async () => {
    const { runtime } = await createRuntimeHarness(cleanup);

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.getState()).toBe('idle');
  });

  it('disposes an idle session and returns to idle', async () => {
    const { runtime, session } = await createRuntimeHarness(cleanup);

    await runtime.start('first');
    await runtime.stop();

    expect(runtime.getState()).toBe('idle');
    expect(session.disposeCalls).toHaveLength(1);
  });

  it('cancels a running turn, waits for termination, and releases the lock', async () => {
    const { runtime, session, workspace } = await createRuntimeHarness(cleanup);
    const gate = session.queuePrompt();

    const startPromise = runtime.start('first');

    await session.promptStartedSignals[0];
    expect(runtime.getState()).toBe('running');
    expect(workspace.isLocked()).toBe(true);

    const stopPromise = runtime.stop();

    expect(session.abortCalls).toHaveLength(1);
    expect(runtime.getState()).toBe('running');

    session.abortCalls[0]?.resolve();
    gate.resolve();

    await stopPromise;
    await startPromise;

    expect(runtime.getState()).toBe('idle');
    expect(workspace.isLocked()).toBe(false);
    expect(session.disposeCalls).toHaveLength(1);
  });
});

describe('AgentRuntime.subscribe', () => {
  it('forwards events unchanged and preserves order', async () => {
    const { runtime, session } = await createRuntimeHarness(cleanup);
    const received = createEventCollector();

    runtime.subscribe(received.listener);

    const firstEvent = { type: 'message_start', value: 1 };
    const secondEvent = { type: 'turn_end', value: 2 };

    await runtime.start('first');
    session.emit(firstEvent);
    session.emit(secondEvent);

    assertEventSequence(received.events, [firstEvent, secondEvent]);
  });

  it('supports multiple listeners without replay', async () => {
    const { runtime, session } = await createRuntimeHarness(cleanup);
    const first = createEventCollector();
    const second = createEventCollector();

    runtime.subscribe(first.listener);

    await runtime.start('first');
    session.emit({ type: 'before-second-listener' });

    runtime.subscribe(second.listener);

    const event = { type: 'after-second-listener' };
    session.emit(event);

    assertEventSequence(first.events, [{ type: 'before-second-listener' }, event]);
    assertEventSequence(second.events, [event]);
  });
});