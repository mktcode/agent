# Git Service (Deterministic State Manipulation)

This sits on top of the workspace module.

**Responsibility:**

* Wrap `simple-git`
* Provide strictly controlled operations:

  * `listBranches()`
  * `checkout(branch)`
  * `merge(source, target)`
  * `push(branch)`
  * `delete(branch)`

**Important constraint:**
This module should **not know anything about HTTP or agents**.

**Key invariant:**

> Every function is a pure mapping: (current repo state + input) → (new repo state OR failure)

**Why separate:**

* You want to test this against real repos without any API/server context
* It’s the most failure-prone area (merge conflicts, detached HEAD, etc.)