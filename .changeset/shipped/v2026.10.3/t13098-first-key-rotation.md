---
id: t13098-first-key-rotation
tasks: [T13098]
kind: fix
summary: "The first cloud push of a project works against Cleo Nexus (its key is minted as a rotation). It needs a Cleo Nexus server with cleo-nexus #33, live in production, which lets a device of the account that registered a keyless project create the project's first key. Against an older server every first push is refused, and the error wrongly says the project key exists but was not shared with this account"
---

Cleo Nexus accepts a project's new key version, the first one included, only as a rotation naming the
current highest version (`rotate: true, expectedMax: 0` for version 1). `cleo cloud push` minted the
first key without those fields, so the server refused it (409 `rotation-required`), and the client
reported "the project key of <id> is not readable". Every first push of a project failed against a
real server. The fake server in the tests did not enforce the rule. The first key is now sent as a
rotation. A concurrent first push that loses (`rotation-stale` or `keys-exist`) uses the winner's key,
and any other refusal names the server's reason. Found by the two-device staging test (T12340).

This needs cleo-nexus #33, live in production: a device credential may create version 1 of a keyless
project that its own account registered. Any other first key is refused with a remedy. A device of
another account is told to run the first push from a device of the registering account. A writer is
told to ask a project owner to share the project key, or, if the project has no key yet, to run the
first push. A server older than #33 refuses every rotation from a device as `session-required`, which
this release reports as a key that exists but was not shared with this account.
