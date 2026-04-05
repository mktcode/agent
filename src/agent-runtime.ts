import { SessionManager, createAgentSession } from '@mariozechner/pi-coding-agent';

import { WorkspaceManager } from './workspace';

export type AgentRuntimeState = 'idle' | 'ready' | 'running';

export interface AgentRuntimeSession {
  prompt(input: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
}

export type CreateAgentRuntimeSession = (cwd: string) => Promise<AgentRuntimeSession>;

export interface AgentRuntimeOptions {
  workspace: WorkspaceManager;
  workspacePath: string;
  createSession?: CreateAgentRuntimeSession;
}

export class AgentRuntimeError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  public constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
    this.cause = cause;
  }
}

export class SessionAlreadyExistsError extends AgentRuntimeError {
  public constructor() {
    super('SESSION_ALREADY_EXISTS', 'An agent session already exists.');
    this.name = 'SessionAlreadyExistsError';
  }
}

export class NoActiveSessionError extends AgentRuntimeError {
  public constructor() {
    super('NO_ACTIVE_SESSION', 'There is no active agent session.');
    this.name = 'NoActiveSessionError';
  }
}

export class SessionBusyError extends AgentRuntimeError {
  public constructor() {
    super('SESSION_BUSY', 'The agent session is already executing a turn.');
    this.name = 'SessionBusyError';
  }
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

  public subscribe(listener: (event: unknown) => void): void {
    this.#listeners.add(listener);
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