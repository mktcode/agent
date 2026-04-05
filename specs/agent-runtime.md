# Agent Runtime

## Purpose

This module orchestrates execution of the **PI Coding Agent** within the system.

It does **not** implement an agent.
It acts as a **thin control layer** around the PI agent SDK, responsible only for:

* Managing a single multi-turn session
* Executing individual turns
* Owning the workspace lock during execution
* Forwarding agent events

All agent logic (reasoning, tools, memory, persistence) is handled entirely by the PI agent.

---

## External Dependency

This module must use the PI agent SDK as documented:

* [PI Agent README](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/agent/README.md?utm_source=chatgpt.com)
* [PI Coding Agent SDK](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/sdk.md?utm_source=chatgpt.com)

The PI agent must be treated as a **black box**.

---

## Responsibilities

The module owns:

* A single active session (multi-turn)
* Triggering agent execution per turn
* Holding the workspace lock during execution only
* Forwarding agent events transparently

It must not:

* Implement agent behavior
* Modify or inject tools
* Interpret or transform agent events
* Manage multiple sessions

---

## Session Model

There is exactly **one session slot**.

Session states:

* `idle` – no session exists
* `ready` – session exists, waiting for input
* `running` – agent is executing a turn

### Invariant

> A session persists across turns, but only one turn executes at a time.

---

## Public API

### `start(prompt: string): Promise<void>`

Creates a new session and executes the first turn.

Behavior:

1. If a session already exists → throw `SessionAlreadyExistsError`
2. Initialize PI agent session via SDK
3. Bind agent to `./.workspace`
4. Execute first turn with `prompt`
5. Transition state → `running`

Execution must follow the same rules as `send()`.

---

### `send(input: string): Promise<void>`

Executes a new turn in the existing session.

Behavior:

1. If no session exists → throw `NoActiveSessionError`
2. If a turn is already running → throw `SessionBusyError`
3. Acquire workspace lock via `runExclusive`
4. Send input to agent via SDK
5. Stream events during execution
6. On completion → transition state → `ready`
7. Release lock

---

### `stop(): Promise<void>`

Terminates the session.

Behavior:

* If no session exists → no-op
* If a turn is running:

  * Signal cancellation via SDK
  * Wait for execution to terminate

After termination:

* Release lock if held
* Destroy session
* Transition state → `idle`

---

### `getState(): "idle" | "ready" | "running"`

Returns current session state.

---

### `subscribe(listener: (event: unknown) => void): void`

Registers a listener for agent events.

* Multiple listeners allowed
* No buffering or replay
* Events delivered in real time

---

## Execution Model

Execution is **turn-based**.

Each turn:

* Is triggered explicitly (`start` or `send`)
* Runs to completion or failure
* Holds the workspace lock for its full duration

### Locking Rule

> The workspace lock is held only during active execution of a turn.

* Lock is acquired before execution
* Lock is released immediately after execution completes

Between turns:

* No lock is held
* Git operations are allowed

---

## Workspace Binding

The agent must execute with:

* `./.workspace` as its working directory

This ensures all file and tool operations are properly scoped.

Access outside this directory is not allowed.

---

## Event Handling

The runtime must forward PI agent events **unchanged**.

Constraints:

* No transformation of event structure
* No filtering or aggregation
* No reordering
* No buffering or replay

Events are treated as opaque data and passed directly to subscribers.

---

## Failure Handling

If a turn fails:

* The failure is reflected via agent-emitted events
* The runtime must:

  * Release the workspace lock
  * Transition state → `ready`

The session remains active and may continue with further turns.

No retries or recovery logic.

---

## Cancellation

When `stop()` is called during execution:

* The agent must be cancelled via SDK mechanism
* Execution must terminate cleanly
* Lock must be released
* State must transition to `idle`

No abrupt termination without cleanup.

---

## Session Persistence

* Session memory and logs are managed by the PI agent
* This module does not access or interpret them

The runtime manages only **live execution state**.

---

## Non-Goals

* No multiple sessions
* No session resume after process restart
* No history querying
* No tool injection or modification
* No parallel execution

---

## Testing Requirements

Use a stubbed or controlled agent implementation.

### Required Cases

* Start creates session and runs first turn
* Send executes additional turns
* Send while running → fails
* Lock is held during execution
* Lock is released after each turn
* Stop terminates session
* Error in turn → session remains usable

### Event Behavior

* Events are forwarded exactly as emitted
* Event order is preserved
* No events after termination

Tests must be deterministic and independent of real LLM behavior.

---

## Invariant

At all times:

> There is at most one session, it executes one turn at a time under exclusive workspace access, and all agent behavior and events are delegated to the PI SDK without modification.

Any additional logic beyond orchestration violates this module’s contract.
