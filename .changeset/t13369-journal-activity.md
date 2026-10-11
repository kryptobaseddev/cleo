---
id: t13369-journal-activity
tasks: [T13369, T13393]
kind: feat
summary: cleo cloud activity --journal shows what each device changed and when, from this store's sync journal
---

`cleo cloud activity` lists the server's account events (snapshots, leases, enrolments). With `--journal` it lists the journal
transactions this store received instead, newest first:

- **Per transaction:**
  - the device that signed it, and whether it is this machine;
  - when it was written (from its HLC), and when this store staged and applied it;
  - its inbox status and reason;
  - its command (`actor.op`), agent and session;
  - its project;
  - its op counts per table (`I`/`U`/`D`/`K`);
  - `history`: applied as inherited history because its replica was retired by a server-confirmed retire (an unconfirmed retire marks nothing).
- **Per device:** how many matching transactions, and the newest one's time.
- **Filters:** `--device`, `--since <ISO date>` and `--project`; paging with `--limit` and `--before <nextBefore>`; `--scope project|global`.
- **Device names** come from the account's device list. `--offline` skips that lookup, so no request leaves the machine.

The listing covers the journal inbox: transactions pruned after a verified checkpoint are no longer shown.
