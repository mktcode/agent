import { rm } from 'node:fs/promises';
import path from 'node:path';

import { getModel, KnownProvider } from "@mariozechner/pi-ai";
import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type SessionEntry,
  SessionManager,
  type SessionMessageEntry,
  type SessionInfo,
} from '@mariozechner/pi-coding-agent';
import {
  SessionBusyError,
  SessionNotFoundError,
} from './errors';
import { WorkspaceManager } from './workspace';

export { SessionBusyError, SessionNotFoundError } from './errors';

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

type AssistantUiContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string };

interface BashExecutionLikeMessage {
  role: 'bashExecution';
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
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

interface UiProjectionState {
  currentAssistantTimestamp: string | undefined;
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
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);

    if (!session) {
      throw new SessionNotFoundError({ sessionId });
    }

    return session;
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

async function readPersistentSessionEntries(
  options: ReadPersistedAgentRuntimeSessionEntriesOptions,
): Promise<AgentRuntimeSessionEntry[]> {
  const sessionManager = SessionManager.open(options.session.path, options.sessionStoragePath);
  return sessionManager.getBranch();
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

function projectSessionEntriesToUiItems(
  entries: AgentRuntimeSessionEntry[],
  sessionId: string,
): UiSessionItem[] {
  const items: UiSessionItem[] = [];

  for (const entry of entries) {
    if (entry.type !== 'message') {
      continue;
    }

    const projected = projectMessageEntry(entry, sessionId);

    for (const item of projected) {
      const existingIndex = items.findIndex((candidate) => candidate.id === item.id);

      if (existingIndex === -1) {
        items.push(item);
      } else {
        items[existingIndex] = item;
      }
    }
  }

  return items;
}

function projectMessageEntry(entry: SessionMessageEntry, sessionId: string): UiSessionItem[] {
  const message = entry.message;

  if (message.role === 'user') {
    const text = isMessageWithContent(message) ? extractMessageText(message.content) : undefined;

    if (!text) {
      return [];
    }

    return [{
      id: `${entry.id}:message`,
      sessionId,
      timestamp: entry.timestamp,
      kind: 'message',
      status: 'final',
      role: 'user',
      text,
      isError: false,
    }];
  }

  if (message.role === 'assistant') {
    return projectAssistantMessageContent({
      baseId: entry.id,
      content: isMessageWithContent(message) && Array.isArray(message.content) ? message.content : [],
      sessionId,
      timestamp: entry.timestamp,
      messageStatus: isAssistantMessageError(message.stopReason) ? 'error' : 'final',
      isError: isAssistantMessageError(message.stopReason),
      fallbackText: message.errorMessage,
    });
  }

  if (message.role === 'toolResult') {
    const text = isMessageWithContent(message) ? extractMessageText(message.content) : undefined;

    return [{
      id: `${message.toolCallId}:tool`,
      sessionId,
      timestamp: entry.timestamp,
      kind: 'tool',
      status: message.isError ? 'error' : 'final',
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      ...(text ? { text } : {}),
      isError: message.isError,
    }];
  }

  if (message.role === 'bashExecution') {
    return [{
      id: `${entry.id}:tool`,
      sessionId,
      timestamp: entry.timestamp,
      kind: 'tool',
      status: isBashExecutionError(message) ? 'error' : 'final',
      toolName: 'bash',
      text: message.output,
      isError: isBashExecutionError(message),
    }];
  }

  return [];
}

function projectAgentEventToUiItems(
  event: AgentSessionEvent,
  sessionId: string,
  state: UiProjectionState,
): UiSessionItemEvent[] {
  switch (event.type) {
    case 'message_start': {
      if (!('message' in event) || event.message === undefined) {
        return [];
      }

      return projectLiveMessageBoundary(event.message, sessionId, state, 'final');
    }

    case 'message_update': {
      if (!('message' in event) || event.message === undefined || event.message.role !== 'assistant') {
        return [];
      }

      const timestamp = isoTimestamp(event.message.timestamp);
      state.currentAssistantTimestamp = timestamp;

      return projectAssistantDeltaToUiItems(event, sessionId, timestamp);
    }

    case 'message_end': {
      if (!('message' in event) || event.message === undefined) {
        return [];
      }

      return projectLiveMessageBoundary(event.message, sessionId, state);
    }

    case 'tool_execution_start': {
      const timestamp = state.currentAssistantTimestamp ?? new Date(0).toISOString();

      return [{
        type: 'session_item',
        item: {
          id: `${event.toolCallId}:tool`,
          sessionId,
          timestamp,
          kind: 'tool',
          status: 'streaming',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: false,
        },
      }];
    }

    case 'tool_execution_update': {
      const timestamp = state.currentAssistantTimestamp ?? new Date(0).toISOString();
      const text = stringifyValue(event.partialResult);

      return [{
        type: 'session_item',
        item: {
          id: `${event.toolCallId}:tool`,
          sessionId,
          timestamp,
          kind: 'tool',
          status: 'streaming',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(text ? { text } : {}),
          isError: false,
        },
      }];
    }

    case 'tool_execution_end': {
      const timestamp = state.currentAssistantTimestamp ?? new Date(0).toISOString();
      const text = stringifyValue(event.result);

      return [{
        type: 'session_item',
        item: {
          id: `${event.toolCallId}:tool`,
          sessionId,
          timestamp,
          kind: 'tool',
          status: event.isError ? 'error' : 'final',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(text ? { text } : {}),
          isError: event.isError,
        },
      }];
    }

    default:
      return [];
  }
}

function projectLiveMessageBoundary(
  message: SessionMessageEntry['message'],
  sessionId: string,
  state: UiProjectionState,
  userStatus: UiSessionItemStatus = 'final',
): UiSessionItemEvent[] {
  if (message.role === 'user') {
    const text = extractMessageText(message.content);

    if (!text) {
      return [];
    }

    return [{
      type: 'session_item',
      item: {
        id: `${message.timestamp}:user:message`,
        sessionId,
        timestamp: isoTimestamp(message.timestamp),
        kind: 'message',
        status: userStatus,
        role: 'user',
        text,
        isError: false,
      },
    }];
  }

  if (message.role !== 'assistant') {
    return [];
  }

  const timestamp = isoTimestamp(message.timestamp);
  state.currentAssistantTimestamp = timestamp;

  return projectAssistantMessageContent({
    baseId: `${message.timestamp}:assistant`,
    content: isMessageWithContent(message) && Array.isArray(message.content) ? message.content : [],
    sessionId,
    timestamp,
    messageStatus: isAssistantMessageError(message.stopReason) ? 'error' : 'final',
    isError: isAssistantMessageError(message.stopReason),
    fallbackText: message.errorMessage,
  }).map((item) => ({ type: 'session_item', item }));
}

function projectAssistantMessageContent(options: {
  baseId: string;
  content: unknown[];
  sessionId: string;
  timestamp: string;
  messageStatus: UiSessionItemStatus;
  isError: boolean;
  fallbackText?: string;
}): UiSessionItem[] {
  const items: UiSessionItem[] = [];
  const content = getAssistantUiContentParts(options.content);
  const thinkingText = content
    .filter((part): part is Extract<AssistantUiContentPart, { type: 'thinking' }> => part.type === 'thinking')
    .map((part) => part.thinking)
    .join('');
  const messageText = content
    .filter((part): part is Extract<AssistantUiContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const finalMessageText = messageText || options.fallbackText;

  if (thinkingText) {
    items.push({
      id: `${options.baseId}:thinking`,
      sessionId: options.sessionId,
      timestamp: options.timestamp,
      kind: 'thinking',
      status: options.messageStatus,
      text: thinkingText,
      isError: options.isError,
    });
  }

  if (finalMessageText) {
    items.push({
      id: `${options.baseId}:message`,
      sessionId: options.sessionId,
      timestamp: options.timestamp,
      kind: 'message',
      status: options.messageStatus,
      role: 'assistant',
      text: finalMessageText,
      isError: options.isError,
    });
  }

  for (const part of content) {
    if (part.type !== 'toolCall') {
      continue;
    }

    items.push({
      id: `${part.id}:tool`,
      sessionId: options.sessionId,
      timestamp: options.timestamp,
      kind: 'tool',
      status: options.messageStatus,
      toolName: part.name,
      toolCallId: part.id,
      isError: options.isError,
    });
  }

  return items;
}

function projectAssistantDeltaToUiItems(
  event: Extract<AgentSessionEvent, { type: 'message_update' }>,
  sessionId: string,
  timestamp: string,
): UiSessionItemEvent[] {
  const content = isMessageWithContent(event.message) && Array.isArray(event.message.content)
    ? getAssistantUiContentParts(event.message.content)
    : [];
  const baseId = `${event.message.timestamp}:assistant`;

  switch (event.assistantMessageEvent.type) {
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end': {
      const text = content
        .filter((part): part is Extract<AssistantUiContentPart, { type: 'thinking' }> => part.type === 'thinking')
        .map((part) => part.thinking)
        .join('');

      if (!text) {
        return [];
      }

      return [{
        type: 'session_item',
        item: {
          id: `${baseId}:thinking`,
          sessionId,
          timestamp,
          kind: 'thinking',
          status: 'streaming',
          text,
          isError: false,
        },
      }];
    }

    case 'text_start':
    case 'text_delta':
    case 'text_end': {
      const text = content
        .filter((part): part is Extract<AssistantUiContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');

      if (!text) {
        return [];
      }

      return [{
        type: 'session_item',
        item: {
          id: `${baseId}:message`,
          sessionId,
          timestamp,
          kind: 'message',
          status: 'streaming',
          role: 'assistant',
          text,
          isError: false,
        },
      }];
    }

    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end': {
      const toolCall = content.find((part): part is Extract<AssistantUiContentPart, { type: 'toolCall' }> => part.type === 'toolCall');

      if (!toolCall) {
        return [];
      }

      return [{
        type: 'session_item',
        item: {
          id: `${toolCall.id}:tool`,
          sessionId,
          timestamp,
          kind: 'tool',
          status: 'streaming',
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          isError: false,
        },
      }];
    }

    default:
      return [];
  }
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .filter((part): part is { type: string; text: string } => (
      typeof part === 'object'
      && part !== null
      && 'type' in part
      && part.type === 'text'
      && 'text' in part
      && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('');

  return text || undefined;
}

function isoTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function stringifyValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isAssistantMessageError(stopReason: string): boolean {
  return stopReason === 'error' || stopReason === 'aborted';
}

function isBashExecutionError(message: BashExecutionLikeMessage): boolean {
  return message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
}

function isMessageWithContent(message: unknown): message is { role: string; content: unknown } {
  return typeof message === 'object' && message !== null && 'role' in message && 'content' in message;
}

function getAssistantUiContentParts(content: unknown[]): AssistantUiContentPart[] {
  const parts: AssistantUiContentPart[] = [];

  for (const part of content) {
    if (typeof part !== 'object' || part === null || !('type' in part) || typeof part.type !== 'string') {
      continue;
    }

    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'thinking' && 'thinking' in part && typeof part.thinking === 'string') {
      parts.push({ type: 'thinking', thinking: part.thinking });
      continue;
    }

    if (part.type === 'toolCall' && 'id' in part && typeof part.id === 'string' && 'name' in part && typeof part.name === 'string') {
      parts.push({ type: 'toolCall', id: part.id, name: part.name });
    }
  }

  return parts;
}