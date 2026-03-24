# Deprecation Policy

- Deprecated fields or semantics MUST be announced before removal.
- Deprecation windows SHOULD be at least 90 days or 2 minor releases.
- Implementations SHOULD emit warning metadata when deprecated fields are used.
- Removal MUST happen only on a major version boundary.

## Runtime deprecation registry

TypeScript SDK exposes a small deprecation registry and warning emitter:

- `getDeprecationRegistry()`
- `detectDeprecatedEnvelopeFields(envelope)`
- `emitDeprecationWarnings(envelope)`

Current tracked entry:

- `_meta.mvi` boolean values are deprecated; use enum values (`minimal|standard|full|custom`), with `removeBy: 2.0.0`.
