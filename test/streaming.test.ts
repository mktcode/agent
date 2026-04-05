import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  streamAgentEvents,
  type AgentEventSource,
  type StreamAgentEventsReply,
} from '../src/streaming';

class ControlledEventSource implements AgentEventSource {
  readonly #listeners = new Set<(event: unknown) => void>();

  public emit(event: unknown): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  public listenerCount(): number {
    return this.#listeners.size;
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }
}

class FakeRawResponse extends EventEmitter {
  public readonly headers = new Map<string, string>();
  public readonly writes: string[] = [];
  public statusCode = 0;
  public destroyed = false;
  public writableEnded = false;
  public flushHeadersCalls = 0;

  public setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  public flushHeaders(): void {
    this.flushHeadersCalls += 1;
  }

  public write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  public end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }

  public destroy(error?: Error): this {
    this.destroyed = true;

    if (error) {
      this.emit('error', error);
    }

    this.emit('close');
    return this;
  }
}

interface FakeReply extends StreamAgentEventsReply {
  raw: FakeRawResponse;
}

function createReply(): FakeReply {
  return {
    raw: new FakeRawResponse(),
    hijack() {
      return;
    },
  };
}

describe('streamAgentEvents', () => {
  it('streams events in order as raw SSE data frames', () => {
    const eventSource = new ControlledEventSource();
    const reply = createReply();

    streamAgentEvents({ eventSource, reply });

    const firstEvent = { type: 'reasoning', text: 'first' };
    const secondEvent = { type: 'result', ok: true };

    eventSource.emit(firstEvent);
    eventSource.emit(secondEvent);

    expect(reply.raw.statusCode).toBe(200);
    expect(reply.raw.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(reply.raw.headers.get('Cache-Control')).toBe('no-cache');
    expect(reply.raw.headers.get('Connection')).toBe('keep-alive');
    expect(reply.raw.flushHeadersCalls).toBe(1);
    expect(reply.raw.writes).toEqual([
      `data: ${JSON.stringify(firstEvent)}\n\n`,
      `data: ${JSON.stringify(secondEvent)}\n\n`,
    ]);
  });

  it('forwards the same live event sequence to multiple clients', () => {
    const eventSource = new ControlledEventSource();
    const firstReply = createReply();
    const secondReply = createReply();

    streamAgentEvents({ eventSource, reply: firstReply });
    streamAgentEvents({ eventSource, reply: secondReply });

    const firstEvent = { type: 'action', tool: 'test' };
    const secondEvent = { type: 'done' };

    eventSource.emit(firstEvent);
    eventSource.emit(secondEvent);

    expect(firstReply.raw.writes).toEqual([
      `data: ${JSON.stringify(firstEvent)}\n\n`,
      `data: ${JSON.stringify(secondEvent)}\n\n`,
    ]);
    expect(secondReply.raw.writes).toEqual(firstReply.raw.writes);
  });

  it('does not replay events emitted before a client connects', () => {
    const eventSource = new ControlledEventSource();
    const firstReply = createReply();

    streamAgentEvents({ eventSource, reply: firstReply });

    const beforeSecondClient = { type: 'reasoning', text: 'before' };
    eventSource.emit(beforeSecondClient);

    const secondReply = createReply();
    streamAgentEvents({ eventSource, reply: secondReply });

    const afterSecondClient = { type: 'reasoning', text: 'after' };
    eventSource.emit(afterSecondClient);

    expect(firstReply.raw.writes).toEqual([
      `data: ${JSON.stringify(beforeSecondClient)}\n\n`,
      `data: ${JSON.stringify(afterSecondClient)}\n\n`,
    ]);
    expect(secondReply.raw.writes).toEqual([`data: ${JSON.stringify(afterSecondClient)}\n\n`]);
  });

  it('removes the listener when the client disconnects', () => {
    const eventSource = new ControlledEventSource();
    const reply = createReply();

    streamAgentEvents({ eventSource, reply });

    expect(eventSource.listenerCount()).toBe(1);

    reply.raw.emit('close');

    expect(eventSource.listenerCount()).toBe(0);

    eventSource.emit({ type: 'result', text: 'ignored' });

    expect(reply.raw.writes).toEqual([]);
  });
});