import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'vitest';

import {
  AgentRuntime,
  type AgentRuntimeSession,
  type CreateAgentRuntimeSession,
} from '../src/agent-runtime';
import type { AgentEventSource, StreamAgentEventsReply } from '../src/streaming';
import { WorkspaceManager } from '../src/workspace';
import {
  commitFile as commitGitFile,
  createGitEnvironment as createRawGitEnvironment,
  createGitRepository as createRawGitRepository,
  type TestGitEnvironment,
  type TestGitRepository,
} from './helpers/git-repository';

export interface CleanupRegistry {
  add(cleanup: () => Promise<void>): void;
  runAll(): Promise<void>;
}

export function createCleanupRegistry(): CleanupRegistry {
  const cleanupTasks: Array<() => Promise<void>> = [];

  return {
    add(cleanup: () => Promise<void>): void {
      cleanupTasks.push(cleanup);
    },
    async runAll(): Promise<void> {
      while (cleanupTasks.length > 0) {
        const cleanup = cleanupTasks.pop();

        if (cleanup) {
          await cleanup();
        }
      }
    },
  };
}

export async function createTempDirectory(
  cleanup: CleanupRegistry,
  prefix: string,
): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.add(async () => {
    await rm(rootPath, { force: true, recursive: true });
  });
  return rootPath;
}

export async function createTempWorkspacePath(
  cleanup: CleanupRegistry,
  prefix = 'nextagent-workspace-',
): Promise<string> {
  const rootPath = await createTempDirectory(cleanup, prefix);
  return path.join(rootPath, '.workspace');
}

export async function createGitRepository(
  cleanup?: CleanupRegistry,
): Promise<TestGitRepository> {
  const repository = await createRawGitRepository();
  cleanup?.add(repository.cleanup);
  return repository;
}

export async function createGitEnvironment(
  cleanup?: CleanupRegistry,
): Promise<TestGitEnvironment> {
  const environment = await createRawGitEnvironment();
  cleanup?.add(environment.cleanup);
  return environment;
}

export async function commitFile(
  repoPath: string,
  filePath: string,
  content: string,
  message: string,
): Promise<string> {
  return commitGitFile(repoPath, filePath, content, message);
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

export class ControlledAgentSession implements AgentRuntimeSession {
  public readonly prompts: string[] = [];
  public readonly promptGates: Array<Deferred<void>> = [];
  public readonly promptStartedSignals: Array<Promise<void>> = [];
  public readonly abortCalls: Array<Deferred<void>> = [];
  public readonly disposeCalls: number[] = [];

  readonly #listeners = new Set<(event: unknown) => void>();
  readonly #failures: unknown[] = [];
  readonly #pendingPromptStarts: Array<Deferred<void>> = [];

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
    this.disposeCalls.push(this.disposeCalls.length + 1);
  }
}

export interface RuntimeHarness {
  runtime: AgentRuntime;
  workspace: WorkspaceManager;
  workspacePath: string;
  session: ControlledAgentSession;
  createSession: CreateAgentRuntimeSession;
}

export async function createRuntimeHarness(
  cleanup: CleanupRegistry,
  prefix = 'nextagent-agent-runtime-',
): Promise<RuntimeHarness> {
  const workspacePath = await createTempWorkspacePath(cleanup, prefix);
  const workspace = new WorkspaceManager({ repoUrl: '/tmp/unused', workspacePath });
  const session = new ControlledAgentSession();

  const createSession: CreateAgentRuntimeSession = async () => session;

  return {
    runtime: new AgentRuntime({
      workspace,
      workspacePath,
      createSession,
    }),
    workspace,
    workspacePath,
    session,
    createSession,
  };
}

export interface EventCollector<T> {
  events: T[];
  listener(event: T): void;
}

export function createEventCollector<T = unknown>(): EventCollector<T> {
  const events: T[] = [];

  return {
    events,
    listener(event: T): void {
      events.push(event);
    },
  };
}

export function assertEventSequence<T>(events: T[], expected: T[]): void {
  expect(events).toEqual(expected);
}

export function assertStreamCompletion(events: Array<{ type?: unknown }>): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events.at(-1)?.type === 'done' || events.at(-1)?.type === 'error').toBe(true);
}

export class ControlledEventSource implements AgentEventSource {
  readonly #listeners = new Set<(event: unknown) => void>();

  public emit(event: unknown): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  public listenerCount(): number {
    return this.#listeners.size;
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export class FakeRawResponse extends EventEmitter {
  public readonly headers = new Map<string, string>();
  public readonly writes: string[] = [];
  public statusCode = 0;
  public destroyed = false;
  public writableEnded = false;
  public flushHeadersCalls = 0;

  public setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  public flushHeaders(): void {
    this.flushHeadersCalls += 1;
  }

  public write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  public end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }

  public destroy(error?: Error): this {
    this.destroyed = true;

    if (error) {
      this.emit('error', error);
    }

    this.emit('close');
    return this;
  }
}

export interface FakeReply extends StreamAgentEventsReply {
  raw: FakeRawResponse;
}

export function createReply(): FakeReply {
  return {
    raw: new FakeRawResponse(),
    hijack() {
      return;
    },
  };
}