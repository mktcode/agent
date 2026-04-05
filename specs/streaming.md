# Streaming Layer (Transport Adapter)

This is purely about delivering events.

**Responsibility:**

* Convert internal event emitter → SSE stream
* Handle client connection lifecycle

**Key invariant:**

> Event order is preserved exactly as emitted.

**Why separate:**
Streaming bugs are subtle and unrelated to agent logic. You want to test this independently with a fake event source.