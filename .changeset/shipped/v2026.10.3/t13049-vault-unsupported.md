---
id: t13049-vault-unsupported
tasks: [T13049]
kind: fix
summary: The cloud vault names a Cleo Nexus server without key escrow instead of calling the vault empty
---

Against a Cleo Nexus server older than account key escrow (cleo-nexus T082), the escrow route does not
exist and the server answers 404 "route not found". The vault read that as "nothing escrowed yet", so
`cleo cloud pull`, `restore`, `verify` and `vault` reported `E_NEXUS_VAULT_EMPTY` ("no device has pushed
a snapshot yet"), which was wrong, and `push` failed with an unexplained "route not found" or a circular
key remedy. A missing route is now `E_NEXUS_VAULT_UNSUPPORTED`: "this Cleo Nexus server does not support
the cloud vault yet: it has no account key escrow", with the remedy to upgrade the server. A server that
supports escrow but has nothing escrowed yet still reports `E_NEXUS_VAULT_EMPTY`. Nothing is written in
either case.
