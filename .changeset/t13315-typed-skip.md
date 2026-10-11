---
id: t13315-typed-skip
tasks: [T13315]
kind: refactor
summary: "`cleo cloud sync` sorts skipped legs by a typed refusal kind instead of matching refusal message text"
---

`cleo cloud sync` used to decide whether a push or pull leg was skipped or refused by matching the refusal's message
against regexes. Rewording a refusal would silently turn a skip (`sync.push` off, no genesis yet) into a reported refusal.

- **Push results** (`PushStreamReport`) now carry `refusedKind`, which is one of:
  - `schema-missing`
  - `push-off`
  - `no-genesis`
  - `genesis-pending`
  - `store-behind`
- **Pull results** (`PullStreamReport`) now carry `refusedKind`, which is `pull-off` or `segment`.
- **Classification** is done by `classifySyncLegs`, using only these kinds. The message regexes are removed. A stream is
  `disabled` when both legs are off. The pull position is reported unless the pull leg was skipped.
