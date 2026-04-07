import { rm } from 'node:fs/promises';

import {
  type SessionInfo,
  SessionManager,
} from '@mariozechner/pi-coding-agent';

import { SessionNotFoundError } from '../errors';
import type {
  AgentRuntimeSessionEntry,
  AgentRuntimeSessionInfo,
  DeletePersistedAgentRuntimeSessionOptions,
  ListAgentRuntimeSessionsOptions,
  ReadPersistedAgentRuntimeSessionEntriesOptions,
} from './types';

export async function listPersistentSessions(
  options: ListAgentRuntimeSessionsOptions,
): Promise<AgentRuntimeSessionInfo[]> {
  return SessionManager.list(options.workspacePath, options.sessionStoragePath);
}

export async function deletePersistentSession(
  options: DeletePersistedAgentRuntimeSessionOptions,
): Promise<void> {
  await rm(options.session.path);
}

export async function readPersistentSessionEntries(
  options: ReadPersistedAgentRuntimeSessionEntriesOptions,
): Promise<AgentRuntimeSessionEntry[]> {
  const sessionManager = SessionManager.open(options.session.path, options.sessionStoragePath);
  return sessionManager.getBranch();
}

export async function openPersistentSession(
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

export async function resolvePersistedSession(
  listSessions: () => Promise<SessionInfo[]>,
  sessionId: string,
): Promise<SessionInfo> {
  const session = (await listSessions()).find((entry) => entry.id === sessionId);

  if (!session) {
    throw new SessionNotFoundError({ sessionId });
  }

  return session;
}