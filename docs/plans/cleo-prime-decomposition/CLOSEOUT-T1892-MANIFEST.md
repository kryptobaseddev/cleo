# CLOSEOUT MANIFEST — T1892 BBTT BRAIN/Briefing Trust

> **Status**: ready-for-agent-execution · 2026-05-15
> **Agent role**: validate every child's evidence, reparent the 3 reopened children, close T1892 with attestation.
> **ZERO ASSUMPTIONS**: every "done" child's `--override` evidence atom must be re-checked against actual code state. Don't trust the status field; trust the diff.

---

## 1. Epic-level context

- **Epic**: T1892 — "BBTT — BRAIN/Briefing Trust & Truth: field contracts, dream-cycle revival, provenance, write-discipline"
- **Status**: pending (epic-level)
- **Children**: 17 total · 14 marked done · 3 reopened (T1897, T1899, T1906)
- **Action**: full close-as-superseded after children disposition
- **Successor**: E-PRIME-SENTIENCE (master) + E-PRIME-T01/T02 (absorbing tier-epics)

---

## 2. Per-child disposition

### 2.1 Reopened children — REPARENT under E-PRIME-T02

| Child | Title | Action | Rationale |
|---|---|---|---|
| **T1897** | W3-2: Add origin + validated_at + provenance_chain to brain_observations | **REPARENT → E-PRIME-T02** | Direct match for origin migration in T02.P1. Blocked-by T9245 (now under E-PRIME-T01). |
| **T1899** | W3-1: Add origin column to tasks schema | **REPARENT → E-PRIME-T02** | Direct match for origin migration in T02.P1. Blocked-by T9245. |
| **T1906** | W3-4: Test-DB isolation enforcement (assertTestEnv) | **REPARENT → E-PRIME-T02** | Direct match for quarantine in T02.P3. |

**Reparent ritual per child** (run after E-PRIME-T02 epic exists):
```bash
# Capture original parent in audit note BEFORE reparent
cleo update T1897 --note "Reparented from T1892 to E-PRIME-T02 on 2026-05-15. Original BBTT W3-2 scope retained verbatim. Now blocked-by T9245 under E-PRIME-T01."
cleo update T1897 --parent <E-PRIME-T02-ID>
cleo update T1897 --depends add <T9245-NEW-ID>   # if T9245 was reparented too — verify ID

# Repeat for T1899 + T1906
```

**Do NOT re-verify these now.** They wait under E-PRIME-T02 until T9245 ships, then re-verify with real evidence atoms (commit+files+tool) — the whole point.

### 2.2 Done children — AUDIT then KEEP-DONE-HISTORICAL

All 14 done children below stay under T1892 as historical record. **BUT**: agents MUST audit each child's evidence atoms before closing T1892. Any child where `--override` was used on `implemented` or `testsPassed` gates **without programmatic proof** must be flagged.

| Child | Title | Evidence atom audit (verify with `cleo show <id>` + `git show <sha>`) |
|---|---|---|
| T1893 | W0-1: Gate relatedDocs on currentTaskId | `commit:692eeaaa0` (real) + `files:briefing.ts, briefing-docs.test.ts` (real) + qa `override:biome pre-existing unrelated`. **VERIFY**: commit reachable from main, diff touches the 2 cited files. |
| T1894 | W0-2: Filter test-fixture epics heuristic | `override:commit 399b8d20e on worktree task/T1894 branch`. **VERIFY**: is 399b8d20e reachable from main? If NOT, flag for re-verify gate audit. |
| T1895 | W2-1: `cleo memory dream --status` CLI | `override:worktree commit c268aa3b on task/T1895 branch`. **VERIFY**: reachable from main? |
| T1896 | W1-2: Pattern dedup at consolidation | `override:commit eb2c918c0 on task/T1896 branch HEAD`. **VERIFY**. |
| T1898 | W2-0 BUG: T1682 daemon dead diagnosis | `commit:c40341aa7` (real) + `files:WHY-DREAM-DIDNT-RUN.md`. **VERIFY**: commit reachable from main. |
| T1900 | W1-1: Recency mode on searchBrainCompact | `override:commit on task/T1900 branch HEAD`. **VERIFY**: reachable from main? |
| T1901 | W2-2: Sentient tick diagnosis | `commit:c40341aa7` (real, same as T1898) + override on tests/qa. **VERIFY**. |
| T1902 | W5-1: Per-worktree handoff ADR | `override:design-only ADR on main`. **CHECK**: ADR-068 exists at `docs/adr/ADR-068-per-worktree-handoff.md`. |
| T1903 | W3-5: Auto-extract repair | check evidence atoms via `cleo show T1903`. |
| T1904 | W2-3: Opportunistic dream trigger | check evidence. |
| T1905 | W1-3: BriefingFieldContract types | check evidence. |
| T1907 | W2-5: Freshness sentinel CI gate | check evidence. |
| T1908 | W2-4: cleo doctor brain CLI | check evidence (depends T1895, T1897, T1899 — interesting since T1897/T1899 are NOT done). |
| T1909 | W3-3: scan-test-fixtures-in-prod | check evidence. |

