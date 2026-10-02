---
id: t12871-cloud-reads
tasks: [T12871]
kind: feat
summary: cleo cloud status, whoami, devices and projects [show] read Cleo Nexus with the device credential, follow every page, report truncation, and send only GET requests; the §4.0.4 error table now lives in @cleocode/contracts
---

**`cleo cloud` (contract §4.4, D6).** Five commands that read with this
machine's device credential. Every request they make is a GET. Getting the
credential can still write, as for every device-credential command (contract
§3.4, §3.5): a 9.24 session is upgraded once through E1, and unsettled logouts
are retried through E9/E10.

- `cleo cloud status [--project <id>]` (operation `cloud.status`) is the agent's
  single verification call. It returns `{ verdict, summary, local, remote,
  warnings }`. With no credential the verdict is `not-signed-in` and no request
  is made. The server's verdict is downgraded to `not-linked` when the current
  project has no `.cleo/nexus-link.json` entry or no bound replica. Offline, the
  envelope is `E_NEXUS_UNREACHABLE` with `error.details.local` and a summary
  whose remote fields are null, and the warnings collected so far. Outside a project only the device is checked.
  The replica id is read through `activeReplica(db, 'project')` on a read-only
  snapshot handle, so the command never binds a replica or writes `cleo.db`. When
  the store cannot be read, `replicaId` is null with `W_NEXUS_REPLICA_UNREADABLE`
  and the verdict is `attention`, never `not-linked` (unknown is not unbound).
  The open is skipped when the store has no `-wal` and its directory is not
  writable, so no sidecar is left behind.
  A server without `GET /v1/status` gets the same shape composed from
  `/v1/whoami` and the project reads, with a `W_NEXUS_STATUS_COMPOSED` warning.
  `--report` (presence) is not part of this change (T12905).
- `cleo cloud whoami` (`cloud.whoami`): E2.
- `cleo cloud devices [--state active|signed-out|revoked|all]`
  (`cloud.devices.list`): E5.
- `cleo cloud projects [--org <id>]` (`cloud.projects.list`): E13.
- `cleo cloud projects show [<id>]` (`cloud.projects.show`): E14, defaulting
  to the current project. When E14 cut the replica list at 50, the rest are
  read from E15.

Lists follow `nextCursor` with pages of 200, up to 25 pages, and report
`paging.truncated` (a server ceiling cut the list) and
`paging.pageLimitReached` (the client stopped while the server had more),
each also named in `warnings`.

**Error mapping (§4.0.4).** The reason-to-code table moved into
`@cleocode/contracts` (`NEXUS_UNAUTHENTICATED_ERRORS`, `NEXUS_FORBIDDEN_ERRORS`,
`NEXUS_CONFLICT_ERRORS`, `NEXUS_REVOKED_REASON_ERRORS`), and
`nexusApiErrorToAccountError` reads it. Three mappings now follow the contract:
`credential-revoked` with `revokedReason: 'signed-out'` is `E_NEXUS_NOT_SIGNED_IN`
and with `'revoked'` is `E_NEXUS_DEVICE_REVOKED` (both were
`E_NEXUS_CREDENTIAL_COMPROMISED`), `session-used` is `E_NEXUS_SESSION_EXPIRED`,
and a 409 `rotation-conflict` is `E_NEXUS_CREDENTIAL_COMPROMISED`.
