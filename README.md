# Agent API Server

This service exposes a small authenticated HTTP API for managing a single repository workspace and running the coding agent against it.

## Requirements

- Node.js
- npm
- A repository URL or local repository path for `REPO_URL`

## Configuration

The server reads configuration from environment variables.

Required:

- `AUTH_TOKEN`: bearer token required on every request
- `REPO_URL`: repository URL or local repository path to clone into `.workspace`

Optional:

- `HOST`: defaults to `127.0.0.1`
- `PORT`: defaults to `3000`
- `MODEL_PROVIDER`: defaults to `openai` ([Pi docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md))
- `MODEL_NAME`: defaults to `gpt-5.4-mini`

Example:

```bash
AUTH_TOKEN=secret-token
REPO_URL=/absolute/path/to/repository
HOST=127.0.0.1
PORT=3000
MODEL_PROVIDER=anthropic
MODEL_NAME=claude-opus-4-6
```

## Start

```bash
npm install
npm run build
npm start

# Or with explicit env vars:
HOST=127.0.0.1 PORT=3000 AUTH_TOKEN=secret-token REPO_URL=/absolute/path/to/repository npm start

# Watch files in `src/`,
npm run dev
```

On first startup, the server clones `REPO_URL` into `.workspace` in the project root. If `.workspace` already exists, it is reused as-is.

PI agent sessions are stored separately in `.pi/sessions` in the project root.

## API Examples

All requests require:

```bash
-H 'Authorization: Bearer secret-token'
```

List branches:

```bash
curl http://127.0.0.1:3000/git/branches \
  -H 'Authorization: Bearer secret-token'
```

Create or switch to a branch:

```bash
curl -X POST http://127.0.0.1:3000/git/checkout \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"branch":"feature-x"}'
```

Merge one branch into another:

```bash
curl -X POST http://127.0.0.1:3000/git/merge \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"source":"feature-x","target":"main"}'
```

Push a branch:

```bash
curl -X POST http://127.0.0.1:3000/git/push \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main"}'
```

Delete a branch:

```bash
curl -X DELETE http://127.0.0.1:3000/git/branch \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"branch":"feature-x"}'
```

List sessions:

```bash
curl http://127.0.0.1:3000/agent/sessions \
  -H 'Authorization: Bearer secret-token'
```

Delete a session:

```bash
curl -X DELETE http://127.0.0.1:3000/agent/session \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<session-id>"}'
```

Run one agent prompt and stream live events:

```bash
curl -N -X POST http://127.0.0.1:3000/agent/prompt \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Implement the missing API layer."}'
```

Continue an existing PI session:

```bash
curl -N -X POST http://127.0.0.1:3000/agent/prompt \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Now add tests.","sessionId":"<session-id>"}'
```

Successful prompt responses include the effective session ID in the `X-Agent-Session-Id` response header.

If the client disconnects while a prompt is running, the agent turn continues to completion.