**Audit procedure per child**:
```bash
# 1. Inspect evidence atoms
cleo show <child-id> --json | jq '.data.task.verification.evidence'

# 2. For each `commit:<sha>` atom, verify reachability from main:
git merge-base --is-ancestor <sha> main && echo "REACHABLE" || echo "ORPHAN"

# 3. For each `override` atom, parse the reason field:
#    - If reason contains "worktree" or "task/T<id> branch" → suspect (commit may have been force-pushed away)
#    - If reason contains "pre-existing unrelated file" → benign (biome/lint waiver)
#    - If reason contains "design-only" → benign (no code change)

# 4. For each `files:<list>` atom, verify sha256 still matches HEAD:
for f in <files>; do
  current=$(sha256sum "$f" | awk '{print $1}')
  echo "$f: current=$current expected=<from-atom>"
done
```

**Output**: per-child audit verdict written to `docs/plans/cleo-prime-decomposition/CLOSEOUT-T1892-AUDIT.md`:
- `CLEAN` — evidence verified, no action needed
- `WORKTREE-ORPHAN` — commit not reachable from main but functionality verified on main (acceptable, document why)
- `SUSPECT` — override evidence, commit not on main, functionality unverified → **file follow-up re-verify subtask under E-PRIME-T01**
- `BENIGN-OVERRIDE` — override is on a non-critical gate (qa/lint waiver) → acceptable

### 2.3 Done children with `--override` on critical gates — follow-up policy

If audit finds ANY done child with `--override` on `implemented` OR `testsPassed` AND the commit is not reachable from main, the agent must:

1. File a follow-up subtask under **E-PRIME-T01.P2** (BBTT re-verify): `Re-verify T<id> with real evidence atoms (post-T9245)`.
2. Leave T<id> status = done (don't reopen — the work was attempted) but add a note: `"2026-05-15 closeout-audit: --override evidence on <gate> not reachable from main. Re-verify subtask filed at <follow-up-id>."`

This preserves historical record while flagging for trust-rebuild under E-PRIME-T01.

---

## 3. Epic closure ritual (after children disposition)

```bash
# Step 1: Final status note
cleo update T1892 --note "Closed-as-superseded 2026-05-15 by E-PRIME-SENTIENCE program. 14 done children remain historical record under T1892. 3 pending children (T1897, T1899, T1906) reparented to E-PRIME-T02 for re-verify under T9245-hardened validator. Per-child audit at docs/plans/cleo-prime-decomposition/CLOSEOUT-T1892-AUDIT.md. See E-PRIME-SENTIENCE master at docs/plans/cleo-prime-decomposition/README.md."

# Step 2: Verify each gate with attestation evidence
cleo verify T1892 --gate implemented \
  --evidence "decision:E-PRIME-SENTIENCE;files:docs/plans/cleo-prime-decomposition/CLOSEOUT-T1892-AUDIT.md,docs/plans/cleo-prime-decomposition/RECONCILIATION-PLAN.md;note:children disposition documented, 3 pending reparented to E-PRIME-T02"

cleo verify T1892 --gate testsPassed \
  --evidence "note:design-only epic supersession; child-level tests stay under reparented children + new E-PRIME-T02 subtasks"

cleo verify T1892 --gate qaPassed \
  --evidence "note:design-only epic supersession; no source changes in this closure"

cleo verify T1892 --gate documented \
  --evidence "files:docs/plans/cleo-prime-decomposition/CLOSEOUT-T1892-AUDIT.md,docs/plans/cleo-prime-decomposition/CLOSEOUT-T1892-MANIFEST.md"

cleo verify T1892 --gate securityPassed \
  --evidence "note:no source changes; trust contracts INCREASE via successor E-PRIME-T01 hardening"

cleo verify T1892 --gate cleanupDone \
  --evidence "note:pending children reparented; done children remain historical; no orphans"

# Step 3: Complete
cleo complete T1892
```

---

## 4. Rollback (if agents discover blocker)

If audit reveals a done child cannot be cleanly closed (e.g., commit force-pushed away AND functionality not on main), agents must:

1. NOT close T1892.
2. File a P0 follow-up: `Investigate T<id> functionality reality on main HEAD`.
3. Leave T1892 open until investigation completes.
4. Update this manifest with findings.

**This manifest does not authorize bulk closure.** Audit is mandatory.

---

## 5. Success criteria for this closeout

- [ ] All 17 children inspected with `cleo show <id> --json`
- [ ] Audit report `CLOSEOUT-T1892-AUDIT.md` written with per-child verdict
- [ ] T1897, T1899, T1906 reparented to E-PRIME-T02 with audit-note added
- [ ] All `SUSPECT` audit findings filed as E-PRIME-T01.P2 re-verify subtasks
- [ ] T1892 closed with 6-gate evidence chain (no `--override` on `implemented`)
- [ ] `cleo show T1892` returns `status:done, verification.passed:true`
- [ ] `cleo find "BBTT"` returns zero pending tasks under T1892 (all reparented or done)

Once these criteria are met, T1892 is canonically retired and E-PRIME-T01/T02 carry the trust-rebuild work forward.
