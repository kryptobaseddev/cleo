#!/usr/bin/env bash
# Generated: 2026-05-11T18:58:23.801412Z
# Purpose: Bubble 23 cross-epic deps from child tasks up to their parent epics
set -uo pipefail


# === Epic T1042 (Cleo Nexus vs GitNexus: Far-Exceed Capability Analysis) ===
#   driven by: T1836→T1841, T1837→T1841, T1846→T1841
#   driven by: T1873→T1864
echo "==> T1042 += deps: T1840,T1855"
cleo update T1042 --add-depends T1840,T1855

# === Epic T1768 (Define Cleo Core SDK 'Tools' surface — centralized harness-agnostic utilities) ===
#   driven by: T1820→T1941, T1821→T1941, T1822→T1941
echo "==> T1768 += deps: T1929"
cleo update T1768 --add-depends T1929

# === Epic T1840 (EPIC: Cleo Nexus multi-language extractor parity + coverage expansion (Swift Jav) ===
#   driven by: T1843→T1838
#   driven by: T1842→T1953
echo "==> T1840 += deps: T1042,T1942"
cleo update T1840 --add-depends T1042,T1942

# === Epic T1855 (EPIC: CLEO opinionated guardrails — mandatory dependency enforcement, auto-sugge) ===
#   driven by: T9038→T1941
echo "==> T1855 += deps: T1929"
cleo update T1855 --add-depends T1929

# === Epic T1942 (Governed Execution Unification — playbook-as-primary-orchestration, OpenProse pa) ===
#   driven by: T9155→T9154
#   driven by: T1943→T1941, T1950→T1937, T1942→T1941
echo "==> T1942 += deps: T1737,T1929"
cleo update T1942 --add-depends T1737,T1929

# === Epic T9097 (EPIC: 3-way honest benchmark validation — cleo nexus vs gitnexus vs graphify, re) ===
#   driven by: T9099→T1844, T9100→T1844, T9101→T1844
echo "==> T9097 += deps: T1042"
cleo update T9097 --add-depends T1042

# === Epic T9098 (EPIC: Steal-from-graphify capability set + token-cheap LLM enrichment ladder — b) ===
#   driven by: T9104→T1844, T9105→T1844, T9106→T1844
echo "==> T9098 += deps: T1042"
cleo update T9098 --add-depends T1042

# === Epic T9144 (MASTER EPIC: Nexus Restructure — cleo graph + narrowed cleo nexus, scope-map SSo) ===
#   driven by: T9144→T1835
echo "==> T9144 += deps: T1042"
cleo update T9144 --add-depends T1042

# === Epic T9145 (W1: Contracts foundation — NexusOperationDescriptor + NEXUS_SCOPE_MAP SSoT + Con) ===
#   driven by: T9145→T1844
echo "==> T9145 += deps: T1042"
cleo update T9145 --add-depends T1042

# === Epic T9146 (W2: LAFS envelope meta._nexus extension — scope projectId bindingSource canonica) ===
#   driven by: T9146→T1844
echo "==> T9146 += deps: T1042"
cleo update T9146 --add-depends T1042

# === Epic T9147 (W3: CLI surgical split — cleo graph top-level + cleo graph living * + narrowed c) ===
#   driven by: T9147→T1844
echo "==> T9147 += deps: T1042"
cleo update T9147 --add-depends T1042

# === Epic T9148 (W4: Help renderer + INJECTION canonical + ct-cleo collapse + adapter-rendering —) ===
#   driven by: T9148→T1844
echo "==> T9148 += deps: T1042"
cleo update T9148 --add-depends T1042

# === Epic T9149 (W5: Project identity canonicalization (N1) + pollution cleanup tooling — git-roo) ===
#   driven by: T9149→T1835
echo "==> T9149 += deps: T1042"
cleo update T9149 --add-depends T1042

# === Epic T9150 (W6: Release 2 — DB topology split nexus.db into nexus-registry.db + nexus-graph/) ===
#   driven by: T9150→T1844
echo "==> T9150 += deps: T1042"
cleo update T9150 --add-depends T1042

# === Epic T9186 (PROTOCOL-HARDEN verifier-backed AC + auditor-loop in cleo verify+complete) ===
#   driven by: T9186→T9050
echo "==> T9186 += deps: T9047"
cleo update T9186 --add-depends T9047

# === Epic T9187 (AUDIT-RECOVERY-2026-05-08 fix scaffold-and-mark-done failure mode + harden cleo ) ===
#   driven by: T9190→T9025, T9191→T9064
#   driven by: T9188→T9050, T9189→T9047, T9214→T9047
#   driven by: T9213→T9082
#   driven by: T9218→T9192
echo "==> T9187 += deps: T9021,T9047,T9080,T9192"
cleo update T9187 --add-depends T9021,T9047,T9080,T9192

# === Epic T9221 (EPIC Forced-Iterations Systemic Enforcement — gate-level bypass prevention) ===
#   driven by: T9230→T9217, T9231→T9215, T9221→T9217
echo "==> T9221 += deps: T9187"
cleo update T9221 --add-depends T9187
