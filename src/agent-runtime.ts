import {
  NoActiveSessionError,
  SessionAlreadyExistsError,
  SessionBusyError,
} from './errors';
import { WorkspaceManager } from './workspace';

export { NoActiveSessionError, SessionAlreadyExistsError, SessionBusyError } from './errors';

export type AgentRuntimeState = 'idle' | 'ready' | 'running';

export interface AgentRuntimeSession {
  prompt(input: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
}

export type CreateAgentRuntimeSession = (cwd: string) => Promise<AgentRuntimeSession>;

interface PiAgentSession {
  prompt(input: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
}

interface PiCodingAgentModule {
  SessionManager: {
    create(cwd: string): unknown;
  };
  createAgentSession(options: {
    cwd: string;
    sessionManager: unknown;
  }): Promise<{
    session: PiAgentSession;
  }>;
}

export interface AgentRuntimeOptions {
  workspace: WorkspaceManager;
  workspacePath: string;
  createSession?: CreateAgentRuntimeSession;
}

export class AgentRuntime {
  readonly #workspace: WorkspaceManager;
  readonly #workspacePath: string;
  readonly #createSession: CreateAgentRuntimeSession;
  readonly #listeners = new Set<(event: unknown) => void>();

  #state: AgentRuntimeState = 'idle';
  #session: AgentRuntimeSession | undefined;
  #unsubscribeFromSession: (() => void) | undefined;
  #execution: Promise<void> | undefined;

  public constructor(options: AgentRuntimeOptions) {
    this.#workspace = options.workspace;
    this.#workspacePath = options.workspacePath;
    this.#createSession = options.createSession ?? createPiAgentRuntimeSession;
  }

  public async start(prompt: string): Promise<void> {
    if (this.#session) {
      throw new SessionAlreadyExistsError();
    }

    const session = await this.#createSession(this.#workspacePath);

    this.#session = session;
    this.#unsubscribeFromSession = session.subscribe((event) => {
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // External listeners must not interfere with agent execution.
        }
      }
    });
    this.#state = 'ready';

    await this.#executeTurn(session, prompt);
  }

  public async send(input: string): Promise<void> {
    const session = this.#session;

    if (!session) {
      throw new NoActiveSessionError();
    }

    if (this.#execution) {
      throw new SessionBusyError();
    }

    await this.#executeTurn(session, input);
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

  async #executeTurn(session: AgentRuntimeSession, input: string): Promise<void> {
    this.#state = 'running';

    const execution = this.#workspace.runExclusive(async () => {
      await session.prompt(input);
    });

    this.#execution = execution;

    try {
      await execution;
    } finally {
      if (this.#execution === execution) {
        this.#execution = undefined;
      }

      if (this.#session === session) {
        this.#state = 'ready';
      }
    }
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

async function createPiAgentRuntimeSession(cwd: string): Promise<AgentRuntimeSession> {
  const { SessionManager, createAgentSession } = await loadPiCodingAgentModule();
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.create(cwd),
  });

  return {
    prompt: (input: string) => session.prompt(input),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: (listener: (event: unknown) => void) => session.subscribe(listener),
  };
}

function loadPiCodingAgentModule(): Promise<PiCodingAgentModule> {
  return new Function(
    'specifier',
    'return import(specifier);',
  )('@mariozechner/pi-coding-agent') as Promise<PiCodingAgentModule>;
}