import type { SessionEntry, SessionInfo } from '@mariozechner/pi-coding-agent';
import type { WorkspaceManager } from '../workspace';

export type AgentRuntimeState = 'idle' | 'ready' | 'running';

export type UiSessionItemKind = 'message' | 'thinking' | 'tool';
export type UiSessionItemStatus = 'streaming' | 'final' | 'error';
export type UiSessionItemRole = 'user' | 'assistant';

export interface UiSessionItem {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: UiSessionItemKind;
  status: UiSessionItemStatus;
  isError: boolean;
  role?: UiSessionItemRole;
  text?: string;
  toolName?: string;
  toolCallId?: string;
}

export interface UiSessionItemEvent {
  type: 'session_item';
  item: UiSessionItem;
}

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

export type AgentRuntimeSessionInfo = SessionInfo;
export type AgentRuntimeSessionEntry = SessionEntry;

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

export interface ReadPersistedAgentRuntimeSessionEntriesOptions {
  session: AgentRuntimeSessionInfo;
  sessionStoragePath: string;
}

export type ReadPersistedAgentRuntimeSessionEntries = (
  options: ReadPersistedAgentRuntimeSessionEntriesOptions,
) => Promise<AgentRuntimeSessionEntry[]>;

export interface AgentRuntimeOptions {
  workspace: WorkspaceManager;
  workspacePath: string;
  createSession?: CreateAgentRuntimeSession;
  listSessions?: ListAgentRuntimeSessions;
  deletePersistedSession?: DeletePersistedAgentRuntimeSession;
  readSessionEntries?: ReadPersistedAgentRuntimeSessionEntries;
}

export interface UiProjectionState {
  currentAssistantTimestamp: string | undefined;
}