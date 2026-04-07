import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { getModel, KnownProvider } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';

import type {
  AgentRuntimeSession,
  CreateAgentRuntimeSessionOptions,
} from './types';
import { openPersistentSession } from './pi-session-store';

function loadContextFileFromDir(dirPath: string): { path: string; content: string } | undefined {
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    const filePath = path.join(dirPath, fileName);

    if (!existsSync(filePath)) {
      continue;
    }

    return {
      path: filePath,
      content: readFileSync(filePath, 'utf8'),
    };
  }

  return undefined;
}

function createScopedResourceLoader(workspacePath: string, agentDir: string): DefaultResourceLoader {
  const settingsManager = SettingsManager.create(workspacePath, agentDir);

  return new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [
      path.join(workspacePath, '.pi', 'extensions'),
      path.join(agentDir, 'extensions'),
    ],
    additionalSkillPaths: [
      path.join(workspacePath, '.pi', 'skills'),
      path.join(workspacePath, '.agents', 'skills'),
      path.join(agentDir, 'skills'),
    ],
    additionalPromptTemplatePaths: [
      path.join(workspacePath, '.pi', 'prompts'),
      path.join(agentDir, 'prompts'),
    ],
    additionalThemePaths: [
      path.join(workspacePath, '.pi', 'themes'),
      path.join(agentDir, 'themes'),
    ],
    agentsFilesOverride: () => ({
      agentsFiles: [agentDir, workspacePath]
        .map((dirPath) => loadContextFileFromDir(dirPath))
        .filter((file): file is { path: string; content: string } => file !== undefined),
    }),
  });
}

export async function createPiAgentRuntimeSession(
  options: CreateAgentRuntimeSessionOptions,
): Promise<AgentRuntimeSession> {
  const agentDir = path.join(path.dirname(options.workspacePath), '.pi');
  const sessionManager = options.sessionId === undefined
    ? SessionManager.create(options.workspacePath, options.sessionStoragePath)
    : await openPersistentSession(options.workspacePath, options.sessionId, options.sessionStoragePath);
  const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
  const settingsManager = SettingsManager.create(options.workspacePath, agentDir);
  const resourceLoader = createScopedResourceLoader(options.workspacePath, agentDir);
  const model = getModel(
    process.env.MODEL_PROVIDER as KnownProvider ?? 'openai',
    process.env.MODEL_NAME as never ?? 'gpt-5.4-mini',
  );

  if (!model) {
    throw new Error('Failed to initialize model. Please check your MODEL_PROVIDER and MODEL_NAME environment variables.');
  }

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.workspacePath,
    agentDir,
    authStorage,
    sessionManager,
    settingsManager,
    resourceLoader,
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