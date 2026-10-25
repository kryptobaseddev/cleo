---
id: t14035-envkeys-undeclared-doc
tasks: [T14035]
kind: docs
summary: "CLEO-REFERENCE states that an undeclared env var lets a cached typed-gate pass be reused under a different value"
---

The typed-gate cache key covers only a gate's `env` keys, its `envKeys` and a
fixed tool-input set (T14034). CLEO-REFERENCE now says what follows: an
inherited variable declared in neither is not part of the key, so a cached
pass is reused under a different value. Inputs that change a result, such as
a database URL or an API base, must be declared in `envKeys`.
