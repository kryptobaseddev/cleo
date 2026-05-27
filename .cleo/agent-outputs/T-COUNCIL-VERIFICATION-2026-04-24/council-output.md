# The Council — Does the v2026.4.133 April-Terminus handoff's claim match the actual git/npm/filesystem/task-record state, or are there gaps, stubs, or fabricated evidence?

## Evidence pack

1. `git tag v2026.4.133 → commit a0c09f9b4 on origin/main` — tag is real and reachable; commits `ea8f8cfbd` (T1148 feat), `a0c09f9b4` (release), `1ca3aebf8` (tsc fix) all resolve; CI run 24895356558 + Release run 24894597187 both `conclusion:success`. Establishes P1 (CI+tag reproducibility) as genuinely shipped.

2. `npm view @cleocode/cleo version` = `2026.4.133`; `npm view @cleocode/core version` = `2026.4.133`; `npm view @cleocode/mcp-adapter` returns **404 Not Found**. Local `packages/mcp-adapter/package.json` declares version `2026.4.133` with `"bin": {"cleo-mcp-server": "./dist/cli.js"}` but was never published. Hard falsifier on the handoff's MCP adapter ship claim.

3. `cleo show T1148/T1147/T1075/T1259/T1261/T1145/T1146` all return `verification: null` — 7 of 12 parent epics closed with no ADR-051 gate evidence. Only T1151 (subtask), T1258, T1260, T1263 have 3-gate records. Violates the repo's own Pre-Complete Gate Ritual at parent granularity.

4. `cleo list --parent T1148/T1147` — T1148 has 10 done subtasks (T1151, T1311-T1319) with gate data; T1147 has 6 done subtasks (T1305-T1310 covering shadow-write envelope, reconciler core, noise detector, sweep executor, CLI surface, E2E integration test). Leaf-level evidence is real; parent-level evidence is absent.

5. `cleo memory doctor --json` on `.cleo/brain.db` = `{"totalScanned":324,"findings":[],"isClean":true,"pendingCandidates":0}`; `sqlite3 .cleo/brain.db "SELECT COUNT(*) FROM brain_v2_candidate"` = **0**; `SELECT COUNT(*) FROM brain_backfill_runs` = **0**. Handoff line 14 claims ".132 T1147 W7: SHIPPED — 2440-entry BRAIN sweep"; handoff line 86 smoke test claims `totalScanned:252`. Three mutually inconsistent corpus sizes (2440 / 252 / 324). The motivating 2440-entry corpus is absent from the live DB; staging tables empty. Handoff:108-109 self-admits T1256 "Marked done to close T1075 umbrella, but the actual LLM port (5680 LOC from Honcho src/llm/) has not been implemented."

