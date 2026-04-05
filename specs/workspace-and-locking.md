# Workspace & Locking Core (Foundation Layer)

This is the most critical module. Everything else depends on it.

**Responsibility:**

* Own `./.workspace`
* Provide the global mutex
* Expose a minimal API like:

  * `runExclusive(fn)`
  * `isLocked()`

**Why it must be isolated:**
If this leaks or becomes inconsistent, determinism is gone across the entire system.

**Key invariant:**

> At most one mutating operation touches the workspace at any time.

**Implementation detail worth locking early:**

* In-process mutex only (no file locks, no Redis, no OS-level primitives)
