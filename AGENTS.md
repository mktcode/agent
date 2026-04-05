# Agent Instructions

## Purpose

This repository is specified via modular documents in `specs/`.

You must treat these specifications as **authoritative** and follow them exactly.

---

## How to Work with the Specs

1. Start with `specs/overview.md`
2. Then read **only the module you are implementing**
3. Read other specs **only if required by dependency**

Rules:

* Do not preload multiple specs for context
* Do not combine responsibilities across modules
* If multiple specs are needed to understand behavior, you are likely violating boundaries

---

## Implementation Rules

* Implement **one module at a time**
* Follow the module spec exactly
* Do not add behavior not explicitly defined

You must not:

* Move logic between modules
* Duplicate responsibilities
* Introduce cross-module coordination
* Extend or “improve” the design

**If something is not specified, it is not allowed.**

---

## API Constraint

The API layer must only:

* validate input
* call a single module
* return a response

It must not contain business logic or orchestration.

---

## Error Handling

* Use only defined error types (`errors-and-results.md`)
* Do not wrap or reinterpret errors
* Errors are mapped only at the API boundary

---

## Testing

* Write a failing test before implementation
* Use the shared test harness (`testing.md`)
* Do not mock components that must be real (e.g. git)
* Do not use nondeterministic behavior

---

## Final Rule

When in doubt:

* Do less
* Stay within the module
* Fail explicitly

Do not deviate from the specifications.
