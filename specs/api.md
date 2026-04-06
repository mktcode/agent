# API Layer

## Purpose

This module exposes the system via HTTP.

It is a **thin transport and validation layer** that maps HTTP requests to underlying modules.

It must not contain business logic, state management, or orchestration.

---

## Responsibilities

The API layer:

* Authenticates requests
* Validates input
* Calls the appropriate module
* Maps results and errors to HTTP responses

It must not:

* Implement domain logic
* Manage locks
* Coordinate multiple modules beyond direct delegation
* Modify behavior of underlying modules

---

## Authentication

All endpoints require:

```
Authorization: Bearer <token>
```

Validation:

* Token must match `AUTH_TOKEN`
* If missing or invalid → respond with `401 Unauthorized`

No exceptions. No partial access.

---

## Error Handling

All errors must be returned in the standard format:

```json id="1q5mp3"
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable description",
    "details": {}
  }
}
```

### Mapping Rules

* Validation errors → `400 Bad Request`
* Authentication failure → `401 Unauthorized`
* Lock contention → `409 Conflict`
* Known domain errors → `400`
* Unexpected errors → `500 Internal Server Error`

No custom or ad-hoc error responses.

---

## Validation

* All inputs must be strictly validated
* Unknown fields must be rejected
* No implicit coercion

Invalid input → immediate `400` response

---

## Endpoints

### Git

#### `GET /git/branches`

Returns all local branches.

Response:

```json id="7k4l5g"
{
  "branches": ["main", "feature-x"]
}
```

---

#### `POST /git/checkout`

Request:

```json id="4k9q1y"
{
  "branch": "string"
}
```

Behavior:

* Calls `gitService.checkout`

Response:

```json id="b6r1n3"
{}
```

---

#### `POST /git/merge`

Request:

```json id="v9j2mz"
{
  "source": "string",
  "target": "string"
}
```

Behavior:

* Calls `gitService.merge`

Response:

```json id="0xv6m7"
{}
```

---

#### `POST /git/push`

Request:

```json id="i2p7wq"
{
  "branch": "string"
}
```

Behavior:

* Calls `gitService.push`

Response:

```json id="o4d8ks"
{}
```

---

#### `DELETE /git/branch`

Request:

```json id="9c3k1x"
{
  "branch": "string"
}
```

Behavior:

* Calls `gitService.deleteBranch`

Response:

```json id="l5t2qn"
{}
```

---

### Agent

#### `POST /agent/prompt`

Request:

```json id="0xg1s2"
{
  "prompt": "string",
  "sessionId": "string"
}
```

Behavior:

* Calls the streaming layer
* If `sessionId` is omitted, the runtime creates a new persistent PI session
* If `sessionId` is provided, the runtime resumes that persistent PI session
* Executes one agent turn for `prompt`
* Streams live agent events on the same HTTP response

Success response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Agent-Session-Id: <sessionId>
```

Response body:

* SSE stream of live agent events for the requested turn

The `sessionId` request field is optional.
The `X-Agent-Session-Id` response header is always required on successful responses.

Error responses before streaming starts use the standard JSON error format.

If the client disconnects during execution, the active turn continues to run and finishes gracefully.

### SSE response format

Each event must be sent as:

```
data: <JSON serialized event>

```

---

## Idempotency

* `GET` endpoints → idempotent
* `POST /agent/prompt` → non-idempotent
* All other `POST` endpoints → non-idempotent

---

## Execution Rules

* Each request must call exactly one module
* No chaining of operations
* No retries or fallback logic

---

## Agent Prompt Constraints

* `POST /agent/prompt` is the only agent endpoint
* Session creation versus resume is handled entirely inside the agent runtime
* The API layer treats `sessionId` as opaque input/output data
* The API layer does not subscribe to agent events directly

---

## Implementation Constraints

* Must use Fastify
* Must not introduce additional frameworks or abstractions
* Handlers must remain minimal and explicit

---

## Testing Requirements

### Required Tests

* Authentication enforcement
* Input validation
* Error mapping correctness
* Endpoint-to-module delegation

### Integration

* Use stubbed modules for agent and git
* Do not test business logic here

Tests must be deterministic and isolated.

---

## Invariant

At all times:

> The API layer is a thin, deterministic mapping from HTTP requests to module calls, with no additional logic or side effects.

Any logic beyond validation and delegation violates this module’s contract.
