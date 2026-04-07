# Agent Runtime

## Purpose

This module orchestrates execution of the **PI Coding Agent** within the system.

It does **not** implement an agent.
It acts as a **thin control layer** around the PI agent SDK, responsible only for:

* Managing persistent PI sessions identified by session ID
* Executing individual turns
* Owning the workspace lock during execution
* Forwarding agent events to subscribers

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
* Using the workspace lock for turn execution and persisted session deletion
* Forwarding agent events transparently
* Projecting live agent events into UI session items when requested
* Reading current-branch persisted session history
* Listing and deleting persisted sessions

It must not:

* Implement agent behavior
* Modify or inject tools
* Execute multiple sessions concurrently
* Persist a second history format separate from PI session files

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
2. Acquire workspace lock via `runExclusive`
3. If `sessionId` is omitted:

  * Create a new persistent PI session via SDK
  * Use the project-local session directory `./.pi/sessions`
4. If `sessionId` is provided:

  * Open the persisted PI session matching that ID
  * If no such session exists → throw `SessionNotFoundError`
5. Bind agent to `./.workspace`
6. Return the effective `sessionId` plus a completion promise to the caller before the first agent event is emitted
7. Send input to agent via SDK
8. Forward agent events during execution
9. On completion → transition state → `ready`
10. Release lock

### `listSessions(): Promise<SessionInfo[]>`

Returns metadata for all existing sessions in `./.pi/sessions`.

Behavior:

* Read session metadata from persistent storage
* Return entries sorted by `sessionId` in ascending lexicographic order
* Do not modify runtime state

### `getSession(sessionId: string): Promise<SessionInfo>`

Returns metadata for the persisted session matching `sessionId`.

Behavior:

* Read session metadata from persistent storage
* Resolve the entry whose `id` matches `sessionId`
* If no such session exists → throw `SessionNotFoundError`
* Do not modify runtime state

### `getSessionEntries(sessionId: string): Promise<unknown[]>`

Returns raw persisted PI session entries for the session's current leaf.

Behavior:

* Resolve the persisted session matching `sessionId`
* Open the persisted PI session from `./.pi/sessions`
* Read the session's current leaf / active branch as defined by PI session state
* Return raw PI session entries in chronological order from root to that leaf
* Exclude the session header from the returned items
* If no such session exists → throw `SessionNotFoundError`
* Do not modify runtime state

### `getSessionItems(sessionId: string): Promise<UiSessionItem[]>`

Returns UI-projected persisted session items for the session's current leaf.

Behavior:

* Resolve the persisted session matching `sessionId`
* Read raw persisted entries for the session's current leaf
* Project supported entries into final `UiSessionItem` objects for a minimal chat UI
* Return items in chronological order
* Omit persisted entries that do not map to the minimal chat UI
* If no such session exists → throw `SessionNotFoundError`
* Do not modify runtime state

### `deleteSession(sessionId: string): Promise<void>`

Deletes the persisted session matching `sessionId`.

Behavior:

1. Acquire workspace lock via `runExclusive`
2. Resolve the persisted session matching `sessionId`
3. If no such session exists → throw `SessionNotFoundError`
4. If the target session is currently loaded:

  * Dispose the loaded session instance
  * Clear the loaded session slot
  * Transition state → `idle`
5. Delete the persisted session from `./.pi/sessions`
6. Release lock

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

### `subscribeUi(listener: (event: UiSessionItemEvent) => void): void`

Registers a listener for UI-projected live turn items.

* Multiple listeners allowed
* No replay
* Each event contains a full snapshot of one `UiSessionItem`
* Repeated events with the same item ID replace the previous snapshot for that item
* UI updates are emitted as relevant PI updates arrive

---

## Execution Model

Execution is **turn-based**.

Each turn:

* Is triggered explicitly (`prompt`)
* Runs to completion or failure
* Holds the workspace lock for its full duration

### Locking Rule

> The workspace lock is held for the full duration of a turn and for persisted session deletion.

* Lock is acquired before loading or creating the session for a turn
* Lock is released immediately after execution completes
* Lock is acquired before deleting a persisted session
* Lock is released immediately after deletion completes

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

For raw subscriptions, the runtime must forward PI agent events **unchanged**.

Constraints:

* `subscribe()` must not transform event structure
* `subscribe()` must not filter or aggregate events
* `subscribe()` must not reorder events
* `subscribe()` must not buffer or replay events

Events for `subscribe()` are treated as opaque data and passed directly to subscribers.

If the loaded session changes between turns, subscriptions remain attached to the runtime and receive events from the next executing turn without replay.

For UI subscriptions, the runtime must derive `UiSessionItemEvent` values from PI events using these rules:

* User messages and completed persisted messages become final UI items
* Assistant text output is projected as `message` items
* Assistant thinking output is projected as `thinking` items
* Tool-call, tool-execution, tool-result, and bash-execution activity is projected as `tool` items
* Assistant `text_delta`, `thinking_delta`, and `toolcall_delta` events update in-progress UI items keyed by stable item IDs and are emitted immediately
* PI-specific entries not needed for a minimal chat UI are omitted from UI projection
* UI events must not include raw PI event payloads
* UI projection must not modify raw runtime behavior or persisted session files

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
* UI session items are derived on demand from PI data and are never persisted separately

The runtime manages only **live execution state** plus selection of which persisted PI session to load for a turn.

Transport disconnects do not alter runtime execution state.

---

## Non-Goals

* No parallel execution
* No tool injection or modification
* No session metadata store separate from PI session files
* No persisted cache of UI-projected items

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
