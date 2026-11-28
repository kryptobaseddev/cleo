---
id: atomic-scope-skip-test-layers
tasks: [T14662]
kind: fix
summary: "Atomic scope pairing skips a unit/ or integration/ layer directory under tests/ or test/"
---

A test under `<root>/tests/unit/<rel>/` or `<root>/tests/integration/<rel>/`
(and the `test/` equivalents) now pairs with the same stem under
`<root>/src/<rel>/` or `<root>/<rel>/`, so it no longer counts toward the
worker file limit. Flattened layouts whose source lives in another directory
still count separately, as T14636 intended.
