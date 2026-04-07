import { rm } from 'node:fs/promises';
import path from 'node:path';

import { getModel, KnownProvider } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type SessionInfo,
} from '@mariozechner/pi-coding-agent';
import {
  SessionBusyError,
  SessionNotFoundError,
} from './errors';
import { WorkspaceManager } from './workspace';

export { SessionBusyError, SessionNotFoundError } from './errors';

export type AgentRuntimeState = 'idle' | 'ready' | 'running';

export interface AgentRuntimeSession {
  readonly sessionId: string;
  prompt(input: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface CreateAgentRuntimeSessionOptions {
  workspacePath: string;
  sessionId?: string;
  sessionStoragePath: string;
}

export type CreateAgentRuntimeSession = (
  options: CreateAgentRuntimeSessionOptions,
) => Promise<AgentRuntimeSession>;

export interface AgentRuntimePromptResult {
  sessionId: string;
  completion: Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export type AgentRuntimeSessionInfo = SessionInfo;

export interface ListAgentRuntimeSessionsOptions {
  workspacePath: string;
  sessionStoragePath: string;
}

export type ListAgentRuntimeSessions = (
  options: ListAgentRuntimeSessionsOptions,
) => Promise<AgentRuntimeSessionInfo[]>;

export interface DeletePersistedAgentRuntimeSessionOptions {
  session: AgentRuntimeSessionInfo;
}

export type DeletePersistedAgentRuntimeSession = (
  options: DeletePersistedAgentRuntimeSessionOptions,
) => Promise<void>;

export interface AgentRuntimeOptions {
  workspace: WorkspaceManager;
  workspacePath: string;
  createSession?: CreateAgentRuntimeSession;
  listSessions?: ListAgentRuntimeSessions;
  deletePersistedSession?: DeletePersistedAgentRuntimeSession;
}

export class AgentRuntime {
  readonly #workspace: WorkspaceManager;
  readonly #workspacePath: string;
  readonly #sessionStoragePath: string;
  readonly #createSession: CreateAgentRuntimeSession;
  readonly #listSessions: ListAgentRuntimeSessions;
  readonly #deletePersistedSession: DeletePersistedAgentRuntimeSession;
  readonly #listeners = new Set<(event: unknown) => void>();

  #state: AgentRuntimeState = 'idle';
  #session: AgentRuntimeSession | undefined;
  #unsubscribeFromSession: (() => void) | undefined;
  #execution: Promise<void> | undefined;

  public constructor(options: AgentRuntimeOptions) {
    this.#workspace = options.workspace;
    this.#workspacePath = options.workspacePath;
    this.#sessionStoragePath = path.join(path.dirname(options.workspacePath), '.pi', 'sessions');
    this.#createSession = options.createSession ?? createPiAgentRuntimeSession;
    this.#listSessions = options.listSessions ?? listPersistentSessions;
    this.#deletePersistedSession = options.deletePersistedSession ?? deletePersistentSession;
  }

  public async prompt(input: string, sessionId?: string): Promise<AgentRuntimePromptResult> {
    if (this.#execution) {
      throw new SessionBusyError();
    }

    const sessionReady = createDeferred<AgentRuntimeSession>();
    let session: AgentRuntimeSession | undefined;

    const execution = this.#workspace.runExclusive(async () => {
      session = await this.#loadSession(sessionId);
      this.#state = 'running';
      sessionReady.resolve(session);

      // Yield once so prompt() can return the session id before agent events begin.
      await Promise.resolve();
      await session.prompt(input);
    });

    this.#execution = execution;

    execution.catch((error) => {
      if (session === undefined) {
        sessionReady.reject(error);
      }
    });

    let activeSession: AgentRuntimeSession;

    try {
      activeSession = await sessionReady.promise;
    } catch (error) {
      if (this.#execution === execution) {
        this.#execution = undefined;
      }

      throw error;
    }

    const completion = execution.finally(() => {
      if (this.#execution === execution) {
        this.#execution = undefined;
      }

      if (this.#session === activeSession) {
        this.#state = 'ready';
      }
    });

    return {
      sessionId: activeSession.sessionId,
      completion,
    };
  }

  public async listSessions(): Promise<AgentRuntimeSessionInfo[]> {
    const sessions = await this.#listSessions({
      workspacePath: this.#workspacePath,
      sessionStoragePath: this.#sessionStoragePath,
    });

