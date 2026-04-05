# Agent Runtime

## Purpose

This module orchestrates execution of the **PI Coding Agent** within the system.

It does **not** implement an agent.
It acts as a **thin control layer** around the PI agent SDK, responsible only for:

* Session lifecycle management (single session)
* Workspace lock ownership
* Binding the agent to `./.workspace`
* Forwarding agent events

All agent logic (reasoning, tool usage, state, persistence) is handled by the PI agent itself.

---

## External Dependency

This module must use the PI agent SDK as documented:

* [PI Agent README](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/agent/README.md?utm_source=chatgpt.com)
* [PI Coding Agent SDK](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/sdk.md?utm_source=chatgpt.com)

The PI agent must be treated as a **black box**.

---

## Responsibilities

The module owns:

* A single active agent session (global)
* Starting and stopping execution
* Subscribing to agent events and forwarding them
* Holding the workspace lock for the duration of execution

It must not:

* Implement agent logic
* Modify tool definitions
* Interpret or persist agent state
* Manage multiple sessions

---

## Session Model

There is exactly **one session slot**.

State is minimal:

* `idle` – no session running
* `running` – agent is executing

No additional states, no session collection.

---

## Public API

### `start(prompt: string): Promise<void>`

Starts a new agent session.

Behavior:

1. If a session is already running → throw `SessionAlreadyRunningError`
2. Acquire workspace lock via `runExclusive`
3. Initialize PI agent session using SDK
4. Bind agent to `./.workspace` as working directory
5. Start execution with provided prompt
6. Attach event listeners
7. Transition state → `running`

Failure behavior:

* If lock cannot be acquired → fail immediately
* If agent initialization fails → release lock and fail

---

### `stop(): Promise<void>`

Stops the active session.

Behavior:

* If no session is running → no-op
* If running:

  * Signal cancellation via SDK (preferred)
  * Wait for agent to terminate
  * Ensure final event is emitted (`done` or `error`)
  * Release workspace lock
  * Transition state → `idle`

Constraints:

* Must not leave lock held
* Must not terminate abruptly without cleanup

---

### `getState(): "idle" | "running"`

Returns current session state.

---

### `subscribe(listener: (event) => void): void`

Registers a listener for agent events.

* Multiple listeners allowed
* No buffering or replay
* Listener receives events in real time

---

## Workspace Binding

The agent must execute with:

* `./.workspace` as its working directory

This ensures:

* File tools operate within the repository
* Bash/tool execution is scoped correctly

The runtime must not allow access outside this directory.

---

## Event Handling

The runtime subscribes to PI agent events and forwards them unchanged.

### Event Format

Events must be normalized to:

```json
{
  "type": "reasoning | action | result | error | done",
  "payload": {}
}
```

Constraints:

* Events are emitted in strict order
* No batching
* No transformation beyond minimal normalization
* No filtering

---

## Execution Model

* Agent runs as an async process via the SDK
* No subprocess management unless required by SDK
* No parallel sessions

### Lock Ownership

> While a session is running, it exclusively owns the workspace lock.

* Lock is acquired before agent starts
* Lock is released only after termination

No partial or temporary release is allowed.

---

## Failure Handling

If the agent fails:

* Emit `error` event
* Terminate session
* Release lock
* Transition state → `idle`

No retries, no restarts.

---

## Session Persistence

* The PI agent may persist session data internally (e.g. logs)
* This module does not manage or interpret that data

The runtime only manages **live execution state**.

---

## Non-Goals

* No multi-session support
* No session resume
* No session history querying
* No tool injection or modification
* No custom agent behavior

---

## Testing Requirements

Use a **stub or controlled agent implementation** for deterministic tests.

### Required Cases

* Start when idle → succeeds
* Start when running → fails
* Lock is held during execution
* Lock is released after completion
* Stop terminates session
* Stop releases lock
* Agent error → handled correctly

### Event Handling

* Events are emitted in correct order
* No events after `done`
* Subscribers receive all events

Tests must not depend on real LLM behavior.

---

## Invariant

At all times:

> At most one agent session exists, it exclusively owns the workspace during execution, and all agent behavior is delegated to the PI SDK without modification.

Any additional logic beyond orchestration violates this module’s contract.
