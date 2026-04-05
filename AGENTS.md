# AGENTS.md

## Purpose

This repository is specified via modular documents under `specs/`.
Each file defines a **strictly bounded subsystem** with clear responsibilities and invariants.

You must **treat these specifications as authoritative**. Do not reinterpret, extend, or merge responsibilities across modules.

---

## Specification Structure

```
specs/
- overview.md
- workspace-and-locking.md
- git-service.md
- agent-runtime.md
- streaming.md
- api.md
- errors-and-results.md
- testing.md
```

### How to read

* Start with `overview.md` to understand the system model and constraints
* Then **only read the module spec you are currently implementing**
* Consult other specs **only if there is a direct dependency**

Do not preload or combine multiple specs “for context”. This leads to boundary violations.

---

## Module Boundaries

Each spec defines:

* Responsibilities (what the module owns)
* Invariants (what must always hold true)
* Constraints (what is explicitly disallowed)

You must not:

* Move logic between modules
* Duplicate responsibilities
* Introduce implicit coupling

If something feels ambiguous, resolve it **within the current module’s constraints**, not by expanding scope.

---

## Dependency Direction

All modules follow a strict, one-way dependency flow:

```
API Layer
   ↓
Streaming Layer
   ↓
Agent Runtime
   ↓
Git Service
   ↓
Workspace & Lock
```

Rules:

* Dependencies only flow downward
* No upward calls
* No cyclic dependencies
* Lower layers must not know about higher layers

---

## Implementation Strategy

* Implement **one module at a time**
* Start from the lowest layer (`workspace-and-locking.md`)
* Move upward only after the lower layer is complete and tested

At all times:

* Think in terms of invariants, not features
* Prefer explicit failure over implicit handling
* Avoid introducing concurrency beyond what is specified

---

## Testing

Testing is mandatory and defined in `testing.md`.

Before writing implementation code:

* Identify the smallest testable unit
* Write a failing test
* Implement only what is required to pass

Do not:

* Skip integration tests where specified
* Mock components that are required to be real (e.g. git)

---

## Practical Outcome

If implemented correctly:

* Each module is independently testable
* Failures are localized and explainable
* The system remains deterministic under all conditions
* Behavior is fully derived from explicit state, not side effects

If your implementation introduces hidden state, implicit retries, or unclear ownership, it is incorrect.

---

## Final Rule

When in doubt:

* Do less
* Stay within the module
* Fail explicitly

Never “improve” the design beyond what is specified.