    return [...sessions].sort((left, right) => left.id.localeCompare(right.id));
  }

  public async getSession(sessionId: string): Promise<AgentRuntimeSessionInfo> {
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);

    if (!session) {
      throw new SessionNotFoundError({ sessionId });
    }

    return session;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.#workspace.runExclusive(async () => {
      const session = await this.getSession(sessionId);

      if (this.#session?.sessionId === sessionId) {
        this.#destroySession(this.#session);
      }

      await this.#deletePersistedSession({ session });
    });
  }

  public async stop(): Promise<void> {
    const session = this.#session;

    if (!session) {
      return;
    }

    const execution = this.#execution;

    if (execution) {
      await session.abort();
      await execution.catch(() => undefined);
    }

    if (this.#session === session) {
      this.#destroySession(session);
    }
  }

  public getState(): AgentRuntimeState {
    return this.#state;
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #loadSession(sessionId?: string): Promise<AgentRuntimeSession> {
    const currentSession = this.#session;

    if (sessionId !== undefined && currentSession?.sessionId === sessionId) {
      return currentSession;
    }

    const nextSession = await this.#createSession({
      workspacePath: this.#workspacePath,
      sessionId,
      sessionStoragePath: this.#sessionStoragePath,
    });

    if (currentSession && currentSession !== nextSession) {
      this.#destroySession(currentSession);
    }

    this.#session = nextSession;
    this.#unsubscribeFromSession = nextSession.subscribe((event) => {
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // External listeners must not interfere with agent execution.
        }
      }
    });
    this.#state = 'ready';

    return nextSession;
  }

  #destroySession(session: AgentRuntimeSession): void {
    this.#unsubscribeFromSession?.();
    this.#unsubscribeFromSession = undefined;

    session.dispose();

    if (this.#session === session) {
      this.#session = undefined;
    }

    this.#state = 'idle';
  }
}

async function createPiAgentRuntimeSession(
  options: CreateAgentRuntimeSessionOptions,
): Promise<AgentRuntimeSession> {
  const sessionManager = options.sessionId === undefined
    ? SessionManager.create(options.workspacePath, options.sessionStoragePath)
    : await openPersistentSession(options.workspacePath, options.sessionId, options.sessionStoragePath);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = getModel(
    process.env.MODEL_PROVIDER as KnownProvider ?? 'openai',
    process.env.MODEL_NAME as never ?? 'gpt-5.4-mini'
  );
  if (!model) {
    throw new Error('Failed to initialize model. Please check your MODEL_PROVIDER and MODEL_NAME environment variables.');
  }

  const { session } = await createAgentSession({
    cwd: options.workspacePath,
    sessionManager,
    modelRegistry,
    model,
  });

  return {
    sessionId: session.sessionId,
    prompt: (input: string) => session.prompt(input),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: (listener: (event: unknown) => void) => session.subscribe(listener),
  };
}

async function listPersistentSessions(
  options: ListAgentRuntimeSessionsOptions,
): Promise<AgentRuntimeSessionInfo[]> {
  return SessionManager.list(options.workspacePath, options.sessionStoragePath);
}

async function deletePersistentSession(
  options: DeletePersistedAgentRuntimeSessionOptions,
): Promise<void> {
  await rm(options.session.path);
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve(value: T | PromiseLike<T>): void {
      resolve(value);
    },
    reject(reason?: unknown): void {
      reject(reason);
    },
  };
}

async function openPersistentSession(
  workspacePath: string,
  sessionId: string,
  sessionStoragePath: string,
): Promise<SessionManager> {
  const sessions = await SessionManager.list(workspacePath, sessionStoragePath);
  const session = sessions.find((entry) => entry.id === sessionId);

  if (!session) {
    throw new SessionNotFoundError({ sessionId });
  }

  return SessionManager.open(session.path, sessionStoragePath);
}