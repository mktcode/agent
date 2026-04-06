# Testing

## Purpose

This module provides the **shared test harness** used across all modules.

It ensures:

* Deterministic test environments
* Consistent setup and teardown
* No duplication of test infrastructure

---

## Responsibilities

The test harness provides:

* Workspace utilities
* Git utilities
* Agent stub
* Event capture utilities

All tests must use this harness.

---

## Determinism Requirements

Tests must:

* Not depend on network access
* Not use real LLMs
* Not rely on timing-based assertions
* Be reproducible across runs

Any nondeterministic test is invalid.

---

## Workspace Utilities

Provide helpers to:

* Create temporary directories
* Initialize a git repository
* Seed commits and branches
* Clean up after tests

Constraints:

* Must use real filesystem
* Must not mock git

---

## Git Utilities

Provide helpers for:

* Creating commits
* Creating branches
* Simulating merge conflicts

These must operate on real repositories.

---

## Agent Stub

Provide a deterministic fake agent.

Capabilities:

* Emit ordered events
* Support multi-turn interaction
* Simulate success and failure
* Support cancellation

The stub must not depend on external systems.

---

## Event Utilities

Provide helpers to:

* Capture event streams
* Assert event order
* Assert streamed response headers
* Assert completion (`done` / `error`)

---

## Isolation Rules

Each test must:

* Use a fresh workspace
* Not share filesystem state
* Not depend on execution order

---

## Reuse Requirement

* All modules must use the shared test harness
* No ad-hoc setup inside individual tests

---

## Test Scope

### Unit Tests

* Validate individual module behavior
* Use harness utilities where needed

### Integration Tests

* Use real filesystem and git
* Validate actual state transitions

---

## Non-Goals

* No performance testing
* No load testing
* No external service integration

---

## Invariant

At all times:

> All tests execute in a fully controlled, deterministic environment with no external dependencies or hidden state.
