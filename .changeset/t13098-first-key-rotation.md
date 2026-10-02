---
id: t13098-first-key-rotation
tasks: [T13098]
kind: fix
summary: The first cloud push of a project works against a real Cleo Nexus server (its key is minted as a rotation)
---

Cleo Nexus accepts a project's new key version, the first one included, only as a rotation naming the
current highest version (`rotate: true, expectedMax: 0` for version 1). `cleo cloud push` minted the
first key without those fields, so the server refused it (409 `rotation-required`), and the client
reported "the project key of <id> is not readable". Every first push of a project failed against a
real server. The fake server in the tests did not enforce the rule. The first key is now sent as a
rotation. A concurrent first push that loses (`rotation-stale` or `keys-exist`) uses the winner's key,
and any other refusal names the server's reason. Found by the two-device staging test (T12340).
