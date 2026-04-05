import { describe, expect, it } from 'vitest';

import { streamAgentEvents } from '../src/streaming';
import { ControlledEventSource, assertEventSequence, createReply } from './harness';

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
    assertEventSequence(reply.raw.writes, [
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

    assertEventSequence(firstReply.raw.writes, [
      `data: ${JSON.stringify(firstEvent)}\n\n`,
      `data: ${JSON.stringify(secondEvent)}\n\n`,
    ]);
    assertEventSequence(secondReply.raw.writes, firstReply.raw.writes);
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

    assertEventSequence(firstReply.raw.writes, [
      `data: ${JSON.stringify(beforeSecondClient)}\n\n`,
      `data: ${JSON.stringify(afterSecondClient)}\n\n`,
    ]);
    assertEventSequence(secondReply.raw.writes, [`data: ${JSON.stringify(afterSecondClient)}\n\n`]);
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