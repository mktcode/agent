# Errors & Results

## Purpose

This module defines the **canonical error model** used across the system.

It ensures that all failures are:

* Explicit
* Deterministic
* Consistently structured

It does not perform HTTP mapping or transport concerns.

---

## Responsibilities

This module:

* Defines the shared `AppError` contract used by all domain errors
* Defines all exported domain error types
* Ensures consistent error semantics across modules

It must not:

* Map errors to HTTP responses
* Perform logging
* Wrap or reinterpret errors dynamically

---

## Error Model

All domain errors must conform to a shared structure:

```ts
type AppError = {
  code: string
  message: string
  details?: unknown
}
```

Constraints:

* `code` must be stable and machine-readable
* `message` must be human-readable
* `details` is optional and must be structured data (no strings)

---

## Error Types

All modules must throw only:

* Defined domain errors (below)
* Or unexpected errors (treated as internal failures)

### Core Errors

* `ValidationError`
* `LockUnavailableError`
* `InvalidLockStateError`

### Agent Errors

* `SessionBusyError`
* `SessionNotFoundError`

### Git Errors

* `GitOperationError`
* `DirtyWorkingTreeError`
* `InvalidBranchNameError`
* `ActiveBranchDeletionError`
* `UpstreamNotConfiguredError`
* `DetachedHeadError`

The module may expose a shared `AppError` base class plus a fixed set of exported subclasses.

Constraints:

* Subclasses must preserve the same `{ code, message, details? }` shape
* Subclasses must have fixed exported names and stable `code` values
* No ad-hoc runtime-generated error classes are allowed

---

## Error Construction

Each error must:

* Have a fixed `code`
* Have a deterministic message
* Not depend on runtime formatting

Example:

```ts
new ValidationError("Invalid branch name")
```

Must produce:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid branch name"
}
```

---

## Error Propagation

Errors must propagate unchanged through layers.

Rules:

* No wrapping or rethrowing with different semantics
* No string-based errors
* No partial conversion
* When unexpected library errors must be attached for diagnostics, they must remain in structured `details`

Flow:

```text
Module throws → API layer catches → API maps to HTTP
```

---

## Mapping Responsibility

Error-to-HTTP mapping is handled **only in the API layer**.

This module must not:

* Know about HTTP
* Encode status codes

---

## Unexpected Errors

Any non-domain error is treated as:

* Internal error
* Mapped to `500` at API layer

No attempt to recover or reinterpret.

---

## Non-Goals

* No dynamic error inheritance beyond the fixed exported types
* No dynamic error generation
* No logging concerns
* No retry semantics

---

## Testing Requirements

* Each error type produces correct `code` and `message`
* Errors are serializable to JSON
* No ambiguity in structure

---

## Invariant

At all times:

> Every failure is represented either as a defined domain error or an unexpected error, and is propagated unchanged until mapped at the API boundary.
