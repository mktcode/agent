# Agent API Server – Specification

## Purpose

This service exposes a minimal API for managing a single repository and executing a coding agent against it. It acts as a controlled execution environment: the API does not contain agent logic, only orchestration, isolation, and tooling.

A separate frontend (“portal”) consumes this API.

---

## Core Principles

The system is intentionally constrained:

* Single-tenant, single-repo, single-node
* Deterministic behavior over flexibility
* Fail fast, no implicit recovery
* Minimal concurrency, explicit locking
* Stateless API, stateful workspace

Every design decision must preserve these properties. If a feature introduces ambiguity, hidden retries, or implicit state transitions, it is out of scope.

---

## System Model

The system consists of a single process with four responsibilities:

1. HTTP API (Fastify, TypeScript, executed via `ts-node`)
2. Workspace management (`./.workspace`)
3. Git operations (via `simple-git`)
4. Agent execution orchestration

The repository defined by `REPO_URL` is cloned into `./.workspace` and represents the only working directory. All operations—git and agent—operate directly on this directory.

There is no replication, no clustering, and no external coordination mechanism. The filesystem is the single source of truth.

---

## Workspace Lifecycle

On server startup:

* If `./.workspace` does not exist → clone `REPO_URL` into it
* If it exists → assume it is valid and usable

There is no validation, repair, or re-cloning logic. Corruption is treated as a fatal condition and must be resolved externally.

The workspace persists across restarts. This is intentional and required for deterministic behavior.

---

## Concurrency Model

The workspace is a shared mutable resource and is protected by a **global mutex**.

Mutating operations include:

* All git operations except read-only queries
* Any agent execution

Rules:

* Only one mutating operation may execute at any time
* Lock acquisition is non-blocking
* If the lock is already held, the request fails immediately with `409 Conflict`
* No internal queuing or scheduling

Read-only operations may bypass the lock only if they do not mutate state (e.g. listing branches). When in doubt, treat the operation as mutating.

This model guarantees that the workspace state evolves linearly and is always explainable.

---

## Authentication

All endpoints require a static token:

* Header: `Authorization: Bearer <token>`
* Compared directly to `AUTH_TOKEN` environment variable

There is no concept of users, roles, scopes, or session-based authentication. This is a deliberate simplification aligned with single-tenant operation.

---

## Git Subsystem

Git operations are performed using `simple-git` against `./.workspace`.

### Supported Operations

* Listing branches
* Checking out a branch (create if it does not exist)
* Merging one branch into another
* Deleting a branch
* Pushing a branch to remote

### Behavioral Constraints

* No force pushes under any circumstance
* No automatic conflict resolution
* Merge conflicts result in immediate failure
* No retries, no fallbacks

All git commands are executed synchronously within the request lifecycle. There are no background operations.

### Determinism

Commands must produce predictable results given the same repository state. Any nondeterministic behavior (e.g. race conditions, implicit rebases) is disallowed.

---

## Agent Execution

The API does not implement agent logic. It runs the PI coding agent inside the workspace and exposes its lifecycle and outputs.

### Execution Model

* Only one agent session may run at any time
* Agent execution is treated as a mutating operation and requires the global lock
* The agent runs as a long-lived process within the server context

### Session Characteristics

* Sessions are multi-turn (stateful conversation)
* Session state is managed by the agent and persisted to disk via its own configuration
* The API does not interpret or modify agent state

### Lifecycle

A session progresses through these phases:

1. **Start**

   * Lock is acquired
   * Agent process is initialized with the provided prompt

2. **Execution**

   * Agent emits reasoning and actions
   * Tools (e.g. git, lint, test) are executed within the workspace

3. **Termination**

   * Completion, failure, or explicit cancellation
   * Lock is released immediately after termination

There is no resumability. If the process crashes, the session is considered lost, though logs may still exist.

---

## Streaming

Streaming is implemented using Server-Sent Events (SSE).

The stream is a direct, real-time projection of agent activity.

### Event Types

