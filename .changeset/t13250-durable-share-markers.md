---
id: t13250-durable-share-markers
tasks: [T13250, T13249]
kind: fix
summary: a portable bundle export and a vault push mark the project store's identity shared in the store itself; local safety bundles do not
---

The full identity refill refuses once a store's uids may have left it. Before this change, two
paths carried uids out without marking the store:
- a `cleo backup export` bundle;
- a vault push, which was marked only by `nexus-vault.json` in `CLEO_HOME`. That signal was lost
  if the project was unlinked and the vault state file was lost too.

**Now.** `exportPortableBundle` marks every project store it bundles shared
(`row_identity_synced`, sent) before it copies it, so the bundle carries the marker as well. That
means the one named project, or each registered project of a `machine` export. A vault push exports
through it. The vault's local pre-restore safety bundle passes `sharesIdentity: false` and marks
nothing. A store that holds no identity value is never touched: with row uids off, the check is
read-only and nothing opens. The marking logic is now one helper (`store/identity-share.ts`), used
by snapshot export and import as well.
