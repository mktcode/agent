export interface AgentEventSource {
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface StreamAgentEventsResponse {
  statusCode: number;
  destroyed: boolean;
  writableEnded: boolean;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  on(event: 'close' | 'error', listener: () => void): void;
  off(event: 'close' | 'error', listener: () => void): void;
}

export interface StreamAgentEventsReply {
  raw: StreamAgentEventsResponse;
  hijack(): void;
}

export interface StreamAgentEventsOptions {
  eventSource: AgentEventSource;
  reply: StreamAgentEventsReply;
}

export function streamAgentEvents(options: StreamAgentEventsOptions): void {
  const { eventSource, reply } = options;
  const response = reply.raw;

  reply.hijack();

  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();

  let closed = false;

  const cleanup = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    unsubscribe();
    response.off('close', cleanup);
    response.off('error', cleanup);
  };

  const unsubscribe = eventSource.subscribe((event) => {
    if (closed || response.destroyed || response.writableEnded) {
      return;
    }

    response.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  response.on('close', cleanup);
  response.on('error', cleanup);
}