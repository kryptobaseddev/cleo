# Cross-Epic Dep Bubble — Remediation Report

**Generated:** 2026-05-11T18:58:23.801412Z

## Summary

- Total `E_CROSS_EPIC_GAP` issues: **82**
- Unique `(epicA, epicB)` pairs: **31**
- Commands to emit: **23** across **17** parent epics
- Skipped: **8** (already-satisfied, archived, or missing)

## Per-Epic Breakdown (emitted)

| Epic | Title | New Deps | Driven by (children) |
|---|---|---|---|
| T1042 | Cleo Nexus vs GitNexus: Far-Exceed Capability Analysis | T1840, T1855 | T1846, T1836, T1837, T1873 |
| T1768 | Define Cleo Core SDK 'Tools' surface — centralized harness-a | T1929 | T1820, T1822, T1821 |
| T1840 | EPIC: Cleo Nexus multi-language extractor parity + coverage  | T1042, T1942 | T1843, T1842 |
| T1855 | EPIC: CLEO opinionated guardrails — mandatory dependency enf | T1929 | T9038 |
| T1942 | Governed Execution Unification — playbook-as-primary-orchest | T1737, T1929 | T1942, T1950, T1943, T9155 |
| T9097 | EPIC: 3-way honest benchmark validation — cleo nexus vs gitn | T1042 | T9101, T9100, T9099 |
| T9098 | EPIC: Steal-from-graphify capability set + token-cheap LLM e | T1042 | T9105, T9106, T9104 |
| T9144 | MASTER EPIC: Nexus Restructure — cleo graph + narrowed cleo  | T1042 | T9144 |
| T9145 | W1: Contracts foundation — NexusOperationDescriptor + NEXUS_ | T1042 | T9145 |
| T9146 | W2: LAFS envelope meta._nexus extension — scope projectId bi | T1042 | T9146 |
| T9147 | W3: CLI surgical split — cleo graph top-level + cleo graph l | T1042 | T9147 |
| T9148 | W4: Help renderer + INJECTION canonical + ct-cleo collapse + | T1042 | T9148 |
| T9149 | W5: Project identity canonicalization (N1) + pollution clean | T1042 | T9149 |
| T9150 | W6: Release 2 — DB topology split nexus.db into nexus-regist | T1042 | T9150 |
| T9186 | PROTOCOL-HARDEN verifier-backed AC + auditor-loop in cleo ve | T9047 | T9186 |
| T9187 | AUDIT-RECOVERY-2026-05-08 fix scaffold-and-mark-done failure | T9021, T9047, T9080, T9192 | T9190, T9213, T9189, T9214, T9218, T9191, T9188 |
| T9221 | EPIC Forced-Iterations Systemic Enforcement — gate-level byp | T9187 | T9231, T9221, T9230 |

## Skipped Pairs

| epicA | epicB | reason | drivers |
|---|---|---|---|
| T1566 | T1563 | epicA T1566 not in active table | T1568→T1565, T1568→T1585, T1566→T1565 |
| T1688 | T1685 | epicA T1688 not in active table | T1688→T1687 |
| T1689 | T1685 | epicA T1689 not in active table | T1689→T1686 |
| T1757 | T1756 | epicA T1757 not in active table | T1767→T1759, T1767→T1761 |
| T1824 | T1929 | epicA status=done | T1825→T1941 |
| T9021 | T9047 | epicA status=done | T9022→T9050, T9023→T9050, T9025→T9050 |
| T9062 | T9047 | epicA status=done | T9062→T9050 |
| T9192 | T9047 | epicA status=done | T9192→T9050 |
