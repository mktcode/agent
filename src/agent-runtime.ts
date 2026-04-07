import path from 'node:path';

import {
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import {
  SessionBusyError,
  SessionNotFoundError,
} from './errors';
import { createPiAgentRuntimeSession } from './agent-runtime/pi-session-factory';
import {
  deletePersistentSession,
  listPersistentSessions,
  readPersistentSessionEntries,
  resolvePersistedSession,
} from './agent-runtime/pi-session-store';
import { projectAgentEventToUiItems, projectSessionEntriesToUiItems } from './agent-runtime/ui-projection';
import type {
  AgentRuntimeOptions,
  AgentRuntimePromptResult,
  AgentRuntimeSession,
  AgentRuntimeSessionEntry,
  AgentRuntimeSessionInfo,
  AgentRuntimeState,
  CreateAgentRuntimeSession,
  DeletePersistedAgentRuntimeSession,
  ListAgentRuntimeSessions,
  ReadPersistedAgentRuntimeSessionEntries,
  UiProjectionState,
  UiSessionItem,
  UiSessionItemEvent,
} from './agent-runtime/types';
import { WorkspaceManager } from './workspace';

export { SessionBusyError, SessionNotFoundError } from './errors';

export type {
  AgentRuntimeOptions,
  AgentRuntimePromptResult,
  AgentRuntimeSession,
  AgentRuntimeSessionEntry,
  AgentRuntimeSessionInfo,
  AgentRuntimeState,
  CreateAgentRuntimeSessionOptions,
  CreateAgentRuntimeSession,
  DeletePersistedAgentRuntimeSession,
  ListAgentRuntimeSessions,
  ReadPersistedAgentRuntimeSessionEntries,
  UiProjectionState,
  UiSessionItem,
  UiSessionItemEvent,
} from './agent-runtime/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export class AgentRuntime {
  readonly #workspace: WorkspaceManager;
  readonly #workspacePath: string;
  readonly #sessionStoragePath: string;
  readonly #createSession: CreateAgentRuntimeSession;
  readonly #listSessions: ListAgentRuntimeSessions;
  readonly #deletePersistedSession: DeletePersistedAgentRuntimeSession;
  readonly #readSessionEntries: ReadPersistedAgentRuntimeSessionEntries;
  readonly #listeners = new Set<(event: unknown) => void>();
  readonly #uiListeners = new Set<(event: UiSessionItemEvent) => void>();

  #state: AgentRuntimeState = 'idle';
  #session: AgentRuntimeSession | undefined;
  #unsubscribeFromSession: (() => void) | undefined;
  #execution: Promise<void> | undefined;
  #uiProjectionState: UiProjectionState = { currentAssistantTimestamp: undefined };

  public constructor(options: AgentRuntimeOptions) {
    this.#workspace = options.workspace;
    this.#workspacePath = options.workspacePath;
    this.#sessionStoragePath = path.join(path.dirname(options.workspacePath), '.pi', 'sessions');
    this.#createSession = options.createSession ?? createPiAgentRuntimeSession;
    this.#listSessions = options.listSessions ?? listPersistentSessions;
    this.#deletePersistedSession = options.deletePersistedSession ?? deletePersistentSession;
    this.#readSessionEntries = options.readSessionEntries ?? readPersistentSessionEntries;
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
    return resolvePersistedSession(() => this.listSessions(), sessionId);
  }

  public async getSessionEntries(sessionId: string): Promise<AgentRuntimeSessionEntry[]> {
    const session = await this.getSession(sessionId);

    return this.#readSessionEntries({
      session,
      sessionStoragePath: this.#sessionStoragePath,
    });
  }

  public async getSessionItems(sessionId: string): Promise<UiSessionItem[]> {
    const entries = await this.getSessionEntries(sessionId);
    return projectSessionEntriesToUiItems(entries, sessionId);
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

  public subscribeUi(listener: (event: UiSessionItemEvent) => void): () => void {
    this.#uiListeners.add(listener);

    return () => {
      this.#uiListeners.delete(listener);
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
    this.#uiProjectionState = { currentAssistantTimestamp: undefined };
    this.#unsubscribeFromSession = nextSession.subscribe((event) => {
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // External listeners must not interfere with agent execution.
        }
      }

      if (this.#uiListeners.size === 0) {
        return;
      }

      for (const uiEvent of projectAgentEventToUiItems(
        event as AgentSessionEvent,
        nextSession.sessionId,
        this.#uiProjectionState,
      )) {
        for (const listener of this.#uiListeners) {
          try {
            listener(uiEvent);
          } catch {
            // External listeners must not interfere with agent execution.
          }
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