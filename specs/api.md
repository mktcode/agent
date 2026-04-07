# API Layer

## Purpose

This module exposes the system via HTTP.

It is the system's **HTTP transport boundary**, responsible for request validation, response mapping, and SSE delivery for agent execution.

It must not contain business logic, lock management, or session persistence logic.

---

## Responsibilities

The API layer:

* Authenticates requests
* Validates input
* Calls the appropriate module
* Maps results and errors to HTTP responses
* Streams agent events over SSE for prompt requests
* Logs failed HTTP requests with basic request context

It must not:

* Implement domain logic
* Manage locks
* Interpret agent events
* Modify behavior of underlying modules

---

## Logging

The API layer must remain mostly silent for successful requests.

It must log failed HTTP requests once after the response is determined.

Each log entry must include:

* HTTP method
* Request URL
* Response status code

If the failure originated from a thrown error, the log must also include the error object.

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

```json
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

#### `GET /git/status`

Returns the current checked out branch plus whether uncommitted changes exist.

Response:

```json
{
  "branch": "main",
  "hasUncommittedChanges": true
}
```

#### `GET /git/branches`

Returns all local branches.

Response:

```json
{
  "branches": ["main", "feature-x"]
}
```

#### `POST /git/checkout`

Request:

```json
{
  "branch": "string"
}
```

Behavior:

* Calls `gitService.checkout`

Response:

```json
{}
```

#### `POST /git/merge`

Request:

```json
{
  "source": "string",
  "target": "string"
}
```

Behavior:

* Calls `gitService.merge`

Response:

```json
{}
```

#### `POST /git/push`

Request:

```json
{
  "branch": "string",
  "commitMessage": "string"
}
```

Behavior:

* Calls `gitService.push`
* If `gitService.push` fails during commit or push, the standard error response must include the structured output returned by the module in `error.details`

Response:

```json
{}
```

#### `POST /git/revert`

Discards all uncommitted changes in the current working tree.

Behavior:

* Calls `gitService.revert`

Response:

```json
{}
```

#### `DELETE /git/branch`

Request:

```json
{
  "branch": "string"
}
```

Behavior:

* Calls `gitService.deleteBranch`

Response:

```json
{}
```

### Agent

The API exposes two data representations for endpoints that return turn or history data:

* `raw` – PI-native events or session entries
* `ui` – UI-friendly projected items derived from PI data

`raw` is the default when a format is not specified.

#### `POST /agent/prompt`

Request:

```json
{
  "prompt": "string",
  "sessionId": "string",
  "format": "raw | ui"
}
```

Behavior:

* Calls `agentRuntime.prompt`
* If `sessionId` is omitted, the runtime creates a new persistent PI session
* If `sessionId` is provided, the runtime resumes that persistent PI session
* Executes one agent turn for `prompt`
* If `format` is omitted, it defaults to `raw`
* If `format` is `raw`, subscribes to the runtime's raw event stream and forwards PI events unchanged on the same HTTP response
* If `format` is `ui`, subscribes to the runtime's UI-projected event stream and forwards UI item snapshots on the same HTTP response

Success response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Agent-Session-Id: <sessionId>
```

Response body:

* If `format` is `raw` → SSE stream of live PI agent events for the requested turn
* If `format` is `ui` → SSE stream of live `UiSessionItemEvent` events for the requested turn

The `sessionId` request field is optional.
The `X-Agent-Session-Id` response header is always required on successful responses.
The `format` request field is optional.

Error responses before streaming starts use the standard JSON error format.

If the client disconnects during execution, the active turn continues to run and finishes gracefully.

##### SSE response format

Each event must be sent as:

```
data: <JSON serialized event>
```

##### UI SSE event format

When `format` is `ui`, each SSE event payload must be:

```json
{
  "type": "session_item",
  "item": {
    "id": "string",
    "sessionId": "string",
    "timestamp": "ISO date string",
    "kind": "message | thinking | tool",
    "status": "streaming | final | error",
    "role": "user | assistant",
    "text": "string",
    "toolName": "string",
    "toolCallId": "string",
    "isError": false
  }
}
```

Rules:

* Each UI event carries the full current snapshot of one item, never a delta object
* Repeated events with the same item `id` replace the previous version of that item in the client
* UI mode must not include raw PI event objects in the payload
* Fields that do not apply to an item kind are omitted

Projection rules:

