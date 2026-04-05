# Streaming Layer

## Purpose

This module exposes agent events to clients via a streaming HTTP interface.

It acts as a **pure transport adapter**, converting internal agent events into a stream consumable by the frontend.

It does not implement business logic, state management, or event processing.

---

## Transport

Streaming is implemented using **Server-Sent Events (SSE)** over HTTP.

This is the only supported transport.

---

## Responsibilities

The module:

* Subscribes to agent runtime events
* Streams events to connected clients
* Manages connection lifecycle

It must not:

* Modify or interpret events
* Buffer or store events
* Trigger agent execution
* Maintain session state

---

## Connection Model

* Each client establishes an independent SSE connection
* Multiple concurrent clients are allowed
* Each client receives only **live events**

### No Replay

> Events emitted before a client connects are not replayed.

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

The agent runtime is **not affected**.

---

## Error Handling

* Agent-emitted `error` events are forwarded like any other event
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

* Events are streamed in order
* Multiple clients receive identical event sequences
* Clients only receive events after connection
* Disconnect removes listener correctly

Tests must be deterministic and not rely on timing.

---

## Invariant

At all times:

> The streaming layer forwards agent events exactly as received, in order, without modification or buffering.

Any transformation or stateful behavior violates this module’s contract.
