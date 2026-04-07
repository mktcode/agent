import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { SessionMessageEntry } from '@mariozechner/pi-coding-agent';

import type {
  AgentRuntimeSessionEntry,
  UiProjectionState,
  UiSessionItem,
  UiSessionItemEvent,
  UiSessionItemStatus,
} from './types';

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

export function projectSessionEntriesToUiItems(
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

export function projectAgentEventToUiItems(
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