* User messages become `message` items with `role: "user"`
* Assistant text output becomes `message` items with `role: "assistant"`
* Assistant thinking output becomes `thinking` items
* Tool-call and tool-execution activity becomes `tool` items
* `bashExecution` is represented as `tool`, not as a separate UI kind
* PI-specific entries not needed for a minimal chat UI are omitted from `ui` output, including custom entries/messages, branch summaries, compaction summaries, labels, session metadata updates, model changes, and thinking-level changes
* `ui` format emits updated snapshots immediately as relevant PI streaming updates arrive; `raw` remains unchanged

#### `GET /agent/sessions`

Lists sessions with metadata for all existing sessions in `.pi/sessions`.

Behavior:

* Calls `agentRuntime.listSessions`
* Returns unmodified session metadata for all existing sessions in the order returned by the runtime

Response:

```json
{
  "sessions": [
    {
      "id": "string",
      "path": "string",
      "cwd": "string",
      "name": "string",
      "created": "ISO date string",
      "modified": "ISO date string",
      "messageCount": 1,
      "firstMessage": "string",
      "allMessagesText": "string"
    }
  ]
}
```

#### `GET /agent/session/:sessionId`

Returns metadata for the persisted session matching `sessionId`.

Behavior:

* Calls `agentRuntime.getSession`
* If no such persisted session exists → return the standard error response for `SessionNotFoundError`

Response:

```json
{
  "session": {
    "id": "string",
    "path": "string",
    "cwd": "string",
    "name": "string",
    "created": "ISO date string",
    "modified": "ISO date string",
    "messageCount": 1,
    "firstMessage": "string",
    "allMessagesText": "string"
  }
}
```


#### `DELETE /agent/session`

Request:

```json
{
  "sessionId": "string"
}
```

Behavior:

* Calls `agentRuntime.deleteSession`
* Deletes the persisted session matching `sessionId`

Response:

```json
{}
```

#### `GET /agent/session/:sessionId/items`

Returns the current branch history for the persisted session matching `sessionId`.

Query parameters:

* `format`: `raw | ui` (optional, defaults to `raw`)

Behavior:

* If `format` is `raw`, calls `agentRuntime.getSessionEntries`
* If `format` is `ui`, calls `agentRuntime.getSessionItems`
* Uses the persisted session's current leaf / active branch as defined by PI session state
* Returns items in chronological order from root to the current leaf
* If no such persisted session exists → return the standard error response for `SessionNotFoundError`

Response if `format=raw`:

```json
{
  "items": [
    {
      "type": "message"
    }
  ]
}
```

Response if `format=ui`:

```json
{
  "items": [
    {
      "id": "string",
      "sessionId": "string",
      "timestamp": "ISO date string",
      "kind": "message",
      "status": "final",
      "role": "assistant",
      "text": "string",
      "isError": false
    }
  ]
}
```

Rules for `ui` history:

* Returned items use the same `UiSessionItem` shape as `POST /agent/prompt` with `format=ui`
* Persisted history returns final items only; no synthetic partial or streaming states are reconstructed
* Raw PI session entries are not included when `format=ui`
* Persisted entries that do not map to the minimal chat UI are omitted from `ui` output

---

## Idempotency

* `GET` endpoints → idempotent
* `POST /agent/prompt` → non-idempotent
* All other `POST` endpoints → non-idempotent
* `DELETE` endpoints → non-idempotent

---

## Execution Rules

* Each request must call exactly one module
* `POST /agent/prompt` may subscribe to runtime events and await turn completion while building the HTTP response
* No retries or fallback logic

---

## Agent Endpoint Constraints

* `POST /agent/prompt` is the only agent execution endpoint
* `GET /agent/sessions` and `DELETE /agent/session` only inspect or delete persisted PI sessions
* Session creation versus resume is handled entirely inside the agent runtime
* The API layer treats `sessionId` as opaque input/output data
* The API layer forwards agent events unchanged
* Client disconnects must not cancel the active turn

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
* Session listing delegates directly to the runtime
* Session deletion delegates directly to the runtime
* Session deletion validates `sessionId` strictly
* Endpoint-to-module delegation
* SSE header and frame formatting for prompt requests
* Disconnect cleanup without turn cancellation

### Integration

* Use stubbed modules for agent and git
* Do not test business logic here

Tests must be deterministic and isolated.

---

## Invariant

At all times:

> The API layer deterministically maps HTTP requests to module calls, and for prompt requests it forwards runtime events over SSE without modifying execution semantics.

Any logic beyond validation and delegation violates this module’s contract.
