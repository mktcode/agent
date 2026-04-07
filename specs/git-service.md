# Git Service

## Purpose

This module provides deterministic, minimal wrappers around git operations inside `./.workspace`.

It is responsible for **all repository state mutations**, but must not:

* Manage locking
* Contain API logic
* Contain agent logic

It operates purely on the filesystem using `simple-git`.

---

## Responsibilities

The module exposes a small, explicit set of operations:

* Listing branches
* Reporting repository status
* Checking out branches
* Merging branches
* Deleting branches
* Reverting uncommitted changes
* Pushing branches

Each operation must be **atomic, predictable, and side-effect minimal**.

---

## Execution Model

* All methods are asynchronous
* All methods assume they are called under an acquired workspace lock
* The module must not acquire or manage locks itself

---

## Implementation Constraints

* Must use `simple-git`
* Must operate only inside `./.workspace`
* Must not shell out manually
* Must not introduce additional git abstractions

---

## Public API

### `listBranches(): Promise<string[]>`

Returns all local branch names.

Constraints:

* Must return normalized branch names only
* Must not include formatting (no `*`, no prefixes)

---

### `getStatus(): Promise<{ branch: string, hasUncommittedChanges: boolean }>`

Returns the current checked out branch plus whether the working tree contains any uncommitted changes.

Constraints:

* Must treat staged, unstaged, and untracked files as uncommitted changes
* Must fail if the repository is in detached HEAD state

---

### `checkout(branch: string): Promise<void>`

Behavior:

* If branch exists → checkout
* If branch does not exist → create from current `HEAD` and checkout

Constraints:

* Must not leave repository in detached HEAD
* Must not pull, fetch, or modify remote state

Failure conditions:

* Invalid branch name
* Underlying git failure

---

### `merge(source: string, target: string): Promise<void>`

Behavior:

1. Checkout `target`
2. Merge `source` into `target`

Constraints:

* After completion, `target` must be checked out
* No rebase, only standard merge
* No automatic conflict resolution

Failure conditions:

* Merge conflict → fail immediately
* Any non-zero git exit → fail

---

### `deleteBranch(branch: string): Promise<void>`

Behavior:

* Deletes the specified branch

Constraints:

* Must not delete the currently checked out branch

Failure conditions:

* Branch does not exist
* Attempt to delete active branch
* Underlying git failure

---

### `revert(): Promise<void>`

Behavior:

* Discards all uncommitted changes in the current working tree

Constraints:

* Must reset staged and unstaged tracked changes to `HEAD`
* Must remove untracked files and directories
* If the working tree is already clean → no-op
* Must not modify commit history

Failure conditions:

* Repository is in detached HEAD state
* Underlying git failure

---

### `push(branch: string, commitMessage: string): Promise<void>`

Behavior:

* Ensure `branch` is the currently checked out branch
* If the working tree contains uncommitted changes:

	1. Stage all changes
	2. Create a single commit using `commitMessage`
* Push branch to `origin`

Constraints:

* Must push exactly `branch` → `origin/branch`
* No force push
* No implicit upstream configuration
* Must not create an empty commit when the working tree is already clean
* Must not amend, squash, or split commits
* If a commit is created and the subsequent push fails, the created commit must remain in local history

Failure conditions:

* Requested branch is not currently checked out
* Commit fails, including git hook failures
* Remote rejects push
* Upstream not configured (must fail, not auto-create)

---

## Working Tree Requirements

Before `checkout`, `merge`, or `deleteBranch`:

* Working directory must be clean

Definition of clean:

* No modified files
* No staged changes
* No untracked files

If not clean:

* Operation must fail immediately

Explicitly disallowed:

* Auto-stashing
* Resetting changes

`push` and `revert` define their own working-tree handling and are the only exceptions to this rule.

---

## Determinism Constraints

* No retries
* No background operations
* No implicit git behavior

Explicitly disallowed:

* Rebasing
* Auto fast-forward logic beyond default git behavior
* Hidden state changes

Each operation must produce predictable results based solely on current repo state.

---

## Repository State Guarantees

After every operation:

* Repository must not be in detached HEAD state
* Current branch must be well-defined
* No partial operations (all-or-fail)

---

## Error Handling

* All failures must throw
* No silent handling
* No fallback behavior

Errors should reflect the underlying git failure but remain structured and predictable.

For `push` failures after an attempted auto-commit, the thrown `GitOperationError` must include structured details with:

* `stage`: `commit` or `push`
* `createdCommit`: boolean
* Available command output (`stdout`, `stderr`, and/or message)

---

## Non-Goals

* No remote management beyond push
* No fetch/pull operations
* No branch tracking automation
* No conflict resolution strategies

---

## Testing Requirements

Tests must use a real git repository (no mocks).

### Setup

* Create temporary directory
* Initialize git repo
* Create commits programmatically

---

### Required Test Cases

**Branches**

* List branches returns correct names

**Checkout**

* Checkout existing branch
* Checkout new branch (created from HEAD)

**Merge**

* Successful merge updates history
* Merge conflict → operation fails

**Delete**

* Delete existing branch
* Delete current branch → fails

**Push**

* Push to a local test remote
* Push without upstream → fails
* Push on a dirty working tree creates one commit before pushing
* Push fails when the requested branch is not currently checked out
* Commit hook failure during push surfaces structured output and does not discard changes

**Status**

* Status returns the current branch and whether uncommitted changes exist

**Revert**

* Revert discards staged, unstaged, and untracked changes
* Revert on a clean working tree is a no-op

---

### State Validation

After each operation, verify:

* Current branch (`HEAD`)
* Branch existence
* Commit history where relevant

---

## Invariant

At all times:

> Repository state transitions are explicit, atomic, and reproducible, with no hidden git behavior.

Any implicit mutation or side effect violates this module’s contract.