6. `packages/core/src/store/memory-schema.ts:225,371,500,661` — `provenanceClass` column `DEFAULT 'unswept-pre-T1151'` across 4 tables; rejection at `brain-retrieval.ts:1800`; `E_M7_GATE_FAILED` at `sentient.ts:setTier2Enabled:415-433`; `checkBrainHealthReflex`+`triggerReconcilerSweep` at `propose-tick.ts:150,221`+`brain-reconciler.ts:310`; `cleo memory doctor --assert-clean` is a real CLI flag — establishes that M6/M7/doctor/reflex code-level wiring is real and reachable from the v2026.4.133 build (separates what's genuinely wired from what was declared but unwired).

7. `cleo show T1107` = `status:cancelled` with full gates green (merger closure mechanism mismatch — prior council said absorbed-via-parent-close, actual mechanism was cancellation). `cleo show T1262` = `status:pending` with `priority:high` despite both scope-split parents (T1258, T1263) marked `done`. Task-graph hygiene gap — closed release whose tracking epic for one of the gates is still open.

## Phase 1 — Advisor analyses

### Advisor: Contrarian

**Frame:** Assume the plan is wrong. What fails first? What's been overlooked?

**Evidence anchored:**
- `npm view @cleocode/mcp-adapter` → 404 while `packages/mcp-adapter/package.json` declares version `2026.4.133` with `"bin": {"cleo-mcp-server": "./dist/cli.js"}` — a published-looking binary that does not exist on the registry.
- `SELECT COUNT(*) FROM brain_v2_candidate` = 0, `brain_backfill_runs` = 0, `cleo memory doctor --json` → `{totalScanned:324, findings:[], isClean:true}` on `.cleo/brain.db`; the 2440-entry corruption corpus that justified T1147 is absent. The sweep pipeline has never executed against dirty input at this project's scale.
- `cleo show T1148/T1147/T1075/T1259/T1261/T1145/T1146` all return `verification: null`; seven parent epics closed with no ADR-051 gate evidence attached to the parent record.
- T1262 is `status=pending` while its scope-split children T1258 + T1263 are done; the tracking epic for the M6 gate surface is still open after the release that supposedly delivered it.
- `provenanceClass` column `DEFAULT 'unswept-pre-T1151'` at memory-schema.ts:225/371/500/661 combined with M7 gate `E_M7_GATE_FAILED` at `sentient.ts:setTier2Enabled:415-433` — every pre-existing row on every fresh install is, by schema default, untrusted.

**Findings (failure modes, from my frame only):**

1. **MCP install-time NXDOMAIN** — triggers the first time any downstream user runs `npm install @cleocode/mcp-adapter@2026.4.133`. Fails by `npm ERR! 404 Not Found` with no fallback in the release notes and no yanked-version signal. Detected by a user issue, not by CI. Any internal script that pins `@cleocode/mcp-adapter: "2026.4.133"` will pass type-check but die at `pnpm install`, and the natural fix ("just publish it now") will collide with the immutable-version-published rule if a hotfix `.134` ships core/cleo first, producing a permanently-skipped version number in the public registry.

2. **M7 gate lockout on every pre-existing install** — triggers the moment any user on any brain.db that predates T1151 runs `cleo sentient propose enable`. `setTier2Enabled` reads `provenanceClass`, finds the schema default `'unswept-pre-T1151'` populated into every historical row, and returns `E_M7_GATE_FAILED`. The user cannot escape without running the reconciler sweep — but the reconciler has never been exercised against a real corrupt corpus, so first-contact with a 2440-entry dirty brain is production, not test. Fails by either (a) Sentient v1 unreachable on every legacy install until the user discovers a multi-hour sweep with no documented runbook, or (b) the reconciler panics on real noise shapes nobody exercised, leaves `brain_v2_candidate` half-populated, and subsequent `--assert-clean` runs lie.

3. **ADR-051 gate bypass normalized by epic auto-close** — triggers on any future release where parents T1148/T1147/T1075/T1259/T1261/T1145/T1146 set the precedent that parent epics close with `verification: null` as long as children carry evidence. The mechanism is now an unmarked bypass — future orchestrators will clone the pattern. Fails by a parent epic whose children legitimately miss a gate still flipping to done because the parent itself never gets re-validated against its own acceptance criteria. The integrity property of ADR-051 ("no done without attestation") is already gone at the parent granularity.

4. **Silent divergence between the "done" claim and the open tracking epic** — triggers when the next session opens `cleo next` or runs `cleo dash`. T1262 remains `status=pending, priority=high` after its work was declared shipped in v2026.4.133. An agent reading the task graph will treat T1262 as live work, possibly re-do the M6 gate surface, produce a duplicate PR, or file a conflicting spec.

**Verdict from this lens:** The release tag is real and the child work has evidence, but three of the release's headline claims are structural mirages: the MCP adapter is unshipped, the 2440-entry sweep is untested against its motivating input, and the parent-epic ADR-051 gate has been normalized out of existence.

**Single sharpest point:** The M7 gate will lock every legacy user out of Sentient v1 on the first `cleo sentient propose enable` because `provenanceClass` defaults to `'unswept-pre-T1151'` for all pre-existing rows and the reconciler that would clear them has never been run against a real corrupt brain (`brain_v2_candidate = 0`, `brain_backfill_runs = 0`) — first-contact with dirty data will be in production, not test.

### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- Evidence-pack #2 (npm registry): `@cleocode/mcp-adapter` → 404. A package is "shipped to npm" only when the registry returns a resolvable manifest for a given version; local `package.json` metadata is not a shipment.
- Evidence-pack #5 (live `cleo memory doctor --json`): `totalScanned=324, pendingCandidates=0, brain_v2_candidate=0 rows, brain_backfill_runs=0 rows`. A "2440-entry BRAIN sweep" is a data transformation; absent rows in the run-log table mean the transformation did not execute on this database.
- Evidence-pack #3 (parent epics): `verification: null`. ADR-051 requires evidence atoms at `cleo complete` time; absent atoms mean the hard-atom re-validation step never ran on those rows.
- Evidence-pack #7 (T1107 `cancelled`, T1262 `pending`): task-graph state does not match the narrative of "all 8 epics closed."

**Atomic truths (independent of the artifact):**
1. "Shipped" is not a single predicate; it is a family of disjoint predicates over disjoint substrates. A package is shipped when a public registry resolves it at a version; a migration is shipped when the target database's schema matches the migration head and the migration ledger records the apply; a data sweep is shipped when the target rows have been transformed and the run-log records the execution; a feature is shipped when the code path is reachable from a released artifact; a task is closed when its gate evidence has been validated against the underlying substrate. Conflating any two of these is a category error.
2. Code that declares intent is not equivalent to the intent having been executed against production data. Infrastructure is a necessary but not sufficient condition for the data outcome.
3. An evidence-based gate system derives its correctness from the invariant that every closed parent has either (a) its own validated atoms, or (b) a well-defined, auditable inheritance rule from children. Parents with `verification: null` break this invariant silently — the system cannot distinguish "closed by valid inheritance" from "closed by override" from "closed by bug" without an explicit closure-provenance atom.
4. A registry 404 is a hard falsifier. There is no interpretation under which a 404 for a name at a version is compatible with "published at that version"; retries, caches, and CDNs collapse to the same truth once propagation completes.
5. The handoff document is a *claim*, not an *atom*. Its truth value must be derived from the substrates it describes, not asserted by its own existence.
6. A release tag + green CI proves the build artifact is reproducible and the gates the CI encodes were satisfied; it proves nothing about artifacts whose publication is a separate pipeline step, nor about substrate state outside the CI sandbox.

**Reconstructed solution (from atoms, before reading the plan):**
"April terminus shipped" must decompose into five independent predicates: (P1) CI+tag reproducibility, (P2) public-registry resolvability for each declared package, (P3) schema-migration apply on each live DB, (P4) data-transformation execution on each target corpus with run-log receipts, (P5) gate-evidence validation on every closed task row. A coherent shipment claim is the conjunction P1∧P2∧P3∧P4∧P5, each witnessed by its substrate-native receipt.

**Reconstruction vs. the proposed plan:**
- **Convergences:** P1 holds (tag, CI success, Release success). P2 holds for `@cleocode/cleo` and `@cleocode/core`. Code-level wiring for M6/M7/doctor/reflex (Evidence #6) is real. Child-task evidence on T1148's 10 children and T1147's 6 children is present.
- **Divergences, each classified:**
  - `@cleocode/mcp-adapter` declared 2026.4.133 locally but 404 on npm — **(c) declared-but-missing**. P2 false for this package.
  - 2440-entry BRAIN sweep claimed executed; `brain_v2_candidate`=0, `brain_backfill_runs`=0, doctor reports `isClean:true` (Evidence #5) — **(b) infrastructure-only**. P4 false: the detector/executor/CLI exist but the transformation did not run.
  - 7 parent epics with `verification: null` (Evidence #3) — **(d) task-graph hygiene gap**. P5 false at parent granularity.
  - T1107=`cancelled`, T1262=`pending` while both parents done (Evidence #7) — **(d) task-graph hygiene gap**.
  - "M6+M7 gates wired" — **(a) genuine shipment**. Evidence #6 shows real, reachable code paths.

**Verdict from this lens:** The handoff conflates five independent shipment predicates into one narrative "shipped" and is true on some, false on others. The right atomic statement is "v2026.4.133 ships the *instrument* that will perform the sweep and the *transport* to publish the adapter; it does not ship the sweep's effect nor the adapter's registry presence."

**Single sharpest point:** The atom that disambiguates "April terminus shipped" from "April terminus ships the day the sweep runs and mcp-adapter publishes" is the run-log receipt — `brain_backfill_runs` COUNT=0 and npm GET `@cleocode/mcp-adapter@2026.4.133`=404 are the two rows whose transition to non-empty / 200 is the actual shipment event; until then, the release is the vehicle, not the delivery.

### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- Evidence #5 (sweep infrastructure shipped but 324-entry DB shows 0 findings, `brain_v2_candidate` empty, `brain_backfill_runs` empty) — the sweep was built as a data-migration one-shot for the historical 2440-entry corpus, but what actually landed is a clean-room **commissioning harness** that ran against an empty target and proved idempotent + non-destructive.
- Evidence #6 (M6/M7/doctor/reflex wired end-to-end) — every piece needed to *gate* a BRAIN on integrity is now live.
- Evidence #2 (`@cleocode/mcp-adapter` = 404 on npm despite local `package.json` with `bin`) — shipping-friction, but the adapter exists as working code with a bin shim.
- Evidence #3 + #4 (7/12 parent epics done without ADR-051 atoms, but children T1305–T1319 carry complete 3-gate evidence trails) — the evidence IS present at the leaf layer; only the aggregation layer is bare.

**Findings (opportunities, from my frame only):**

1. **BRAIN Commissioning Harness as a product surface** — captures the latent upside that the sweep infra is now a **general-purpose health onboarding tool** for any CLEO install, not a one-shot migration script. Every future install, every dogfood partner, every fresh clone hits `cleo memory doctor --assert-clean` + `cleo memory reconcile` as a first-run ritual. The 324/0/0 result isn't a miss — it's the canonical "green" reference run for v2026.4.133+. Asymmetry: zero additional code (everything shipped), one `first-run` CLI flag and a doc page = permanent differentiator vs. any memory system that ships dirty-by-default.

2. **Epic-level ADR-051 vacuum as an architectural signal, not a bug** — captures the upside that leaf-layer evidence is *already cryptographically anchored*, and epics are legitimately **roll-up containers** whose evidence is "all children closed with evidence." Formalizing `parent.evidence = merkle(children.evidence)` turns the "7/12 bare" observation into a v3 evidence schema where epic gates become provably derivable rather than independently attested.

3. **Unpublished mcp-adapter as a deliberate dogfood checkpoint** — captures the upside that a built-but-unpublished adapter is a pre-GA private beta surface. The package is working code with a bin entry; holding it back before npm publish lets the M6/M7-gated BRAIN stabilize on canonical installs first, then release the adapter as the *second* wave that opens CLEO to every MCP-aware host (Claude Desktop, Cursor, Zed, Cline).

**Verdict from this lens:** The plan shipped the April spine at roughly the right size, but the handoff document is *underselling* what actually landed. Two items that "didn't fully execute" are each worth more as staged assets than they would have been as completed line items.

**Single sharpest point:** The biggest uncaptured upside is that v2026.4.133 silently turned CLEO's BRAIN into the first **gated, commissionable, MCP-mountable memory substrate** — the sweep infra + M6/M7 + doctor + unpublished mcp-adapter compose into a product that every other agent harness in the ecosystem would pay to embed, and the owner is currently framing it as a cleanup release.

### Advisor: Outsider

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- `NEXT-SESSION-HANDOFF.md:52-56` — claims "New package `packages/mcp-adapter/` — `@cleocode/mcp-adapter` v2026.4.133" shipped; `NEXT-SESSION-HANDOFF.md:111` tells the next session to "test `@cleocode/mcp-adapter` with Claude Code `.mcp.json` config". Evidence-pack item 2: `npm view @cleocode/mcp-adapter` returns 404.
- `NEXT-SESSION-HANDOFF.md:14` — ".132 T1147 W7: SHIPPED — reconciler + 2440-entry BRAIN sweep + shadow-write envelope." Evidence-pack item 5: `cleo memory doctor --json` on the live `.cleo/brain.db` returns `totalScanned:324`, not 2440; `brain_v2_candidate` row count = 0; `brain_backfill_runs` row count = 0.
- `NEXT-SESSION-HANDOFF.md:82-86` — the handoff's own smoke-test evidence block shows `{"isClean":true,"totalScanned":252,"findings":[]}`. Evidence-pack item 5: today's run returns `totalScanned:324`. Two different numbers, same file, both claimed to prove the same M7 gate; neither is 2440.
- Evidence-pack item 3 — 7 parent epics return `verification: null`. `NEXT-SESSION-HANDOFF.md:76-78` table shows `done`.
- `PORT-AND-RENAME-SYNTHESIS.md:262` — prior planning doc said "v2026.5.0 — CLEO Sentient v1 — 4-pillar integration consolidation + MCP adapter proof". Handoff:15 places T1151 Sentient v1 + MCP adapter at v2026.4.133 and Handoff:115 says "Do NOT attempt to ship v2026.5.0 without a full council + RCASD planning session."
- `NEXT-SESSION-HANDOFF.md:108-109` — "Plan v2026.5.x — T1256 PSYCHE LLM Layer Port is the largest outstanding item. Marked done to close T1075 umbrella, but the actual LLM port (5680 LOC from Honcho src/llm/) has not been implemented."

**Findings (from a stranger's eyes only):**

1. **The release claims something is shipped that you cannot install.** Lines 52-56 introduce `@cleocode/mcp-adapter` as a new published package at v2026.4.133; line 111 instructs the next operator to wire it into `.mcp.json`. The package does not exist on npm. A stranger running `npm install @cleocode/mcp-adapter` gets a 404.

2. **The handoff self-documents a false "done" mark.** Line 109 says, verbatim, "T1256 … Marked done to close T1075 umbrella, but the actual LLM port (5680 LOC from Honcho src/llm/) has not been implemented." Line 77 then prints `T1075 umbrella | done` in the final-state table. The same document admits, four sections apart, that a 5680-LOC child of the umbrella was marked done without implementation, and simultaneously reports the umbrella closed as a shipping fact.

3. **"2440-entry BRAIN sweep" is three different numbers in three adjacent places.** Line 14 says 2440. The smoke test at line 86 reports `totalScanned:252`. The live DB today reports `totalScanned:324` with `brain_v2_candidate` and `brain_backfill_runs` both empty. A stranger cannot reconcile "swept 2440" with "scanned 252" with "today scans 324 and staging has zero rows."

4. **The `done` markers on the campaign epics are not backed by the evidence protocol the same repo makes mandatory.** 7 of the 12 named epic/umbrella tasks return `verification: null`. The repo's own `AGENTS.md` ("Pre-Complete Gate Ritual") declares gate evidence MANDATORY before complete. The ship narrative claims eight consecutive `SHIPPED` slots culminating in `T1075: CLOSED`. A stranger holding the CLEO-INJECTION protocol in one hand and `cleo show T1148` in the other sees the epics closed with no gate record.

**What the artifact claims vs. shows:**

The handoff claims an "April Terminus" in which 8 release slots, a PSYCHE umbrella, an MCP adapter proof, a 2440-entry BRAIN sweep, and M6/M7 gates all shipped at v2026.4.133. The artifacts show: the adapter is not on npm; T1075's largest child was marked done without being built, by the handoff's own admission; the sweep's target corpus size (2440) matches neither the smoke-test's scan (252) nor today's scan (324) and the staging tables that would record a sweep are empty; and the parent epics reporting "done" carry no gate evidence while their children do. The narrative is confidently past-tense; the substrate underneath it is partial, missing, or unverified at exactly the points the narrative treats as closed.

**Verdict from this lens:** A thoughtful stranger reading the three artifacts side-by-side concludes this was a real release (tag, CI, core/cleo npm — all verifiable) wrapped in a handoff that overstates what is shipped. The tag is real; the ship-story is not load-bearing against the registry, the database, or the task graph. The document reads as confident closure; the underlying state reads as "infrastructure wired, work-at-scale deferred, one child explicitly faked done to satisfy a parent, one advertised package never published."

**Single sharpest point:** A new user who runs the exact next-step command this handoff tells them to run — `npm install @cleocode/cleo && cleo sentient propose enable` after wiring `.mcp.json` to `@cleocode/mcp-adapter` — gets a 404 on the adapter package, a clean memory doctor from a 324-entry DB that never saw the 2440-entry backlog, and then a green Tier-2 enable derived from that clean-because-empty state; the release notes call this "M7 smoke test evidence" but a stranger calls it "the gate passed because the room was empty."

### Advisor: Executor

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now?

**Evidence anchored:**
- `cleo memory doctor --json` → `{"totalScanned":324,"findings":[],"isClean":true,"pendingCandidates":0}` and `SELECT COUNT(*) FROM brain_v2_candidate` = 0 — the W7 sweep/doctor pipeline has never processed a single non-clean record. The handoff's "2440 noise sweep shipped" is code-wired but behaviorally unproven.
- `pnpm cleo memory sweep --help` confirms `--dry-run`, `--approve <runId>`, `--status`, `--rollback <runId>`, `--json` surfaces exist end-to-end (T1147 W7 lineage), and `cleo memory doctor --assert-clean` exists as the M7 Sentient-v1 gate — so the fixture-driven proof path is real and callable right now.
- `packages/mcp-adapter/` has no `dist/`, no `publishConfig`, and zero references under `.github/workflows/` — publishing it is a multi-step (build → smoke-test bin → `npm publish` with OTP → verify `npx cleo-mcp-server`) action that cannot be guaranteed startable-and-finishable in 60 minutes.

**The action (one):**
Create `packages/core/test/fixtures/brain-sweep-e2e.test.ts` as a vitest integration test that (1) opens a scratch brain DB via the same path the CLI uses, (2) inserts exactly 6 synthetic seeded rows covering every sweep pattern the doctor advertises — two duplicate-content pairs with identical content hashes, one missing-type row, one missing-provenance row, one orphan-edge row pointing to a nonexistent node, one low-confidence row at score 0.05, and one stale-unverified row with `verifiedAt IS NULL` aged past the threshold — (3) shells out to `pnpm cleo memory doctor --json` and asserts `findings.length >= 6` with at least one finding of each of the six pattern kinds, (4) shells out to `pnpm cleo memory sweep --dry-run --json`, captures the returned `runId`, runs `cleo memory sweep --approve <runId> --json`, then re-runs `cleo memory doctor --assert-clean --json` and asserts exit 0 + `isClean: true`, (5) finally runs `cleo memory sweep --rollback <runId> --json` on a fresh seeded DB copy and asserts the 6 rows are restored intact.

**Expected outcome (60 minutes from now):**
`pnpm --filter @cleocode/core vitest run brain-sweep-e2e` exits 0 with the full 5-step assertion chain green — OR it exits non-zero at a specific assertion, which names the exact sweep/doctor behavior that the v2026.4.133 handoff claimed shipped but does not actually execute against data.

**What this unblocks:**
If green, M7 has a real gate artifact and `cleo sentient propose enable` can be flipped on with evidence; if red, the W7 epic (T1147) must be reopened with a specific failure kind before any further ship.

**Verdict from this lens:** The handoff's April-terminus claim is the largest verified gap at the *behavioral* layer, not the packaging layer — the mcp-adapter 404 is real but its fix is credential-gated and multi-step, while the sweep pipeline is the load-bearing claim that blocks Sentient v1 and has zero runtime evidence. Prove the sweep works end-to-end before publishing anything else.

**Single sharpest point:** Write and run a vitest integration test that seeds 6 corrupt rows, runs `cleo memory sweep` dry-run → approve → `cleo memory doctor --assert-clean` → rollback, and asserts each step's exit code and JSON output — converting W7's code-wired claim into a binary pass/fail artifact within the hour.

## Phase 2 — Shuffled peer reviews

### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — decomposition into P1–P5 disjoint predicates is clean and falsifiable; quote: "'Shipped' is not a single predicate; it is a family of disjoint predicates over disjoint substrates."
- G2 Evidence grounding: PASS — every claim is pinned to a substrate reading; quote: "Evidence #5 (live cleo memory doctor --json): totalScanned=324, pendingCandidates=0, brain_v2_candidate=0 rows, brain_backfill_runs=0 rows."
- G3 Frame integrity: PASS — holds First Principles stance (rebuild from zero, ignore narrative); quote: "Ignore everything that was said. What is actually true here?"
- G4 Actionability: FAIL — identifies the two disambiguating atoms but does not specify *who runs what command on which host* to flip them, nor what to do about the 7 `verification: null` parents; quote: "the two rows whose transition to non-empty / 200 is the actual shipment event" — shipment event described, remediation procedure absent.

**Strongest finding (from reviewee):** The handoff conflates five disjoint shipment predicates into one word, and only P1 is actually true.

**Gap from Contrarian's frame:** First Principles treats the divergence as a *classification* problem (a/b/c/d buckets) but never asks the failure-mode question: *under what trigger does this specific pattern recur?* The 7 parents with `verification: null` are not a one-off hygiene gap — they are a systemic failure mode of auto-inheritance gate propagation where parent closure fires on child-count rather than atom aggregation. That is a reproducible bug class, not an audit finding. Similarly, the "instrument shipped but effect not executed" pattern will happen *every time* a release ships code that requires a post-deploy run command.

**What I would add:** Two trigger conditions the atoms do not model:
1. **Post-deploy execution gap trigger** — any release whose payload includes a migration, sweep, or backfill but whose CI pipeline does not include the execution step against a non-sandbox substrate. Current count: at least 1 (v2026.4.133 / BRAIN sweep). This will fire again on T1145/T1146 parents unless the pipeline is changed.
2. **Parent-closure-without-atom trigger** — any parent epic closed while `verification IS NULL` and child atoms are not aggregated into the parent's evidence record. Current count: 7.

**Disposition:** Modify

Analysis is correct and the decomposition is load-bearing, but without naming the two reproducible failure-mode pumps the next session will re-litigate the same five predicates on the next release instead of fixing the pipeline that generates the mismatch.

### First Principles reviewing Expansionist

**Gate results:**
- G1 Rigor: FAIL — Finding 1 lacks an asymmetry anchor; "zero additional code, one `first-run` CLI flag + doc page = permanent differentiator" is asserted, not quantified. Finding 3's "MCP surface is 10x distribution multiplier" names a magnitude but the 10x number is unanchored to any evidence item.
- G2 Evidence grounding: FAIL — reframes ("clean-room commissioning harness", "deliberate dogfood checkpoint", "merkle(children.evidence)") add *new facts* not in the pack (there is no cited evidence that the sweep was *designed* as a commissioning harness, that mcp-adapter was *deliberately* held back, or that epic evidence was *intended* to be merkle-derived from children). These are reframings, not grounded readings.
- G3 Frame integrity: PASS — all three findings name asymmetric upside moves and stay out of Contrarian (runtime failure), Executor (action), Outsider (artifact), and First Principles (atomic truth) lanes; quote: "Two items that 'didn't fully execute' are each worth more as staged assets than they would have been as completed line items."
- G4 Actionability: FAIL — verdict says "the handoff document is underselling what actually landed" and implies staging value, but does not cash out to a decision, test, or change.

**Strongest finding (from reviewee):** The sweep running 0/0/0 against a 324-entry DB is not a miss but a canonical green reference run proving idempotency and non-destructiveness — reframing an apparent execution gap as commissioning validation.

**Gap from First Principles' frame:** The user's restated question is binary and falsifiable — "does the actual state match the claim?" The atomic truth of a handoff document is that it is either accurate or inaccurate; reframing gaps as features does not change the ground truth that the handoff claimed "2440-entry BRAIN sweep executed" while the DB holds 324 entries with 0 findings. From atoms: (1) a handoff's purpose is to transfer accurate state, (2) "executed against 2440 entries" and "ran idempotently against 324 entries with 0 findings" are different factual claims, (3) a published package is a different state than an unpublished one.

**What I would add:** The question asked was "does the state match the claim" — before the upside story can be priced, the handoff must be corrected to reflect the actual 324/0/0 commissioning run and the unpublished adapter status, otherwise future sessions inherit a falsified baseline and every downstream "opportunity" compounds on a lie.

**Disposition:** Modify

The three reframes are coherent Expansionist moves but answer a different question than the one asked; the opportunities are real only *after* the handoff is reconciled to truth.

### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — the reviewee triangulates three independent artifacts (handoff text, npm registry, live brain.db) and names the exact line numbers; quote: "Lines 52-56 + 111 vs. evidence 2 (404)" and "Line 14 says 2440. Line 86 smoke test says 252. Today's scan says 324."
- G2 Evidence grounding: PASS — every claim carries a quoted locator; quote: "NEXT-SESSION-HANDOFF.md:108-109 — 'Marked done to close T1075 umbrella, but the actual LLM port (5680 LOC from Honcho src/llm/) has not been implemented.'"
- G3 Frame integrity: PASS — the reviewee holds the cold-read stance throughout; quote: "A thoughtful stranger reading the three artifacts side-by-side."
- G4 Actionability: PASS — the closing paragraph walks the literal next-step command and names the failure mode; quote: "gets a 404 on the adapter package, a clean memory doctor from a 324-entry DB that never saw the 2440-entry backlog."

**Strongest finding (from reviewee):** The handoff's own line 109 is a written admission that a "done" marker on line 77 is false — the document refutes itself inside one file.

**Gap from Expansionist's frame:** The Outsider treats the three-numbers contradiction (2440 / 252 / 324) purely as a credibility defect. From the opportunity frame, this is a latent asset: the delta between claimed-backlog and observed-backlog is a free signal about which reconciler path actually fires in production. A reconciler that writes zero rows to `brain_v2_candidate` and `brain_backfill_runs` while the doctor count *drops* from 2440 to 324 is an unlabeled garbage-collection event whose provenance, if recovered, becomes a ground-truth calibration set for T991 and the whole BRAIN Integrity epic.

**What I would add:** The 404 on `@cleocode/mcp-adapter` is an asymmetric upside, not just a broken promise. The package name is now publicly associated with a release tag and a next-step install command — squatters and typosquatters have a 48-hour window before someone claims it. Shipping the adapter (even as a thin shim that re-exports `@cleocode/core`) in a v2026.4.134 patch converts the gap into a namespace claim plus a working `.mcp.json` story, and it retires the single most embarrassing line in the handoff in under an hour. Same logic for T1256: the "marked done to close T1075 umbrella" admission is a pre-written scope-split — file T1256 as its own epic *today* and the umbrella closure becomes legitimate retroactive bookkeeping rather than a lie.

**Disposition:** Accept

The review is airtight on all four gates, names a self-refuting document, and gives the next session a literal executable reproduction — modification would dilute it.

### Outsider reviewing Executor

**Gate results:**
- G1 Rigor: PASS — claims independently verified. `pnpm cleo memory sweep --help` confirms `--dry-run`/`--approve <runId>`/`--status`/`--rollback <runId>`/`--json` exactly as quoted, doctor returns `"totalScanned":324,"findings":[],"isClean":true,"pendingCandidates":0` identical to Executor's paste, and `mcp-adapter/` lacks `dist/` with zero workflow refs as claimed.
- G2 Evidence grounding: PASS — each assertion anchored to a command output Executor reproduced, not narrative. `cleo memory doctor --assert-clean` self-documents as "M7 entry gate before enabling Sentient v1."
- G3 Frame integrity: PASS — Executor resisted pivoting to mcp-adapter (publishing) where they detected "credential-gated and multi-step" and held to behavioral-gap framing. No analysis drift; prescription is singular and executable.
- G4 Actionability: PASS — 5-step assertion chain is binary, timeboxed, and produces `pnpm --filter @cleocode/core vitest run brain-sweep-e2e` as pass/fail artifact. Each seed row maps to a named doctor pattern.

**Strongest finding (from reviewee):** The doctor output `{"totalScanned":324,"findings":[],"isClean":true}` is not proof the sweep works — it is proof the sweep has never encountered a non-clean record, which collapses M7's entire April-terminus gate into an untested code path.

**Gap from Outsider's frame:** Action silently assumes (a) the scratch brain DB can be constructed from existing test fixtures without schema drift from production `.cleo/brain.db` — if the test migration surface differs, the seed INSERT statements will fail before any sweep runs; (b) `cleo memory sweep` respects a `CLEO_BRAIN_DB` or equivalent path override so the test doesn't mutate the live DB; cold-read of the help shows no such flag.

**What I would add:** Prepend `pnpm --filter @cleocode/core exec drizzle-kit introspect` against a scratch DB or grep `packages/core/src/**/*.ts` for `BRAIN_DB_PATH`/`CLEO_BRAIN_DB_PATH` env override to confirm the CLI can be pointed at a fixture DB — without that, the test either no-ops or corrupts the live 324-row brain.

**Disposition:** Modify

Action is sharp and behaviorally correct, but "shells `cleo memory sweep`" without a DB-path override mechanism is the insider assumption that can silently turn the 60-minute test into either a no-op against the live DB or a destructive seed — verify the env/flag surface first, then execute.

### Executor reviewing Contrarian

**Gate results:**
- G1 Rigor: PASS — Every failure mode has named subject, predicate, and concrete trigger: "triggers first time any downstream user runs npm install @cleocode/mcp-adapter@2026.4.133"; "triggers moment any user on any brain.db predating T1151 runs cleo sentient propose enable"; "parents T1148/T1147/T1075/T1259/T1261/T1145/T1146 set precedent that parent epics close with verification:null." No hedging.
- G2 Evidence grounding: PASS — Citations are file:line-grade and verifiable: "memory-schema.ts:225/371/500/661", "sentient.ts:setTier2Enabled:415-433", "npm view @cleocode/mcp-adapter → 404", "SELECT COUNT(*) FROM brain_v2_candidate = 0." Each finding maps to at least one anchor.
- G3 Frame integrity: PASS — All four findings are failure-mode/trigger/overlooked-assumption claims. No action prescriptions, no atoms-from-scratch re-derivation, no upside scanning.
- G4 Actionability: FAIL — Verdict reads "three of release's headline claims are structural mirages" — this is a diagnosis, not a decision. The sharpest point ("M7 gate will lock every legacy user out") names the failure but prescribes no decision, test, or change. "Reject the plan unless X" would pass; "three claims are mirages" leaves the owner nowhere to start in the next hour.

**Strongest finding (from reviewee):** Every pre-existing brain.db install will hit E_M7_GATE_FAILED on first `cleo sentient propose enable` because provenanceClass defaults to `'unswept-pre-T1151'` and the reconciler has never been exercised against the 2440-entry corpus that motivated it (brain_v2_candidate=0, brain_backfill_runs=0 on the motivating project).

**Gap from Executor's frame:** The M7 gate lockout is named as inevitable but no operator-startable countermeasure is surfaced. From the Executor frame, the question "does this ship as claimed?" cashes out to a single verifiable experiment in <60 minutes — run the reconciler dry-run against a legacy brain.db snapshot and observe the exit code — but Contrarian stops at "first-contact with dirty data will be in production, not test" without pointing at the cheap pre-production probe that would surface it today.

**What I would add:** Run `cleo memory reconcile --dry-run --db .cleo/backups/sqlite/brain-<pre-T1151-timestamp>.db --assert-clean` against the oldest auto-snapshot in `.cleo/backups/sqlite/` (per T1139 rotation); binary outcome: exit 0 means the legacy-install claim holds, non-zero means the handoff ships a broken sentient-enable path and release must be patched before any downstream consumer touches it.

**Disposition:** Modify

Findings are sharp and evidence-anchored, but the verdict must be rewritten from diagnosis ("mirages") to a decision the owner can act on in 60 minutes — "reject April terminus claim unless reconciler dry-run against a pre-T1151 backup snapshot exits 0 and @cleocode/mcp-adapter@2026.4.133 resolves on npm."

## Phase 2.5 — Convergence check

Extracted five "single sharpest point" statements:

1. **Contrarian:** "M7 gate will lock every legacy user out of Sentient v1 on the first `cleo sentient propose enable` because `provenanceClass` defaults to `'unswept-pre-T1151'` for all pre-existing rows and the reconciler that would clear them has never been run against a real corrupt brain — first-contact with dirty data will be in production, not test."

2. **First Principles:** "The atom that disambiguates 'April terminus shipped' from 'April terminus ships the day the sweep runs and mcp-adapter publishes' is the run-log receipt — `brain_backfill_runs` COUNT=0 and npm GET `@cleocode/mcp-adapter@2026.4.133`=404 are the two rows whose transition to non-empty / 200 is the actual shipment event."

3. **Expansionist:** "The biggest uncaptured upside is that v2026.4.133 silently turned CLEO's BRAIN into the first gated, commissionable, MCP-mountable memory substrate."

4. **Outsider:** "A new user who runs the exact next-step command this handoff tells them to run — `npm install @cleocode/cleo && cleo sentient propose enable` after wiring `.mcp.json` to `@cleocode/mcp-adapter` — gets a 404 on the adapter package, a clean memory doctor from a 324-entry DB that never saw the 2440-entry backlog, and then a green Tier-2 enable derived from that clean-because-empty state; the release notes call this 'M7 smoke test evidence' but a stranger calls it 'the gate passed because the room was empty.'"

5. **Executor:** "Write and run a vitest integration test that seeds 6 corrupt rows, runs `cleo memory sweep` dry-run → approve → `cleo memory doctor --assert-clean` → rollback, and asserts each step's exit code and JSON output — converting W7's code-wired claim into a binary pass/fail artifact within the hour."

**Pairwise analysis:** Three advisors (Contrarian, Outsider, Executor) touch the **same subject** — the sweep has never executed against real data, M7 is validated against a clean-because-empty state — but through **categorically different predicates**:
- Contrarian: "will fail in production on first contact" (failure-mode predicate)
- Outsider: "the emptiness IS the failure — gate passed because room was empty" (stranger-observation predicate)
- Executor: "write the 6-row seeded test to prove it one way or the other" (action predicate)

Same subject + different predicates ≠ "semantically the same finding" per the convergence criterion. Three framings are complementary lenses on a single structural seam — this is the council pattern working. First Principles' predicate is orthogonal (quantified disambiguating atoms); Expansionist's predicate is orthogonal (same emptiness reframed as upside).

**Convergence flag: NOT raised.** Five semantically distinct positions retained. Proceed to Phase 3.

## Phase 3 — Chairman's verdict

### Gate summary

| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Disposition |
|---|---|---|---|---|---|
| Contrarian       | PASS | PASS | PASS | FAIL | Modify — add legacy-snapshot reconcile probe |
| First Principles | PASS | PASS | PASS | FAIL | Modify — classification correct, must name pumps (post-deploy execution gap + parent-closure-without-atom) |
| Expansionist     | FAIL | FAIL | PASS | FAIL | Modify — reframings not evidenced; ground truth must be corrected first |
| Outsider         | PASS | PASS | PASS | PASS | Accept |
| Executor         | PASS | PASS | PASS | PASS | Modify — prepend `CLEO_BRAIN_DB_PATH` env-override verification |

### Recommendation

**The handoff's claim does NOT match reality. v2026.4.133 is a real release of instrumentation and transport; it is not the shipment the handoff describes.** Per-claim classification using the First Principles taxonomy:

| Handoff claim | Classification | Evidence |
|---|---|---|
| `v2026.4.133` tagged, CI green, `@cleocode/cleo` + `@cleocode/core` published | **(a) genuine-shipment** | Evidence pack items 1, 2 |
| M6 rejection + M7 gate code-wired; doctor CLI + reflex exist; schema migrated with `provenanceClass DEFAULT 'unswept-pre-T1151'` | **(b) infrastructure-only** | Evidence pack item 6 — code paths exist; no run-log receipt proves they fired against real corrupt data |
| `@cleocode/mcp-adapter@2026.4.133` published | **(c) declared-but-missing** | Evidence pack item 2 — `npm view` returns 404; `package.json` declares the version but publish never occurred |
| "2440-entry BRAIN sweep executed" | **(c) declared-but-missing** | Evidence pack item 5 — `brain_v2_candidate=0`, `brain_backfill_runs=0`, three mutually inconsistent numbers (2440/252/324); T1256 self-admission at handoff:109 |
| "All 8 epics closed, T1075 umbrella done" | **(d) task-graph-hygiene-gap** | Evidence pack item 3 — 7/12 parent epics have `verification: null`; violates ADR-051 at the parent layer |
| T1107 `cancelled` with full gates green; T1262 `pending` despite both split-parents `done` | **(d) task-graph-hygiene-gap** | Evidence pack item 7 |

**Right atomic statement of what shipped:** v2026.4.133 ships the *instrument* (doctor, reflex, reconciler, M6/M7 gate code, `provenanceClass` column and default) and the *transport* (core + CLI on npm). It does not ship the sweep's effect (no `brain_backfill_runs` row exists), the adapter's registry presence (404), or the parent-layer evidence attestation (7 epics closed without gates).

### Why this, not the alternatives

**Rejecting Expansionist's "deliberate dogfood checkpoint" framing for mcp-adapter.** MEMORY.md's newly-added external-bridge carve-out clarifies mcp-adapter's *role* (subprocess-only, not in dispatch surface) — but the handoff gave users install-time instructions that depend on the package resolving on npm. Architectural role does not retroactively convert a 404 into a feature. A deliberate pre-GA checkpoint would be documented as such in the handoff; it is not.

**Rejecting Expansionist's "324/0/0 is the canonical green reference run" reframing for the sweep.** The handoff quotes `totalScanned:252` as M7 smoke evidence and claims a 2440-entry sweep was executed. Today's DB reads 324/[]/true/0. The three numbers are not a reference run — they are an unlabeled delta with no provenance, and calling them a reference run after the fact is retroactive bookkeeping, which the owner's standing "STOP Building Theater" feedback explicitly forbids. Outsider's artifact-anchored reading ("the gate passed because the room was empty") is the correct one.

**Rejecting First Principles' pure classification as sufficient.** Contrarian's peer review is right: classification without naming the *pump* leaves the pattern free to recur. Two pumps must be named and plugged:
1. **Post-deploy execution gap** — CI ships payloads that require a post-tag execute step (migrations, sweeps, registry publishes) but no stage runs them. Instance count: ≥3 in this release alone (sweep, mcp-adapter publish, parent-epic attestation).
2. **Parent-closure-without-atom** — `SELECT id FROM tasks WHERE status='done' AND type='epic' AND verification IS NULL` returns 7 rows. The epic layer has no ADR-051 enforcement.

### What each advisor got right (carried forward)

- **Contrarian:** M7 will lock every legacy user out on first `propose enable` because `provenanceClass` defaults to `'unswept-pre-T1151'` for all pre-existing rows and the reconciler has never run against real corrupt data. *Carried to conditions.*
- **First Principles:** `brain_backfill_runs=0` and npm GET `@cleocode/mcp-adapter@2026.4.133`=404 are the two rows whose transition is the actual shipment event. *Carried to verdict taxonomy above.*
- **Expansionist:** The BRAIN Commissioning Harness is a real product surface; its worth does not depend on whether the handoff was accurate. *Carried to open question (c) for owner framing of v2026.4.134.*
- **Outsider:** A stranger running the handoff's next-step commands gets a 404 on the adapter, a clean doctor from an empty room, and a green M7 enable derived from that emptiness. "The gate passed because the room was empty." *Carried as the dispositive framing.*
- **Executor:** An end-to-end seed-sweep-assert-rollback vitest converts the entire W7 claim from code-wired to binary within the hour. *Carried to 60-minute action below.*

### Conditions on the recommendation

1. **v2026.4.133 is not retagged.** It is what it is: a real release of instrumentation. No retroactive rewrite of CalVer history.
2. **The handoff is corrected to match ground truth before any downstream consumer acts on it.** No retroactive relabeling of 324/0/0 as a reference run. The three conflicting corpus numbers must be reconciled to the one that is actually true.
3. **Fix-forward in v2026.4.134** — publish `@cleocode/mcp-adapter`, attest the 7 parent epics with real evidence (or reopen them), run the reconciler against a pre-T1151 brain snapshot with a persisted `brain_backfill_runs` row.
4. **T1256 reopens as its own epic.** Handoff:109 is a written admission that the LLM port (5680 LOC from Honcho src/llm/) was marked done to close T1075 without being implemented. Per ADR-051 this is not a judgment call; it is a required reopen.
5. **The two pumps (post-deploy execution gap, parent-closure-without-atom) are filed as their own cleanup tasks** before the next epic starts. Without this, the pattern recurs on T1145/T1146.

### Next 60-minute action

Two complementary probes, run in this order. Bundled because Executor's test needs a fixture-DB path, and Contrarian's legacy-snapshot probe independently answers whether the M7 lockout is latent in the wild.

**Step 0 — Outsider's prepend (verify DB-path override exists):**
```bash
rg -n "CLEO_BRAIN_DB|BRAIN_DB_PATH|brainDbPath" packages/core/src packages/cleo/src
```
Binary: if no env override surfaces, the test must use whatever DB-injection seam does exist (config override, constructor injection); otherwise proceed.

**Step 1 — Contrarian's legacy-snapshot reconcile probe (fastest signal):**
```bash
ls -t .cleo/backups/sqlite/brain-*.db | tail -5
CLEO_BRAIN_DB_PATH=.cleo/backups/sqlite/brain-<oldest-pre-T1151>.db \
  cleo memory reconcile --dry-run --assert-clean
```
Binary: exit 0 → M7 legacy-install claim holds; non-zero → v2026.4.134 MUST patch before any downstream consumer touches.

**Step 2 — Executor's e2e fixture (converts W7 to binary artifact):**
Create `packages/core/test/fixtures/brain-sweep-e2e.test.ts` seeding 6 synthetic rows (duplicate-content×2, missing-type, missing-provenance, orphan-edge, low-confidence, stale-unverified). Pipeline: seed → `cleo memory sweep --dry-run` → approve → `cleo memory doctor --assert-clean` → rollback. Assert exit codes and JSON output at each step. Binary: green → M7 gate has real artifact + `propose enable` can flip with evidence; red → T1147 reopens.

### Confidence

**High** on the classification verdict itself — every cell in the taxonomy table is backed by a hard-verified evidence-pack item plus a direct query result. Three independent reads (doctor JSON pendingCandidates=0, brain_v2_candidate=0, brain_backfill_runs=0) confirm the sweep did not execute. The 404 on mcp-adapter is a hard falsifier. The 7 null-verification parent epics are direct query results.

Reasons confidence could drop:
- If `brain_backfill_runs` table was migrated-out or renamed and the COUNT=0 is a schema-name miss (unlikely given three independent reads all agree).
- If `@cleocode/mcp-adapter` was published under a scope alias not queried (low — local `package.json` declares the scope literally).
- If the 7 null-verification epics have evidence stored out-of-band (memory observations rather than the `verification` column). Would move those from (d) to (b), not to (a).

### Open questions for the owner

**(a) Should the handoff be rewritten to reflect actual ground truth?** Chairman recommendation: **yes, immediately**, before any orchestrator reads it as context. The 2440/252/324 inconsistency and the T1256 admission at line 109 are self-contradictions inside one document.

**(b) Should v2026.4.134 ship as a fix-forward that publishes mcp-adapter + re-attests the 7 parent epics + runs the sweep on a legacy snapshot?** Chairman recommendation: **yes, as a single coherent patch with a restated release note.** Anything less lets the (c) and (d) classifications harden into precedent.

**(c) Should T1256 be reopened as its own epic?** Chairman recommendation: **yes — handoff:109 is not ambiguous.** The 5680-LOC Honcho LLM port was marked done to close T1075; per ADR-051 and the owner's "STOP Building Theater" standing feedback, this is a required reopen, not a judgment call. The reopened epic can legitimately be sequenced after v2026.4.134 — but must not remain closed.
