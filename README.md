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
- `MODEL_PROVIDER`: defaults to `openai`
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

Install dependencies:

```bash
npm install
```

Build the server bundle:

```bash
npm run build
```

Start the server:

```bash
AUTH_TOKEN=secret-token REPO_URL=/absolute/path/to/repository npm start
```

Or with explicit host and port:

```bash
HOST=127.0.0.1 PORT=3000 AUTH_TOKEN=secret-token REPO_URL=/absolute/path/to/repository npm start
```

For a lighter development run:

```bash
AUTH_TOKEN=secret-token REPO_URL=/absolute/path/to/repository npm run dev
```

`npm start` first builds the server once and then runs plain Node on the generated bundle in `dist/server.mjs`.

`npm run dev` is the watch-mode workflow. It watches `src/`, rebuilds on source changes, and restarts the bundled server after a successful rebuild.

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

Successful prompt responses use SSE and include the effective session ID in the `X-Agent-Session-Id` response header.

If the client disconnects while a prompt is running, the agent turn continues to completion.