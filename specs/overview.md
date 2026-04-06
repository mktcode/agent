# Agent API Server – Overview

## Purpose

This service exposes a minimal API for managing a single repository and executing a coding agent against it.

It acts as a **controlled execution environment**. The system does not implement agent logic; it provides orchestration, isolation, and deterministic execution around the PI Coding Agent.

A separate frontend (“portal”) consumes this API.

---

## Core Principles

The system is intentionally constrained:

* Single-tenant, single-repo, single-node
* Deterministic behavior over flexibility
* Fail fast, no implicit recovery
* Minimal concurrency, explicit locking
* Stateless API, stateful workspace

Every implementation decision must preserve these properties. Any feature that introduces hidden state, retries, or ambiguity is out of scope.

---

## System Model

The system runs as a single process with a persistent local workspace:

* One API server (Fastify, TypeScript, `ts-node`)
* One workspace directory (`./.workspace`)
* One repository cloned from `REPO_URL`
* One project-local PI session directory (`./.pi/sessions`)

All git operations and agent execution occur directly inside this workspace.

There is:

* No horizontal scaling
* No distributed coordination
* No external state beyond the filesystem

The filesystem is the single source of truth.

---

## Module Architecture

The system is composed of strictly separated modules, each defined in `specs/`.

Dependency direction is one-way:

```text
API Layer
   ↓
Agent Runtime
   ↓
Git Service
   ↓
Workspace & Locking
```

Each module owns a well-defined responsibility and must not leak concerns across boundaries.

### Module Specifications

* Workspace & Locking → `specs/workspace-and-locking.md`
* Git Service → `specs/git-service.md`
* Agent Runtime → `specs/agent-runtime.md`
* API Layer → `specs/api.md`
* Errors & Results → `specs/errors-and-results.md`
* Testing → `specs/testing.md`

All implementation details are defined in these documents.

---

## Workspace Lifecycle

On server startup:

* If `./.workspace` does not exist → clone `REPO_URL` into it
* If it exists → assume it is valid

No validation, repair, or synchronization is performed.

The workspace persists across restarts and represents the full system state.

---

## Concurrency Model

The workspace is protected by a **global mutex**.

* Only one mutating operation may execute at a time
* Lock acquisition is non-blocking
* If the lock is held → request fails with `409 Conflict`
* No queuing or scheduling

Mutating operations include:

* Git operations
* Agent execution (per turn)

Between agent turns, no lock is held.

This guarantees that all state transitions are linear and explainable.

---

## Authentication

All endpoints require:

```
Authorization: Bearer <token>
```

The token is compared to `AUTH_TOKEN`.

There are:

* No users
* No roles
* No session-based authentication

---

## Agent Transport

Agent execution uses a single HTTP endpoint:

* `POST /agent/prompt`

That request both:

* selects or creates the PI session
* executes one agent turn
* streams live agent events back to the client via SSE

---

## Failure Philosophy

The system fails explicitly and immediately:

* No retries
* No fallback behavior
* No automatic recovery

Errors propagate directly and are only mapped at the API boundary.

---

## Non-Goals

The following are explicitly out of scope:

* Multi-tenancy
* Horizontal scaling
* Automatic retries or recovery
* Conflict resolution strategies
* Background job processing
* Fine-grained access control

---

## External Dependencies

* [PI Agent README](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/agent/README.md?utm_source=chatgpt.com)
* [PI Coding Agent SDK](https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/sdk.md?utm_source=chatgpt.com)
* [Fastify Docs](https://fastify.dev/docs/latest/Reference/?utm_source=chatgpt.com)
* [simple-git README](https://raw.githubusercontent.com/steveukx/git-js/refs/heads/main/simple-git/readme.md?utm_source=chatgpt.com)

---

## Final Note

This document defines the system at a high level.

All concrete behavior, constraints, and edge cases are specified in the module documents.
Implementation must follow those specifications exactly.
