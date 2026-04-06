# Streaming Layer

## Purpose

This module executes one agent prompt request and exposes the resulting agent events to the client via a streaming HTTP response.

It acts as the **transport boundary** for agent execution, combining prompt invocation with SSE delivery.

It does not implement agent behavior, persist transport state, or interpret events.

---

## Transport

Streaming is implemented using **Server-Sent Events (SSE)** over HTTP.

This is the only supported transport.

---

## Responsibilities

The module:

* Starts one agent turn through the agent runtime
* Subscribes to agent runtime events
* Streams live events to the requesting client
* Manages connection lifecycle

It must not:

* Modify or interpret events
* Buffer or store events
* Implement agent logic
* Maintain session history

---

## Request Model

Each `POST /agent/prompt` request creates one SSE response stream for one agent turn.

The module must:

* create or resume the session through the agent runtime
* set the `X-Agent-Session-Id` response header before writing the first SSE frame
* stream only **live events** from that turn

### No Replay

> Events emitted before the request subscribes are not replayed.

---

## Event Forwarding

Events from the agent runtime must be forwarded **unchanged**.

### SSE Format

Each event must be sent as:

```id="y1fl8c"
data: <JSON serialized event>

```

Constraints:

* No custom SSE event types
* No transformation of payload
* No splitting across multiple messages

---

## Ordering Guarantees

> Events must be delivered in exactly the order they are received.

The module must not introduce reordering under any circumstances.

---

## Delivery Model

* Events are written to the response immediately upon receipt
* No batching
* No buffering

The module starts streaming only after the runtime returns the effective `sessionId`.

---

## Backpressure

No backpressure handling is implemented.

* Slow clients may lag or disconnect
* The server does not queue or drop events intentionally

---

## Disconnect Handling

When a client disconnects:

* The connection is closed
* The event listener is removed
* The active turn is cancelled through the agent runtime

---

## Error Handling

* Agent-emitted `error` events are forwarded like any other event
* Runtime errors before streaming begins propagate to the API layer
* Transport-level errors terminate the connection
* No retries or reconnection logic is implemented server-side

---

## Implementation Constraints

* Must use Fastify’s native response streaming
* Must not introduce external streaming libraries
* Must not buffer full responses

---

## Testing Requirements

Use a controlled event source (stubbed agent runtime).

### Required Cases

* The module starts a prompt through the runtime
* Events are streamed in order
* The effective session ID is written to the response header
* Only events emitted after subscription are streamed
* Disconnect removes listener correctly
* Disconnect cancels the active turn

Tests must be deterministic and not rely on timing.

---

## Invariant

At all times:

> The streaming layer executes one prompt request, returns the effective session ID as response metadata, and forwards agent events exactly as received, in order, without modification or buffering.

Any transformation or stateful behavior violates this module’s contract.
