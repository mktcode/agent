import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  NoActiveSessionError,
  SessionAlreadyExistsError,
  SessionBusyError,
  type AgentRuntimeSession,
  type CreateAgentRuntimeSession,
} from '../src/agent-runtime';
import { WorkspaceManager } from '../src/workspace';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();

    if (cleanup) {
      await cleanup();
    }
  }
});

async function createTempWorkspacePath(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nextagent-agent-runtime-'));
  cleanupTasks.push(async () => {
    await rm(rootPath, { force: true, recursive: true });
  });
  return path.join(rootPath, '.workspace');
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

class ControlledAgentSession implements AgentRuntimeSession {
  readonly prompts: string[] = [];
  readonly events: unknown[] = [];
  readonly promptGates: Array<Deferred<void>> = [];
  readonly promptStartedSignals: Array<Promise<void>> = [];
  readonly abortCalls: Array<Deferred<void>> = [];
  readonly disposeCalls: number[] = [];

  #listeners = new Set<(event: unknown) => void>();
  #failures: unknown[] = [];
  #pendingPromptStarts: Array<Deferred<void>> = [];

  public queuePrompt(): Deferred<void> {
    const started = createDeferred<void>();
    const gate = createDeferred<void>();

    this.#pendingPromptStarts.push(started);
    this.promptStartedSignals.push(started.promise);
    this.promptGates.push(gate);
    return gate;
  }

  public failNextPrompt(error: unknown): void {
    this.#failures.push(error);
  }

  public emit(event: unknown): void {
    this.events.push(event);

    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  public async prompt(input: string): Promise<void> {
    this.prompts.push(input);

    const started = this.#pendingPromptStarts.shift();
    started?.resolve();

    const failure = this.#failures.shift();

    if (failure !== undefined) {
      throw failure;
    }

    const gate = this.promptGates.shift();

    if (gate) {
      await gate.promise;
    }
  }

  public async abort(): Promise<void> {
    const call = createDeferred<void>();
    this.abortCalls.push(call);
    await call.promise;
  }

  public dispose(): void {
    this.disposeCalls.push(Date.now());
  }
}

interface RuntimeHarness {
  runtime: AgentRuntime;
  workspace: WorkspaceManager;
  session: ControlledAgentSession;
  createSession: CreateAgentRuntimeSession;
}

async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const workspacePath = await createTempWorkspacePath();
  const workspace = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });
  const session = new ControlledAgentSession();

  const createSession: CreateAgentRuntimeSession = async (cwd) => {
    expect(cwd).toBe(workspacePath);
    return session;
  };

  return {
    runtime: new AgentRuntime({
      workspace,
      workspacePath,
      createSession,
    }),
    workspace,
    session,
    createSession,
  };
}

describe('AgentRuntime.start', () => {
  it('creates a session and runs the first turn', async () => {
    const { runtime, session } = await createRuntimeHarness();

    await runtime.start('Implement the feature');

    expect(runtime.getState()).toBe('ready');
    expect(session.prompts).toEqual(['Implement the feature']);
  });

  it('fails when a session already exists', async () => {
    const { runtime } = await createRuntimeHarness();

    await runtime.start('first');

    await expect(runtime.start('second')).rejects.toBeInstanceOf(SessionAlreadyExistsError);
  });
});

describe('AgentRuntime.send', () => {
  it('runs an additional turn in the active session', async () => {
    const { runtime, session } = await createRuntimeHarness();

    await runtime.start('first');
    await runtime.send('second');

    expect(runtime.getState()).toBe('ready');
    expect(session.prompts).toEqual(['first', 'second']);
  });

  it('fails when there is no active session', async () => {
    const { runtime } = await createRuntimeHarness();

    await expect(runtime.send('missing')).rejects.toBeInstanceOf(NoActiveSessionError);
  });

  it('fails when another turn is already running', async () => {
    const { runtime, session } = await createRuntimeHarness();
    const firstTurn = session.queuePrompt();

    const startPromise = runtime.start('first');

    await session.promptStartedSignals[0];
    expect(runtime.getState()).toBe('running');

    await expect(runtime.send('second')).rejects.toBeInstanceOf(SessionBusyError);

    firstTurn.resolve();
    await startPromise;
  });

  it('holds the workspace lock for the full turn', async () => {
    const { runtime, session, workspace } = await createRuntimeHarness();
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
    const { runtime, session, workspace } = await createRuntimeHarness();
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
    const { runtime } = await createRuntimeHarness();

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.getState()).toBe('idle');
  });

  it('disposes an idle session and returns to idle', async () => {
    const { runtime, session } = await createRuntimeHarness();

    await runtime.start('first');
    await runtime.stop();

    expect(runtime.getState()).toBe('idle');
    expect(session.disposeCalls).toHaveLength(1);
  });

  it('cancels a running turn, waits for termination, and releases the lock', async () => {
    const { runtime, session, workspace } = await createRuntimeHarness();
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
    const { runtime, session } = await createRuntimeHarness();
    const received: unknown[] = [];

    runtime.subscribe((event) => {
      received.push(event);
    });

    const firstEvent = { type: 'message_start', value: 1 };
    const secondEvent = { type: 'turn_end', value: 2 };

    await runtime.start('first');
    session.emit(firstEvent);
    session.emit(secondEvent);

    expect(received).toEqual([firstEvent, secondEvent]);
  });

  it('supports multiple listeners without replay', async () => {
    const { runtime, session } = await createRuntimeHarness();
    const first: unknown[] = [];
    const second: unknown[] = [];

    runtime.subscribe((event) => {
      first.push(event);
    });

    await runtime.start('first');
    session.emit({ type: 'before-second-listener' });

    runtime.subscribe((event) => {
      second.push(event);
    });

    const event = { type: 'after-second-listener' };
    session.emit(event);

    expect(first).toEqual([{ type: 'before-second-listener' }, event]);
    expect(second).toEqual([event]);
  });
});