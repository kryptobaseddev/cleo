---
id: t13101-link-initial-key
tasks: [T13101]
kind: feat
summary: cleo project link registers a new project with its encryption key in one call (onboarding B)
---

`cleo project link` now creates a new project's data key when it registers the project. The key is
wrapped by the account key at version 1, sent as `initialKey` in `POST /v1/projects`, and stored by
Cleo Nexus in the same transaction (cleo-nexus T095). The first `cleo cloud push` then finds the key
and mints nothing.

Link sends the key only when all of these hold:

- the server's E3 (`GET /v1/status`) lists the `project.initial-key` feature;
- the credential is a full-profile device;
- the project is not registered yet.

The account key is only read: link never mints it, because `cleo login` provisions it (onboarding A).

Link sends no key in these cases:

- a re-link, from this machine or another;
- a project registered without a key, which keeps the existing first-push path (`rotate: true, expectedMax: 0`);
- a server without the feature;
- a 9.24 session or a read-only device.

In these cases link sends the same registration as before. If the device cannot unlock the account
key, the project is registered without one and a warning says the first push creates it. A
registration that loses a race to a concurrently keyed project (409 `keys-exist`), or that is refused
for lacking `keys:write`, is sent once more without the key. The result reports `initialKeyVersion`.
The contract adds `InitialProjectKey`, `RegisterProjectRequest.initialKey` and
`RegisterProjectResult.initialKeyVersion` (contract v2.24), and the client E3 schema gains `features`.

Cleo Nexus stores `initialKey` only for the project owner role, meaning an organization owner or
admin (cleo-nexus #35). A team member's new project is registered without its key (201,
`initialKeyVersion: null`), and link warns that an org owner or admin must create the project key
from a signed-in session. That account's first push is refused once with 403 `project-role` and is
not retried. The `project-role` remedy now reads "an org owner or admin must create the project key
from a signed-in session, or, if the project already has a key, share it with this account". The
client never sends an empty or padding-only key wrap, which the server refuses with 400: it checks
`initialKey` and the first-key PUT before sending.
