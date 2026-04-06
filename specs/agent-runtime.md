# Agent Runtime

## Purpose

This module orchestrates execution of the **PI Coding Agent** within the system.

It does **not** implement an agent.
It acts as a **thin control layer** around the PI agent SDK, responsible only for:

* Managing persistent PI sessions identified by session ID
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

* Persistent PI sessions stored on disk
* At most one loaded session instance at a time
* Triggering agent execution per turn
* Holding the workspace lock during execution only
* Forwarding agent events transparently

It must not:

* Implement agent behavior
* Modify or inject tools
* Interpret or transform agent events
* Execute multiple sessions concurrently

---

## Session Model

PI sessions are persisted on disk and identified by `sessionId`.

Multiple persisted sessions may exist.

At runtime there is exactly **one loaded session slot**.

Session states:

* `idle` – no session is loaded
* `ready` – one session is loaded, waiting for input
* `running` – agent is executing a turn

### Invariant

> Persisted sessions may outlive the process, but only one turn executes at a time.

---

## Public API

### `prompt(input: string, sessionId?: string): Promise<{ sessionId: string, completion: Promise<void> }>`

Creates or resumes a session and starts one turn.

Behavior:

1. If a turn is already running → throw `SessionBusyError`
2. If `sessionId` is omitted:

  * Create a new persistent PI session via SDK
  * Use the project-local session directory `./.pi/sessions`
3. If `sessionId` is provided:

  * Open the persisted PI session matching that ID
  * If no such session exists → throw `SessionNotFoundError`
4. Bind agent to `./.workspace`
5. Return the effective `sessionId` plus a completion promise to the caller before the first agent event is emitted
6. Acquire workspace lock via `runExclusive`
7. Send input to agent via SDK
8. Forward agent events during execution
9. On completion → transition state → `ready`
10. Release lock

---

### `stop(): Promise<void>`

Terminates the session.

Behavior:

* If no session is loaded → no-op
* If a turn is running:

  * Signal cancellation via SDK
  * Wait for execution to terminate

After termination:

* Release lock if held
* Dispose the loaded session instance
* Transition state → `idle`

Stopping execution must not delete persisted PI session files.

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

* Is triggered explicitly (`prompt`)
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

If the loaded session changes between turns, subscriptions remain attached to the runtime and receive events from the next executing turn without replay.

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
* This module must use the PI SDK's file-backed session manager APIs
* Session files must be stored in `./.pi/sessions`
* This module must not define a second session storage format or duplicate session history

The runtime manages only **live execution state** plus selection of which persisted PI session to load for a turn.

---

## Non-Goals

* No parallel execution
* No history querying
* No tool injection or modification
* No session metadata store separate from PI session files

---

## Testing Requirements

Use a stubbed or controlled agent implementation.

### Required Cases

* Prompt without `sessionId` creates a persistent session and runs a turn
* Prompt with `sessionId` resumes the matching persistent session
* Prompt with unknown `sessionId` fails
* Prompt while running → fails
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

> Persisted PI sessions are the source of truth for session history, the runtime executes at most one turn at a time under exclusive workspace access, and all agent behavior and events are delegated to the PI SDK without modification.

Any additional logic beyond orchestration violates this module’s contract.
