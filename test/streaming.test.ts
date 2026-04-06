import { describe, expect, it, vi } from 'vitest';

import { streamAgentPrompt } from '../src/streaming';
import { ControlledEventSource, assertEventSequence, createDeferred, createReply } from './harness';

function createRuntimeStub() {
  const eventSource = new ControlledEventSource();
  const completion = createDeferred<void>();

  const agentRuntime = {
    subscribe: vi.fn((listener: (event: unknown) => void) => eventSource.subscribe(listener)),
    prompt: vi.fn(async (prompt: string, sessionId?: string) => ({
      sessionId: sessionId ?? 'session-1',
      completion: completion.promise,
    })),
    stop: vi.fn(async () => undefined),
  };

  return {
    agentRuntime,
    completion,
    eventSource,
  };
}

describe('streamAgentPrompt', () => {
  it('starts a prompt, sets the session header, and streams events in order', async () => {
    const { agentRuntime, completion, eventSource } = createRuntimeStub();
    const reply = createReply();

    const streamPromise = streamAgentPrompt({
      agentRuntime,
      prompt: 'Implement the feature',
      reply,
    });

    const firstEvent = { type: 'reasoning', text: 'first' };
    const secondEvent = { type: 'result', ok: true };

    eventSource.emit(firstEvent);
    eventSource.emit(secondEvent);
    completion.resolve();

    await streamPromise;

    expect(agentRuntime.prompt).toHaveBeenCalledWith('Implement the feature', undefined);
    expect(reply.raw.statusCode).toBe(200);
    expect(reply.raw.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(reply.raw.headers.get('Cache-Control')).toBe('no-cache');
    expect(reply.raw.headers.get('Connection')).toBe('keep-alive');
    expect(reply.raw.headers.get('X-Agent-Session-Id')).toBe('session-1');
    expect(reply.raw.flushHeadersCalls).toBe(1);
    assertEventSequence(reply.raw.writes, [
      `data: ${JSON.stringify(firstEvent)}\n\n`,
      `data: ${JSON.stringify(secondEvent)}\n\n`,
    ]);
  });

  it('streams only events emitted after the request subscribes', async () => {
    const { agentRuntime, completion, eventSource } = createRuntimeStub();
    const reply = createReply();

    eventSource.emit({ type: 'before-subscribe' });

    const streamPromise = streamAgentPrompt({
      agentRuntime,
      prompt: 'Continue',
      sessionId: 'session-9',
      reply,
    });

    const event = { type: 'after-subscribe' };
    eventSource.emit(event);
    completion.resolve();

    await streamPromise;

    assertEventSequence(reply.raw.writes, [`data: ${JSON.stringify(event)}\n\n`]);
  });

  it('removes the listener and lets the active turn continue on disconnect', async () => {
    const { agentRuntime, eventSource } = createRuntimeStub();
    const reply = createReply();

    const streamPromise = streamAgentPrompt({
      agentRuntime,
      prompt: 'Implement the feature',
      reply,
    });

    expect(eventSource.listenerCount()).toBe(1);

    reply.raw.emit('close');
    await Promise.resolve();

    expect(agentRuntime.stop).toHaveBeenCalledTimes(0);
    expect(eventSource.listenerCount()).toBe(0);

    eventSource.emit({ type: 'ignored' });

    expect(reply.raw.writes).toEqual([]);

    await streamPromise;
  });

  it('propagates runtime errors before streaming starts', async () => {
    const reply = createReply();
    const agentRuntime = {
      subscribe: vi.fn(() => () => undefined),
      prompt: vi.fn(async () => {
        throw new Error('boom');
      }),
      stop: vi.fn(async () => undefined),
    };

    await expect(
      streamAgentPrompt({
        agentRuntime,
        prompt: 'Implement the feature',
        reply,
      }),
    ).rejects.toThrow('boom');

    expect(reply.raw.flushHeadersCalls).toBe(0);
    expect(reply.raw.writes).toEqual([]);
  });
});