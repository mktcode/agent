# Agent Instructions

This project contains a Fastify API server, running the PI coding agent against a locally checked out repository.

The API exposes endpoints to:

- Manage git branches
- Run the agent with a given prompt against the current branch and stream its actions and reasoning

The agent can push to remote, to trigger deployments.

## Test Driven Development

Development happens strictly test driven. Always write a failing test first, then implement the code to make it pass.

When reasoning about features, think about how you would test them first and start with the most atomic pieces.

## Documentation Resources

- PI Agent README: https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/agent/README.md
- PI Coding Agent SDK: https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/sdk.md
- Fastify Reference: https://fastify.dev/docs/latest/Reference/