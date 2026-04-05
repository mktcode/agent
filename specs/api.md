# API Layer (Thin HTTP Shell)

This should be intentionally dumb.

**Responsibility:**

* Route requests
* Validate input
* Call underlying services
* Map errors → HTTP responses

**Strict rule:**

> No business logic in handlers.

Each handler should look like:

* validate
* call service
* return result

If logic appears here, your boundaries are wrong.