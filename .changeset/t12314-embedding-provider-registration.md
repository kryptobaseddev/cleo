---
id: t12314-embedding-provider-registration
tasks: [T12314]
kind: fix
summary: Memories are actually embedded, instead of waiting on a registration nobody triggers
---

Removing the unsatisfiable availability check exposed the reason embeddings still never appeared: nothing registered a provider in time. Registration was scheduled by a deferred callback in the database open path, with its failures swallowed, so a consumer asking whether embeddings were available was told no for two unrelated reasons — the provider had failed, or it had simply not been registered yet. While the availability check could never be satisfied at all, that difference was impossible to observe. With the deadlock gone it was the entire story.

Registration is now ensured by the consumer that needs it rather than raced. This costs nothing: the model download happens on the first embedding, not on registration, and registering explicitly against the released build took no measurable time before producing a real three-hundred-and-eighty-four-dimension vector. There was never a cost argument for making a consumer race a registration it could not see.

The same race sat on the write path, where an observation stored early in a process was silently never embedded because the check ran before registration. That check now happens inside the deferred work, after a provider is ensured, so a memory written at any point in a process lifetime is embedded on the same best-effort terms as before.

A provider that was never constructed and one that constructed and then failed are now reported separately, because their remedies differ: one is a missing runtime or a disabled setting, the other a failed model load. The previous wording attributed both to a failed load.

Measured on a project carrying five and a half thousand observations and no vectors at all: the backfill now reports five thousand five hundred and fifty processed with no errors, and the vector table holds one row per observation. Hybrid retrieval stops silently degrading to keyword search.

Code placed in packages/core/ for the embedding registry and its consumers per Package-Boundary Check — verified against AGENTS.md.