* `reasoning` – internal agent thoughts
* `action` – tool invocation
* `result` – tool output
* `error` – failure during execution
* `done` – terminal event

### Guarantees

* Events are emitted in strict chronological order
* No buffering or replay
* No transformation of agent output beyond minimal structuring

If the client disconnects, the agent continues execution. The stream is not recoverable.

---

## API Surface

The API is intentionally small and explicit.

### Git Endpoints

* `GET /git/branches`
  Returns all branches

* `POST /git/checkout`
  Checks out a branch, creating it if necessary

* `POST /git/merge`
  Merges one branch into another

* `POST /git/push`
  Pushes a branch to remote

* `DELETE /git/branch`
  Deletes a branch

All mutating endpoints require the global lock.

---

### Agent Endpoints

* `POST /agent/start`
  Starts a new agent session with a prompt
  Fails with `409` if another session is active

* `POST /agent/send`
  Sends input to the active agent session
  Fails with `409` if the session is already executing a turn

* `GET /agent/stream`
  Streams agent output via SSE

* `DELETE /agent/session`
  Terminates the active session

There is exactly one active session at any time.

---

## Error Handling

Error handling is strict and explicit. The system never attempts recovery.

All errors follow a consistent structure:

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable description",
    "details": {}
  }
}
```

Examples of error conditions:

* Lock contention → `409 Conflict`
* Git failure → `400` or `500` depending on cause
* Agent runtime error → streamed `error` event + request termination

No retries, no silent corrections, no fallback logic.

---

## Security Model

Security is enforced through restriction, not complexity.

### Filesystem

* The agent operates strictly within `./.workspace`
* No access to parent directories or arbitrary paths

### Execution

* Tools must be explicitly defined and controlled
* Arbitrary shell execution is disallowed unless explicitly exposed as a tool

### Network

* Outbound access is allowed (required for git push)
* No inbound connections initiated by the agent

---

## Logging

All operations produce structured logs in JSON format.

Each log entry includes:

* Timestamp
* Request identifier
* Operation type (git, agent, auth, etc.)
* Duration
* Outcome (success/failure)

Logs are append-only and written to stdout or file.

No distributed tracing or external observability systems are assumed.

---

## Testing Strategy

Development is strictly test-driven.

### Unit Tests

Focus areas:

* Lock acquisition and contention
* Git operation wrappers
* Agent session lifecycle

### Integration Tests

* Use real filesystem (temporary directories)
* Use a real git repository (local, not mocked)
* Validate actual git behavior

### Streaming Tests

* Use a stubbed agent
* Assert event ordering and structure
* Avoid timing-dependent assertions

### Determinism

Tests must be reproducible and free of race conditions. Any flakiness is considered a design failure.

---

## Failure Modes

The system is designed to fail visibly and predictably.

* Lock contention → immediate rejection
* Git errors → surfaced directly
* Agent failure → session terminates with error
* Process crash → session lost, workspace unchanged

There is no automatic recovery or cleanup.

---

## Deployment Assumptions

* Single process execution
* No clustering or load balancing
* Persistent local filesystem
* Environment variables available at runtime

Running via `ts-node` is intentional to reduce build complexity.

---

## Non-Goals

The following are explicitly out of scope:

* Multi-tenancy
* Horizontal scaling
* Session persistence across restarts
* Automatic retries or recovery
* Conflict resolution strategies
* Background job processing
* Fine-grained access control

---

## External Dependencies

* PI Agent README: [PI Agent README](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/agent/README.md?utm_source=chatgpt.com)
* PI Coding Agent SDK: [PI Coding Agent SDK](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/sdk.md?utm_source=chatgpt.com)
* Fastify: [Fastify Docs](https://fastify.dev/docs/latest/Reference/?utm_source=chatgpt.com)
* simple-git: [simple-git README](https://raw.githubusercontent.com/steveukx/git-js/refs/heads/main/simple-git/readme.md?utm_source=chatgpt.com)

---

This specification intentionally narrows the design space. The correct implementation should feel constrained and mechanical, not interpretive.
