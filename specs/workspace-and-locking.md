# Workspace & Locking

## Purpose

This module owns:

* The `./.workspace` directory
* The global mutex protecting workspace and project-local session mutations

It is the **foundation of determinism** in the system. All higher-level modules depend on its correctness.

---

## Responsibilities

The module provides:

1. Workspace initialization
2. Exclusive access control via a global lock

It must not contain any git logic, agent logic, or API concerns.

---

## Workspace Initialization

On server startup:

* If `./.workspace` does not exist → clone `REPO_URL` into it
* If it exists → do nothing

Constraints:

* No validation of repository state
* No pulling, resetting, or cleaning
* No retries

Failure behavior:

* If cloning fails → the process must fail to start

The workspace is persistent across restarts.

---

## Lock Model

A single **in-process global mutex** protects the entire workspace.

### Scope

The lock covers:

* All filesystem mutations inside `./.workspace`
* All git operations
* Entire agent execution lifecycle
* Mutations to persisted PI sessions in `./.pi/sessions`

The lock does **not** cover:

* Read-only operations
* Logging
* Streaming
* In-memory computation

---

## Lock Semantics

* Non-blocking
* No queuing
* No timeouts
* No reentrancy

At most one operation may hold the lock at any time.

---

## Public API

The module exposes the following functions:

### `acquire(): boolean`

* Attempts to acquire the lock
* Returns `true` if successful
* Returns `false` if already locked
* Must not block

---

### `release(): void`

* Releases the lock

Error conditions:

* If lock is not currently held → throw `InvalidLockStateError`

---

### `isLocked(): boolean`

* Returns current lock state

---

### `runExclusive<T>(fn: () => Promise<T>): Promise<T>`

* Attempts to execute `fn` under lock

Behavior:

* If lock is already held → throw `LockUnavailableError`
* If acquired:

  * Execute `fn`
  * Always release lock afterward

Guarantees:

* Lock is released on both success and failure
* No code path may leave the lock held

Implementation must use strict `try/finally` semantics.

---

## Ownership Rules

* The lock has a single logical owner
* Re-acquiring while already held → must fail
* Releasing without ownership → must throw

No reentrant or nested locking is allowed.

---

## Implementation Constraints

* Must be implemented in-process
* Must use simple in-memory state (e.g. boolean or small state object)

Explicitly disallowed:

* File locks
* Redis or external systems
* OS-level locking primitives

---

## Error Types

The module defines:

* `LockUnavailableError`
* `InvalidLockStateError`

Errors must be explicit and deterministic.

---

## Non-Goals

* No fairness guarantees
* No scheduling or queuing
* No lock expiration
* No cross-process coordination

---

## Testing Requirements

The following cases must be covered:

* Acquire when unlocked → succeeds
* Acquire when locked → returns `false`
* Release when locked → succeeds
* Release when unlocked → throws

### `runExclusive`

* Executes function when unlocked
* Throws when already locked
* Releases lock after success
* Releases lock after failure (throw inside `fn`)

### Concurrency Behavior

* Nested `runExclusive` → fails
* Async function inside `runExclusive` holds lock correctly until completion

Tests must be deterministic and not rely on timing.

---

## Invariant

At all times:

> The workspace is mutated by at most one operation, and lock state always reflects reality.

Any violation of this invariant invalidates the system.
