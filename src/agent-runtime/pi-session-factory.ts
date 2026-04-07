import { getModel, KnownProvider } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from '@mariozechner/pi-coding-agent';

import type {
  AgentRuntimeSession,
  CreateAgentRuntimeSessionOptions,
} from './types';
import { openPersistentSession } from './pi-session-store';

export async function createPiAgentRuntimeSession(
  options: CreateAgentRuntimeSessionOptions,
): Promise<AgentRuntimeSession> {
  const sessionManager = options.sessionId === undefined
    ? SessionManager.create(options.workspacePath, options.sessionStoragePath)
    : await openPersistentSession(options.workspacePath, options.sessionId, options.sessionStoragePath);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = getModel(
    process.env.MODEL_PROVIDER as KnownProvider ?? 'openai',
    process.env.MODEL_NAME as never ?? 'gpt-5.4-mini',
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