import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CreateAgentSessionOptions } from '@mariozechner/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCleanupRegistry, createTempDirectory } from './harness';

const cleanup = createCleanupRegistry();
const mocks = vi.hoisted(() => {
  return {
    createAgentSession: vi.fn(async (_options?: CreateAgentSessionOptions) => ({
      session: {
        sessionId: 'session-1',
        prompt: async (_input: string) => undefined,
        abort: async () => undefined,
        dispose: () => undefined,
        subscribe: () => () => undefined,
      },
      extensionsResult: {
        extensions: [],
        errors: [],
        runtime: {
          pendingProviderRegistrations: [],
        },
      },
    })),
    getModel: vi.fn(() => ({ id: 'gpt-5.4-mini' })),
  };
});

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();

  return {
    ...actual,
    getModel: mocks.getModel,
  };
});

vi.mock('@mariozechner/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-coding-agent')>();

  return {
    ...actual,
    createAgentSession: mocks.createAgentSession,
  };
});

import { createPiAgentRuntimeSession } from '../src/agent-runtime/pi-session-factory';

afterEach(async () => {
  vi.clearAllMocks();
  delete process.env.HOME;
  await cleanup.runAll();
});

describe('createPiAgentRuntimeSession', () => {
  it('scopes PI resources to project-local .workspace and .pi only', async () => {
    const projectRoot = await createTempDirectory(cleanup, 'nextagent-pi-session-factory-');
    const workspacePath = path.join(projectRoot, '.workspace');
    const projectPiPath = path.join(projectRoot, '.pi');
    const homePath = path.join(projectRoot, 'home');
    process.env.HOME = homePath;

    await mkdir(path.join(workspacePath, '.git'), { recursive: true });
    await mkdir(path.join(projectPiPath, 'skills', 'global-skill'), { recursive: true });
    await mkdir(path.join(workspacePath, '.agents', 'skills', 'workspace-skill'), { recursive: true });
    await mkdir(path.join(projectRoot, '.agents', 'skills', 'parent-skill'), { recursive: true });
    await mkdir(path.join(homePath, '.agents', 'skills', 'home-skill'), { recursive: true });

    await writeFile(path.join(projectPiPath, 'AGENTS.md'), '# project pi\n', 'utf8');
    await writeFile(path.join(workspacePath, 'AGENTS.md'), '# workspace\n', 'utf8');
    await writeFile(path.join(projectRoot, 'AGENTS.md'), '# parent\n', 'utf8');

    await writeFile(
      path.join(projectPiPath, 'skills', 'global-skill', 'SKILL.md'),
      ['---', 'name: global-skill', 'description: global skill', '---', '', 'global'].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(workspacePath, '.agents', 'skills', 'workspace-skill', 'SKILL.md'),
      ['---', 'name: workspace-skill', 'description: workspace skill', '---', '', 'workspace'].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(projectRoot, '.agents', 'skills', 'parent-skill', 'SKILL.md'),
      ['---', 'name: parent-skill', 'description: parent skill', '---', '', 'parent'].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(homePath, '.agents', 'skills', 'home-skill', 'SKILL.md'),
      ['---', 'name: home-skill', 'description: home skill', '---', '', 'home'].join('\n'),
      'utf8',
    );

    await createPiAgentRuntimeSession({
      workspacePath,
      sessionStoragePath: path.join(projectPiPath, 'sessions'),
    });

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);

    const createAgentSessionOptions = mocks.createAgentSession.mock.calls[0]?.[0];

    expect(createAgentSessionOptions?.cwd).toBe(workspacePath);
    expect(createAgentSessionOptions?.agentDir).toBe(projectPiPath);
    expect(createAgentSessionOptions?.resourceLoader).toBeDefined();

    if (!createAgentSessionOptions?.resourceLoader) {
      throw new Error('Expected a scoped resourceLoader to be passed to createAgentSession().');
    }

    const { resourceLoader } = createAgentSessionOptions;

    await resourceLoader.reload();

    expect(resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path)).toEqual([
      path.join(projectPiPath, 'AGENTS.md'),
      path.join(workspacePath, 'AGENTS.md'),
    ]);
    expect(resourceLoader.getSkills().skills.map((skill) => skill.filePath).sort()).toEqual([
      path.join(projectPiPath, 'skills', 'global-skill', 'SKILL.md'),
      path.join(workspacePath, '.agents', 'skills', 'workspace-skill', 'SKILL.md'),
    ].sort());
  });
});