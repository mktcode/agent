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
- `POST_CLONE_COMMAND`: optional shell command to run after cloning the repository (e.g. for installing dependencies and setting up git hooks)

Example:

```bash
AUTH_TOKEN=secret-token
REPO_URL=/absolute/path/to/repository
HOST=127.0.0.1
PORT=3000
MODEL_PROVIDER=anthropic
MODEL_NAME=claude-opus-4-6
POST_CLONE_COMMAND=npm install && npm run prepare
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

On first startup, the server clones `REPO_URL` into `.workspace` in the project root. If `POST_CLONE_COMMAND` is set, it runs once after that fresh clone inside `.workspace`. If `.workspace` already exists, it is reused as-is and the post-clone command is not run again.

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

Get the current branch and whether the workspace has uncommitted changes:

```bash
curl http://127.0.0.1:3000/git/status \
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
  -d '{"branch":"main","commitMessage":"Agent commit"}'
```

If `.workspace` contains uncommitted changes, `POST /git/push` stages and commits them before pushing. When commit or push fails, the JSON error response includes structured details that contain the failed stage and available command output.

Discard all uncommitted changes:

```bash
curl -X POST http://127.0.0.1:3000/git/revert \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{}'
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

## React Example

For a chat-style UI, use `format: "ui"` on `POST /agent/prompt` and `GET /agent/session/:sessionId/items?format=ui`.

The important client rule is:

- append a UI item the first time you see its `id`
- replace the existing item when the same `id` appears again
- do not move an existing item when it updates

That gives stable ordering for mixed `message`, `thinking`, and `tool` items while still letting streaming updates replace earlier snapshots in place.

```tsx
import { useEffect, useRef, useState } from 'react';

type UiSessionItem = {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: 'message' | 'thinking' | 'tool';
  status: 'streaming' | 'final' | 'error';
  isError: boolean;
  role?: 'user' | 'assistant';
  text?: string;
  toolName?: string;
  toolCallId?: string;
};

type UiSessionItemEvent = {
  type: 'session_item';
  item: UiSessionItem;
};

const API_BASE_URL = 'http://127.0.0.1:3000';
const AUTH_TOKEN = 'secret-token';

export function AgentSessionView() {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [items, setItems] = useState<UiSessionItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let cancelled = false;

    void fetch(`${API_BASE_URL}/agent/session/${sessionId}/items?format=ui`, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load items: ${response.status}`);
        }

        const body = await response.json() as { items: UiSessionItem[] };

        if (!cancelled) {
          setItems(body.items);
        }
      })
      .catch((error) => {
        console.error(error);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function submitPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    const response = await fetch(`${API_BASE_URL}/agent/prompt`, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        sessionId,
        format: 'ui',
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Prompt failed: ${response.status}`);
    }

    const nextSessionId = response.headers.get('X-Agent-Session-Id') ?? undefined;

    if (nextSessionId) {
      setSessionId(nextSessionId);
    }

    setPrompt('');

    for await (const sseEvent of readSseEvents<UiSessionItemEvent>(response.body)) {
      if (sseEvent.type !== 'session_item') {
        continue;
      }

      setItems((currentItems) => upsertSessionItem(currentItems, sseEvent.item));
    }
  }

  return (
    <div>
      <div>
        {items.map((item) => (
          <div key={item.id}>
            <strong>
              {item.kind === 'tool'
                ? `tool:${item.toolName ?? 'unknown'}`
                : item.kind === 'thinking'
                  ? 'thinking'
                  : item.role}
            </strong>
            {' '}
            <span>{item.text ?? ''}</span>
            {item.status === 'streaming' ? ' ...' : ''}
            {item.isError ? ' (error)' : ''}
          </div>
        ))}
      </div>

      <form onSubmit={(event) => void submitPrompt(event)}>
        <input value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

function upsertSessionItem(items: UiSessionItem[], nextItem: UiSessionItem): UiSessionItem[] {
  const index = items.findIndex((item) => item.id === nextItem.id);

  if (index === -1) {
    return [...items, nextItem];
  }

  return items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
}

async function* readSseEvents<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf('\n\n');

        if (boundary === -1) {
          break;
        }

        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = rawEvent
          .split('\n')
          .find((line) => line.startsWith('data: '));

        if (!dataLine) {
          continue;
        }

        yield JSON.parse(dataLine.slice(6)) as T;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```