---
id: row-uid-fill-default-on
tasks: [T13305, T12341]
kind: feat
summary: "Row uids fill by default; CLEO_ROW_UID_FILL=0 is the kill switch (canary only)"
---

The open-time row-identity pass (T12341) now runs by default. Opening a
project or global `cleo.db` gives every syncing row a stable `row_uid` and
stamps the `cleo/row-identity/v2` recipe marker. **Kill switch:** set
`CLEO_ROW_UID_FILL=0` to turn the pass off. Any other value, or no value,
leaves it on. Ship this through the canary channel first.

A store with a stale recipe whose share state is not `unshared` (for example
one with pre-release uids that is linked to Nexus) is refused a full refill,
as before (T13231). The refusal is now cheap and quiet:

- The refusal is saved in the store as a local-only `row_identity_refused`
  marker, recording the share state, recipe, a digest of the share signals,
  the reasons and the time of the last warning.
- Later opens skip the pass and log nothing. A warning is logged once a day
  at most.
- The pass is re-evaluated only when the recipe or the share signals change,
  or on `cleo doctor row-identity --refill` (the dry run too), which clears
  the marker and reports `refusalCleared`.
- `cleo doctor` shows the standing refusal as a finding.

Two follow-ups from the #1952 review:

- Importing or vault-restoring a portable bundle whose project store carries
  row uids now marks the placed store as having received them. This includes
  bundles made before T13250, which carry no marker, so a later refill never
  re-derives uids the bundle shares. The import opens the placed file
  directly and never migrates it.
- When a machine export cannot mark one project (busy or restoring), it fails
  with `E_PROJECT_STORE_UNAVAILABLE` and names that project.
