---
id: t12735-bench-named-profiles
tasks: [T12735]
kind: feat
summary: cleo decide bench resolves --profiles through the named System One profile store
---

`cleo decide bench --profiles layahost/work,jev/team` now resolves each entry
through the named profile store (`cleo decide profiles`, T12733) instead of the
interim env/stored-connection adapter, which is removed. Resolution order:

1. an exact profile id `<provider>/<name>`;
2. a bare provider (`layahost`, `jev`): that provider's active profile, else
   `<provider>/default`;
3. the environment override layer, `CLEO_DECIDE_PROFILE_<NAME>_KEY` (plus
   `_URL`, `_MODEL`, `_PROVIDER`), only for a name no stored profile holds.

A stored `default` URL and an env profile without `_URL` resolve through the
same provider preset table everyday decisions use. An unknown name fails with
`BenchProfileError`, which lists the stored profile ids with masked keys; a
stored profile with an unusable URL or key fails with
`BenchProfileInvalidError`. `createInterimProfileResolver` is replaced by
`createProfileResolver({ env?, store? })`.
