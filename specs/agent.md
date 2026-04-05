# Agent Runtime (Execution Orchestrator)

This is where complexity lives, so isolating it is critical.

**Responsibility:**

* Start/stop agent
* Maintain current session state (in memory reference)
* Bridge agent output → event stream

**Key invariant:**

> Exactly one active session exists, and it owns the workspace lock for its entire lifetime.

**Design constraint:**

* This module must *not* implement locking itself
  → it must depend on the workspace module

**Important boundary decision:**
Do not mix:

* session lifecycle
* streaming transport

Those should be separated.