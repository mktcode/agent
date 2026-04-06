import type { AgentRuntime, AgentRuntimePromptResult } from './agent-runtime';

export interface AgentEventSource {
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface StreamAgentPromptResponse {
  statusCode: number;
  destroyed: boolean;
  writableEnded: boolean;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close' | 'error', listener: () => void): void;
  off(event: 'close' | 'error', listener: () => void): void;
}

export interface StreamAgentPromptReply {
  raw: StreamAgentPromptResponse;
  hijack(): void;
}

export interface StreamAgentPromptOptions {
  agentRuntime: Pick<AgentRuntime, 'prompt' | 'stop' | 'subscribe'>;
  prompt: string;
  sessionId?: string;
  reply: StreamAgentPromptReply;
}

export async function streamAgentPrompt(options: StreamAgentPromptOptions): Promise<void> {
  const {
    agentRuntime,
    prompt,
    reply,
    sessionId,
  } = options;
  const response = reply.raw;

  let resolveDisconnected!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnected = resolve;
  });

  let closed = false;
  let stopStarted = false;

  const unsubscribe = agentRuntime.subscribe((event) => {
    if (closed || response.destroyed || response.writableEnded) {
      return;
    }

    response.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const cleanup = (): void => {
    unsubscribe();
    response.off('close', handleDisconnect);
    response.off('error', handleDisconnect);
  };

  const stopTurn = async (): Promise<void> => {
    if (stopStarted) {
      return;
    }

    stopStarted = true;
    cleanup();
    await agentRuntime.stop().catch(() => undefined);
    resolveDisconnected();
  };

  const handleDisconnect = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    void stopTurn();
  };

  response.on('close', handleDisconnect);
  response.on('error', handleDisconnect);

  let promptResult: AgentRuntimePromptResult;

  try {
    promptResult = await agentRuntime.prompt(prompt, sessionId);
  } catch (error) {
    cleanup();
    throw error;
  }

  if (closed || response.destroyed || response.writableEnded) {
    await disconnected;
    return;
  }

  reply.hijack();
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Agent-Session-Id', promptResult.sessionId);
  response.flushHeaders();

  await Promise.race([
    promptResult.completion.catch(() => undefined),
    disconnected,
  ]);

  cleanup();

  if (!closed && !response.destroyed && !response.writableEnded) {
    response.end();
  }
}