# Test Harness Layer (Often overlooked, but critical here)

Given your strict TDD requirement, this deserves its own mental module.

**Responsibility:**

* Provide utilities:

  * temp repo creation
  * workspace bootstrap
  * fake agent runner
* Ensure deterministic test setup

**Why separate:**
Otherwise tests will duplicate setup logic and drift.