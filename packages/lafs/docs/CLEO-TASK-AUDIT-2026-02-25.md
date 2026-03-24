# CLEO Task Audit (2026-02-25)

This audit classified every pending CLEO task as either:

- `audit-partial` (work exists, specific acceptance gaps remain)
- `audit-truly-pending` (core implementation still missing)

Also completed as `done_not_marked` based on code evidence:

- `T063` Fix migration manifest schema inconsistency
- `T095` Download and reference A2A specification documents

## Current backlog status

- Pending tasks: `37`
- Classified partial: `29`
- Classified truly pending: `8`
- Unclassified: `0`

## Truly pending (must build)

- `T055` Implement conformance check 8 (context mutation failure)
- `T059` Add transport mapping helper function
- `T060` Add transport mapping conformance check
- `T066` Add deprecation and migration tests
- `T082` Finalize adoption tier conformance (machine-readable profiles missing)
- `T085` v1.0.0-rc release and stabilization
- `T088` Prototype context ledger retrieval efficiency
- `T101` Implement streaming and async operations

## Partial tasks and missing work (condensed)

### Phase 3A/3B/3C

- `T053` Conformance epic: blocked by missing context+transport checks (`T055`, `T059`, `T060`).
- `T054` Context validation: schema/fixtures exist, runtime validator + tests incomplete.
- `T056` Fixtures exist, but fixture-backed automated tests are incomplete.
- `T061` Conformance tests pass, but not all targeted checks are implemented; no coverage artifact.
- `T062` Deprecation/migration epic: registry + warning emission + tests incomplete.
- `T064` Deprecation policy/types exist; no dedicated deprecation registry module.
- `T065` Warning field exists; no automatic deprecated-field detection/emission.
- `T067` Token/context epic mostly present; pagination-MVI/lazy-loading spec work remains (`T070`, `T071`).
- `T070` Pagination-MVI relation not fully explicit in normative text.
- `T071` Lazy-loading/task-isolation/progressive schema disclosure spec is incomplete.

### Phase 4 ecosystem/A2A

- `T072` Ecosystem epic partially complete; adoption/conformance tasks still open.
- `T076/T077/T078` Integration docs exist, but required dedicated adoption guides are missing.
- `T079` Language-independent suite incomplete (multi-validator and non-Node execution evidence missing).
- `T094` A2A epic partially complete; strict v1 alignment still missing.
- `T096` New discovery path exists, but legacy path remains dominant in tests/examples.
- `T097` Agent Card has many fields, but full v1 interface model alignment remains.
- `T098` Extension negotiation exists; extension-category semantics are incomplete.
- `T099` Lifecycle exists; refinement/reference-task semantics incomplete.
- `T100` Binding constants/mapping exist; runtime version negotiation and final naming alignment incomplete.
- `T102` Uses upstream SDK types, but full bridge runtime alignment is incomplete.
- `T103` Good test base; complete A2A compliance test suite still missing.
- `T104` Docs updated partially; full A2A v1 compliance docs set still incomplete.

### Phase 5 release

- `T080` Release epic partially complete; depends on unresolved phase-5 tasks.
- `T081` Governance process docs exist; organization/account governance acceptance still incomplete.
- `T083` Conformance validation partially complete; tier-profile-based validation still missing.
- `T084` Changelog/release docs exist; migration/release artifacts need final cleanup.
- `T086` Final release partially complete; Python publish + announcement evidence incomplete.

## Priority execution waves

Use existing labels (`wave-1` to `wave-5`) and dependencies in CLEO.

Recommended immediate focus:

1. `wave-1` critical foundations (`T055`, `T059`, `T060`, `T088`, `T094`)
2. `wave-2` A2A + deprecation/buildout (`T098`, `T099`, `T100`, `T062`)
3. `wave-3` streaming/spec completion (`T101`, `T066`, `T070`, `T071`, `T102`)
4. `wave-4` compliance/doc hardening (`T079`, `T082`, `T083`, `T103`, `T104`)
5. `wave-5` release gates (`T085`, `T086`)
