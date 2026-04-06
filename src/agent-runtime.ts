import path from 'node:path';

import { createAgentSession, SessionManager } from '@mariozechner/pi-coding-agent';
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

export interface AgentRuntimeOptions {
  workspace: WorkspaceManager;
  workspacePath: string;
  createSession?: CreateAgentRuntimeSession;
}

export class AgentRuntime {
  readonly #workspace: WorkspaceManager;
  readonly #workspacePath: string;
  readonly #sessionStoragePath: string;
  readonly #createSession: CreateAgentRuntimeSession;
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
  }

  public async prompt(input: string, sessionId?: string): Promise<AgentRuntimePromptResult> {
    if (this.#execution) {
      throw new SessionBusyError();
    }

    const session = await this.#loadSession(sessionId);
    this.#state = 'running';

    const execution = this.#workspace.runExclusive(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await session.prompt(input);
    });

    this.#execution = execution;

    let immediateError: unknown;
    execution.catch((error) => {
      immediateError = error;
    });

    await Promise.resolve();

    if (immediateError !== undefined) {
      if (this.#execution === execution) {
        this.#execution = undefined;
      }

      if (this.#session === session) {
        this.#state = 'ready';
      }

      throw immediateError;
    }

    const completion = execution.finally(() => {
      if (this.#execution === execution) {
        this.#execution = undefined;
      }

      if (this.#session === session) {
        this.#state = 'ready';
      }
    });

    return {
      sessionId: session.sessionId,
      completion,
    };
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
  const { session } = await createAgentSession({
    cwd: options.workspacePath,
    sessionManager,
  });

  return {
    sessionId: session.sessionId,
    prompt: (input: string) => session.prompt(input),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: (listener: (event: unknown) => void) => session.subscribe(listener),
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